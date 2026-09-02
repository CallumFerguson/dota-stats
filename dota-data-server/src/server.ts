import dotenv from "dotenv";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, type ClientConfig } from "pg";
import { createDatabaseSchema } from "./database-schema.js";
import { storeMatches, type DotaMatch } from "./match-storage.js";
import { RateLimitTracker } from "./rate-limit-tracker.js";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(sourceDirectory, "..");

dotenv.config({ path: path.join(projectDirectory, ".env"), quiet: true });

const PORT = Number(process.env.PORT ?? 3000);
const MATCHES_REQUESTED = 100;
const TARGET_MATCH_COUNT = 90;
const INITIAL_POLL_INTERVAL_MS = 5_000;
const MIN_POLL_INTERVAL_MS = 2_000;
const MAX_POLL_INTERVAL_MS = 6_000;
const FULL_PAGES_PER_DELAY_REDUCTION = 5;
const INITIAL_BACKOFF_MS = 6_000;
const MAX_BACKOFF_MS = 60_000;
const RATE_LIMIT_THRESHOLD = 10;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1_000;
const DATABASE_CONNECTION_TIMEOUT_MS = 10_000;
const MATCH_HISTORY_ENDPOINT =
  "https://api.steampowered.com/IDOTA2Match_570/GetMatchHistory/v1/";
const MATCH_SEQUENCE_ENDPOINT =
  "https://api.steampowered.com/IDOTA2Match_570/GetMatchHistoryBySequenceNum/v1/";

interface MatchApiResponse {
  result?: {
    matches?: DotaMatch[];
  };
}

type PollingPhase = "starting" | "catching-up" | "caught-up" | "failed";

interface PollingStatus {
  apiKeyCount: number;
  consecutiveFailures: number;
  consecutiveFullPages: number;
  isBehind: boolean;
  lastError: string | null;
  latestMatchCount: number | null;
  nextPollDelayMs: number;
  nextSequenceNumber: number | null;
  phase: PollingPhase;
}

const pollingStatus: PollingStatus = {
  apiKeyCount: 0,
  consecutiveFailures: 0,
  consecutiveFullPages: 0,
  isBehind: false,
  lastError: null,
  latestMatchCount: null,
  nextPollDelayMs: INITIAL_POLL_INTERVAL_MS,
  nextSequenceNumber: null,
  phase: "starting",
};

class ValveApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = "ValveApiError";
  }
}

class ValveRateLimitThresholdError extends ValveApiError {
  constructor(retryAfterMs: number | null) {
    super(
      `Valve API rate-limit threshold reached: received ${RATE_LIMIT_THRESHOLD} HTTP 429 responses within 10 minutes`,
      429,
      retryAfterMs,
    );
    this.name = "ValveRateLimitThresholdError";
  }
}

class ApiKeyRotator {
  private nextKeyIndex = 0;
  private readonly lastUsedAt: Array<number | null>;

  constructor(private readonly apiKeys: readonly string[]) {
    this.lastUsedAt = apiKeys.map(() => null);
  }

  get count(): number {
    return this.apiKeys.length;
  }

  next(): {
    apiKey: string;
    keyNumber: number;
    millisecondsSinceLastUse: number | null;
  } {
    const keyIndex = this.nextKeyIndex;
    const apiKey = this.apiKeys[keyIndex];
    const usedAt = Date.now();
    const previousUse = this.lastUsedAt[keyIndex];
    this.lastUsedAt[keyIndex] = usedAt;
    this.nextKeyIndex = (this.nextKeyIndex + 1) % this.apiKeys.length;

    return {
      apiKey,
      keyNumber: keyIndex + 1,
      millisecondsSinceLastUse:
        previousUse === null ? null : usedAt - previousUse,
    };
  }
}

