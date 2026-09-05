# Dota Stats Client

This Vite, React, and TypeScript app is a temporary browser UI for checking
that the Dota Stats services are connected. It accepts a plain-language match
question, sends it to `dota-query-server`, and displays the returned rows in a
table, with the final executed SQL in an expandable section below the results.

The client has no database credentials or full database schema description.
It receives the executed SQL with successful results. It does not communicate with `dota-data-server`, OpenRouter,
or Valve; all query generation and database access happens in
`dota-query-server`.

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

The text area starts with a sample question. Select **Ask question** or press
Ctrl/Command+Enter to send it. The page displays loading and error states,
query duration, whether results were truncated to the 1,000-row server limit,
and the result columns and rows. **Executed SQL** shows the exact statement
run by PostgreSQL, including the server's row-limit wrapper, and can be collapsed.

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
