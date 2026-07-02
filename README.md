# Real-Time Collaborative Code Editor with Sandboxed Execution

A collaborative code editor with real-time multi-cursor sync (CRDT-based) and secure sandboxed code execution — built to explore distributed state management and execution isolation at scale.

🚧 Status: In Progress — early development

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
- [ ] Sandboxed code execution
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
