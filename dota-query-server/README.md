# Dota Query Server

This TypeScript server is the read-only API for the Dota Stats client. It turns
plain-language questions into SQL with OpenRouter, runs the generated query
against the PostgreSQL database populated by `dota-data-server`, and returns
tabular JSON results. It never calls Valve, creates database objects, or writes
match data.

## Read-only boundaries

The browser sends only a plain-language question. The server discovers the
tables/views, columns, and relation descriptions visible to its database role
and constructs the OpenRouter prompt itself. The schema description stays on
the server; successful responses include
the final SQL statement executed against PostgreSQL. System policy and JSON-encoded user text are placed in separate
chat roles, and the prompt explicitly labels all user-generated content as
untrusted request data. The model must return strict structured output that is
either one query or a rejection. It is instructed to reject anything that is
not a read-only request.

Generated output is not trusted. Before PostgreSQL sees it, the server rejects
non-`SELECT` statements, multiple statements, data-changing keywords,
`SELECT INTO`, row locks, and known state-changing functions. Every accepted
query is then wrapped as a result-producing subquery, limited to 1,000 returned
rows, and run in a `READ ONLY` transaction with a 10-second statement timeout.
The PostgreSQL connection also starts with `default_transaction_read_only=on`,
and the transaction is rolled back after both successful and failed queries.
The server discards the PostgreSQL connection after each generated query so
session-level state cannot leak into another request.

The database login is the authoritative security boundary. Configure `PGUSER`
as a dedicated role with only `CONNECT`, schema `USAGE`, and `SELECT` on the
tables the client may inspect. Do not reuse the write-capable role used by
`dota-data-server`. A database administrator can create a suitable role with
commands like these, replacing the names and password for the local database.
For future tables, identify the role that owns objects created by the ingestion
service in the default-privilege command:

```sql
CREATE ROLE dota_stats_reader LOGIN PASSWORD 'replace-me';
GRANT CONNECT ON DATABASE your_database TO dota_stats_reader;
GRANT USAGE ON SCHEMA public TO dota_stats_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO dota_stats_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE your_ingestion_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO dota_stats_reader;
ALTER ROLE dota_stats_reader SET default_transaction_read_only = on;
```

The PostgreSQL permissions remain the authoritative boundary. Model prompts
and SQL validation are defense in depth, not replacements for the restricted
database role. Schema metadata and each user's question are sent to the
configured OpenRouter model/provider, so configure OpenRouter's data handling
to match your deployment requirements.

## Item queries

The prompt prefers `player_item_results` for item statistics. This view already
combines inventory, backpacks, both neutral fields, and reported persistent
upgrades into one row per player-match and canonical item. Names and categories
come from the seeded item catalog. Queries group and aggregate these rows;
they do not need to unpivot slots, deduplicate copies, join match outcomes, or
union consumed-upgrade flags.

"Show the win rate of each item that is in at least 100 games" defaults to the
trailing 30 days, `won IS NOT NULL`, and `HAVING COUNT(*) >= 100` on this view.
The count is player-match occurrences. An explicit request for distinct matches
uses `COUNT(DISTINCT match_id)` for the threshold. All item categories are
included unless requested otherwise. Use rate is only added when requested;
its denominator uses complete snapshots in `player_results`, including empty
inventories, with the same filters as the numerator. See the
[data schema and example SQL](../dota-data-server/README.md#end-of-match-item-analytics).

After recreating the database, start `dota-data-server` first to create and seed
the new schema. The SELECT grants above cover views as well as tables; repeat
the grant on existing objects if the owner role's default privileges were not
configured before creation. Restart the query server after schema changes so
its startup schema discovery includes the new relations and descriptions.

## Configuration

Copy `.env.example` to `.env` and fill in the same database location used by
`dota-data-server`, but use the dedicated read-only database role. Also provide
an OpenRouter API key and a model that supports structured outputs.

| Variable | Required | Description |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Yes | Server-side OpenRouter API key; never sent to the client |
| `OPENROUTER_MODEL` | Yes | OpenRouter model ID with structured-output support |
| `OPENROUTER_PROVIDER` | No | Restrict requests to one provider slug and disable provider fallback |
| `OPENROUTER_REASONING_EFFORT` | No | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; defaults to `low` |
| `OPENROUTER_MAX_COMPLETION_TOKENS` | No | Model output ceiling; defaults to `2000` |
| `OPENROUTER_TIMEOUT_MS` | No | OpenRouter request timeout; defaults to `30000` |
| `PGHOST` | Yes | PostgreSQL host |
| `PGPORT` | Yes | PostgreSQL port |
| `PGDATABASE` | Yes | Database populated by `dota-data-server` |
| `PGUSER` | Yes | Dedicated read-only PostgreSQL role |
| `PGPASSWORD` | Yes | Password for the read-only role |
| `PGSCHEMA` | No | Schema made available to the model; defaults to `public` |
| `PORT` | No | HTTP port; defaults to `3001` |

The HTTP server binds to `127.0.0.1`.

## Run it

```powershell
npm install
npm start
```

For a compiled run:

```powershell
npm run build
npm run start:compiled
```

Run the unit tests with `npm test`.

## API

### `GET /api/health`

Returns `{ "status": "ok" }` when the server can query PostgreSQL.

### `POST /api/query`

Send JSON containing one plain-language, read-only analytics question:

```json
{
  "question": "Show the five newest matches and which side won each one."
}
```

Successful responses preserve column order and duplicate column names by
returning rows as arrays:

```json
{
  "columns": [
    { "name": "match_id", "dataTypeId": 20 },
    { "name": "radiant_win", "dataTypeId": 16 }
  ],
  "command": "SELECT",
  "durationMs": 12.4,
  "rowCount": 1,
  "rows": [["123456789", true]],
  "sql": "SELECT * FROM (\nSELECT match_id, radiant_win FROM matches ORDER BY start_time DESC LIMIT 5\n) AS query_result\nLIMIT 1001",
  "truncated": false,
  "assumptions": "Treated Radiant as the first team and Dire as the second team."
}
```

PostgreSQL `BIGINT` values are strings so they do not lose precision in JSON.
The `sql` field contains the exact executed statement, including the server's
row-limit wrapper. It fetches up to 1,001 rows to detect truncation before
returning at most 1,000 rows to the client.
The optional `assumptions` field is included when the question generator made a
material assumption while interpreting an underspecified question.
The question must fit within 10,000 UTF-8 bytes. Requests that are not clearly
read-only are rejected. If more than 1,000 rows are produced, the response
contains the first 1,000 and sets `truncated` to `true`.

Try a request from PowerShell after the server starts:

```powershell
$body = @{ question = 'How many matches are stored?' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3001/api/query -ContentType application/json -Body $body
```
