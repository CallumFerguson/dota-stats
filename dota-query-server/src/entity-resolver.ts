import type { Pool } from "pg";

export type EntityKind = "item" | "hero" | "game_mode" | "lobby_type";
export interface CatalogEntry {
  kind: EntityKind;
  id: number | string;
  name: string;
  names: string[];
}
export interface EntityCandidate {
  kind: EntityKind;
  ids: number[];
  name: string;
}
export interface EntityResolution {
  resolved: Array<EntityCandidate & { mention: string }>;
  ambiguous: Array<{ mention: string; candidates: EntityCandidate[] }>;
}
export type EntityResolver = (question: string) => EntityResolution;

function words(value: string): string[] {
  return value.normalize("NFKC").toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/'s\b/g, "")
    .replace(/'/g, "")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Exact normalized names and curated aliases only; no fuzzy guesses or inferred IDs. */
export function createEntityResolver(entries: CatalogEntry[]): EntityResolver {
  const index = new Map<string, Map<string, EntityCandidate>>();
  let maxKeyLength = 0;
  for (const entry of entries) {
    const id = Number(entry.id);
    if (!Number.isSafeInteger(id) || id < 0) throw new Error("Invalid reference catalog ID.");
    for (const alias of new Set([entry.name, ...entry.names])) {
      const key = words(alias).join("");
      if (!key) continue;
      const candidates = index.get(key) ?? new Map<string, EntityCandidate>();
      // The catalog deliberately names game modes 1 and 22 All Pick. Other
      // duplicate names remain ambiguous, including distinct items and heroes.
      const identity = entry.kind === "game_mode"
        ? `${entry.kind}:${entry.name}` : `${entry.kind}:${id}`;
      const candidate = candidates.get(identity) ?? { kind: entry.kind, ids: [], name: entry.name };
      if (!candidate.ids.includes(id)) candidate.ids.push(id);
      candidate.ids.sort((a, b) => a - b);
      candidates.set(identity, candidate);
      index.set(key, candidates);
      maxKeyLength = Math.max(maxKeyLength, key.length);
    }
  }

  return (question) => {
    const tokens = words(question);
    const result: EntityResolution = { resolved: [], ambiguous: [] };
    const seen = new Set<string>();
    for (let start = 0; start < tokens.length; start++) {
      let key = "";
      let longest: { key: string; end: number; candidates: EntityCandidate[] } | undefined;
      for (let end = start; end < tokens.length; end++) {
        key += tokens[end];
        if (key.length > maxKeyLength) break;
        const candidates = index.get(key);
        if (candidates) longest = { key, end, candidates: [...candidates.values()] };
      }
      if (!longest) continue;
      start = longest.end;
      if (seen.has(longest.key)) continue;
      seen.add(longest.key);
      // Only a normalized catalog key is emitted, never arbitrary request text.
      if (longest.candidates.length === 1) {
        result.resolved.push({ mention: longest.key, ...longest.candidates[0] });
      } else {
        result.ambiguous.push({ mention: longest.key, candidates: longest.candidates });
      }
    }
    return result;
  };
}

/** Read only the small reference tables, never match data, using the configured schema. */
export async function loadEntityResolver(database: Pool, schemaName: string): Promise<EntityResolver> {
  const schema = `"${schemaName.replaceAll('"', '""')}"`;
  const result = await database.query<CatalogEntry>(`
    SELECT 'item' AS kind, canonical.item_id AS id, canonical.item_name AS name,
      ARRAY_REMOVE(ARRAY[raw.item_name, raw.internal_name], NULL) || raw.name_aliases AS names
    FROM ${schema}.items AS raw
    JOIN ${schema}.items AS canonical ON canonical.item_id = raw.canonical_item_id
    UNION ALL
    SELECT 'hero', hero_id, hero_name, ARRAY[internal_name] || name_aliases FROM ${schema}.heroes
    UNION ALL
    SELECT 'game_mode', game_mode, game_mode_name, ARRAY[internal_name] || name_aliases FROM ${schema}.game_modes
    UNION ALL
    SELECT 'lobby_type', lobby_type, lobby_type_name, ARRAY[internal_name] || name_aliases FROM ${schema}.lobby_types
  `);
  for (const kind of ["item", "hero", "game_mode", "lobby_type"] as const) {
    if (!result.rows.some((entry) => entry.kind === kind)) {
      throw new Error(`Missing ${kind} reference data. Start dota-data-server to seed the catalogs, grant SELECT to the query role, then restart dota-query-server.`);
    }
  }
  return createEntityResolver(result.rows);
}
