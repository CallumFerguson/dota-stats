import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

interface ItemMetadata {
  id: number;
  dname?: string;
  cost?: number | null;
  tier?: number;
}

// Load only the two item files from the pinned package, not its entire dataset.
const constantsDirectory = path.dirname(createRequire(import.meta.url).resolve("dotaconstants"));
const itemIds = JSON.parse(readFileSync(path.join(constantsDirectory, "build/item_ids.json"), "utf8")) as Record<string, string>;
const metadata = JSON.parse(readFileSync(path.join(constantsDirectory, "build/items.json"), "utf8")) as Record<string, ItemMetadata>;
const idsByName = new Map(Object.entries(itemIds).map(([id, name]) => [name, Number(id)]));

function requireItemId(name: string): number {
  const id = idsByName.get(name);
  if (id === undefined || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`Missing item ID for ${name} in the pinned item catalog.`);
  }
  return id;
}

export const UPGRADE_ITEM_IDS = {
  aghanims_scepter: requireItemId("ultimate_scepter"),
  aghanims_shard: requireItemId("aghanims_shard"),
  moonshard: requireItemId("moon_shard"),
} as const;

// Explicit equivalent forms only: recipes and other upgraded items stay distinct.
const canonicalIds = new Map([
  [requireItemId("ultimate_scepter_2"), UPGRADE_ITEM_IDS.aghanims_scepter],
  [requireItemId("ultimate_scepter_roshan"), UPGRADE_ITEM_IDS.aghanims_scepter],
  [requireItemId("aghanims_shard_roshan"), UPGRADE_ITEM_IDS.aghanims_shard],
]);

function category(name: string, item: ItemMetadata | undefined): string {
  if (name.startsWith("recipe_")) return "recipe";
  if (/^tier[1-5]_token$/.test(name)) return "neutral_token";
  if (name.startsWith("enhancement_")) return "neutral_enchantment";
  if (item?.tier !== undefined) return "neutral_artifact";
  // A zero price alone does not identify a neutral item (e.g. Aegis).
  if (item?.cost && item.cost > 0) return "regular";
  return "unknown";
}

export const ITEM_CATALOG = Object.entries(itemIds)
  .filter(([id]) => Number(id) > 0)
  .map(([id, name]) => ({
    item_id: Number(id),
    internal_name: name,
    item_name: metadata[name]?.dname || name,
    item_category: category(name, metadata[name]),
    neutral_tier: metadata[name]?.tier ?? null,
    canonical_item_id: canonicalIds.get(Number(id)) ?? Number(id),
  }));

export const SEED_ITEM_CATALOG_SQL = `
INSERT INTO items (item_id, internal_name, item_name, item_category, neutral_tier, canonical_item_id)
SELECT item_id, internal_name, item_name, item_category, neutral_tier, canonical_item_id
FROM JSONB_TO_RECORDSET($1::JSONB) AS catalog (
  item_id BIGINT, internal_name TEXT, item_name TEXT, item_category TEXT,
  neutral_tier BIGINT, canonical_item_id BIGINT
)
ON CONFLICT (item_id) DO UPDATE SET
  internal_name = EXCLUDED.internal_name,
  item_name = EXCLUDED.item_name,
  item_category = EXCLUDED.item_category,
  neutral_tier = EXCLUDED.neutral_tier,
  canonical_item_id = EXCLUDED.canonical_item_id;
`;
