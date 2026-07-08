# Real-Time Collaborative Code Editor with Sandboxed Execution

A collaborative code editor with real-time multi-cursor sync (CRDT-based) and secure sandboxed code execution — built to explore distributed state management and execution isolation at scale.

🚧 Status: In Progress — single-user editor with sandboxed execution is working locally; real-time multi-tab sync is now live via Yjs + y-websocket + the standalone WebSocket server, with independent per-room documents via URL-based room routing; live multi-cursor presence (via Yjs awareness) is also working; Postgres (via Prisma + Neon) is connected and now wired into the full connection lifecycle — a room's persisted state, if any, loads into the in-memory `Y.Doc` before a new client's initial sync, edits are written back with a per-room debounced snapshot, and a room's last disconnecting client now flushes that snapshot immediately instead of waiting out the debounce window, so state now survives a server restart; code execution now runs through its own standalone service, `exec-server/` — the Next.js app calls `exec-server/`, which is currently a bare passthrough proxy to Piston with no queue yet; Redis pub/sub for cross-instance sync is scaffolded (client, channel naming, and a connection hook on each room's `Y.Doc`) but not implemented yet — see [Cross-Instance Sync](#cross-instance-sync-scaffold).

---

## Overview

Pair programming, technical interviews, and classroom coding often happen over screen-share with no shared, executable environment. This project solves that with a lightweight, multiplayer code editor where multiple users can edit the same file simultaneously and run code safely — without relying on `eval()` or client-side execution, which is a common security shortcut in similar portfolio projects.

What makes it technically interesting: keeping edit state consistent across multiple concurrent users without conflicts (via CRDTs) and running arbitrary, untrusted code safely without compromising the host system (via sandboxed execution). These are two distinct hard problems — most tutorials solve neither well.

---

## Demo

*Coming soon — will be added once core editing and execution flows are functional.*

**Live link:** Coming soon

---

## Features

- [x] Real-time multi-tab sync (Yjs CRDT over `y-websocket`, independent rooms via URL routing)
- [x] Real-time multi-cursor editing
- [x] Presence indicators (who's online, where they're looking) — via Yjs's awareness protocol
- [x] Sandboxed code execution (JavaScript, TypeScript, Python, Java, C++ via a self-hosted Piston instance)
- [x] Room persistence (reload without losing state) — `Room` schema + migration in place; loading persisted state into a room on connect, writing it back via a per-room debounced snapshot, and flushing immediately on a room's last disconnect, are all wired in ([details](#persistence))

---

## Tech Stack

| Layer | Technology | Why |
| --- | --- | --- |
| Frontend | Next.js (App Router) | An industry-standard React framework that provides a fast development experience for building the editor interface and collaborative room pages. |
| Code Editor | Monaco / CodeMirror | Free, open-source, and battle-tested editor components with built-in syntax highlighting and a rich editing experience. |
| Sync Engine | Yjs | A CRDT-based library that automatically resolves concurrent edits without conflicts, eliminating the need for custom conflict resolution logic. |
| Realtime Server | Node.js WebSocket Server (separate from Next.js) | Since Next.js API routes are not designed for long-lived connections, a dedicated WebSocket server provides persistent, low-latency, bidirectional communication. |
| Caching / Pub-Sub | Redis | Broadcasts room state across multiple server instances, enabling efficient horizontal scaling. |
| Persistence | PostgreSQL (Neon) via Prisma | Provides durable storage, ensuring rooms and documents persist across server restarts; Neon gives a managed, serverless Postgres instance with no infra to run, and Prisma gives typed schema/migrations. |
| Execution Server | Node.js / Express (separate from both Next.js and the WS server) | Code execution is bursty and resource-heavy; a dedicated service keeps it from sharing a process (and failure domain) with either the always-on editor UI or the low-latency sync server. |
| Code Execution | Piston (Open-Source Sandboxed Execution Engine) | Enables secure, multi-language code execution without building a custom Docker-based sandbox, allowing development effort to focus on real-time collaboration and scalability instead of execution isolation. |

---

## Architecture
*Diagram image coming soon — described in text below in the meantime.*

The Next.js frontend holds a `Y.Doc` per editor session, bound to the Monaco editor via `y-monaco`. A `WebsocketProvider` (from `y-websocket`) connects that same `Y.Doc` to the standalone Node.js WebSocket server in `server/`, which speaks the Yjs sync protocol (via `y-websocket`'s server-side `setupWSConnection` utility) instead of a custom message format. Landing on `/` shows a room-join screen where you enter a room ID or generate a new one; that ID becomes the dynamic route segment for `/room/[roomId]` and is passed as the Yjs document name to both the `Y.Doc` setup and the `WebsocketProvider`, so each room gets its own independent, isolated CRDT document — two tabs on the same room ID converge in real time, and a tab on a different room ID never sees those edits. Each client also broadcasts live cursor/selection presence via Yjs's awareness protocol (see [Presence: Multi-Cursor Awareness](#presence-multi-cursor-awareness) below). On each new connection, the WS server now loads that room's persisted state (if any) from Postgres into the in-memory `Y.Doc` before the connecting client's initial sync, and every subsequent edit is written back with a per-room debounced snapshot (see [Persistence](#persistence) below), so state now survives a server restart.

**WebSocket server:** deployed on Railway, URL: `collabrativecodeeditor-production.up.railway.app`

Code execution has been pulled out of the Next.js app into its own standalone service, `exec-server/` (see [Execution Service](#execution-service) below). The Next.js `/api/execute` route still does the language→Piston mapping the editor relies on, but now forwards the mapped request to `exec-server/`'s `/execute` endpoint instead of calling Piston directly; `exec-server/` in turn proxies straight through to Piston. The execution path is now Next.js → `exec-server/` → Piston.

**Why editing sync and code execution are separate systems, and why execution is now its own service rather than living inside the Next.js app:**
There are deliberately three separate failure domains now: the Next.js app (editor UI), the WebSocket server (`server/`, editing sync), and the execution service (`exec-server/`, code running). Editing sync needs to be low-latency and always-on — every keystroke matters, and a slow or crashed execution request must never degrade it for every user in the room. Execution is bursty, resource-heavy, and runs untrusted input — it needs strict isolation not just from the sync path but from the app server itself, since it's the piece most likely to need its own scaling, queueing, and resource limits (CPU/memory/time caps) as usage grows. Keeping all three decoupled lets each scale, fail, and recover independently, instead of one noisy neighbor taking the others down with it.

---

## Key Technical Challenges

- [ ] **CRDT conflict resolution** — Ensuring multiple users editing the same line simultaneously converge to the same final state without manual merge logic. Approach: use Yjs's built-in CRDT algorithm rather than implementing operational transform manually; document the tradeoff in a dedicated write-up below.
- [ ] **WebSocket scaling** — A single Node.js WebSocket server can't hold every connection once traffic grows. Approach: use Redis pub/sub so multiple server instances share room state, with clients able to connect to any instance.
- [ ] **Sandboxed execution security** — Running arbitrary user-submitted code without letting it harm the host system or other users. Approach: route all execution through Piston's isolated sandboxes rather than local `eval()` or unrestricted containers, with per-request CPU/memory/time limits.

---

## CRDT vs Operational Transform

*Full write-up to be added once implementation decisions are finalized — this will compare Yjs's CRDT approach against Operational Transform (used by Google Docs), explaining why CRDTs were chosen for this project (no central server required for conflict resolution, simpler offline/reconnect handling) and the tradeoffs involved (larger metadata overhead per edit).*

---

## Real-Time Sync

Yjs is integrated with the Monaco editor in `collab-code-editor/app/components/CodeEditor.tsx`, and is now synced across tabs/clients over the network.

- A `Y.Doc` and `Y.Text` are created per editor session and bound to the Monaco model via `y-monaco`'s `MonacoBinding`, so keystrokes flow into the CRDT.
- A `WebsocketProvider` (from `y-websocket`) connects that same `Y.Doc` to the standalone WebSocket server in `server/`, so edits are broadcast to every other client in the same room and merged via Yjs's CRDT — open the editor in two tabs on the same room and typing in one shows up in the other.
- **Room routing is now live:** the landing page (`/`) lets you type a room ID to join, or click "Create New Room" to generate one, then navigates to `/room/[roomId]`. That `roomId` is used as the Yjs document/room name for both the `Y.Doc` and the `WebsocketProvider`, and `y-websocket`'s server-side `setupWSConnection` keys its in-memory document map by that same name — so each room ID gets its own independent document, and rooms never see each other's edits.
- The env var `NEXT_PUBLIC_WS_URL` (see `collab-code-editor/.env.example`) controls which server the provider connects to — defaults to `ws://localhost:8080` locally, and should point at the deployed Railway/Render URL in production.
- A small connected/connecting/disconnected status dot in the editor toolbar reflects the provider's live connection state (replaces the old temporary debug panel, which has been removed now that real sync is in place).

---

## Presence: Multi-Cursor Awareness

Beyond syncing document contents, each client now broadcasts *where it is* — its cursor position, selection range, display name, and color — so every connected user can see who else is editing and what they're pointing at in real time.

**This is a separate protocol from document sync, on purpose.** Document edits go through Yjs's CRDT sync protocol (`Y.Doc` updates), which is durable and must be replayed/merged correctly even after a client reconnects. Cursor position is ephemeral — nobody needs to know where another user's cursor *was* five minutes ago, only where it is *right now*. Yjs models this as a distinct concept, **awareness**, built on `y-protocols/awareness`. Awareness state is non-persistent, keyed by client ID, and is dropped entirely (with a broadcast to everyone else) as soon as a client disconnects, rather than being merged into document history like a CRDT op would be.

- `WebsocketProvider` (from `y-websocket`) already constructs an `Awareness` instance internally and syncs it over the same WebSocket connection as document updates — a separate message type in the same protocol, not a second connection. `collab-code-editor/app/components/CodeEditor.tsx` reuses `provider.awareness` rather than creating its own.
- On connect, each client picks a random display name (e.g. `"User 4213"`) and a color from a small fixed palette, and sets it via `awareness.setLocalStateField("user", { name, color })`.
- Cursor/selection tracking and decoration rendering is handled by `y-monaco`'s `MonacoBinding`, which accepts the awareness instance as a constructor argument: it listens for local `onDidChangeCursorSelection` events to publish this client's position, and listens for awareness `"change"` events to redraw decorations for every other connected client's position.
- `y-monaco` renders the decorations themselves (as CSS classes keyed by client ID: `yRemoteSelection-<id>`, `yRemoteSelectionHead-<id>`) but doesn't know about color or name labels — those are cosmetic and app-specific. `CodeEditor.tsx` fills that gap by regenerating a `<style>` tag from the current awareness states on every change, mapping each connected client ID to a CSS rule with their color and a `::after` pseudo-element showing their name. Rebuilding the whole stylesheet from scratch (rather than patching it incrementally) means a disconnected client's rule is simply not included next time — no manual cleanup, no lingering cursors.
- On unmount, the local awareness state is explicitly set to `null` before the provider disconnects, so peers see this client's cursor disappear immediately rather than waiting for the server to notice the socket closed. As a second layer of defense, `y-websocket`'s server-side `setupWSConnection` also removes a client's awareness state on the raw WebSocket `close` event, so an abrupt disconnect (closed tab, lost network) is still cleaned up for everyone else even without a graceful unmount.

---

## Persistence

Room documents are persisted to Postgres (hosted on [Neon](https://neon.tech)) via [Prisma](https://www.prisma.io/), from within the `server/` WebSocket server.

**Schema** (`server/prisma/schema.prisma`):

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `String` (`@id`) | The room id from the URL route (`/room/[roomId]`), used directly as the primary key — it's already a stable, unique identifier, so a separate surrogate id would be redundant. |
| `ydocState` | `Bytes?` | Serialized Yjs document state (`Y.encodeStateAsUpdate`). Nullable until the room's first snapshot is written. |
| `createdAt` | `DateTime` | Set once, when the row is first created. |
| `updatedAt` | `DateTime` | Bumped automatically (`@updatedAt`) on every snapshot write. |

**Loading state on connect (implemented).** `server/yjsConnection.js`'s `handleYjsConnection` runs on every new WebSocket connection, before the client is handed to `y-websocket`'s `setupWSConnection`:

1. It upserts a `Room` row for the room id parsed from the connection URL — creating it if this is the first time anyone has connected to that id, or fetching the existing row (including any stored `ydocState`) otherwise. An upsert (rather than find-then-create) avoids a race where two clients opening the same brand-new room simultaneously could both see "not found" and try to create it.
2. If the row has a stored `ydocState`, it's applied (`Y.applyUpdate`) to that room's in-memory `Y.Doc` — the same `WSSharedDoc` instance `y-websocket` keeps per room name.
3. Only then does `setupWSConnection` run, which immediately sends the client "sync step 1" built from the current contents of that in-memory doc.

**This load must happen before step 3, not after.** `setupWSConnection` sends sync step 1 synchronously, from whatever is currently in the in-memory doc — it has no awareness of Postgres. If the Postgres read happened after (or concurrently with) that send, a fast client could complete its initial sync against an empty/stale doc, before the persisted state arrived — the client would render nothing (or an old snapshot in memory from a previous session on the same server run) until some later, unrelated event triggered a re-sync, if ever. Because the DB read is async and `ws` starts feeding buffered socket data to `y-websocket`'s message handler as soon as it's attached, the connection is also paused via `ws.pause()` before the Postgres call and resumed via `ws.resume()` only after the state has been applied and `setupWSConnection` has run — this closes the gap where a client's own first message could otherwise be processed (or its sync step 1 sent) before the loaded state is in the doc.

**Saving state back (implemented).** `server/yjsConnection.js` also attaches a listener to each room's shared `Y.Doc` (once per room, guarded by a `Set`, since `getYDoc` returns the same instance for every connection to that room):

1. Every Yjs `update` event on the doc calls `schedulePersist(roomId, ydoc)`, which clears any pending timer for that room and starts a new one.
2. If 4 seconds pass with no further updates to that room, the timer fires: `Y.encodeStateAsUpdate(ydoc)` is serialized and written to that room's `ydocState` column via `prisma.room.update`.
3. Timers are tracked per room id in a `Map`, so typing in one room never delays (or triggers) a save in another — each room's debounce window is independent.

**Flush on last disconnect (implemented).** `y-websocket`'s `WSSharedDoc` already tracks every open connection for a room in `doc.conns` (a `Map` keyed by socket). `handleYjsConnection` attaches its own `"close"` listener to each socket *after* calling `setupWSConnection` — since `y-websocket` registers its own `"close"` handler first (which deletes the socket from `doc.conns`), listeners fire in registration order, so by the time this one runs, `doc.conns` already reflects the disconnect. If `doc.conns.size === 0`, this was the room's last client, so `flushPersist(roomId, ydoc)` runs immediately: it cancels that room's pending debounce timer (if any) and writes the current doc state to Postgres right away, instead of waiting out the rest of the 4-second window with nobody left to eventually trigger it.

*Race condition this closes:* without this, a room's last edit starts a 4-second debounce timer, and if every client for that room disconnects before the timer fires — or the process exits/restarts during that window — the timer never runs and the last few seconds of edits are lost, even though the disconnect itself was perfectly graceful. Flushing synchronously on the last disconnect means the debounce timer is never the only thing standing between an edit and durable storage once nobody is left to keep resetting it.

Two persistence-related decisions:

- **Auto-create-on-connect (implemented).** A `Room` row is created lazily on first connection to a given room id, rather than requiring rooms to be explicitly provisioned through a separate API call. *Rationale: room ids are freely chosen by users on the landing page (typed or generated) with no pre-registration step, so the WS server is the natural place to guarantee a row exists before state is read or written for that id.*
- **Debounced snapshot, 4-second window (implemented).** Instead of writing to Postgres on every Yjs update (far too frequent — every keystroke would trigger a write), the server debounces snapshot writes to 4 seconds after the *last* edit to a given room. *Why 4 seconds specifically:* it's long enough to collapse a burst of rapid keystrokes (or a paste, or an AI-assisted large edit) into a single write, but short enough that the amount of unsaved work lost if the process crashes stays small and bounded. The trade-off is a direct dial between two costs that move in opposite directions:
  - **Shorter debounce (e.g. 500ms–1s)** → smaller data-loss window if the server crashes mid-session, but more frequent writes to Postgres. A room with continuous typing would issue a write roughly every debounce interval, since each new keystroke keeps resetting the timer only until the user briefly pauses — busy rooms would still batch reasonably well, but idle-then-type-then-idle patterns would write more often and each write recomputes/serializes the *entire* doc state (`Y.encodeStateAsUpdate` returns the full state, not just the delta), so more writes also means more bytes shipped to Neon over time.
  - **Longer debounce (e.g. 15–30s)** → far fewer writes and lower load on the Postgres connection pool (relevant since Neon's pooled connection is shared across all rooms on this server instance), but a bigger window of edits that only exist in-memory and would be lost on an ungraceful crash.
  - 4 seconds was chosen as a middle ground for a pair-programming/interview use case: sessions are typically short-lived and conversational (natural pauses between edits are common), so a few seconds of debounce rarely coincides with a hard crash, while keeping writes infrequent enough not to stress a single shared Postgres connection across many concurrent rooms.
- **Flush-on-last-disconnect (implemented, see above).** Closes the common-case data-loss window (a room simply going idle) without shortening the debounce window itself. A process crash or `kill -9` mid-session, unrelated to any client disconnecting, is still not covered — that would need a graceful-shutdown hook that flushes every room with a pending timer.

### Manual Test Checklist (Persistence)

No automated tests cover the WS server yet, so verify persistence by hand after touching `server/yjsConnection.js` or the Prisma schema. Run the WS server (`cd server && npm run dev`) and frontend (`cd collab-code-editor && npm run dev`) locally for all of these.

1. **Two separate rooms persist independently**
   - [ ] Open `/room/room-a`, type distinct content (e.g. `hello-from-a`).
   - [ ] Open `/room/room-b` in another tab, type different content (e.g. `hello-from-b`).
   - [ ] Close both tabs, wait 5s (past the 4s debounce), then reopen `/room/room-a` — confirm it shows only `hello-from-a`.
   - [ ] Reopen `/room/room-b` — confirm it shows only `hello-from-b`, with no cross-contamination between rooms.

2. **Reopening a room after a server restart restores prior content**
   - [ ] Open a room, type some content, and wait at least 5s (past the 4s debounce) so the snapshot is written to Postgres.
   - [ ] Stop the WS server (`Ctrl+C`) and start it again (`npm run dev`).
   - [ ] Reopen the same room URL — confirm the editor loads the content typed before the restart, not a blank document.

3. **Rapid edits followed by immediate disconnect don't lose data**
   - [ ] Open a room and type or paste a burst of content quickly (well under 4s), then close the tab immediately — before the debounce timer would otherwise fire.
   - [ ] Reopen the same room in a new tab — confirm all the rapid edits are present (the last-disconnect flush should have written them immediately rather than waiting out the debounce).
   - [ ] Restart the WS server and reopen the room once more — confirm the same content is still there, verifying it actually reached Postgres and wasn't just served from the in-memory doc.

---

## Cross-Instance Sync (scaffold)

A single WebSocket server instance holds every room's `Y.Doc` in memory, so today two clients only converge in real time if they happen to land on the *same* instance — the [WebSocket scaling](#key-technical-challenges) problem. The fix is Redis pub/sub: each instance publishes its local updates to a per-room channel and applies updates other instances publish, so clients on different instances still converge. That part is **scaffolded, not implemented** — the pieces exist and are wired together, but the actual publish/subscribe calls are still TODOs.

What's in place, all in `server/`:

- **`redis/client.js`** — two `ioredis` connections (`publisher`, `subscriber`) against `REDIS_URL` (an Upstash TCP endpoint, not the REST API — a pub/sub `SUBSCRIBE` needs a persistent connection, which the REST API can't hold open). Split into two connections because a connection that issues `SUBSCRIBE` can no longer run other commands.
- **`redis/channels.js`** — the channel naming scheme (`syncChannel(roomId)` → `room:<roomId>:sync`, one channel per room) and the `SyncEnvelope` shape (`{ roomId, update, originInstanceId }`) that will eventually go over the wire.
- **`instanceId.js`** — a `crypto.randomUUID()` generated once per server process (`INSTANCE_ID`), so an instance can eventually recognize and drop its own updates echoing back from Redis.
- **`redis/sync.js`** — `startRoomSync(roomId, ydoc)` / `stopRoomSync(roomId, ydoc)`. `startRoomSync` attaches a **second, independent `"update"` listener** to the room's `Y.Doc` — separate from (and not chained off) the debounced-snapshot listener described in [Persistence](#persistence) above, guarded the same way against duplicate attachment across multiple connections to the same room. `stopRoomSync` detaches it. `server/yjsConnection.js`'s `handleYjsConnection` now calls `startRoomSync` when a room starts being hosted and `stopRoomSync` on that room's last disconnect, alongside (not touching) the existing persistence hooks.
- Inside that listener sits `// TODO(core-logic): publish this update + this instance's ID to Redis on the room's channel` — the actual `publisher.publish(...)` call, the subscribe-and-apply side, and echo-loop prevention (telling "update that originated here" apart from "update that just arrived from Redis") are all still open, called out as `TODO(core-logic)` comments in `redis/sync.js`.

*Setup instructions (`REDIS_URL` etc.) will be added once the publish/subscribe logic is actually implemented.*

---

## Execution Service

A standalone Express server, `exec-server/`, is the new home for code execution — sibling to `collab-code-editor/` and `server/`. Right now it's deliberately minimal: a bare passthrough.

- `GET /health` — a health check for the deploy platform (Railway/Render).
- `POST /execute` — forwards the request body straight to Piston's `/api/v2/execute` and relays back whatever Piston returns, status code included. No queue, no retries, no request shaping yet.

**Why this exists as its own step, before any queueing logic:** establishing the service boundary and deploy target first — as a working, deployable proxy — means the request queue (rate limiting, concurrency caps, retry/backoff) can be layered on top of something already running in production, rather than designed in the abstract. It also means the three services (Next.js app, WS sync server, execution server) are now three separate failure domains on purpose: an execution spike or crash can't take down live editing or the app itself, and vice versa.

Both `PORT` and the Piston URL (`PISTON_API_URL`) are env-configurable (see `exec-server/.env.example`), the same pattern `server/` and the Next.js app already use for their own upstream URLs (the Next.js app now points at `exec-server/` via its own `EXEC_SERVER_API_URL` var), so each environment (local Docker Compose Piston vs. a deployed instance) just needs a different `.env`.

### Execution status UI

The editor's Run button and output panel (`collab-code-editor/app/components/CodeEditor.tsx`) surface the distinct outcomes `exec-server` classifies a job into (see `exec-server/piston/classifyResult.js` and its README's "Queue backpressure"/"Distinguishing failure modes" sections), instead of a single generic "Error." Each state gets its own color-coded status pill and output panel tint, matching the existing connection-status indicator's visual style:

- **Queued** (slate) — the job has been submitted and is waiting for a free worker.
- **Running** (blue) — the job is executing. Since `exec-server` currently holds the HTTP request open for a job's whole lifecycle rather than pushing incremental updates, the queued → running transition in the UI is a short client-side heuristic, not a real server signal — it'll become accurate once `exec-server` exposes real job-status updates.
- **Completed** (green for a clean exit, amber for a non-zero exit / stderr) — the program ran to completion; stdout/stderr/exit code are shown as before.
- **Timed out** (orange) — the job hit `exec-server`'s configured `run_timeout`/`compile_timeout` and was terminated.
- **Memory limit exceeded** (purple) — the job was killed for exceeding its configured memory limit.
- **Server busy** (pink) — `exec-server` rejected the request with `429` because its job queue is full (`MAX_QUEUE_DEPTH`); the job never ran.
- **Error** (red) — a fallback for anything else (network failure, an unexpected response shape, etc.).

This is a frontend-only change: `/api/execute` forwards `exec-server`'s classification fields (`status`/`stage`/`detail`) when present, and falls back to deriving a plain success/runtime-error status from the exit code otherwise, so the UI degrades gracefully against today's still-scaffolded `exec-server` (see [Execution Service](#execution-service) above).

### Manual Test Checklist (Execution Queue, v0.5)

No automated tests cover `exec-server`'s queue/worker-pool/timeout/resource-limit behavior yet, so verify it by hand once "Execution request queue + resource limits" (see [Roadmap](#roadmap--whats-next)) is actually implemented — these TODOs are currently stubbed (see [Execution Service](#execution-service) above), so every check below will fail against today's code. Run Piston (`docker compose up -d`), `exec-server/` (`cd exec-server && npm run dev`), and the frontend (`cd collab-code-editor && npm run dev`) locally for all of these.

1. **Concurrent executions beyond the worker pool size are queued, not run in parallel**
   - [ ] With `WORKER_POOL_SIZE` at its default (4), submit more concurrent executions than that (e.g. 6-8 Run requests fired back-to-back, or via a small script hitting `/api/execute` directly) using code that takes a couple of seconds to finish (e.g. a short sleep/busy-loop).
   - [ ] Confirm only `WORKER_POOL_SIZE` jobs are actually running against Piston at any one time, and the rest visibly wait their turn (e.g. later jobs' results arrive only after earlier ones free up a worker) rather than all hitting Piston at once.

2. **A job that runs past the configured timeout is reported as "timed out," not a generic error**
   - [ ] Run code that sleeps/loops longer than `RUN_TIMEOUT_MS` (default 3000ms) or `COMPILE_TIMEOUT_MS` (default 5000ms) for a compiled language.
   - [ ] Confirm the job is killed at (or shortly after) the configured timeout rather than being left to hang, and the UI shows the **Timed out** (orange) state specifically — not the generic **Error** (red) state.

3. **A job that exceeds the memory limit is reported as "memory limit exceeded," distinct from timeout**
   - [ ] Run code that allocates well beyond `RUN_MEMORY_LIMIT_MB` (default 128MB) or `COMPILE_MEMORY_LIMIT_MB` (default 256MB) quickly (so it gets OOM-killed rather than timing out first).
   - [ ] Confirm the UI shows the **Memory limit exceeded** (purple) state, not **Timed out** (orange) or the generic **Error** (red) state — the two failure modes must stay visibly distinct.

4. **Filling the queue past its max depth returns 429 instead of hanging**
   - [ ] With `MAX_QUEUE_DEPTH` set low for testing (e.g. `MAX_QUEUE_DEPTH=2` in `exec-server/.env`) and a small `WORKER_POOL_SIZE`, submit enough concurrent long-running jobs to exceed both the worker pool and the queue depth.
   - [ ] Confirm the excess requests come back **immediately** with `429` / `{"error": "server busy, try again"}` rather than hanging indefinitely, and the UI shows the **Server busy** (pink) state for those.
   - [ ] Confirm jobs already queued (within the depth limit) still complete normally rather than also being rejected.

5. **A normal, well-behaved execution still completes correctly through the full path**
   - [ ] Run a simple, quick snippet in each supported language (JavaScript, TypeScript, Python, Java, C++) with normal output (e.g. printing a string).
   - [ ] Confirm each one completes through the full path (Next.js → `exec-server/` → Piston) and the UI shows the **Completed** (green) state with the expected stdout and exit code `0` — confirming the queue/worker-pool/timeout/resource-limit changes above didn't regress the ordinary success path.

### Known issues / fixed

**Silent empty "success" on every run (fixed).** When the job queue/worker pool landed (Step 3/4 of v0.5), `exec-server`'s `POST /execute` response shape changed from a flat Piston passthrough to a wrapped envelope — `{ pistonStatus, data, result }`, where `data` is the raw Piston response and `result` is `exec-server`'s own `{ stage, status, detail }` classification (see `exec-server/worker/workerPool.js`'s `job.resolve(...)` call). `collab-code-editor/app/api/execute/route.ts` was never updated to match: it kept reading `run`/`compile`/`status`/`stage`/`detail` off the top level of that response. Those fields no longer existed there, but every read went through `??`/`?.` fallbacks instead of throwing, so the route silently returned a fake `{ success: true, status: "success", stdout: "", stderr: "", exitCode: null }` on every execution — no thrown error anywhere in the chain, just an empty Run result. Fixed by unwrapping `data`/`result` correctly in `route.ts`, and by adding an `ExecServerResponse` TypeScript type for `exec-server`'s actual envelope shape so a top-level-vs-nested mismatch like this is a type error next time instead of a silent fallback.

---

## Local Setup / Installation

```bash
git clone [repo-url]
cd collab-code-editor
npm install

# Start the self-hosted Piston sandbox (code execution engine)
docker compose up -d

# Run the frontend
npm run dev
```

Also start `exec-server/` (see [Execution server](#execution-server) below) — the Next.js app now proxies execution requests to it rather than calling Piston directly.

Open [http://localhost:3000](http://localhost:3000), write some code in the editor, pick a language, and hit **Run** — it's forwarded to `/api/execute`, which relays it to `exec-server/` (see [Execution Service](#execution-service) below), which in turn relays it to the local Piston container and streams back stdout/stderr/exit code. The execution path is Next.js → `exec-server/` → Piston.

By default the app talks to `exec-server/` at `http://localhost:4000`. Override with an `EXEC_SERVER_API_URL` env var if you're running `exec-server/` elsewhere.

### WebSocket server (Yjs sync)

A standalone WebSocket server lives in `server/`, sibling to `collab-code-editor/`. It now speaks the **Yjs sync protocol** — via `y-websocket`'s server-side `setupWSConnection` utility (`server/yjsConnection.js`) — instead of the plain echo logic from the earlier scaffold. To run it locally:

```bash
cd server
npm install
cp .env.example .env
npm run dev
```

It listens on `PORT` from `.env` (default `8080`). Run it alongside the frontend (`npm run dev` in `collab-code-editor/`, pointed at it via `NEXT_PUBLIC_WS_URL`) to see edits sync live between browser tabs.

**Database (Prisma + Neon Postgres):** the server also connects to a Neon Postgres database via Prisma (see [Persistence](#persistence) above for the schema). To set it up:

```bash
cd server
# Add DATABASE_URL (pooled) and DIRECT_URL (direct) from your Neon project to .env
npx prisma migrate dev   # applies migrations, using DIRECT_URL
npx prisma generate      # regenerates the Prisma Client, if needed
```

`DATABASE_URL` (Neon's pooled/PgBouncer connection) is used by Prisma Client at runtime via the `@prisma/adapter-pg` driver adapter; `DIRECT_URL` (Neon's direct, non-pooled connection) is used only by `prisma migrate`, since PgBouncer's transaction-mode pooling doesn't support the session-level advisory locks Migrate needs.

*Redis pub/sub is scaffolded but not implemented yet — see [Cross-Instance Sync](#cross-instance-sync-scaffold). Setup instructions will be added once the publish/subscribe logic is in place.*

### Execution server

A standalone Express server lives in `exec-server/`, another sibling of `collab-code-editor/` and `server/`. It currently does nothing but proxy `POST /execute` straight through to Piston (see [Execution Service](#execution-service) above). To run it locally:

```bash
cd exec-server
npm install
cp .env.example .env
npm run dev
```

It listens on `PORT` from `.env` (default `4000`) and proxies to `PISTON_API_URL` (default `http://localhost:2000`) — point it at the same local Piston container `docker compose up -d` starts above.

---

## Roadmap / What's Next

- [x] Basic single-user code editor UI (Monaco)
- [x] Code execution via Piston integration (self-hosted via Docker)
- [x] Real-time multi-tab sync (Yjs + `y-websocket` + WebSocket server)
- [x] Room routing (`/room/[roomId]`, joined/created from a landing screen)
- [x] Presence indicators and live cursor labels (Yjs awareness)
- [x] Room persistence with Postgres — loading state on connect, debounced snapshot writes, and flush-on-last-disconnect are all done
- [x] Standalone execution service (`exec-server/`) — bare passthrough proxy to Piston, establishing the service boundary and deploy target
- [x] Next.js `/api/execute` now calls `exec-server/` instead of Piston directly
- [ ] Reconnect/resync handling
- [ ] Execution request queue + resource limits, on top of `exec-server/`
- [ ] Redis pub/sub for horizontal scaling — client, channel design, and the `Y.Doc` connection hook are scaffolded ([details](#cross-instance-sync-scaffold)); publish/subscribe logic itself is still TODO
- [ ] Deploy live demo (Vercel + Railway/Render)

---

## License

MIT License. See `LICENSE` file for details.
