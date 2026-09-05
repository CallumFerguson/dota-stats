import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Client } from "pg";
import { createDatabaseSchema } from "../src/database-schema.js";
import { storeMatches } from "../src/match-storage.js";

interface QueryCall {
  text: string;
  values?: unknown[];
}

function createRecordingDatabase(): {
  calls: QueryCall[];
  database: Client;
} {
  const calls: QueryCall[] = [];
  const database = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      return { rows: [] };
    },
  } as unknown as Client;

  return { calls, database };
}

describe("Dota match integer storage", () => {
  it("uses BIGINT for every integer column supplied by Valve", async () => {
    const { calls, database } = createRecordingDatabase();

    await createDatabaseSchema(database);

    assert.equal(calls.length, 4);
    assert.match(calls[1].text, /gold_per_min BIGINT/);
    assert.doesNotMatch(calls[1].text, /\b(?:SMALLINT|INTEGER)\b/);
  });

  it("stores values beyond SMALLINT and INTEGER ranges", async () => {
    const { calls, database } = createRecordingDatabase();

    await storeMatches(database, [
      {
        match_id: 8_979_618_081,
        match_seq_num: 8_000_000_000,
        flags: 4_294_967_295,
        players: [
          {
            player_slot: 130,
            gold_per_min: 64_651,
            hero_damage: Number.MAX_SAFE_INTEGER,
          },
        ],
      },
    ]);

    assert.deepEqual(
      calls.map((call) => call.text.trim().split("\n", 1)[0]),
      ["BEGIN", "INSERT INTO matches (", "INSERT INTO match_players (",
        "INSERT INTO items (item_id, item_name, item_category, canonical_item_id)",
        "INSERT INTO match_player_items (match_id, player_slot, item_id, observed_held, upgrade_reported)", "COMMIT"],
    );
    assert.doesNotMatch(calls[1].text, /\b(?:SMALLINT|INTEGER)\b/);
    assert.doesNotMatch(calls[2].text, /\b(?:SMALLINT|INTEGER)\b/);

    const playerRows = JSON.parse(String(calls[2].values?.[0])) as Array<{
      gold_per_min: number;
      hero_damage: number;
    }>;
    assert.equal(playerRows[0].gold_per_min, 64_651);
    assert.equal(playerRows[0].hero_damage, Number.MAX_SAFE_INTEGER);
  });
});
