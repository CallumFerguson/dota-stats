import type { Client } from "pg";

export interface DotaMatchPlayer {
  account_id?: number;
  player_slot?: number;
  team_number?: number;
  team_slot?: number;
  hero_id?: number;
  hero_variant?: number;
  item_0?: number;
  item_1?: number;
  item_2?: number;
  item_3?: number;
  item_4?: number;
  item_5?: number;
  backpack_0?: number;
  backpack_1?: number;
  backpack_2?: number;
  item_neutral?: number;
  item_neutral2?: number;
  kills?: number;
  deaths?: number;
  assists?: number;
  leaver_status?: number;
  last_hits?: number;
  denies?: number;
  gold_per_min?: number;
  xp_per_min?: number;
  level?: number;
  net_worth?: number;
  aghanims_scepter?: number;
  aghanims_shard?: number;
  moonshard?: number;
  hero_damage?: number;
  tower_damage?: number;
  hero_healing?: number;
  gold?: number;
  gold_spent?: number;
  scaled_hero_damage?: number;
  scaled_tower_damage?: number;
  scaled_hero_healing?: number;
}

export interface DotaMatch {
  match_id?: number;
  match_seq_num?: number;
  radiant_win?: boolean;
  duration?: number;
  pre_game_duration?: number;
  start_time?: number;
  tower_status_radiant?: number;
  tower_status_dire?: number;
  barracks_status_radiant?: number;
  barracks_status_dire?: number;
  cluster?: number;
  first_blood_time?: number;
  lobby_type?: number;
  human_players?: number;
  leagueid?: number;
  game_mode?: number;
  flags?: number;
  engine?: number;
  radiant_score?: number;
  dire_score?: number;
  players?: DotaMatchPlayer[];
}

const INSERT_MATCHES_SQL = `
INSERT INTO matches (
  match_id,
  match_seq_num,
  radiant_win,
  duration,
  pre_game_duration,
  start_time,
  tower_status_radiant,
  tower_status_dire,
  barracks_status_radiant,
  barracks_status_dire,
  cluster,
  first_blood_time,
  lobby_type,
  human_players,
  league_id,
  game_mode,
  flags,
  engine,
  radiant_score,
  dire_score
)
SELECT
  match_id,
  match_seq_num,
  radiant_win,
  duration,
  pre_game_duration,
  TO_TIMESTAMP(start_time::DOUBLE PRECISION),
  tower_status_radiant,
  tower_status_dire,
  barracks_status_radiant,
  barracks_status_dire,
  cluster,
  first_blood_time,
  lobby_type,
  human_players,
  league_id,
  game_mode,
  flags,
  engine,
  radiant_score,
  dire_score
FROM JSONB_TO_RECORDSET($1::JSONB) AS payload (
  match_id BIGINT,
  match_seq_num BIGINT,
  radiant_win BOOLEAN,
  duration BIGINT,
  pre_game_duration BIGINT,
  start_time BIGINT,
  tower_status_radiant BIGINT,
  tower_status_dire BIGINT,
  barracks_status_radiant BIGINT,
  barracks_status_dire BIGINT,
  cluster BIGINT,
  first_blood_time BIGINT,
  lobby_type BIGINT,
  human_players BIGINT,
  league_id BIGINT,
  game_mode BIGINT,
  flags BIGINT,
  engine BIGINT,
  radiant_score BIGINT,
  dire_score BIGINT
)
ON CONFLICT DO NOTHING;
`;

const INSERT_PLAYERS_SQL = `
INSERT INTO match_players (
  match_id,
  player_slot,
  account_id,
  team_number,
  team_slot,
  hero_id,
  hero_variant,
  item_0,
  item_1,
  item_2,
  item_3,
  item_4,
  item_5,
  backpack_0,
  backpack_1,
  backpack_2,
  item_neutral,
  item_neutral2,
  kills,
  deaths,
  assists,
  leaver_status,
  last_hits,
  denies,
  gold_per_min,
  xp_per_min,
  level,
  net_worth,
  aghanims_scepter,
  aghanims_shard,
  moonshard,
  hero_damage,
  tower_damage,
  hero_healing,
  gold,
  gold_spent,
  scaled_hero_damage,
  scaled_tower_damage,
  scaled_hero_healing
)
SELECT *
FROM JSONB_TO_RECORDSET($1::JSONB) AS payload (
  match_id BIGINT,
  player_slot BIGINT,
  account_id BIGINT,
  team_number BIGINT,
  team_slot BIGINT,
  hero_id BIGINT,
  hero_variant BIGINT,
  item_0 BIGINT,
  item_1 BIGINT,
  item_2 BIGINT,
  item_3 BIGINT,
  item_4 BIGINT,
  item_5 BIGINT,
  backpack_0 BIGINT,
  backpack_1 BIGINT,
  backpack_2 BIGINT,
  item_neutral BIGINT,
  item_neutral2 BIGINT,
  kills BIGINT,
  deaths BIGINT,
  assists BIGINT,
  leaver_status BIGINT,
  last_hits BIGINT,
  denies BIGINT,
  gold_per_min BIGINT,
  xp_per_min BIGINT,
  level BIGINT,
  net_worth BIGINT,
  aghanims_scepter BOOLEAN,
  aghanims_shard BOOLEAN,
  moonshard BOOLEAN,
  hero_damage BIGINT,
  tower_damage BIGINT,
  hero_healing BIGINT,
  gold BIGINT,
  gold_spent BIGINT,
  scaled_hero_damage BIGINT,
  scaled_tower_damage BIGINT,
  scaled_hero_healing BIGINT
)
ON CONFLICT DO NOTHING;
`;

