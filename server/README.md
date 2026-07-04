# WebSocket Server

A standalone Node.js WebSocket server (using the `ws` package) that will eventually power real-time collaboration for the code editor; for now it just accepts connections, assigns each client a connection ID, and echoes back whatever message it receives — no rooms, Yjs sync, or broadcasting yet.

## Running locally

```bash
cd server
npm install
cp .env.example .env
npm run dev
```

The server listens on `PORT` from `.env` (defaults to `8080` if unset).
