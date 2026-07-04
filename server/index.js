require("dotenv").config();

const { randomUUID } = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws) => {
  const connectionId = randomUUID();
  console.log(`client connected: ${connectionId}`);

  ws.send(JSON.stringify({ type: "welcome", id: connectionId }));

  ws.on("message", (data) => {
    console.log(`received from ${connectionId}: ${data}`);
    ws.send(data);
  });

  ws.on("close", () => {
    console.log(`client disconnected: ${connectionId}`);
  });
});

console.log(`WebSocket server listening on port ${PORT}`);
