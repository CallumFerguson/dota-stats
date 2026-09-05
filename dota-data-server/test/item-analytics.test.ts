import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Client, Pool } from "pg";
import { createDatabaseSchema } from "../src/database-schema.js";
import { storeMatches, type DotaMatch, type DotaMatchPlayer } from "../src/match-storage.js";
import { loadDatabaseSchemaDescription } from "../../dota-query-server/src/database-schema.js";
import { loadEntityResolver } from "../../dota-query-server/src/entity-resolver.js";

// Execute the application's SQL in an isolated, in-memory PostgreSQL engine.
// No environment configuration, credentials, network, or developer DB is used.
const postgres = new PGlite();
const database = {
  query: async (sql: string, values?: unknown[]) => values === undefined
    ? (await postgres.exec(sql)).at(-1)
    : postgres.query(sql, values),
} as unknown as Client;

function player(overrides: Partial<DotaMatchPlayer> = {}): DotaMatchPlayer {
  return {
    player_slot: 0, hero_id: 1, leaver_status: 0,
    item_0: 0, item_1: 0, item_2: 0, item_3: 0, item_4: 0, item_5: 0,
    backpack_0: 0, backpack_1: 0, backpack_2: 0, item_neutral: 0, item_neutral2: 0,
    aghanims_scepter: 0, aghanims_shard: 0, moonshard: 0,
    ...overrides,
  };
}

function match(players: DotaMatchPlayer[], overrides: Partial<DotaMatch> = {}): DotaMatch {
  return {
    match_id: 1, match_seq_num: 1, radiant_win: true,
    start_time: Math.floor(Date.now() / 1_000), game_mode: 22, lobby_type: 7,
    players, ...overrides,
  };
}

