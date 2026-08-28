# Dota Data Server

This TypeScript server uses Valve's recent match history to find an approximate
current match sequence number. It then requests pages of up to 100 newer
matches, advances its sequence cursor, and saves every response as a new
timestamped JSON file in `data`.

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
count, saved JSON path, polling adjustment, and any behind/caught-up transition.
Empty successful responses are also saved. Failed requests use exponential
backoff beginning at six seconds, and a Valve `Retry-After` response is
honored when it requires a longer wait.

## Run it

1. Put at least two unique Valve Web API keys in `.env` as a comma-separated
   list:

   ```env
   STEAM_API_KEYS=your_first_api_key,your_second_api_key
   ```

2. Install dependencies and start the server:

   ```powershell
   npm install
   npm start
   ```

The server listens on port `3000` by default. Set `PORT` in `.env` to use
another port.
