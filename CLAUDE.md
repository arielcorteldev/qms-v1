# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Queue Management System for a single office (City Civil Registrar's Office), run on a local network. No database, no build step, no test suite, no linter. Deployed on a Windows PC as a service via NSSM.

## Commands

All commands run from `backend/`:

```bash
npm install
ADMIN_PIN=1234 npm start      # node server.js
ADMIN_PIN=1234 npm run dev    # node --watch server.js (auto-restart)

$env:ADMIN_PIN="1234"; npm start   # Windows PowerShell equivalent
```

Environment variables:
- `ADMIN_PIN` — required for any admin action; if unset, the server starts but refuses every admin event (`code: 'not-configured'`).
- `PORT` — default 3000. Server binds to `0.0.0.0`.
- `QMS_STATE_FILE` — default `backend/state.json`.

There are no automated tests. After every change, verify manually: run the server and open `/admin.html`, `/counter.html?c=1`, and `/display.html` in separate tabs. Start the queue, call a regular and a priority ticket, mark one done, and confirm all three views update. Then restart the server and confirm the queue restores.

## Architecture

**Single-file backend** ([backend/server.js](backend/server.js)): Express serves `frontend/` statically (with a catch-all to `index.html`) and Socket.io carries all app traffic. There is no REST API.

**State model** — one in-memory `state` object, the sole source of truth:
- Two lanes, `regular` and `priority`, each with a sequential `next` counter and a `returned` pool. `takeNextFromLane` re-issues the smallest returned number before advancing `next`. Tickets display as `"12"` (regular) or `"P3"` (priority) via `ticketDisplay`.
- `activeNumbers[counterId] = { lane, seq, display }` — at most one active ticket per counter.
- `counters` (fixed ids 1–3, renameable, enable/disable), `log` (newest first, capped at 200), `completedNumbers`, `servedCounts`, `started`.

**Mutation flow**: every socket handler mutates `state` then calls `broadcastState()`, which both persists to disk (`saveState`) and emits `state` to all clients (`publicState()`). New handlers must end with `broadcastState()` so persistence is not skipped. Clients are dumb renderers of the full `state` payload; they never compute queue logic themselves.

**Socket events**:
- Counter (no auth): `counter:callNext`, `counter:callPriority`, `counter:markDone` with `{ counterId }`. Errors are sent back as `socket.emit('error', msg)`. Calling regular while holding a priority ticket auto-cancels it and returns it to the priority pool.
- Admin (PIN-protected): `queue:start`, `queue:reset`, `admin:renameCounter`, `admin:toggleCounter`. Wrapped in `adminOnly(socket, handler)`; client sends `{ ...data, pin }` with an ack callback and receives `{ ok }` or `{ ok: false, code: 'bad-pin'|'locked'|'not-configured', error }`. PIN check is timing-safe, with per-IP lockout (5 failures → 60s). Auth must stay server-side — any LAN client can emit events directly.
- Server → clients: `state` (full snapshot, also sent on connect) and `number:called` (drives the display's announcement; keeps legacy `number` key alongside `ticket`/`lane`).

**Persistence**: state is written atomically (write `state.json.tmp`, then rename) on every change, wrapped as `{ savedDate, state }`. On boot it is restored only if `savedDate` is today (server local time) and passes a shape check; otherwise a fresh queue starts. Restored state is merged over `freshState()` so new fields get defaults — keep that pattern when adding fields.

**Frontend** ([frontend/](frontend/)): plain HTML pages with inline `<script>` that load `/socket.io/socket.io.js`.
- `counter.html?c=<id>` — counter operator; keyboard shortcuts Enter/Space (call next), P (call priority), D (done).
- `admin.html` — admin panel; prompts for PIN in a modal, caches it in `sessionStorage` (`qmsAdminPin`), and retries the pending action after re-prompting on `bad-pin`/`locked`.
- `display.html` — wall screen; speaks called numbers with the Web Speech API.
- `index.html` — hub linking to the views.

Styling: every page links `css/tokens.css` (design tokens/variables) then `css/styles.css` (all component and page styles, scoped by wrapper classes `.hub`, `.counter-page`, `.admin-page`, `.display-screen`).

[presentation.md](presentation.md) is a non-technical overview for office stakeholders.

## Constraints
- Keep the stack as is: vanilla HTML/CSS/JS, no frameworks, no build step. Ask before adding any npm dependency.
- LAN-only. The display may run without internet, so no CDN links, web fonts, or external calls. All assets stay local.
- All queue logic stays in server.js. Frontend pages only render the state they receive.
- Don't change the NSSM service setup or production config; tell me what needs changing and I'll do it.
- New socket events and state fields must follow the existing patterns (broadcastState, freshState defaults, adminOnly for admin actions).