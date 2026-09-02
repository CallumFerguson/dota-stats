import dotenv from "dotenv";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { loadConfig } from "./config.js";
import {
  DatabaseUnavailableError,
  QUERY_TIMEOUT_MS,
  QueryValidationError,
  runReadOnlyQuery,
} from "./query-runner.js";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(sourceDirectory, "..");

dotenv.config({ path: path.join(projectDirectory, ".env"), quiet: true });

const MAX_REQUEST_BODY_BYTES = 64_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getPostgresErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }

  const code = error.code;
  return typeof code === "string" ? code : null;
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();

  if (contentType !== "application/json") {
    throw new HttpError(415, "Content-Type must be application/json.");
  }

  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  let isTooLarge = false;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += buffer.length;

    if (receivedBytes > MAX_REQUEST_BODY_BYTES) {
      isTooLarge = true;
      chunks.length = 0;
      continue;
    }

    if (!isTooLarge) {
      chunks.push(buffer);
    }
  }

  if (isTooLarge) {
    throw new HttpError(
      413,
      `Request body must be no larger than ${MAX_REQUEST_BODY_BYTES} bytes.`,
    );
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "Request body must contain valid JSON.");
  }
}

function getQuery(body: unknown): string {
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    !("query" in body) ||
    typeof body.query !== "string"
  ) {
    throw new HttpError(
      400,
      'Request body must be an object with a string "query" field.',
    );
  }

  return body.query;
}

function getQueryErrorResponse(error: unknown): {
  message: string;
  status: number;
} {
  if (error instanceof HttpError || error instanceof QueryValidationError) {
    return {
      message: error.message,
      status: error instanceof HttpError ? error.status : 400,
    };
  }

  if (error instanceof DatabaseUnavailableError) {
    return { message: "Database is unavailable.", status: 503 };
  }

  const postgresCode = getPostgresErrorCode(error);

  if (postgresCode === "57014") {
    return {
      message: `Query exceeded the ${QUERY_TIMEOUT_MS / 1_000}-second execution limit.`,
      status: 408,
    };
  }

  if (
    postgresCode?.startsWith("08") === true ||
    [
      "57P01",
      "57P02",
      "57P03",
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ENOTFOUND",
      "EPIPE",
      "ETIMEDOUT",
    ].includes(postgresCode ?? "")
  ) {
    return { message: "Database is unavailable.", status: 503 };
  }

  if (postgresCode !== null) {
    return { message: getErrorMessage(error), status: 400 };
  }

  return { message: "Unexpected server error.", status: 500 };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  database: Pool,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "GET" && requestUrl.pathname === "/api/health") {
    try {
      await database.query("SELECT 1");
      sendJson(response, 200, { status: "ok" });
    } catch (error: unknown) {
      console.error(`Database health check failed: ${getErrorMessage(error)}`);
      sendJson(response, 503, { error: "Database is unavailable." });
    }
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/query") {
    try {
      const query = getQuery(await readJsonBody(request));
      const result = await runReadOnlyQuery(database, query);
      sendJson(response, 200, result);
    } catch (error: unknown) {
      const errorResponse = getQueryErrorResponse(error);

      if (errorResponse.status >= 500) {
        console.error(`Query request failed: ${getErrorMessage(error)}`);
      }

      sendJson(response, errorResponse.status, { error: errorResponse.message });
    }
    return;
  }

  sendJson(response, 404, { error: "Not found." });
}

async function startServer(): Promise<void> {
  const config = loadConfig();
  const database = new Pool(config.database);

  database.on("error", (error: Error) => {
    console.error(`Unexpected PostgreSQL pool error: ${getErrorMessage(error)}`);
  });

  try {
    const readOnlySetting = await database.query<{
      default_transaction_read_only: string;
    }>("SHOW default_transaction_read_only");

    if (readOnlySetting.rows[0]?.default_transaction_read_only !== "on") {
      throw new Error("PostgreSQL session is not configured as read-only.");
    }
  } catch (error: unknown) {
    await database.end().catch(() => undefined);
    throw new Error(`Could not connect to PostgreSQL: ${getErrorMessage(error)}`, {
      cause: error,
    });
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response, database).catch((error: unknown) => {
      console.error(`HTTP request failed: ${getErrorMessage(error)}`);

      if (!response.headersSent) {
        sendJson(response, 500, { error: "Unexpected server error." });
      } else {
        response.end();
      }
    });
  });

  let isStopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (isStopping) {
      return;
    }

    isStopping = true;
    console.log(`Received ${signal}; shutting down.`);
    server.close(() => {
      void database.end().finally(() => {
        process.exitCode = 0;
      });
    });
  };

  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  try {
    await new Promise<void>((resolve, reject) => {
      const handleListenError = (error: Error): void => reject(error);
      server.once("error", handleListenError);
      server.listen(config.port, config.host, () => {
        server.off("error", handleListenError);
        resolve();
      });
    });
  } catch (error: unknown) {
    await database.end().catch(() => undefined);
    throw new Error(`Could not start the HTTP server: ${getErrorMessage(error)}`, {
      cause: error,
    });
  }

  server.on("error", (error: Error) => {
    console.error(`HTTP server failure: ${getErrorMessage(error)}`);
    process.exitCode = 1;

    if (server.listening) {
      server.close();
    }

    void database.end();
  });

  console.log(
    `Dota query server listening on http://${config.host}:${config.port}`,
  );
}

startServer().catch((error: unknown) => {
  console.error(`Failed to start Dota query server: ${getErrorMessage(error)}`);
  process.exitCode = 1;
});
