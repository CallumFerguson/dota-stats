import dotenv from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const MATCH_HISTORY_ENDPOINT =
  "https://api.steampowered.com/IDOTA2Match_570/GetMatchHistory/v1/";
const MATCH_SEQUENCE_ENDPOINT =
  "https://api.steampowered.com/IDOTA2Match_570/GetMatchHistoryBySequenceNum/v1/";

interface MatchWithSequenceNumber {
  match_seq_num?: number;
}

interface MatchApiResponse {
  result?: {
    matches?: MatchWithSequenceNumber[];
  };
}

type PollingPhase = "starting" | "catching-up" | "caught-up";

interface PollingStatus {
  apiKeyCount: number;
  consecutiveFailures: number;
  consecutiveFullPages: number;
  isBehind: boolean;
  latestMatchCount: number | null;
  latestOutputPath: string | null;
  nextPollDelayMs: number;
  nextSequenceNumber: number | null;
  phase: PollingPhase;
}

const pollingStatus: PollingStatus = {
  apiKeyCount: 0,
  consecutiveFailures: 0,
  consecutiveFullPages: 0,
  isBehind: false,
  latestMatchCount: null,
  latestOutputPath: null,
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
    throw new ValveApiError(
      `Valve API request failed: ${response.status} ${response.statusText}`,
      response.status,
      parseRetryAfter(response.headers.get("retry-after")),
    );
  }

  return (await response.json()) as MatchApiResponse;
}

function getMatches(matchData: MatchApiResponse): MatchWithSequenceNumber[] {
  const matches = matchData.result?.matches;

  if (!Array.isArray(matches)) {
    throw new Error("Valve API response did not contain a matches array.");
  }

  return matches;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
): Promise<T> {
  let failureCount = 0;

  while (true) {
    try {
      const result = await operation();
      pollingStatus.consecutiveFailures = 0;
      return result;
    } catch (error: unknown) {
      failureCount += 1;
      pollingStatus.consecutiveFailures = failureCount;
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
        `${description} failed: ${getErrorMessage(error)}. Retrying in ${(retryDelay / 1_000).toFixed(1)} seconds${retryReason}.`,
      );
      await delay(retryDelay);
    }
  }
}

async function fetchApproximateLatestSequenceNumber(
  apiKeys: ApiKeyRotator,
): Promise<number> {
  const requestUrl = new URL(MATCH_HISTORY_ENDPOINT);
  requestUrl.searchParams.set(
    "matches_requested",
    String(MATCHES_REQUESTED),
  );

  const matchData = await fetchJson(requestUrl, apiKeys);
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

async function fetchAndSaveMatches(
  apiKeys: ApiKeyRotator,
  startSequenceNumber: number,
): Promise<{ matchCount: number; nextSequenceNumber: number; outputPath: string }> {
  const requestUrl = new URL(MATCH_SEQUENCE_ENDPOINT);
  requestUrl.searchParams.set(
    "start_at_match_seq_num",
    String(startSequenceNumber),
  );
  requestUrl.searchParams.set("matches_requested", String(MATCHES_REQUESTED));

  const matchData = await fetchJson(requestUrl, apiKeys);
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
  const dataDirectory = path.join(projectDirectory, "data");
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const outputPath = path.join(
    dataDirectory,
    `matches-seq-${startSequenceNumber}-${timestamp}.json`,
  );

  await mkdir(dataDirectory, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(matchData, null, 2)}\n`, "utf8");

  return { matchCount: matches.length, nextSequenceNumber, outputPath };
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
    outputPath: string;
  },
): void {
  pollingStatus.latestMatchCount = result.matchCount;
  pollingStatus.latestOutputPath = result.outputPath;
  pollingStatus.nextSequenceNumber = result.nextSequenceNumber;
}

function logFetchSummary(
  result: { matchCount: number; outputPath: string },
  detail: string,
  warning = false,
): void {
  const relativeOutputPath = path.relative(projectDirectory, result.outputPath);
  const message = `Fetched ${result.matchCount} matches; ${detail}; saved ${relativeOutputPath}.`;

  if (warning) {
    console.warn(message);
  } else {
    console.log(message);
  }
}

async function pollForMatches(apiKeys: ApiKeyRotator): Promise<never> {
  let nextSequenceNumber = await retryWithBackoff(
    "Finding an approximate latest match sequence number",
    () => fetchApproximateLatestSequenceNumber(apiKeys),
  );
  pollingStatus.nextSequenceNumber = nextSequenceNumber;
  pollingStatus.phase = "catching-up";
  console.log(`Approximate latest match sequence number: ${nextSequenceNumber}`);

  while (true) {
    const result = await retryWithBackoff("Startup match fetch", () =>
      fetchAndSaveMatches(apiKeys, nextSequenceNumber),
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
      () => fetchApproximateLatestSequenceNumber(apiKeys),
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

    const result = await retryWithBackoff("Match fetch", () =>
      fetchAndSaveMatches(apiKeys, nextSequenceNumber),
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

function startServer(): void {
  const apiKeys = new ApiKeyRotator(
    parseApiKeys(process.env.STEAM_API_KEYS),
  );
  pollingStatus.apiKeyCount = apiKeys.count;

  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        message: "Dota 2 match polling is running.",
        ...pollingStatus,
      }),
    );
  });

  server.listen(PORT, () => {
    console.log(
      `Dota data server listening on http://localhost:${PORT} with ${apiKeys.count} rotating API keys`,
    );
  });

  void pollForMatches(apiKeys);
}

try {
  startServer();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start Dota data server: ${message}`);
  process.exitCode = 1;
}
