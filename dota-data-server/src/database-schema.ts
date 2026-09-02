import type { Client } from "pg";

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS matches (
  match_id BIGINT PRIMARY KEY,
  match_seq_num BIGINT NOT NULL UNIQUE,
  radiant_win BOOLEAN,
  duration BIGINT,
  pre_game_duration BIGINT,
  start_time TIMESTAMPTZ,
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
  dire_score BIGINT,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS match_players (
  match_id BIGINT NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
  player_slot BIGINT NOT NULL,
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
  scaled_hero_healing BIGINT,
  PRIMARY KEY (match_id, player_slot)
);

CREATE INDEX IF NOT EXISTS matches_start_time_idx ON matches (start_time);
`;

export async function createDatabaseSchema(database: Client): Promise<void> {
  await database.query(CREATE_TABLES_SQL);
}
