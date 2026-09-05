# Dota Data Server

This TypeScript server uses Valve's recent match history to find an approximate
current match sequence number. It then requests pages of up to 100 newer
matches, advances its sequence cursor, and stores the matches in PostgreSQL.

Before the HTTP server starts or any Valve request is made, the app validates
its PostgreSQL connection settings and connects to the database. A missing or
empty setting, an invalid port, or a failed connection stops startup. It then
creates the raw `matches` and `match_players` tables, the `items` catalog and
`match_player_items` observation table, their indexes, and the analytics views.
It seeds item metadata in the same schema-creation transaction. Schema creation
uses plain SQL in `src/database-schema.ts`; there is no migration framework.
This schema is intended for a fresh database; there is no legacy-data backfill.

Each fetched page is stored in one database transaction. Existing match and
player primary keys are ignored, which makes overlapping fetches safe. Item
observations are derived from the persisted player snapshots in that same
transaction, so a conflicting fetch cannot change items on an unchanged raw
player record. Unknown item IDs receive catalog placeholders before
normalization; failures roll back the entire page. The
large `picks_bans` and `ability_upgrades` arrays are intentionally discarded.
All integer values supplied by Valve use PostgreSQL `BIGINT` columns. This is a
deliberate schema-wide rule: Valve can return unusual values outside narrower
integer ranges, including from custom or malformed matches, so fields are not
sized from their expected gameplay values. Incoming values must still be safe
JavaScript integers, which fit comfortably inside `BIGINT`. Existing schemas
are not altered automatically; table changes are handled manually. Analytics
views and the normalization function are replaced at startup, and the pinned
catalog is upserted without removing historical or unknown IDs.

## End-of-match item analytics

Use `player_item_results` for item queries and `player_results` for player
populations and win/loss results. Raw slots are retained for inspection and
explicit slot or copy-count questions.

| Relation | Row meaning |
| --- | --- |
| `items` | A raw item ID with name, category, optional neutral tier, and canonical item ID |
| `match_player_items` | One canonical item observed for one `(match_id, player_slot)` |
| `player_results` | One player-match, including players with no items |
| `player_item_results` | One canonical player-item occurrence with names, categories, filters, and outcomes |

The primary key `(match_id, player_slot, item_id)` prevents duplicate copies
from inflating counts. All six inventory slots, three backpack slots, and both
neutral fields contribute to the same item set. Zero and missing slots do not
produce observations. Two players holding the same item produce two rows.

Persistent upgrades count for the recipient. Scepter (108), Blessing (271),
Roshan Blessing (727), and the `aghanims_scepter` flag map to Scepter (108).
Shard (609), its consumable variant (725), and `aghanims_shard` map to Shard
(609). Moon Shard (247) and `moonshard` map to Moon Shard (247). A held item
plus its reported upgrade still produces only one row. Recipes remain separate.
`observed_held` records a positive slot observation; `upgrade_reported` retains
the corresponding flag, including NULL for unknown or inapplicable. These fields
do not establish who purchased an item or whether the upgrade was purchased,
gifted, or otherwise granted. Sold items and ordinary consumed items are not
reconstructed from the final snapshot.

The data server also seeds `heroes`, `game_modes`, and `lobby_types` reference
tables. Each contains its numeric ID, internal name, display name, and
`name_aliases`; items gain the same alias array. Curated nicknames live in
`src/reference-catalog.ts` and `src/item-catalog.ts`, keyed by internal names.
Startup updates reference metadata transactionally alongside the item catalog.
Existing databases receive the new tables and item alias column automatically;
match rows are preserved. Unknown hero/mode/lobby IDs remain valid in match
data, so use LEFT JOIN when adding names to query results.

