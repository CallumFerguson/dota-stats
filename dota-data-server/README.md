# Dota Data Server

This TypeScript server uses Valve's recent match history to find an approximate
current match sequence number. It then requests pages of up to 100 newer
matches, advances its sequence cursor, and stores the matches in PostgreSQL.

Before the HTTP server starts or any Valve request is made, the app validates
its PostgreSQL connection settings and connects to the database. A missing or
empty setting, an invalid port, or a failed connection stops startup. It then
creates the `matches` and `match_players` tables and supporting index when they
do not already exist. Schema creation uses plain SQL in `src/database-schema.ts`;
there is no migration framework.

Each fetched page is stored in one database transaction. Existing match and
player primary keys are ignored, which makes overlapping fetches safe. The
large `picks_bans` and `ability_upgrades` arrays are intentionally discarded.
All integer values supplied by Valve use PostgreSQL `BIGINT` columns. This is a
deliberate schema-wide rule: Valve can return unusual values outside narrower
integer ranges, including from custom or malformed matches, so fields are not
sized from their expected gameplay values. Incoming values must still be safe
JavaScript integers, which fit comfortably inside `BIGINT`. Existing schemas
are not altered automatically; schema changes are handled manually.

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
