# Dota Stats Client

This Vite, React, and TypeScript app is a temporary browser UI for checking
that the Dota Stats services are connected. It provides a SQL textarea, sends
the query to `dota-query-server`, and displays the returned rows in a table.

The client has no database credentials and never communicates with
`dota-data-server` or Valve.

Vite 8 requires Node.js `^20.19.0 || >=22.12.0`.

## Run it

Start `dota-query-server` first. Then install the client dependencies and run
the Vite development server:

```powershell
npm install
npm run dev
```

Open <http://localhost:5173>. During development, Vite proxies relative `/api`
requests to `http://127.0.0.1:3001`, so no client environment variables or CORS
configuration are needed.

The editor starts with a sample query. Select **Run query** or press
Ctrl/Command+Enter to send it. The page displays loading and error states,
query duration, whether results were truncated to the 1,000-row server limit,
and the result columns and rows.

## Commands

```powershell
npm run dev      # Start the development server on port 5173
npm run lint     # Check the TypeScript and React source
npm run build    # Type-check and create the production build in dist
npm run preview  # Preview the production build locally
```

For a deployed build, route `/api` on the same origin to `dota-query-server`.
The temporary client deliberately has no configurable direct database or
ingestion-server connection.