function parseApiKeys(value: string | undefined): string[] {
  const apiKeys = (value ?? "")
    .split(",")
    .map((apiKey) => apiKey.trim())
    .filter(Boolean);
  const uniqueApiKeys = [...new Set(apiKeys)];

  if (uniqueApiKeys.length < 2) {
    throw new Error(
      "STEAM_API_KEYS must contain at least two unique comma-separated Valve Web API keys.",
    );
  }

  if (uniqueApiKeys.length !== apiKeys.length) {
    throw new Error("STEAM_API_KEYS must not contain duplicate API keys.");
  }

  return uniqueApiKeys;
}

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name];

  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be set and cannot be empty.`);
  }

  return value;
}

function getDatabaseConfig(): ClientConfig {
  const portValue = requireEnvironmentVariable("PGPORT");
  const port = Number(portValue);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PGPORT must be an integer between 1 and 65535.");
  }

  return {
    host: requireEnvironmentVariable("PGHOST"),
    port,
    database: requireEnvironmentVariable("PGDATABASE"),
    user: requireEnvironmentVariable("PGUSER"),
    password: requireEnvironmentVariable("PGPASSWORD"),
    connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MS,
  };
}

async function connectToDatabase(): Promise<Client> {
  const config = getDatabaseConfig();
  const database = new Client(config);

  try {
    await database.connect();
  } catch (error: unknown) {
    throw new Error(
      `Could not connect to PostgreSQL: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }

  console.log(
    `Connected to PostgreSQL at ${config.host}:${config.port}/${config.database}.`,
  );
  return database;
}

function parseRetryAfter(retryAfter: string | null): number | null {
  if (retryAfter === null) {
    return null;
  }

  const seconds = Number(retryAfter);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }

  const retryAt = Date.parse(retryAfter);

  if (Number.isNaN(retryAt)) {
    return null;
  }

  return Math.max(0, retryAt - Date.now());
}

async function fetchJson(
  requestUrl: URL,
  apiKeys: ApiKeyRotator,
  rateLimits: RateLimitTracker,
): Promise<MatchApiResponse> {
  const selectedKey = apiKeys.next();
  requestUrl.searchParams.set("key", selectedKey.apiKey);
  const previousUseDescription =
    selectedKey.millisecondsSinceLastUse === null
      ? "first use in this process"
      : `${(selectedKey.millisecondsSinceLastUse / 1_000).toFixed(1)} seconds since its last use`;
  console.log(
    `Valve request using API key #${selectedKey.keyNumber}/${apiKeys.count} (${previousUseDescription}).`,
  );
  const response = await fetch(requestUrl);

  if (!response.ok) {
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));

    if (
      response.status === 429 &&
      rateLimits.record() >= RATE_LIMIT_THRESHOLD
    ) {
      throw new ValveRateLimitThresholdError(retryAfterMs);
    }

    throw new ValveApiError(
      `Valve API request failed: ${response.status} ${response.statusText}`,
      response.status,
      retryAfterMs,
    );
  }

  return (await response.json()) as MatchApiResponse;
}

