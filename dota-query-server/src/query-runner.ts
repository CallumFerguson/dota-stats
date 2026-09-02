import type { Pool } from "pg";

export const MAX_RESULT_ROWS = 1_000;
export const MAX_QUERY_BYTES = 50_000;
export const QUERY_TIMEOUT_MS = 10_000;
const QUERY_PREPARED_STATEMENT_NAME = "dota_stats_read_only_query";

export interface QueryColumn {
  dataTypeId: number;
  name: string;
}

export interface QueryResponse {
  columns: QueryColumn[];
  command: string;
  durationMs: number;
  rowCount: number;
  rows: unknown[][];
  truncated: boolean;
}

export class QueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryValidationError";
  }
}

export class DatabaseUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DatabaseUnavailableError";
  }
}

function normalizeQuery(query: string): string {
  const normalizedQuery = query.trim().replace(/;\s*$/, "").trim();

  if (normalizedQuery.length === 0) {
    throw new QueryValidationError("SQL query is required.");
  }

  if (Buffer.byteLength(normalizedQuery, "utf8") > MAX_QUERY_BYTES) {
    throw new QueryValidationError(
      `SQL query must be no larger than ${MAX_QUERY_BYTES} bytes.`,
    );
  }

  return normalizedQuery;
}

function wrapQuery(query: string): string {
  return `SELECT * FROM (\n${query}\n) AS query_result\nLIMIT ${MAX_RESULT_ROWS + 1}`;
}

export async function runReadOnlyQuery(
  database: Pool,
  query: string,
): Promise<QueryResponse> {
  const normalizedQuery = normalizeQuery(query);
  let client;

  try {
    client = await database.connect();
  } catch (error: unknown) {
    throw new DatabaseUnavailableError(
      "Could not acquire a PostgreSQL connection.",
      { cause: error },
    );
  }

  const startedAt = performance.now();
  let transactionStarted = false;

  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    transactionStarted = true;
    await client.query("SELECT set_config('statement_timeout', $1, true)", [
      `${QUERY_TIMEOUT_MS}ms`,
    ]);

    const result = await client.query<unknown[]>({
      name: QUERY_PREPARED_STATEMENT_NAME,
      text: wrapQuery(normalizedQuery),
      rowMode: "array",
    });
    const truncated = result.rows.length > MAX_RESULT_ROWS;
    const rows = truncated ? result.rows.slice(0, MAX_RESULT_ROWS) : result.rows;

    await client.query("ROLLBACK");
    transactionStarted = false;

    return {
      columns: result.fields.map((field) => ({
        dataTypeId: field.dataTypeID,
        name: field.name,
      })),
      command: result.command,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      rowCount: rows.length,
      rows,
      truncated,
    };
  } catch (error: unknown) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError: unknown) {
        throw new AggregateError(
          [error, rollbackError],
          "The query failed and its read-only transaction could not be rolled back.",
        );
      }
    }

    throw error;
  } finally {
    // A SELECT can change session-level state, such as advisory locks, even
    // when its transaction is rolled back. Never return that state to the pool.
    client.release(true);
  }
}
