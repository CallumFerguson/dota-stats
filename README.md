# Dota Stats

Dota Stats is split into three independent applications with one shared
PostgreSQL database:

```text
Valve Web API
      │
      ▼
dota-data-server ──writes──▶ PostgreSQL ◀──reads── dota-query-server ◀──/api── dota-stats-client
```

| Project | Responsibility | Default port |
| --- | --- | --- |
| [`dota-data-server`](./dota-data-server/) | Fetch match data from Valve, own the database schema, and insert new matches and players | `3000` |
| [`dota-query-server`](./dota-query-server/) | Run bounded, read-only queries against the populated database and expose the client API | `3001` |
| [`dota-stats-client`](./dota-stats-client/) | Provide the temporary Vite/React SQL console and render query results | `5173` |

The boundaries are intentional. `dota-data-server` only ingests data. The
client never knows about or contacts that service; it talks only to
`dota-query-server`. The query server connects to the same database but does
not create schemas or write records.

## Database access

Give the two servers different PostgreSQL roles:

- `dota-data-server` needs permission to create its schema and insert match
  data.
- `dota-query-server` should use a dedicated role limited to `CONNECT`, schema
  `USAGE`, and `SELECT`. It also enforces read-only transactions and read-only
  PostgreSQL sessions in code.

See the [query server README](./dota-query-server/README.md) for an example role
setup. The SQL console is a temporary development tool and should not be
exposed to an untrusted network.

## Local development

Each directory is a standalone npm project with its own dependencies and
commands; there is no root workspace to install.

Run each long-lived application in a separate terminal.

1. Start PostgreSQL and configure `dota-data-server` as described in its
   [README](./dota-data-server/README.md).
2. Start the ingestion service:

   ```powershell
   cd dota-data-server
   npm install
   npm start
   ```

3. Configure `dota-query-server` with the same host and database but a
   read-only PostgreSQL user, then start it:

   ```powershell
   cd dota-query-server
   npm install
   npm start
   ```

4. Start the client:

   ```powershell
   cd dota-stats-client
   npm install
   npm run dev
   ```

5. Open <http://localhost:5173>. The Vite development server proxies `/api` to
   the query server on `127.0.0.1:3001`.

The ingestion service does not need to be running for existing database rows
to be queried, but PostgreSQL and the query server do.

## Validation

Run checks from each project directory:

```powershell
cd dota-data-server
npm test
npm run build

cd ../dota-query-server
npm test
npm run build

cd ../dota-stats-client
npm run lint
npm run build
```
