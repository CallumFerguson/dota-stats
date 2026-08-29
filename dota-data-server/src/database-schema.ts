import type { Client } from "pg";

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS matches (
  match_id BIGINT PRIMARY KEY,
  match_seq_num BIGINT NOT NULL UNIQUE,
  radiant_win BOOLEAN,
  duration INTEGER,
  pre_game_duration SMALLINT,
  start_time TIMESTAMPTZ,
  tower_status_radiant SMALLINT,
  tower_status_dire SMALLINT,
  barracks_status_radiant SMALLINT,
  barracks_status_dire SMALLINT,
  cluster SMALLINT,
  first_blood_time INTEGER,
  lobby_type SMALLINT,
  human_players SMALLINT,
  league_id INTEGER,
  game_mode SMALLINT,
  flags INTEGER,
  engine SMALLINT,
  radiant_score SMALLINT,
  dire_score SMALLINT,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS match_players (
  match_id BIGINT NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
  player_slot SMALLINT NOT NULL,
  account_id BIGINT,
  team_number SMALLINT,
  team_slot SMALLINT,
  hero_id SMALLINT,
  hero_variant SMALLINT,
  item_0 INTEGER,
  item_1 INTEGER,
  item_2 INTEGER,
  item_3 INTEGER,
  item_4 INTEGER,
  item_5 INTEGER,
  backpack_0 INTEGER,
  backpack_1 INTEGER,
  backpack_2 INTEGER,
  item_neutral INTEGER,
  item_neutral2 INTEGER,
  kills SMALLINT,
  deaths SMALLINT,
  assists SMALLINT,
  leaver_status SMALLINT,
  last_hits INTEGER,
  denies SMALLINT,
  gold_per_min SMALLINT,
  xp_per_min SMALLINT,
  level SMALLINT,
  net_worth INTEGER,
  aghanims_scepter BOOLEAN,
  aghanims_shard BOOLEAN,
  moonshard BOOLEAN,
  hero_damage INTEGER,
  tower_damage INTEGER,
  hero_healing INTEGER,
  gold INTEGER,
  gold_spent INTEGER,
  scaled_hero_damage INTEGER,
  scaled_tower_damage INTEGER,
  scaled_hero_healing INTEGER,
  PRIMARY KEY (match_id, player_slot)
);

CREATE INDEX IF NOT EXISTS matches_start_time_idx ON matches (start_time);
`;

export async function createDatabaseSchema(database: Client): Promise<void> {
  await database.query(CREATE_TABLES_SQL);
}