The query server loads these tables at startup to resolve names before SQL
generation. Restart it after updating the catalogs, and grant its read-only role
SELECT on the new tables. See [name resolution](../dota-query-server/README.md#name-resolution)
for matching and ambiguity behavior.

Names, IDs, and classifications come from the pinned
[`dotaconstants` 10.8.0](https://github.com/odota/dotaconstants) package; startup
does not download metadata. Categories are `regular`, `recipe`,
`neutral_artifact`, `neutral_enchantment`, `neutral_token`, and `unknown`.
Neutral tiers identify artifacts and `enhancement_` names identify enchantments;
classification is independent of which slot held the item. Distinct item IDs
are retained even when their names or tiers resemble one another. Incomplete
metadata (including some retired neutral items) is classified as `unknown`,
not guessed from a zero price. Unknown IDs are displayed as `Unknown item ID`
and remain in all-item results. Review catalog/classification changes when
updating the pinned package. If canonical mappings change, stored observations
must also be rebuilt from raw snapshots; changing metadata alone does not
renormalize existing rows.

`team_won` uses Radiant slots 0-4 and Dire slots 128-132; a missing winner or
nonstandard slot yields NULL. `won` additionally applies the existing personal
loss rule for leaver statuses 2-6; statuses 0-1 follow the team result, and
missing/invalid statuses yield NULL. Filter `won IS NOT NULL` for personal
win rates. A win-rate-only query can use any positive item observation.

`item_snapshot_complete` means all eleven slot fields and all three upgrade
flags were supplied. For use rates, apply this filter to both the item numerator
and the `player_results` denominator, together with identical population and
outcome filters. This includes explicitly empty inventories and excludes
unknown snapshots. Use the same completeness filter for claims that a player
did not have an item; missing observations alone do not establish absence.

For example, the win rate of each item appearing in at least 100 player-games:

```sql
SELECT item_id, item_name, item_category,
  COUNT(*) AS player_match_occurrences,
  ROUND(100.0 * AVG(won::int), 2) AS win_rate_percent
FROM public.player_item_results
WHERE start_time >= CURRENT_TIMESTAMP - INTERVAL '30 days'
  AND won IS NOT NULL
GROUP BY item_id, item_name, item_category
HAVING COUNT(*) >= 100
ORDER BY player_match_occurrences DESC, item_id;
```

All item categories are included by default. Use an `item_category` filter for
a neutral-only or regular-item leaderboard. For a threshold of 100 distinct
matches, use `HAVING COUNT(DISTINCT match_id) >= 100`; win rate still counts
individual player occurrences.

Start the data server before the query server so the latter can discover the
new relations. Ensure its read-only role has SELECT on the new tables and views;
see the [query server role setup](../dota-query-server/README.md#read-only-boundaries).

Run `npm test` to execute ingestion, normalization, and example-query tests in
an isolated in-memory PostgreSQL engine (PGlite), plus unit tests. Tests do not
read `.env` or contact your database. Run `npm run build` to compile the server.

## Polling

Every Valve request uses the next API key from a round-robin rotation. At least
two unique keys are required, retries rotate keys too, and duplicate keys are
rejected so the same key is never used for consecutive requests. Before each
request, the console logs its non-secret key number and how many seconds have
passed since that key was last used by the current process.

During startup, a full page means the initial cursor is behind. The server waits
five seconds, refreshes its approximate cursor, and may intentionally skip
matches until a request returns fewer than 100. This avoids an immediate burst
of catch-up requests.

Once caught up, polling timing adjusts gradually to target about 90 matches per
request, with normal waits constrained to 2–6 seconds. A full 100-match page
does not immediately change the timing. Five consecutive full pages indicate a
sustained backlog and reduce the polling delay by 10%. Every additional five
consecutive full pages reduce it by another 10%. Any page below 100 resets the
full-page streak. Steady-state polling never skips matches or performs an
immediate catch-up burst.

The console emits one summary line per successful fetch containing its match
count, polling adjustment, and any behind/caught-up transition. Failed requests
use exponential backoff beginning at six seconds, and a Valve `Retry-After`
response is honored when it requires a longer wait. Rate limits are tracked
across all Valve endpoints and API keys. If the server receives 10 HTTP 429
responses within a rolling 10-minute window, it stops instead of retrying.

Valve fetching and PostgreSQL storage have separate failure handling. A
transient storage failure retries the already-fetched page without making
another Valve request. Non-retryable data or schema errors include available
PostgreSQL error metadata in the log and shut down the server instead of
retrying forever. The status endpoint exposes the latest failure as
`lastError`.

## Run it

1. Put at least two unique Valve Web API keys and the required PostgreSQL
   connection settings in `.env`:

   ```env
   STEAM_API_KEYS=your_first_api_key,your_second_api_key

   # postgres database connection info
   PGHOST=localhost
   PGPORT=5432
   PGDATABASE=your_database_name
   PGUSER=postgres
   PGPASSWORD=your_database_password
   ```

   All five PostgreSQL variables must be present and non-empty. `PGPORT` must
   be an integer from 1 through 65535.

2. Install dependencies and start the server:

   ```powershell
   npm install
   npm start
   ```

The server listens on port `3000` by default. Set `PORT` in `.env` to use
another port.
