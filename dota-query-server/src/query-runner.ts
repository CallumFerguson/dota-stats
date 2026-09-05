import type { Pool } from "pg";

export const MAX_RESULT_ROWS = 1_000;
export const MAX_QUERY_BYTES = 50_000;
export const QUERY_TIMEOUT_MS = 10_000;
const QUERY_PREPARED_STATEMENT_NAME = "dota_stats_read_only_query";
const FORBIDDEN_SQL_KEYWORDS = new Set([
  "alter",
  "analyze",
  "call",
  "checkpoint",
  "cluster",
  "comment",
  "commit",
  "copy",
  "create",
  "deallocate",
  "declare",
  "delete",
  "discard",
  "do",
  "drop",
  "execute",
  "explain",
  "grant",
  "insert",
  "listen",
  "load",
  "lock",
  "merge",
  "move",
  "notify",
  "prepare",
  "reassign",
  "refresh",
  "reindex",
  "release",
  "reset",
  "revoke",
  "rollback",
  "savepoint",
  "set",
  "start",
  "truncate",
  "unlisten",
  "update",
  "vacuum",
]);
const FORBIDDEN_SQL_FUNCTIONS = new Set([
  "lo_export",
  "lo_import",
  "nextval",
  "pg_advisory_lock",
  "pg_advisory_lock_shared",
  "pg_advisory_unlock",
  "pg_advisory_unlock_all",
  "pg_advisory_unlock_shared",
  "pg_advisory_xact_lock",
  "pg_advisory_xact_lock_shared",
  "pg_notify",
  "setval",
]);

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
  sql: string;
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

function tokenizeSql(query: string): string[] {
  const tokens: string[] = [];
  let index = 0;

  while (index < query.length) {
    const character = query[index];
    const nextCharacter = query[index + 1];

    if (/\s/.test(character)) {
      index += 1;
      continue;
    }

    if (character === "-" && nextCharacter === "-") {
      index += 2;
      while (index < query.length && query[index] !== "\n") {
        index += 1;
      }
      continue;
    }

    if (character === "/" && nextCharacter === "*") {
      let depth = 1;
      index += 2;

      while (index < query.length && depth > 0) {
        if (query[index] === "/" && query[index + 1] === "*") {
          depth += 1;
          index += 2;
        } else if (query[index] === "*" && query[index + 1] === "/") {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      continue;
    }

    if (character === "'") {
      index += 1;
      while (index < query.length) {
        if (query[index] === "'" && query[index + 1] === "'") {
          index += 2;
        } else if (query[index] === "'") {
          index += 1;
          break;
        } else if (query[index] === "\\") {
          index += 2;
        } else {
          index += 1;
        }
      }
      continue;
    }

    if (character === '"') {
      index += 1;
      while (index < query.length) {
        if (query[index] === '"' && query[index + 1] === '"') {
          index += 2;
        } else if (query[index] === '"') {
          index += 1;
          break;
        } else {
          index += 1;
        }
      }
      continue;
    }

    if (character === "$") {
      const delimiterMatch = query.slice(index).match(/^\$[A-Za-z_0-9]*\$/);

      if (delimiterMatch !== null) {
        const delimiter = delimiterMatch[0];
        const closingIndex = query.indexOf(delimiter, index + delimiter.length);
        index = closingIndex < 0 ? query.length : closingIndex + delimiter.length;
        continue;
      }
    }

    const wordMatch = query.slice(index).match(/^[A-Za-z_][A-Za-z_0-9$]*/);

    if (wordMatch !== null) {
      tokens.push(wordMatch[0].toLowerCase());
      index += wordMatch[0].length;
      continue;
    }

    tokens.push(character);
    index += 1;
  }

  return tokens;
}

function assertReadOnlyQuery(query: string): void {
  const tokens = tokenizeSql(query);
  const firstToken = tokens[0];

  if (firstToken !== "select" && firstToken !== "with") {
    throw new QueryValidationError(
      "Generated SQL must be a SELECT statement.",
    );
  }

  if (tokens.includes(";")) {
    throw new QueryValidationError(
      "Generated SQL must contain exactly one statement.",
    );
  }

  for (const token of tokens) {
    if (FORBIDDEN_SQL_KEYWORDS.has(token)) {
      throw new QueryValidationError(
        `Generated SQL contains the forbidden keyword ${token.toUpperCase()}.`,
      );
    }

    if (FORBIDDEN_SQL_FUNCTIONS.has(token)) {
      throw new QueryValidationError(
        `Generated SQL contains the state-changing function ${token}().`,
      );
    }
  }

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === "into") {
      throw new QueryValidationError("Generated SQL cannot use SELECT INTO.");
    }

    if (
      tokens[index] === "for" &&
      (tokens[index + 1] === "update" ||
        tokens[index + 1] === "share" ||
        (tokens[index + 1] === "no" &&
          tokens[index + 2] === "key" &&
          tokens[index + 3] === "update") ||
        (tokens[index + 1] === "key" && tokens[index + 2] === "share"))
    ) {
      throw new QueryValidationError(
        "Generated SQL cannot acquire row locks.",
      );
    }
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

  assertReadOnlyQuery(normalizedQuery);

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
  const sql = wrapQuery(normalizedQuery);
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
      text: sql,
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
      sql,
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
