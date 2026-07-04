# Real-Time Collaborative Code Editor with Sandboxed Execution

A collaborative code editor with real-time multi-cursor sync (CRDT-based) and secure sandboxed code execution — built to explore distributed state management and execution isolation at scale.

🚧 Status: In Progress — single-user editor with sandboxed execution is working locally; Yjs is now bound to the Monaco editor locally (single-tab, no networking yet); WebSocket server, Redis, and Postgres are not wired up yet.

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

- [ ] Real-time multi-cursor editing
- [ ] Presence indicators (who's online, where they're looking)
- [x] Sandboxed code execution (JavaScript, TypeScript, Python, Java, C++ via a self-hosted Piston instance)
- [ ] Room persistence (reload without losing state)

---

## Tech Stack

| Layer | Technology | Why |
| --- | --- | --- |
| Frontend | Next.js (App Router) | An industry-standard React framework that provides a fast development experience for building the editor interface and collaborative room pages. |
| Code Editor | Monaco / CodeMirror | Free, open-source, and battle-tested editor components with built-in syntax highlighting and a rich editing experience. |
| Sync Engine | Yjs | A CRDT-based library that automatically resolves concurrent edits without conflicts, eliminating the need for custom conflict resolution logic. |
| Realtime Server | Node.js WebSocket Server (separate from Next.js) | Since Next.js API routes are not designed for long-lived connections, a dedicated WebSocket server provides persistent, low-latency, bidirectional communication. |
| Caching / Pub-Sub | Redis | Broadcasts room state across multiple server instances, enabling efficient horizontal scaling. |
| Persistence | PostgreSQL | Provides durable storage, ensuring rooms and documents persist across server restarts. |
| Code Execution | Piston (Open-Source Sandboxed Execution Engine) | Enables secure, multi-language code execution without building a custom Docker-based sandbox, allowing development effort to focus on real-time collaboration and scalability instead of execution isolation. |

---

## Architecture
*Diagram coming soon.*

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

Yjs is integrated with the Monaco editor in `collab-code-editor/app/components/CodeEditor.tsx`, but **only locally** — there is no provider or network transport wired up yet.

- A `Y.Doc` and `Y.Text` are created per editor session and bound to the Monaco model via `y-monaco`'s `MonacoBinding`, so keystrokes flow into the CRDT.
- This is single-user, single-tab: edits update the local `Y.Doc`, but nothing is broadcast anywhere.
- A temporary debug panel (`YjsDebugPanel.tsx`) logs each `Y.Doc` update as a base64-encoded string and shows a running update count, just to make the CRDT's update events visible during development. It's safe to delete once real sync lands.
- Next step: connect this binding to the standalone WebSocket server in `server/` via `y-websocket` (or an equivalent custom provider) to get actual multi-client sync.

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

### WebSocket server (standalone, not yet wired to the frontend)

A plain `ws`-based WebSocket server now lives in `server/`, sibling to `collab-code-editor/`. It currently just accepts connections, replies with a `{ type: "welcome", id }` message, and echoes back whatever it receives — no Yjs, rooms, or broadcasting yet. To run it locally:

```bash
cd server
npm install
cp .env.example .env
npm run dev
```

It listens on `PORT` from `.env` (default `8080`). The Next.js frontend doesn't talk to it yet — that integration comes with the Yjs sync work.

*Postgres and Redis aren't wired up yet — setup instructions for those will be added as each comes online.*

---

## Roadmap / What's Next

- [x] Basic single-user code editor UI (Monaco)
- [x] Code execution via Piston integration (self-hosted via Docker)
- [ ] Real-time multi-cursor sync (Yjs + WebSocket server)
- [ ] Presence indicators and live cursor labels
- [ ] Room persistence with Postgres
- [ ] Reconnect/resync handling
- [ ] Execution resource limits + worker queue
- [ ] Redis pub/sub for horizontal scaling
- [ ] Deploy live demo (Vercel + Railway/Render)

---

## License

MIT License. See `LICENSE` file for details.