function getMatches(matchData: MatchApiResponse): DotaMatch[] {
  const matches = matchData.result?.matches;

  if (!Array.isArray(matches)) {
    throw new Error("Valve API response did not contain a matches array.");
  }

  return matches;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrorStringProperty(
  error: unknown,
  propertyName: string,
): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const value = (error as Record<string, unknown>)[propertyName];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function formatError(error: unknown): string {
  if (error instanceof AggregateError) {
    const nestedErrors = [...error.errors]
      .map((nestedError) => formatError(nestedError))
      .join(" | ");
    return `${error.message}: ${nestedErrors}`;
  }

  const details = [
    ["code", getErrorStringProperty(error, "code")],
    ["table", getErrorStringProperty(error, "table")],
    ["column", getErrorStringProperty(error, "column")],
    ["constraint", getErrorStringProperty(error, "constraint")],
    ["detail", getErrorStringProperty(error, "detail")],
    ["hint", getErrorStringProperty(error, "hint")],
  ]
    .filter((detail): detail is [string, string] => detail[1] !== null)
    .map(([label, value]) => `${label}=${value}`);
  const detailSuffix = details.length > 0 ? ` (${details.join(", ")})` : "";
  const cause =
    error instanceof Error && "cause" in error ? error.cause : undefined;
  const causeSuffix =
    cause === undefined || cause === error
      ? ""
      : `; caused by: ${formatError(cause)}`;

  return `${getErrorMessage(error)}${detailSuffix}${causeSuffix}`;
}

function isRetryableDatabaseError(error: unknown): boolean {
  const code = getErrorStringProperty(error, "code");

  if (code === null) {
    return false;
  }

  return ["40001", "40P01", "55P03"].includes(code);
}

function getRetryDelay(error: unknown, failureCount: number): number {
  const exponent = Math.min(failureCount - 1, 10);
  const exponentialDelay = Math.min(
    INITIAL_BACKOFF_MS * 2 ** exponent,
    MAX_BACKOFF_MS,
  );
  const retryAfterDelay =
    error instanceof ValveApiError ? error.retryAfterMs : null;

  return Math.max(exponentialDelay, retryAfterDelay ?? 0);
}

async function retryWithBackoff<T>(
  description: string,
  operation: () => Promise<T>,
  options: {
    formatFailure?: (error: unknown) => string;
    retryNote?: string;
    shouldRetry?: (error: unknown) => boolean;
  } = {},
): Promise<T> {
  let failureCount = 0;

  while (true) {
    try {
      const result = await operation();
      pollingStatus.consecutiveFailures = 0;
      pollingStatus.lastError = null;
      return result;
    } catch (error: unknown) {
      const formattedFailure = (options.formatFailure ?? getErrorMessage)(error);

      if (error instanceof ValveRateLimitThresholdError) {
        pollingStatus.lastError = `${description}: ${formattedFailure}`;
        throw error;
      }

      if (options.shouldRetry !== undefined && !options.shouldRetry(error)) {
        pollingStatus.lastError = `${description}: ${formattedFailure}`;
        throw error;
      }

      failureCount += 1;
      pollingStatus.consecutiveFailures = failureCount;
      pollingStatus.lastError = `${description}: ${formattedFailure}`;
      const retryDelay = getRetryDelay(error, failureCount);
      pollingStatus.nextPollDelayMs = retryDelay;
      const retryAfterWasUsed =
        error instanceof ValveApiError &&
        error.retryAfterMs !== null &&
        error.retryAfterMs >= retryDelay;
      const retryReason = retryAfterWasUsed
        ? " (honoring Retry-After)"
        : " (exponential backoff)";

      console.error(
        `${description} failed: ${formattedFailure}. Retrying in ${(retryDelay / 1_000).toFixed(1)} seconds${retryReason}.${options.retryNote === undefined ? "" : ` ${options.retryNote}`}`,
      );
      await delay(retryDelay);
    }
  }
}

async function fetchApproximateLatestSequenceNumber(
  apiKeys: ApiKeyRotator,
  rateLimits: RateLimitTracker,
): Promise<number> {
  const requestUrl = new URL(MATCH_HISTORY_ENDPOINT);
  requestUrl.searchParams.set(
    "matches_requested",
    String(MATCHES_REQUESTED),
  );

  const matchData = await fetchJson(requestUrl, apiKeys, rateLimits);
  const sequenceNumbers = getMatches(matchData)
    .map((match) => match.match_seq_num)
    .filter((sequenceNumber): sequenceNumber is number =>
      Number.isSafeInteger(sequenceNumber),
    );
  const sequenceNumber = sequenceNumbers.length
    ? Math.max(...sequenceNumbers)
    : undefined;

  if (
    typeof sequenceNumber !== "number" ||
    !Number.isSafeInteger(sequenceNumber)
  ) {
    throw new Error(
      "Valve API did not return a usable approximate match sequence number.",
    );
  }

  return sequenceNumber;
}

interface FetchedMatchPage {
  matchCount: number;
  matches: DotaMatch[];
  nextSequenceNumber: number;
}

async function fetchMatchPage(
  apiKeys: ApiKeyRotator,
  rateLimits: RateLimitTracker,
  startSequenceNumber: number,
): Promise<FetchedMatchPage> {
  const requestUrl = new URL(MATCH_SEQUENCE_ENDPOINT);
  requestUrl.searchParams.set(
    "start_at_match_seq_num",
    String(startSequenceNumber),
  );
  requestUrl.searchParams.set("matches_requested", String(MATCHES_REQUESTED));

  const matchData = await fetchJson(requestUrl, apiKeys, rateLimits);
  const matches = getMatches(matchData);
  const returnedSequenceNumbers = matches
    .map((match) => match.match_seq_num)
    .filter((sequenceNumber): sequenceNumber is number =>
      Number.isSafeInteger(sequenceNumber),
    );
  const highestReturnedSequenceNumber = returnedSequenceNumbers.length
    ? Math.max(...returnedSequenceNumbers)
    : null;
  const nextSequenceNumber =
    highestReturnedSequenceNumber === null
      ? startSequenceNumber
      : highestReturnedSequenceNumber + 1;

  return { matchCount: matches.length, matches, nextSequenceNumber };
}

async function fetchAndStoreMatchPage(
  database: Client,
  apiKeys: ApiKeyRotator,
  rateLimits: RateLimitTracker,
  startSequenceNumber: number,
  fetchDescription: string,
): Promise<{ matchCount: number; nextSequenceNumber: number }> {
  const page = await retryWithBackoff(fetchDescription, () =>
    fetchMatchPage(apiKeys, rateLimits, startSequenceNumber),
  );

  await retryWithBackoff(
    `PostgreSQL storage for ${page.matchCount} matches starting at sequence ${startSequenceNumber}`,
    () => storeMatches(database, page.matches),
    {
      formatFailure: formatError,
      shouldRetry: isRetryableDatabaseError,
      retryNote:
        "The fetched page is retained in memory; no additional Valve request will be made for this retry.",
    },
  );

  return {
    matchCount: page.matchCount,
    nextSequenceNumber: page.nextSequenceNumber,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function calculateNextPollDelay(
  currentDelay: number,
  matchCount: number,
  elapsedSincePreviousFetch: number,
): number {
  const idealDelay =
    matchCount === 0
      ? currentDelay * 1.25
      : (elapsedSincePreviousFetch * TARGET_MATCH_COUNT) / matchCount;
  const graduallyAdjustedDelay = clamp(
    idealDelay,
    currentDelay * 0.75,
    currentDelay * 1.25,
  );

  return Math.round(
    clamp(
      graduallyAdjustedDelay,
      MIN_POLL_INTERVAL_MS,
      MAX_POLL_INTERVAL_MS,
    ),
  );
}

function reducePollDelayAfterSustainedFullPages(currentDelay: number): number {
  return Math.max(
    MIN_POLL_INTERVAL_MS,
    Math.round((currentDelay * TARGET_MATCH_COUNT) / MATCHES_REQUESTED),
  );
}

function recordFetchResult(
  result: {
    matchCount: number;
    nextSequenceNumber: number;
  },
): void {
  pollingStatus.latestMatchCount = result.matchCount;
  pollingStatus.nextSequenceNumber = result.nextSequenceNumber;
}

function logFetchSummary(
  result: { matchCount: number },
  detail: string,
  warning = false,
): void {
  const message = `Fetched and stored ${result.matchCount} matches; ${detail}.`;

  if (warning) {
    console.warn(message);
  } else {
    console.log(message);
  }
}

async function pollForMatches(
  database: Client,
  apiKeys: ApiKeyRotator,
  rateLimits: RateLimitTracker,
): Promise<never> {
  let nextSequenceNumber = await retryWithBackoff(
    "Finding an approximate latest match sequence number",
    () => fetchApproximateLatestSequenceNumber(apiKeys, rateLimits),
  );
  pollingStatus.nextSequenceNumber = nextSequenceNumber;
  pollingStatus.phase = "catching-up";
  console.log(`Approximate latest match sequence number: ${nextSequenceNumber}`);

  while (true) {
    const result = await fetchAndStoreMatchPage(
      database,
      apiKeys,
      rateLimits,
      nextSequenceNumber,
      "Startup Valve match fetch",
    );
    nextSequenceNumber = result.nextSequenceNumber;
    recordFetchResult(result);

    if (result.matchCount < MATCHES_REQUESTED) {
      pollingStatus.isBehind = false;
      pollingStatus.phase = "caught-up";
      logFetchSummary(
        result,
        `startup caught up, targeting about ${TARGET_MATCH_COUNT} per request`,
      );
      break;
    }

    pollingStatus.isBehind = true;
    pollingStatus.nextPollDelayMs = INITIAL_POLL_INTERVAL_MS;
    logFetchSummary(
      result,
      `startup is behind, refreshing its cursor in ${INITIAL_POLL_INTERVAL_MS / 1_000} seconds`,
      true,
    );
    await delay(INITIAL_POLL_INTERVAL_MS);

    const sequentialNextSequenceNumber = nextSequenceNumber;
    const refreshedSequenceNumber = await retryWithBackoff(
      "Refreshing the approximate latest match sequence number",
      () => fetchApproximateLatestSequenceNumber(apiKeys, rateLimits),
    );
    nextSequenceNumber = Math.max(
      sequentialNextSequenceNumber,
      refreshedSequenceNumber,
    );
    pollingStatus.nextSequenceNumber = nextSequenceNumber;

    if (nextSequenceNumber > sequentialNextSequenceNumber) {
      console.warn(
        `Startup skipped ahead by ${nextSequenceNumber - sequentialNextSequenceNumber} sequence numbers to ${nextSequenceNumber}.`,
      );
    } else {
      console.warn(
        `The refreshed approximate cursor was not ahead; startup will continue from ${nextSequenceNumber}.`,
      );
    }
  }

  let calmPollDelay = INITIAL_POLL_INTERVAL_MS;
  let waitBeforeNextFetch = calmPollDelay;
  let previousFetchCompletedAt = Date.now();
  let consecutiveFullPages = 0;

  while (true) {
    pollingStatus.nextPollDelayMs = waitBeforeNextFetch;
    await delay(waitBeforeNextFetch);

    const result = await fetchAndStoreMatchPage(
      database,
      apiKeys,
      rateLimits,
      nextSequenceNumber,
      "Valve match fetch",
    );
    const fetchCompletedAt = Date.now();
    const elapsedSincePreviousFetch =
      fetchCompletedAt - previousFetchCompletedAt;
    nextSequenceNumber = result.nextSequenceNumber;
    recordFetchResult(result);

    if (result.matchCount >= MATCHES_REQUESTED) {
      consecutiveFullPages += 1;
      pollingStatus.consecutiveFullPages = consecutiveFullPages;
      previousFetchCompletedAt = fetchCompletedAt;
      const shouldReduceDelay =
        consecutiveFullPages % FULL_PAGES_PER_DELAY_REDUCTION === 0;

      if (shouldReduceDelay) {
        calmPollDelay = reducePollDelayAfterSustainedFullPages(calmPollDelay);
        pollingStatus.isBehind = true;
        logFetchSummary(
          result,
          `behind after ${consecutiveFullPages} consecutive full pages, reduced the poll delay by 10% to ${(calmPollDelay / 1_000).toFixed(1)} seconds`,
          true,
        );
      } else {
        const pagesTowardNextReduction =
          consecutiveFullPages % FULL_PAGES_PER_DELAY_REDUCTION;
        const isSustainedBacklog =
          consecutiveFullPages >= FULL_PAGES_PER_DELAY_REDUCTION;
        pollingStatus.isBehind = isSustainedBacklog;
        logFetchSummary(
          result,
          isSustainedBacklog
            ? `still behind, ${pagesTowardNextReduction}/${FULL_PAGES_PER_DELAY_REDUCTION} full pages toward the next 10% reduction; poll delay remains ${(calmPollDelay / 1_000).toFixed(1)} seconds`
            : `full-page streak ${consecutiveFullPages}/${FULL_PAGES_PER_DELAY_REDUCTION}; poll delay remains ${(calmPollDelay / 1_000).toFixed(1)} seconds`,
          isSustainedBacklog,
        );
      }

      waitBeforeNextFetch = calmPollDelay;
      pollingStatus.nextPollDelayMs = calmPollDelay;
      continue;
    }

    if (consecutiveFullPages > 0) {
      const wasSustainedBacklog =
        consecutiveFullPages >= FULL_PAGES_PER_DELAY_REDUCTION;
      logFetchSummary(
        result,
        wasSustainedBacklog
          ? `caught up after ${consecutiveFullPages} consecutive full pages; next poll in ${(calmPollDelay / 1_000).toFixed(1)} seconds`
          : `full-page streak ended at ${consecutiveFullPages}/${FULL_PAGES_PER_DELAY_REDUCTION}; poll delay remains ${(calmPollDelay / 1_000).toFixed(1)} seconds`,
      );
    } else {
      calmPollDelay = calculateNextPollDelay(
        calmPollDelay,
        result.matchCount,
        elapsedSincePreviousFetch,
      );
      logFetchSummary(
        result,
        `next poll in ${(calmPollDelay / 1_000).toFixed(1)} seconds, target ${TARGET_MATCH_COUNT}`,
      );
    }

    consecutiveFullPages = 0;
    pollingStatus.consecutiveFullPages = 0;
    pollingStatus.isBehind = false;
    pollingStatus.nextPollDelayMs = calmPollDelay;
    waitBeforeNextFetch = calmPollDelay;
    previousFetchCompletedAt = fetchCompletedAt;
  }
}

async function startServer(): Promise<void> {
  const apiKeys = new ApiKeyRotator(
    parseApiKeys(process.env.STEAM_API_KEYS),
  );
  pollingStatus.apiKeyCount = apiKeys.count;
  const rateLimits = new RateLimitTracker(RATE_LIMIT_WINDOW_MS);
  const database = await connectToDatabase();

  try {
    await createDatabaseSchema(database);
  } catch (error: unknown) {
    await database.end().catch(() => undefined);
    throw new Error(
      `Could not create the PostgreSQL schema: ${formatError(error)}`,
      { cause: error },
    );
  }

  console.log("PostgreSQL schema is ready.");

  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        message: "Dota 2 match polling is running.",
        ...pollingStatus,
      }),
    );
  });

  let isStopping = false;
  let databaseClosePromise: Promise<void> | null = null;
  const closeDatabase = (): Promise<void> => {
    databaseClosePromise ??= database.end().catch((error: unknown) => {
      console.error(
        `Failed to close the PostgreSQL connection: ${formatError(error)}`,
      );
    });
    return databaseClosePromise;
  };
  const stopAfterFatalError = (
    description: string,
    error: unknown,
  ): void => {
    if (isStopping) {
      return;
    }

    isStopping = true;
    const formattedError = formatError(error);
    pollingStatus.phase = "failed";
    pollingStatus.lastError = `${description}: ${formattedError}`;
    console.error(
      `${description}: ${formattedError}. The server is shutting down because this error is not safely retryable.`,
    );
    process.exitCode = 1;

    if (server.listening) {
      server.close();
    }

    void closeDatabase();
  };

  server.on("close", () => void closeDatabase());
  server.on("error", (error: Error) =>
    stopAfterFatalError("HTTP server failure", error),
  );
  database.on("error", (error: Error) =>
    stopAfterFatalError("PostgreSQL connection failure", error),
  );

  server.listen(PORT, () => {
    console.log(
      `Dota data server listening on http://localhost:${PORT} with ${apiKeys.count} rotating API keys`,
    );
  });

  void pollForMatches(database, apiKeys, rateLimits).catch((error: unknown) =>
    stopAfterFatalError("Match polling stopped", error),
  );
}

startServer().catch((error: unknown) => {
  console.error(`Failed to start Dota data server: ${formatError(error)}`);
  process.exitCode = 1;
});