function requireSafeInteger(value: number | undefined, name: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safe integer.`);
  }

  return value as number;
}

function toOptionalBoolean(value: number | undefined): boolean | null {
  return value === undefined ? null : value !== 0;
}

function validateSafeIntegerFields(
  row: Record<string, unknown>,
  fieldNames: readonly string[],
  context: string,
): void {
  for (const fieldName of fieldNames) {
    const value = row[fieldName];

    if (value === undefined || value === null) {
      continue;
    }

    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw new Error(
        `Invalid ${fieldName}=${String(value)} for ${context}: Valve integer fields must be JavaScript safe integers before storage as PostgreSQL BIGINT.`,
      );
    }
  }
}

const MATCH_INTEGER_FIELDS = [
  "duration",
  "pre_game_duration",
  "start_time",
  "tower_status_radiant",
  "tower_status_dire",
  "barracks_status_radiant",
  "barracks_status_dire",
  "cluster",
  "first_blood_time",
  "lobby_type",
  "human_players",
  "league_id",
  "game_mode",
  "flags",
  "engine",
  "radiant_score",
  "dire_score",
] as const;

const PLAYER_INTEGER_FIELDS = [
  "account_id",
  "team_number",
  "team_slot",
  "hero_id",
  "hero_variant",
  "item_0",
  "item_1",
  "item_2",
  "item_3",
  "item_4",
  "item_5",
  "backpack_0",
  "backpack_1",
  "backpack_2",
  "item_neutral",
  "item_neutral2",
  "kills",
  "deaths",
  "assists",
  "leaver_status",
  "last_hits",
  "denies",
  "gold_per_min",
  "xp_per_min",
  "level",
  "net_worth",
  "hero_damage",
  "tower_damage",
  "hero_healing",
  "gold",
  "gold_spent",
  "scaled_hero_damage",
  "scaled_tower_damage",
  "scaled_hero_healing",
] as const;

export async function storeMatches(
  database: Client,
  matches: readonly DotaMatch[],
): Promise<void> {
  if (matches.length === 0) {
    return;
  }

  const matchRows = matches.map((match) => ({
    match_id: requireSafeInteger(match.match_id, "match_id"),
    match_seq_num: requireSafeInteger(match.match_seq_num, "match_seq_num"),
    radiant_win: match.radiant_win,
    duration: match.duration,
    pre_game_duration: match.pre_game_duration,
    start_time: match.start_time,
    tower_status_radiant: match.tower_status_radiant,
    tower_status_dire: match.tower_status_dire,
    barracks_status_radiant: match.barracks_status_radiant,
    barracks_status_dire: match.barracks_status_dire,
    cluster: match.cluster,
    first_blood_time: match.first_blood_time,
    lobby_type: match.lobby_type,
    human_players: match.human_players,
    league_id: match.leagueid,
    game_mode: match.game_mode,
    flags: match.flags,
    engine: match.engine,
    radiant_score: match.radiant_score,
    dire_score: match.dire_score,
  }));
  const playerRows = matches.flatMap((match) => {
    const matchId = requireSafeInteger(match.match_id, "match_id");

    return (match.players ?? []).map((player) => ({
      match_id: matchId,
      player_slot: requireSafeInteger(player.player_slot, "player_slot"),
      account_id: player.account_id,
      team_number: player.team_number,
      team_slot: player.team_slot,
      hero_id: player.hero_id,
      hero_variant: player.hero_variant,
      item_0: player.item_0,
      item_1: player.item_1,
      item_2: player.item_2,
      item_3: player.item_3,
      item_4: player.item_4,
      item_5: player.item_5,
      backpack_0: player.backpack_0,
      backpack_1: player.backpack_1,
      backpack_2: player.backpack_2,
      item_neutral: player.item_neutral,
      item_neutral2: player.item_neutral2,
      kills: player.kills,
      deaths: player.deaths,
      assists: player.assists,
      leaver_status: player.leaver_status,
      last_hits: player.last_hits,
      denies: player.denies,
      gold_per_min: player.gold_per_min,
      xp_per_min: player.xp_per_min,
      level: player.level,
      net_worth: player.net_worth,
      aghanims_scepter: toOptionalBoolean(player.aghanims_scepter),
      aghanims_shard: toOptionalBoolean(player.aghanims_shard),
      moonshard: toOptionalBoolean(player.moonshard),
      hero_damage: player.hero_damage,
      tower_damage: player.tower_damage,
      hero_healing: player.hero_healing,
      gold: player.gold,
      gold_spent: player.gold_spent,
      scaled_hero_damage: player.scaled_hero_damage,
      scaled_tower_damage: player.scaled_tower_damage,
      scaled_hero_healing: player.scaled_hero_healing,
    }));
  });

  for (const matchRow of matchRows) {
    const context = `match ${matchRow.match_id}`;
    validateSafeIntegerFields(matchRow, MATCH_INTEGER_FIELDS, context);
  }

  for (const playerRow of playerRows) {
    const context =
      `match ${playerRow.match_id}, player slot ${playerRow.player_slot}`;
    validateSafeIntegerFields(playerRow, PLAYER_INTEGER_FIELDS, context);
  }

  await database.query("BEGIN");

  try {
    await database.query(INSERT_MATCHES_SQL, [JSON.stringify(matchRows)]);

    if (playerRows.length > 0) {
      await database.query(INSERT_PLAYERS_SQL, [JSON.stringify(playerRows)]);
    }

    await database.query("COMMIT");
  } catch (error: unknown) {
    try {
      await database.query("ROLLBACK");
    } catch (rollbackError: unknown) {
      throw new AggregateError(
        [error, rollbackError],
        "Match storage failed and the database transaction could not be rolled back.",
      );
    }

    throw error;
  }
}
