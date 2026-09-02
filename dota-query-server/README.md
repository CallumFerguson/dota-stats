# Dota Query Server

This TypeScript server is the read-only API for the Dota Stats client. It
connects to the PostgreSQL database populated by `dota-data-server`, executes
temporary SQL-console queries, and returns tabular JSON results. It never calls
Valve, creates database objects, or writes match data.

## Read-only boundaries

Every submitted query is wrapped as a result-producing subquery, limited to
1,000 returned rows, and run in a `READ ONLY` transaction with a 10-second
statement timeout. The PostgreSQL connection also starts with
`default_transaction_read_only=on`, and the transaction is rolled back after
both successful and failed queries. The server discards the PostgreSQL
connection after each submitted query so session-level state cannot leak into
another request.

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

This arbitrary-SQL endpoint is a temporary development tool. Even `SELECT`
queries can be expensive or call functions with side effects outside ordinary
tables, so do not expose this server to an untrusted network.

## Configuration

Copy `.env.example` to `.env` and fill in the same database location used by
`dota-data-server`, but use the dedicated read-only database role.

| Variable | Required | Description |
| --- | --- | --- |
| `PGHOST` | Yes | PostgreSQL host |
| `PGPORT` | Yes | PostgreSQL port |
| `PGDATABASE` | Yes | Database populated by `dota-data-server` |
| `PGUSER` | Yes | Dedicated read-only PostgreSQL role |
| `PGPASSWORD` | Yes | Password for the read-only role |
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

Send JSON containing one result-producing SQL query:

```json
{
  "query": "SELECT match_id, radiant_win FROM matches ORDER BY match_id DESC LIMIT 5"
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
  "truncated": false
}
```

PostgreSQL `BIGINT` values are strings so they do not lose precision in JSON.
The query must fit within 50,000 UTF-8 bytes, cannot use parameter placeholders,
and must be valid inside a SQL subquery. If more than 1,000 rows are produced,
the response contains the first 1,000 and sets `truncated` to `true`.

Try a request from PowerShell after the server starts:

```powershell
$body = @{ query = 'SELECT COUNT(*) AS match_count FROM matches' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3001/api/query -ContentType application/json -Body $body
```
