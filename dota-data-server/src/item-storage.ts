// Read persisted snapshots so overlapping fetches cannot change the item set of
// an existing player whose raw INSERT was ignored. All calls share its transaction.
export const INSERT_UNKNOWN_ITEMS_SQL = `
INSERT INTO items (item_id, item_name, item_category, canonical_item_id)
SELECT DISTINCT slots.item_id, 'Unknown item ' || slots.item_id, 'unknown', slots.item_id
FROM match_players AS mp
CROSS JOIN LATERAL (VALUES
  (mp.item_0), (mp.item_1), (mp.item_2), (mp.item_3), (mp.item_4), (mp.item_5),
  (mp.backpack_0), (mp.backpack_1), (mp.backpack_2), (mp.item_neutral), (mp.item_neutral2)
) AS slots(item_id)
WHERE mp.match_id IN (SELECT value::BIGINT FROM JSONB_ARRAY_ELEMENTS_TEXT($1::JSONB))
  AND slots.item_id > 0
ON CONFLICT (item_id) DO NOTHING;
`;

export const INSERT_PLAYER_ITEMS_SQL = `
INSERT INTO match_player_items (match_id, player_slot, item_id, observed_held, upgrade_reported)
SELECT mp.match_id, mp.player_slot, normalized.item_id,
  normalized.observed_held, normalized.upgrade_reported
FROM match_players AS mp
CROSS JOIN LATERAL normalize_player_items(mp) AS normalized
WHERE mp.match_id IN (SELECT value::BIGINT FROM JSONB_ARRAY_ELEMENTS_TEXT($1::JSONB))
ON CONFLICT (match_id, player_slot, item_id) DO NOTHING;
`;
