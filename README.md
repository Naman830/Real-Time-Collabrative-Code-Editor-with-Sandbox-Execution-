# Real-Time Collaborative Code Editor with Sandboxed Execution

A collaborative code editor with real-time multi-cursor sync (CRDT-based) and secure sandboxed code execution — built to explore distributed state management and execution isolation at scale.

🚧 Status: In Progress — single-user editor with sandboxed execution is working locally; real-time multi-tab sync is now live via Yjs + y-websocket + the standalone WebSocket server, with independent per-room documents via URL-based room routing; live multi-cursor presence (via Yjs awareness) is also working; Postgres (via Prisma + Neon) is connected and now wired into the full connection lifecycle — a room's persisted state, if any, loads into the in-memory `Y.Doc` before a new client's initial sync, and edits are written back with a per-room debounced snapshot, so state now survives a server restart; Redis is not wired up yet.

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
- [x] Room persistence (reload without losing state) — `Room` schema + migration in place; loading persisted state into a room on connect, and writing it back via a per-room debounced snapshot, are both wired in ([details](#persistence))

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
| Code Execution | Piston (Open-Source Sandboxed Execution Engine) | Enables secure, multi-language code execution without building a custom Docker-based sandbox, allowing development effort to focus on real-time collaboration and scalability instead of execution isolation. |

---

## Architecture
*Diagram image coming soon — described in text below in the meantime.*

The Next.js frontend holds a `Y.Doc` per editor session, bound to the Monaco editor via `y-monaco`. A `WebsocketProvider` (from `y-websocket`) connects that same `Y.Doc` to the standalone Node.js WebSocket server in `server/`, which speaks the Yjs sync protocol (via `y-websocket`'s server-side `setupWSConnection` utility) instead of a custom message format. Landing on `/` shows a room-join screen where you enter a room ID or generate a new one; that ID becomes the dynamic route segment for `/room/[roomId]` and is passed as the Yjs document name to both the `Y.Doc` setup and the `WebsocketProvider`, so each room gets its own independent, isolated CRDT document — two tabs on the same room ID converge in real time, and a tab on a different room ID never sees those edits. Each client also broadcasts live cursor/selection presence via Yjs's awareness protocol (see [Presence: Multi-Cursor Awareness](#presence-multi-cursor-awareness) below). On each new connection, the WS server now loads that room's persisted state (if any) from Postgres into the in-memory `Y.Doc` before the connecting client's initial sync, and every subsequent edit is written back with a per-room debounced snapshot (see [Persistence](#persistence) below), so state now survives a server restart.

**WebSocket server:** deployed on Railway, URL: `collabrativecodeeditor-production.up.railway.app`

**Why editing sync and code execution are separate systems:**
Editing sync needs to be low-latency and always-on — every keystroke matters. Execution is bursty, resource-heavy, and needs strict isolation from untrusted input. Coupling them would mean a slow or crashed execution request could degrade the live-editing experience for every user in the room. Keeping them decoupled lets each scale, fail, and recover independently.

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

Two persistence-related decisions:

- **Auto-create-on-connect (implemented).** A `Room` row is created lazily on first connection to a given room id, rather than requiring rooms to be explicitly provisioned through a separate API call. *Rationale: room ids are freely chosen by users on the landing page (typed or generated) with no pre-registration step, so the WS server is the natural place to guarantee a row exists before state is read or written for that id.*
- **Debounced snapshot, 4-second window (implemented).** Instead of writing to Postgres on every Yjs update (far too frequent — every keystroke would trigger a write), the server debounces snapshot writes to 4 seconds after the *last* edit to a given room. *Why 4 seconds specifically:* it's long enough to collapse a burst of rapid keystrokes (or a paste, or an AI-assisted large edit) into a single write, but short enough that the amount of unsaved work lost if the process crashes stays small and bounded. The trade-off is a direct dial between two costs that move in opposite directions:
  - **Shorter debounce (e.g. 500ms–1s)** → smaller data-loss window if the server crashes mid-session, but more frequent writes to Postgres. A room with continuous typing would issue a write roughly every debounce interval, since each new keystroke keeps resetting the timer only until the user briefly pauses — busy rooms would still batch reasonably well, but idle-then-type-then-idle patterns would write more often and each write recomputes/serializes the *entire* doc state (`Y.encodeStateAsUpdate` returns the full state, not just the delta), so more writes also means more bytes shipped to Neon over time.
  - **Longer debounce (e.g. 15–30s)** → far fewer writes and lower load on the Postgres connection pool (relevant since Neon's pooled connection is shared across all rooms on this server instance), but a bigger window of edits that only exist in-memory and would be lost on an ungraceful crash (a graceful shutdown could still flush all pending timers, but that's not yet implemented — see below).
  - 4 seconds was chosen as a middle ground for a pair-programming/interview use case: sessions are typically short-lived and conversational (natural pauses between edits are common), so a few seconds of debounce rarely coincides with a hard crash, while keeping writes infrequent enough not to stress a single shared Postgres connection across many concurrent rooms.
  - **Not yet implemented:** a flush-on-disconnect (or on process shutdown) to eliminate the remaining data-loss window entirely for the common case of a room simply going idle or the server restarting gracefully, rather than relying on the debounce timer alone.

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

Open [http://localhost:3000](http://localhost:3000), write some code in the editor, pick a language, and hit **Run** — it's forwarded to `/api/execute`, which relays it to the local Piston container and streams back stdout/stderr/exit code.

By default the app talks to Piston at `http://localhost:2000`. Override with a `PISTON_API_URL` env var if you're running Piston elsewhere.

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

*Redis isn't wired up yet — setup instructions will be added once it comes online.*

---

## Roadmap / What's Next

- [x] Basic single-user code editor UI (Monaco)
- [x] Code execution via Piston integration (self-hosted via Docker)
- [x] Real-time multi-tab sync (Yjs + `y-websocket` + WebSocket server)
- [x] Room routing (`/room/[roomId]`, joined/created from a landing screen)
- [x] Presence indicators and live cursor labels (Yjs awareness)
- [x] Room persistence with Postgres — loading state on connect and debounced snapshot writes are both done; flush-on-disconnect is still pending
- [ ] Reconnect/resync handling
- [ ] Execution resource limits + worker queue
- [ ] Redis pub/sub for horizontal scaling
- [ ] Deploy live demo (Vercel + Railway/Render)

---

## License

MIT License. See `LICENSE` file for details.
