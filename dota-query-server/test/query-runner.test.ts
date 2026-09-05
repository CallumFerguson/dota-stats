import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pool, QueryArrayConfig, QueryArrayResult } from "pg";
import {
  DatabaseUnavailableError,
  MAX_QUERY_BYTES,
  MAX_RESULT_ROWS,
  QueryValidationError,
  runReadOnlyQuery,
} from "../src/query-runner.js";

type RecordedQuery = string | QueryArrayConfig;

function createFakeDatabase(
  options: { failQuery?: boolean; failRollback?: boolean } = {},
): {
  calls: RecordedQuery[];
  database: Pool;
  wasDestroyed: () => boolean;
} {
  const calls: RecordedQuery[] = [];
  let releaseArgument: Error | boolean | undefined;

  const client = {
    async query(input: string | QueryArrayConfig): Promise<unknown> {
      calls.push(input);

      if (input === "ROLLBACK" && options.failRollback === true) {
        throw new Error("connection lost during rollback");
      }

      if (typeof input !== "string" && input.rowMode === "array") {
        if (options.failQuery === true) {
          throw Object.assign(new Error("syntax error at or near bad"), {
            code: "42601",
          });
        }

        return {
          command: "SELECT",
          fields: [
            {
              columnID: 1,
              dataTypeID: 20,
              dataTypeModifier: -1,
              dataTypeSize: 8,
              format: "text",
              name: "match_id",
              tableID: 1,
            },
          ],
          rowCount: MAX_RESULT_ROWS + 1,
          rows: Array.from({ length: MAX_RESULT_ROWS + 1 }, (_, index) => [
            String(index + 1),
          ]),
        } satisfies QueryArrayResult<unknown[]>;
      }

      return { command: "SELECT", fields: [], rowCount: 0, rows: [] };
    },
    release(error?: Error | boolean): void {
      releaseArgument = error;
    },
  };

  return {
    calls,
    database: {
      connect: async () => client,
    } as unknown as Pool,
    wasDestroyed: () => releaseArgument === true,
  };
}

describe("runReadOnlyQuery", () => {
  it("runs a single wrapped statement in a read-only transaction and caps rows", async () => {
    const fake = createFakeDatabase();
    const result = await runReadOnlyQuery(
      fake.database,
      "SELECT match_id FROM matches;",
    );

    assert.equal(fake.calls[0], "BEGIN TRANSACTION READ ONLY");
    assert.equal(fake.calls[1], "SELECT set_config('statement_timeout', $1, true)");
    assert.deepEqual(fake.calls[2], {
      name: "dota_stats_read_only_query",
      text: `SELECT * FROM (\nSELECT match_id FROM matches\n) AS query_result\nLIMIT ${MAX_RESULT_ROWS + 1}`,
      rowMode: "array",
    });
    assert.equal(fake.calls[3], "ROLLBACK");
    const executedQuery = fake.calls[2] as QueryArrayConfig;
    assert.equal(result.sql, executedQuery.text);
    assert.equal(result.rowCount, MAX_RESULT_ROWS);
    assert.equal(result.rows.length, MAX_RESULT_ROWS);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.columns, [{ dataTypeId: 20, name: "match_id" }]);
    assert.equal(fake.wasDestroyed(), true);
  });

  it("rolls back and destroys the connection when PostgreSQL rejects a query", async () => {
    const fake = createFakeDatabase({ failQuery: true });

    await assert.rejects(
      () => runReadOnlyQuery(fake.database, "SELECT bad FROM matches"),
      /syntax error/,
    );
    assert.equal(fake.calls.at(-1), "ROLLBACK");
    assert.equal(fake.wasDestroyed(), true);
  });

  it("rejects empty input before opening a database connection", async () => {
    let connected = false;
    const database = {
      connect: async () => {
        connected = true;
        throw new Error("should not connect");
      },
    } as unknown as Pool;

    await assert.rejects(
      () => runReadOnlyQuery(database, "  ;  "),
      QueryValidationError,
    );
    assert.equal(connected, false);
  });

  it("rejects oversized input before opening a database connection", async () => {
    const fake = createFakeDatabase();

    await assert.rejects(
      () => runReadOnlyQuery(fake.database, "x".repeat(MAX_QUERY_BYTES + 1)),
      /must be no larger/,
    );
    assert.equal(fake.calls.length, 0);
  });

  it("rejects generated SQL that is not strictly read-only", async () => {
    const unsafeQueries = [
      "DELETE FROM matches",
      "WITH removed AS (DELETE FROM matches RETURNING *) SELECT * FROM removed",
      "SELECT * INTO copied_matches FROM matches",
      "SELECT * FROM matches FOR UPDATE",
      "SELECT nextval('match_sequence')",
      "SELECT 1; SELECT 2",
    ];

    for (const query of unsafeQueries) {
      const fake = createFakeDatabase();
      await assert.rejects(
        () => runReadOnlyQuery(fake.database, query),
        QueryValidationError,
      );
      assert.equal(fake.calls.length, 0);
    }
  });

  it("does not treat keywords inside strings or quoted identifiers as commands", async () => {
    const fake = createFakeDatabase();

    await runReadOnlyQuery(
      fake.database,
      `SELECT 'delete update' AS "drop"`,
    );

    assert.equal(fake.calls.length, 4);
  });

  it("wraps pool acquisition failures as database availability errors", async () => {
    const database = {
      connect: async () => {
        throw new Error("connection refused");
      },
    } as unknown as Pool;

    await assert.rejects(
      () => runReadOnlyQuery(database, "SELECT 1"),
      DatabaseUnavailableError,
    );
  });

  it("destroys the connection when rollback fails", async () => {
    const fake = createFakeDatabase({ failQuery: true, failRollback: true });

    await assert.rejects(
      () => runReadOnlyQuery(fake.database, "SELECT bad"),
      /could not be rolled back/,
    );
    assert.equal(fake.wasDestroyed(), true);
  });
});
