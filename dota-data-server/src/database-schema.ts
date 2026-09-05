import type { Client } from "pg";
import { ITEM_CATALOG, SEED_ITEM_CATALOG_SQL, UPGRADE_ITEM_IDS } from "./item-catalog.js";
import { seedReferenceCatalogs } from "./reference-catalog.js";

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

CREATE TABLE IF NOT EXISTS items (
  item_id BIGINT PRIMARY KEY CHECK (item_id > 0),
  internal_name TEXT,
  item_name TEXT NOT NULL,
  item_category TEXT NOT NULL CHECK (item_category IN
    ('regular', 'recipe', 'neutral_artifact', 'neutral_enchantment', 'neutral_token', 'unknown')),
  neutral_tier BIGINT,
  canonical_item_id BIGINT NOT NULL REFERENCES items(item_id)
);

CREATE TABLE IF NOT EXISTS match_player_items (
  match_id BIGINT NOT NULL,
  player_slot BIGINT NOT NULL,
  item_id BIGINT NOT NULL REFERENCES items(item_id),
  observed_held BOOLEAN NOT NULL,
  upgrade_reported BOOLEAN,
  PRIMARY KEY (match_id, player_slot, item_id),
  FOREIGN KEY (match_id, player_slot)
    REFERENCES match_players(match_id, player_slot) ON DELETE CASCADE,
  CHECK (observed_held OR upgrade_reported IS TRUE)
);

ALTER TABLE items ADD COLUMN IF NOT EXISTS name_aliases TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS match_player_items_item_idx
  ON match_player_items (item_id, match_id, player_slot);

CREATE OR REPLACE FUNCTION normalize_player_items(snapshot match_players)
RETURNS TABLE (item_id BIGINT, observed_held BOOLEAN, upgrade_reported BOOLEAN)
LANGUAGE SQL STABLE AS $normalize$
  WITH observations AS (
    SELECT catalog.canonical_item_id AS item_id, TRUE AS observed_held
    FROM (VALUES
      (snapshot.item_0), (snapshot.item_1), (snapshot.item_2),
      (snapshot.item_3), (snapshot.item_4), (snapshot.item_5),
      (snapshot.backpack_0), (snapshot.backpack_1), (snapshot.backpack_2),
      (snapshot.item_neutral), (snapshot.item_neutral2)
    ) AS slots(raw_item_id)
    JOIN items AS catalog ON catalog.item_id = slots.raw_item_id
    WHERE slots.raw_item_id > 0
    UNION ALL
    SELECT upgrades.item_id, FALSE
    FROM (VALUES
      (${UPGRADE_ITEM_IDS.aghanims_scepter}::BIGINT, snapshot.aghanims_scepter),
      (${UPGRADE_ITEM_IDS.aghanims_shard}::BIGINT, snapshot.aghanims_shard),
      (${UPGRADE_ITEM_IDS.moonshard}::BIGINT, snapshot.moonshard)
    ) AS upgrades(item_id, reported)
    WHERE upgrades.reported IS TRUE
  )
  SELECT observations.item_id, BOOL_OR(observations.observed_held),
    CASE observations.item_id
      WHEN ${UPGRADE_ITEM_IDS.aghanims_scepter} THEN snapshot.aghanims_scepter
      WHEN ${UPGRADE_ITEM_IDS.aghanims_shard} THEN snapshot.aghanims_shard
      WHEN ${UPGRADE_ITEM_IDS.moonshard} THEN snapshot.moonshard
      ELSE NULL
    END
  FROM observations
  GROUP BY observations.item_id;
$normalize$;

CREATE OR REPLACE VIEW player_results AS
SELECT mp.match_id, mp.player_slot, mp.account_id, mp.hero_id, mp.hero_variant,
  mp.leaver_status, m.start_time, m.duration, m.game_mode, m.lobby_type,
  outcome.team_won,
  CASE
    WHEN outcome.team_won IS NULL OR mp.leaver_status IS NULL
      OR mp.leaver_status NOT BETWEEN 0 AND 6 THEN NULL
    WHEN mp.leaver_status BETWEEN 2 AND 6 THEN FALSE
    ELSE outcome.team_won
  END AS won,
  (mp.item_0 IS NOT NULL AND mp.item_1 IS NOT NULL AND mp.item_2 IS NOT NULL
    AND mp.item_3 IS NOT NULL AND mp.item_4 IS NOT NULL AND mp.item_5 IS NOT NULL
    AND mp.backpack_0 IS NOT NULL AND mp.backpack_1 IS NOT NULL AND mp.backpack_2 IS NOT NULL
    AND mp.item_neutral IS NOT NULL AND mp.item_neutral2 IS NOT NULL
    AND mp.aghanims_scepter IS NOT NULL AND mp.aghanims_shard IS NOT NULL
    AND mp.moonshard IS NOT NULL) AS item_snapshot_complete
FROM match_players AS mp
JOIN matches AS m ON m.match_id = mp.match_id
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN mp.player_slot BETWEEN 0 AND 4 THEN m.radiant_win
    WHEN mp.player_slot BETWEEN 128 AND 132 THEN NOT m.radiant_win
    ELSE NULL
  END AS team_won
) AS outcome;

CREATE OR REPLACE VIEW player_item_results AS
SELECT pr.*, mpi.item_id, i.internal_name AS item_internal_name,
  i.item_name, i.item_category, i.neutral_tier,
  mpi.observed_held, mpi.upgrade_reported
FROM match_player_items AS mpi
JOIN player_results AS pr USING (match_id, player_slot)
JOIN items AS i ON i.item_id = mpi.item_id;

COMMENT ON TABLE items IS
  'Item catalog including raw aliases. canonical_item_id groups equivalent Scepter/Blessing and Shard forms. Unknown IDs are retained; category unknown means unclassified, not a regular item.';
COMMENT ON TABLE match_players IS
  'Raw end-of-match snapshots. Prefer player_results for outcomes and player_item_results for item statistics.';
COMMENT ON TABLE match_player_items IS
  'Exactly one observed canonical item per (match_id, player_slot, item_id), including backpacks and reported persistent upgrades. No row means no positive observation, not necessarily known absence.';
COMMENT ON VIEW player_results IS
  'One row per (match_id, player_slot), including empty inventories. won applies personal abandoner losses (leaver_status 2-6); unknown outcome/status or nonstandard player slot yields NULL. team_won ignores leaver status. For item use rate, require item_snapshot_complete and the same outcome/population filters in numerator and denominator.';
COMMENT ON VIEW player_item_results IS
  'Preferred item analytics: exactly one row per (match_id, player_slot, canonical item_id). Inventory, backpack, neutral slots and reported upgrades already combined and deduplicated. COUNT(*) counts player-match occurrences; AVG(won::int) is win fraction with won IS NOT NULL. All categories are included. observed_held is a positive slot observation; upgrade_reported is the raw flag (NULL means unknown or inapplicable).';
`;

export async function createDatabaseSchema(database: Client): Promise<void> {
  await database.query("BEGIN");
  try {
    await database.query(CREATE_TABLES_SQL);
    await database.query(SEED_ITEM_CATALOG_SQL, [JSON.stringify(ITEM_CATALOG)]);
    await seedReferenceCatalogs(database);
    await database.query("COMMIT");
  } catch (error) {
    await database.query("ROLLBACK");
    throw error;
  }
}
