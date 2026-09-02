import { type FormEvent, type KeyboardEvent, useState } from "react";

const DEFAULT_QUERY = `SELECT
  match_id,
  start_time,
  radiant_win,
  radiant_score,
  dire_score
FROM matches
ORDER BY start_time DESC
LIMIT 25;`;

interface QueryColumn {
  dataTypeId: number;
  name: string;
}

interface QueryResult {
  columns: QueryColumn[];
  command: string;
  durationMs: number;
  rowCount: number;
  rows: unknown[][];
  truncated: boolean;
}

interface ErrorResponse {
  error?: string;
}

function isQueryResult(value: unknown): value is QueryResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<QueryResult>;
  return (
    Array.isArray(candidate.columns) &&
    Array.isArray(candidate.rows) &&
    typeof candidate.durationMs === "number" &&
    typeof candidate.rowCount === "number" &&
    typeof candidate.truncated === "boolean"
  );
}

function getResponseError(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const error = (value as ErrorResponse).error;
  return typeof error === "string" && error.length > 0 ? error : null;
}

function formatCell(value: unknown): string {
  if (value === null) {
    return "NULL";
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

function App() {
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  async function runQuery(event?: FormEvent): Promise<void> {
    event?.preventDefault();

    if (isRunning || query.trim().length === 0) {
      return;
    }

    setIsRunning(true);
    setError(null);

    try {
      const response = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const responseText = await response.text();
      let payload: unknown;

      try {
        payload = JSON.parse(responseText) as unknown;
      } catch {
        throw new Error(
          response.ok
            ? "Query server returned an invalid response."
            : `Query failed with HTTP ${response.status}. Is the query server running?`,
        );
      }

      if (!response.ok) {
        throw new Error(
          getResponseError(payload) ?? `Query failed with HTTP ${response.status}.`,
        );
      }

      if (!isQueryResult(payload)) {
        throw new Error("Query server returned an unexpected response shape.");
      }

      setResult(payload);
    } catch (caughtError: unknown) {
      setError(
        caughtError instanceof Error ? caughtError.message : String(caughtError),
      );
    } finally {
      setIsRunning(false);
    }
  }

  function handleEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <main className="app-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Dota Stats</p>
          <h1>SQL console</h1>
        </div>
        <p className="read-only-badge">Read-only</p>
      </header>

      <form className="query-panel" onSubmit={(event) => void runQuery(event)}>
        <label htmlFor="sql-query">PostgreSQL query</label>
        <textarea
          id="sql-query"
          name="query"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleEditorKeyDown}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
        <div className="query-actions">
          <span>Ctrl/⌘ + Enter to run</span>
          <button
            type="submit"
            disabled={isRunning || query.trim().length === 0}
          >
            {isRunning ? "Running…" : "Run query"}
          </button>
        </div>
      </form>

      <section className="results-panel" aria-busy={isRunning}>
        <div className="results-heading">
          <h2>Results</h2>
          <p role="status">
            {isRunning
              ? "Running query…"
              : result !== null && !error
                ? `${result.rowCount.toLocaleString()} rows · ${result.durationMs.toLocaleString()} ms${result.truncated ? " · limited to 1,000 rows" : ""}`
                : ""}
          </p>
        </div>

        {error ? (
          <div className="message error-message" role="alert">
            <strong>Query failed</strong>
            <span>{error}</span>
          </div>
        ) : result === null ? (
          <p className="message empty-message">
            Run a query to inspect the match data.
          </p>
        ) : result.columns.length === 0 ? (
          <p className="message empty-message">The query returned no columns.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {result.columns.map((column, columnIndex) => (
                    <th key={`${column.name}-${columnIndex}`} scope="col">
                      {column.name || `column_${columnIndex + 1}`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {result.columns.map((column, columnIndex) => {
                      const value = row[columnIndex];
                      return (
                        <td
                          key={`${column.name}-${columnIndex}`}
                          className={value === null ? "null-value" : undefined}
                        >
                          {formatCell(value)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            {result.rows.length === 0 ? (
              <p className="message empty-message">The query returned no rows.</p>
            ) : null}
          </div>
        )}
      </section>
    </main>
  );
}

export default App;
