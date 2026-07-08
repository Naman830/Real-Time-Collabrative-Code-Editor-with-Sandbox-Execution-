# WebSocket Server

A standalone Node.js WebSocket server that powers real-time collaboration for the code editor. It speaks the **Yjs sync protocol** (via `y-websocket`'s server-side `setupWSConnection` utility, in `yjsConnection.js`) rather than a custom message format — `index.js` just opens a `ws` `WebSocketServer` and hands each connection off to that handler. There's no room routing, persistence, or auth yet: every connecting client is trusted and the room/document name comes straight from the URL path (e.g. `ws://host:port/test-room`).

## Running locally

```bash
cd server
npm install
cp .env.example .env
npm run dev
```

The server listens on `PORT` from `.env` (defaults to `8080` if unset).

## Running two instances (manual multi-instance testing)

```bash
npm run dev:cluster
```

Starts two copies of `index.js` side by side via `concurrently`, on `PORT=8080` and `PORT=8081`, both reading the same `.env`. Useful for manually exercising anything that's supposed to behave consistently across server instances (e.g. the Redis cross-instance relay in `redis/`) — see the root README's [Manual Multi-Instance Testing](../README.md#manual-multi-instance-testing) section for how to point the frontend at each instance.
