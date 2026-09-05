import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Client } from "pg";

const constantsDirectory = path.dirname(createRequire(import.meta.url).resolve("dotaconstants"));
function readConstants<T>(file: string): T[] {
  return Object.values(JSON.parse(readFileSync(path.join(constantsDirectory, "build", file), "utf8")));
}

// Curated nicknames, keyed by stable internal names rather than duplicated IDs.
const heroAliases: Record<string, string[]> = {
  antimage: ["AM"], axe: ["Mogul Khan"], crystal_maiden: ["CM", "Rylai"],
  drow_ranger: ["Drow", "Traxex"], earthshaker: ["ES", "Shaker"],
  earth_spirit: ["ES"], ember_spirit: ["Ember"], storm_spirit: ["Storm"],
  void_spirit: ["Void Spirit"], faceless_void: ["FV", "Void"],
  nevermore: ["SF", "Shadow Fiend"], queenofpain: ["QoP"],
  skeleton_king: ["WK", "Wraith King", "Skeleton King"],
  windrunner: ["WR", "Windrunner"], zuus: ["Zeus"],
  life_stealer: ["LS", "Naix"], phantom_assassin: ["PA"],
  phantom_lancer: ["PL"], templar_assassin: ["TA"], terrorblade: ["TB"],
  obsidian_destroyer: ["OD", "Outworld Destroyer", "Outworld Devourer"],
  furion: ["NP", "Nature's Prophet", "Furion"], spirit_breaker: ["SB", "Bara"],
  keeper_of_the_light: ["KotL"], ancient_apparition: ["AA"],
  legion_commander: ["LC"], bounty_hunter: ["BH"], witch_doctor: ["WD"],
  night_stalker: ["NS"], necrolyte: ["Necro", "Necrophos"],
};

interface HeroMetadata { id: number; name: string; localized_name: string }
interface ModeMetadata { id: number; name: string }

function title(value: string): string {
  return value.split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

export const HERO_CATALOG = readConstants<HeroMetadata>("heroes.json").map((hero) => {
  const shortName = hero.name.replace(/^npc_dota_hero_/, "");
  return { id: hero.id, internal_name: hero.name, name: hero.localized_name,
    name_aliases: [shortName, ...(heroAliases[shortName] ?? [])] };
});

export const GAME_MODE_CATALOG = readConstants<ModeMetadata>("game_mode.json").map((mode) => {
  const shortName = mode.name.replace(/^game_mode_/, "");
  // Both modes intentionally share a display name and form the All Pick filter.
  return { id: mode.id, internal_name: mode.name,
    name: shortName === "all_draft" ? "All Pick" : title(shortName),
    name_aliases: [shortName] };
});

export const LOBBY_TYPE_CATALOG = readConstants<ModeMetadata>("lobby_type.json").map((lobby) => {
  const shortName = lobby.name.replace(/^lobby_type_/, "");
  return { id: lobby.id, internal_name: lobby.name, name: title(shortName),
    name_aliases: shortName === "normal" ? ["public", "unranked"] : [] };
});

export async function seedReferenceCatalogs(database: Client): Promise<void> {
  // Identifiers below are server-owned literals; catalog values stay parameterized.
  for (const [table, idColumn, nameColumn, catalog] of [
    ["heroes", "hero_id", "hero_name", HERO_CATALOG],
    ["game_modes", "game_mode", "game_mode_name", GAME_MODE_CATALOG],
    ["lobby_types", "lobby_type", "lobby_type_name", LOBBY_TYPE_CATALOG],
  ] as const) {
    await database.query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        ${idColumn} BIGINT PRIMARY KEY,
        internal_name TEXT NOT NULL,
        ${nameColumn} TEXT NOT NULL,
        name_aliases TEXT[] NOT NULL DEFAULT '{}'
      );
      COMMENT ON TABLE ${table} IS
        'Reference names and curated aliases from pinned dotaconstants. LEFT JOIN for display names so unknown match IDs remain in results. Game modes sharing a display name form one named filter; game mode and lobby type are separate dimensions.';
    `);
    await database.query(`
      INSERT INTO ${table} (${idColumn}, internal_name, ${nameColumn}, name_aliases)
      SELECT id, internal_name, name, name_aliases
      FROM JSONB_TO_RECORDSET($1::JSONB) AS catalog
        (id BIGINT, internal_name TEXT, name TEXT, name_aliases TEXT[])
      ON CONFLICT (${idColumn}) DO UPDATE SET
        internal_name = EXCLUDED.internal_name,
        ${nameColumn} = EXCLUDED.${nameColumn},
        name_aliases = EXCLUDED.name_aliases
    `, [JSON.stringify(catalog)]);
  }
}
