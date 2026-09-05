import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { loadDatabaseSchemaDescription } from "../src/database-schema.js";

describe("loadDatabaseSchemaDescription", () => {
  it("loads and formats only server-side schema metadata", async () => {
    let queryValues: unknown[] | undefined;
    const database = {
      query: async (_query: string, values: unknown[]) => {
        queryValues = values;
        return {
          rows: [
            {
              table_name: "match_players",
              column_name: "match_id",
              data_type: "bigint",
              udt_name: "int8",
              is_nullable: "NO",
              ordinal_position: 1,
            },
            {
              table_name: "match_players",
              column_name: "hero_id",
              data_type: "smallint",
              udt_name: "int2",
              is_nullable: "YES",
              ordinal_position: 2,
            },
          ],
        };
      },
    } as unknown as Pool;

    const description = await loadDatabaseSchemaDescription(database, "public");

    assert.deepEqual(queryValues, ["public"]);
    assert.equal(
      description,
      'TABLE "public"."match_players"\n  - "match_id": bigint NOT NULL\n  - "hero_id": smallint',
    );
  });

  it("fails when the configured schema has no readable relations", async () => {
    const database = {
      query: async () => ({ rows: [] }),
    } as unknown as Pool;

    await assert.rejects(
      () => loadDatabaseSchemaDescription(database, "private"),
      /No readable tables or views/,
    );
  });

  it("describes analytics views and their database-owned semantics", async () => {
    const database = {
      query: async () => ({ rows: [{
        table_name: "player_item_results", table_type: "VIEW",
        relation_description: "One row per player-match and canonical item.",
        column_name: "item_id", data_type: "bigint", udt_name: "int8",
        is_nullable: "YES", ordinal_position: 1,
      }] }),
    } as unknown as Pool;
    const description = await loadDatabaseSchemaDescription(database, "analytics");
    assert.equal(description,
      'VIEW "analytics"."player_item_results"\n  Description: One row per player-match and canonical item.\n  - "item_id": bigint');
  });
});