describe("normalized item analytics (PostgreSQL)", () => {
  before(async () => { await createDatabaseSchema(database); });
  beforeEach(async () => { await postgres.exec("TRUNCATE matches CASCADE"); });
  after(async () => { await postgres.close(); });

  it("seeds and resolves real reference names, canonical items, and ambiguous aliases", async () => {
    const resolve = await loadEntityResolver(database as unknown as Pool, "public");
    assert.deepEqual(resolve("what is battle fury's win rate on anti mage in turbo?").resolved.map((entity) => [entity.kind, entity.ids]),
      [["item", [145]], ["hero", [1]], ["game_mode", [23]]]);
    assert.deepEqual(resolve("BKB on AM in ranked All Pick").resolved.map((entity) => entity.ids),
      [[116], [1], [7], [1, 22]]);
    assert.deepEqual(resolve("Aghanim's Blessing").resolved[0].ids, [108]);
    assert.deepEqual(resolve("ES").ambiguous[0].candidates.map((entity) => entity.name).sort(), ["Earth Spirit", "Earthshaker"]);
    assert.deepEqual(resolve("Battle Fury Recipe").resolved[0].ids, [144]);
  });

  it("answers Battle Fury on Anti-Mage in Turbo with catalog-derived filters", async () => {
    await storeMatches(database, [
      match([player({ item_0: 145, item_1: 145 }), player({ player_slot: 128, backpack_0: 145 }),
        player({ player_slot: 1, hero_id: 2, item_0: 145 }), player({ player_slot: 2 })], { game_mode: 23 }),
      match([player({ item_0: 145 })], { match_id: 2, match_seq_num: 2, game_mode: 22 }),
    ]);
    const resolve = await loadEntityResolver(database as unknown as Pool, "public");
    const { resolved } = resolve("battle fury's win rate on anti mage in turbo");
    const id = (kind: string) => resolved.find((entity) => entity.kind === kind)!.ids[0];
    const { rows } = await postgres.query<{ games: number; win_rate: string; hero_name: string; item_name: string }>(`
      SELECT h.hero_name, pir.item_name, COUNT(*) AS games,
        ROUND(100.0 * AVG(pir.won::int), 2) AS win_rate
      FROM player_item_results pir LEFT JOIN heroes h USING (hero_id)
      WHERE pir.item_id = $1 AND pir.hero_id = $2 AND pir.game_mode = $3
        AND pir.won IS NOT NULL AND pir.start_time >= NOW() - INTERVAL '30 days'
      GROUP BY h.hero_name, pir.item_name
    `, [id("item"), id("hero"), id("game_mode")]);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].games), 2);
    assert.equal(Number(rows[0].win_rate), 50);
    assert.equal(rows[0].hero_name, "Anti-Mage");
    assert.equal(rows[0].item_name, "Battle Fury");
  });

  it("combines backpacks, duplicates, aliases, upgrades, and both neutral slots", async () => {
    await storeMatches(database, [match([player({
      item_0: 108, item_1: 271, item_2: 727, item_3: 247, item_4: 247, item_5: 725,
      backpack_0: 609, backpack_1: 1, backpack_2: 1,
      item_neutral: 565, item_neutral2: 1576,
      aghanims_scepter: 1, aghanims_shard: 1, moonshard: 1,
    })])]);
    const { rows } = await postgres.query<{ item_id: number; item_name: string; item_category: string; observed_held: boolean; upgrade_reported: boolean | null }>(
      "SELECT item_id, item_name, item_category, observed_held, upgrade_reported FROM player_item_results ORDER BY item_id",
    );
    assert.deepEqual(rows.map((r) => Number(r.item_id)), [1, 108, 247, 565, 609, 1576]);
    assert.ok(rows.every((r) => r.observed_held));
    assert.deepEqual(rows.filter((r) => r.upgrade_reported).map((r) => r.item_name),
      ["Aghanim's Scepter", "Moon Shard", "Aghanim's Shard"]);
    assert.equal(rows[3].item_category, "neutral_artifact");
    assert.equal(rows[5].item_category, "neutral_enchantment");
    assert.equal(rows[0].upgrade_reported, null);
  });

  it("records upgrade-only recipients and preserves missing flags as unknown", async () => {
    await storeMatches(database, [match([
      player({ aghanims_scepter: 1, aghanims_shard: 1, moonshard: 1 }),
      player({ player_slot: 1 }),
      player({ player_slot: 2, aghanims_scepter: null, aghanims_shard: undefined, moonshard: null }),
      player({ player_slot: 3, item_0: 108, aghanims_scepter: null }),
    ])]);
    const { rows } = await postgres.query<{ player_slot: number; observed_held: boolean; upgrade_reported: boolean | null }>(
      "SELECT player_slot, observed_held, upgrade_reported FROM player_item_results ORDER BY player_slot, item_id",
    );
    assert.equal(rows.length, 4);
    assert.ok(rows.slice(0, 3).every((r) => Number(r.player_slot) === 0 && !r.observed_held && r.upgrade_reported));
    assert.equal(rows[3].observed_held, true);
    assert.equal(rows[3].upgrade_reported, null);
  });

  it("keeps recipes separate and preserves unknown IDs without a catalog lookup loss", async () => {
    await storeMatches(database, [match([player({ item_0: 270, item_1: 108,
      backpack_0: Number.MAX_SAFE_INTEGER, item_neutral: Number.MAX_SAFE_INTEGER })])]);
    const { rows } = await postgres.query<{ item_id: number; item_category: string }>(
      "SELECT item_id, item_category FROM player_item_results ORDER BY item_id",
    );
    assert.deepEqual(rows.map((r) => Number(r.item_id)), [108, 270, Number.MAX_SAFE_INTEGER]);
    assert.deepEqual(rows.map((r) => r.item_category), ["regular", "recipe", "unknown"]);
  });

  it("does not merge distinct neutral IDs even when they have similar names", async () => {
    await storeMatches(database, [match([player({ backpack_0: 565, item_neutral: 565, item_neutral2: 1576, item_0: 1577 })])]);
    const { rows } = await postgres.query<{ item_id: number }>("SELECT item_id FROM player_item_results ORDER BY item_id");
    assert.deepEqual(rows.map((r) => Number(r.item_id)), [565, 1576, 1577]);
  });

  it("centralizes both sides, abandoner losses, and unknown outcomes", async () => {
    await storeMatches(database, [match([
      player({ item_0: 1 }),
      player({ player_slot: 128, item_0: 1 }),
      player({ player_slot: 1, item_0: 1, leaver_status: 2 }),
      player({ player_slot: 2, item_0: 1, leaver_status: undefined }),
      player({ player_slot: 3, item_0: 1, leaver_status: 99 }),
      player({ player_slot: 999, item_0: 1 }),
    ]), match([player({ item_0: 1, leaver_status: 2 })], { match_id: 2, match_seq_num: 2, radiant_win: undefined })]);
    const { rows } = await postgres.query<{ team_won: boolean | null; won: boolean | null }>(
      "SELECT team_won, won FROM player_item_results ORDER BY match_id, player_slot",
    );
    assert.deepEqual(rows, [
      { team_won: true, won: true }, { team_won: true, won: false },
      { team_won: true, won: null }, { team_won: true, won: null },
      { team_won: false, won: false }, { team_won: null, won: null },
      { team_won: null, won: null },
    ]);
    const result = await postgres.query<{ appearances: number; win_rate: string }>(
      "SELECT COUNT(*) AS appearances, ROUND(100.0 * AVG(won::int), 2) AS win_rate FROM player_item_results WHERE won IS NOT NULL",
    );
    assert.equal(Number(result.rows[0].appearances), 3);
    assert.equal(Number(result.rows[0].win_rate), 33.33);
  });

  it("exposes team sides at slot boundaries independently of winner and leaver status", async () => {
    const slots = [-1, 0, 4, 5, 127, 128, 132, 133];
    await storeMatches(database, [match(slots.map((player_slot) =>
      player({ player_slot, item_0: 1, leaver_status: 2 })), { radiant_win: undefined })]);
    for (const view of ["player_results", "player_item_results"]) {
      const { rows } = await postgres.query(`SELECT team_side, team_won, won FROM ${view} ORDER BY player_slot`);
      assert.deepEqual(rows, [null, "radiant", "radiant", null, null, "dire", "dire", null]
        .map((team_side) => ({ team_side, team_won: null, won: null })));
    }
    const schema = await loadDatabaseSchemaDescription(database as unknown as Pool, "public");
    assert.equal((schema.match(/"team_side": text/g) ?? []).length, 2);
    assert.match(schema, /Compare known team_side values within the same match/);
  });

  it("compares enemy Axe presence without confusing personal losses or multiplying appearances", async () => {
    await storeMatches(database, [
      match([player(), player({ player_slot: 128, hero_id: 2 }), player({ player_slot: 129, hero_id: 2 })]),
      match([player({ leaver_status: 2 }), player({ player_slot: 128, hero_id: 2 })], { match_id: 2, match_seq_num: 2 }),
      match([player({ player_slot: 128 }), player({ hero_id: 2, leaver_status: 2 })], { match_id: 3, match_seq_num: 3 }),
      match([player(), player({ player_slot: 1, hero_id: 2 })], { match_id: 4, match_seq_num: 4 }),
      match([player()], { match_id: 5, match_seq_num: 5, radiant_win: false }),
    ]);
    const { rows } = await postgres.query<{ enemy_axe: boolean; appearances: number; wins: number; win_rate: string }>(`
      WITH appearances AS (
        SELECT am.won, EXISTS (
          SELECT 1 FROM player_results axe
          WHERE axe.match_id = am.match_id AND axe.hero_id = 2
            AND axe.team_side <> am.team_side
        ) AS enemy_axe
        FROM player_results am
        WHERE am.hero_id = 1 AND am.won IS NOT NULL AND am.team_side IS NOT NULL
          AND am.start_time >= CURRENT_TIMESTAMP - INTERVAL '30 days'
      )
      SELECT enemy_axe, COUNT(*) AS appearances, COUNT(*) FILTER (WHERE won) AS wins,
        ROUND(100.0 * AVG(won::int), 2) AS win_rate
      FROM appearances GROUP BY enemy_axe ORDER BY enemy_axe DESC
    `);
    assert.deepEqual(rows.map((row) => ({ ...row, appearances: Number(row.appearances), wins: Number(row.wins) })), [
      { enemy_axe: true, appearances: 3, wins: 1, win_rate: "33.33" },
      { enemy_axe: false, appearances: 2, wins: 1, win_rate: "50.00" },
    ]);
    const allies = await postgres.query<{ match_id: number }>(`
      SELECT am.match_id FROM player_results am
      WHERE am.hero_id = 1 AND EXISTS (
        SELECT 1 FROM player_results axe WHERE axe.match_id = am.match_id
          AND axe.player_slot <> am.player_slot AND axe.hero_id = 2 AND axe.team_side = am.team_side
      )
    `);
    assert.deepEqual(allies.rows.map((row) => Number(row.match_id)), [4]);
  });

  it("keeps repeat ingestion consistent with the original persisted snapshots", async () => {
    await storeMatches(database, [match([player({ item_0: 1 })])]);
    await storeMatches(database, [match([player({ item_0: 116, aghanims_scepter: 1 })])]);
    const { rows } = await postgres.query<{ item_id: number }>("SELECT item_id FROM player_item_results");
    assert.deepEqual(rows.map((r) => Number(r.item_id)), [1]);
    await postgres.exec("DELETE FROM matches WHERE match_id = 1");
    assert.equal((await postgres.query("SELECT * FROM match_player_items")).rows.length, 0);
  });

  it("rolls back matches, players, and unknown catalog entries when normalization fails", async () => {
    const failingDatabase = { query: async (sql: string, values?: unknown[]) => {
      if (sql.includes("INSERT INTO match_player_items")) throw new Error("simulated item write failure");
      return database.query(sql, values);
    } } as unknown as Client;
    await assert.rejects(() => storeMatches(failingDatabase, [match([player({ item_0: 987654321 })])]), /simulated item write failure/);
    assert.equal((await postgres.query("SELECT * FROM matches")).rows.length, 0);
    assert.equal((await postgres.query("SELECT * FROM match_players")).rows.length, 0);
    assert.equal((await postgres.query("SELECT * FROM items WHERE item_id = 987654321")).rows.length, 0);
    await storeMatches(database, [match([player({ item_0: 987654321 })])]);
    assert.equal((await postgres.query("SELECT * FROM player_item_results")).rows.length, 1);
  });

  it("uses complete player snapshots, including empty inventories, as the use-rate population", async () => {
    await storeMatches(database, [match([
      player({ item_0: 1 }), player({ player_slot: 128 }),
      player({ player_slot: 1, item_0: 1, backpack_0: undefined }),
    ])]);
    const { rows } = await postgres.query<{ use_rate: string }>(`
      SELECT 100.0 * COUNT(*) / NULLIF((
        SELECT COUNT(*) FROM player_results WHERE item_snapshot_complete AND won IS NOT NULL
      ), 0) AS use_rate
      FROM player_item_results
      WHERE item_id = 1 AND item_snapshot_complete AND won IS NOT NULL
    `);
    assert.equal(Number(rows[0].use_rate), 50);
    const absent = await postgres.query<{ player_slot: number }>(`
      SELECT pr.player_slot FROM player_results pr
      WHERE pr.item_snapshot_complete AND NOT EXISTS (
        SELECT 1 FROM player_item_results pir
        WHERE pir.match_id = pr.match_id AND pir.player_slot = pr.player_slot AND pir.item_id = 1
      )
    `);
    assert.deepEqual(absent.rows.map((r) => Number(r.player_slot)), [128]);
  });

  it("queries a 100-game threshold with player occurrences and a 30-day window", async () => {
    const matches = Array.from({ length: 60 }, (_, index) => match([
      player({ item_0: 1, item_1: index < 50 ? 116 : 0 }),
      player({ player_slot: 128, item_0: 1, item_1: index < 49 ? 116 : 0 }),
    ], { match_id: index + 1, match_seq_num: index + 1 }));
    matches.push(match([player({ item_0: 116 })], {
      match_id: 61, match_seq_num: 61, start_time: Math.floor(Date.now() / 1000) - 31 * 86400,
    }));
    matches.push(match([player({ item_0: 116 })], { match_id: 62, match_seq_num: 62, radiant_win: undefined }));
    await storeMatches(database, matches);
    const schema = await loadDatabaseSchemaDescription(database as unknown as Pool, "public");
    assert.match(schema, /VIEW "public"\."player_item_results"/);
    assert.match(schema, /exactly one row per/);
    const sql = `
      SELECT item_id, item_name, item_category,
        COUNT(*) AS player_match_occurrences,
        ROUND(100.0 * AVG(won::int), 2) AS win_rate_percent
      FROM player_item_results
      WHERE start_time >= CURRENT_TIMESTAMP - INTERVAL '30 days'
        AND won IS NOT NULL
      GROUP BY item_id, item_name, item_category
      HAVING COUNT(*) >= 100
      ORDER BY player_match_occurrences DESC, item_id
    `;
    const { rows } = await postgres.query<{ item_id: number; player_match_occurrences: number; win_rate_percent: string }>(sql);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].item_id), 1);
    assert.equal(Number(rows[0].player_match_occurrences), 120);
    assert.equal(Number(rows[0].win_rate_percent), 50);
    assert.equal((await postgres.query(sql.replace("HAVING COUNT(*) >= 100", "HAVING COUNT(DISTINCT match_id) >= 100"))).rows.length, 0);
  });

  it("upgrades an existing schema and reseeds catalogs without losing observations", async () => {
    await storeMatches(database, [match([player({ item_0: 1 })])]);
    // Simulate the previous schema in this isolated database.
    const legacyViews = [];
    for (const name of ["player_results", "player_item_results"]) {
      const { rows: columns } = await postgres.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name <> 'team_side'
        ORDER BY ordinal_position
      `, [name]);
      const { rows: definitions } = await postgres.query<{ definition: string }>(
        "SELECT pg_get_viewdef($1::regclass) AS definition", [name]);
      legacyViews.push({ name, columns: columns.map((column) => column.column_name),
        definition: definitions[0].definition.trim().replace(/;$/, "").replace(/,\s*pr\.team_side\b/, "") });
    }
    await postgres.exec("DROP VIEW player_item_results; DROP VIEW player_results");
    for (const view of legacyViews) {
      await postgres.exec(`CREATE VIEW ${view.name} AS SELECT ${view.columns.join(", ")} FROM (${view.definition}) AS legacy`);
    }
    await postgres.exec("ALTER TABLE items DROP COLUMN name_aliases; DROP TABLE heroes, game_modes, lobby_types");
    await createDatabaseSchema(database);
    for (const view of legacyViews) {
      const result = await postgres.query(`SELECT * FROM ${view.name}`);
      assert.deepEqual(result.fields.map((field) => field.name), [...view.columns, "team_side"]);
      assert.equal(result.rows[0].team_side, "radiant");
    }
    assert.equal((await postgres.query("SELECT * FROM player_item_results")).rows.length, 1);
    const resolve = await loadEntityResolver(database as unknown as Pool, "public");
    assert.deepEqual(resolve("BKB on AM in turbo").resolved.map((entity) => entity.ids), [[116], [1], [23]]);
    await createDatabaseSchema(database);
    assert.equal((await postgres.query("SELECT * FROM player_item_results")).rows.length, 1);
  });

  it("rejects malformed upgrade flags before starting a transaction", async () => {
    await assert.rejects(() => storeMatches(database, [match([player({ moonshard: Number.NaN })])]), /upgrade flags must be safe integers/);
    assert.equal((await postgres.query("SELECT * FROM matches")).rows.length, 0);
  });
});
