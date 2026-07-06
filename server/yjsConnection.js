// Isolated from index.js on purpose: this module is the only place that speaks
// the Yjs sync protocol. Everything downstream of `setupWSConnection` (sync
// steps, awareness, per-doc broadcast) is handled by y-websocket itself — this
// server no longer echoes or interprets messages on its own.
const Y = require("yjs");
const { setupWSConnection, getYDoc } = require("y-websocket/bin/utils");
const { prisma } = require("./prismaClient");

// 4s of quiet time before a room's doc is flushed to Postgres. See README.md
// ("Persistence debounce") for the reasoning behind this value.
const PERSIST_DEBOUNCE_MS = 4000;

// Per-room debounce timers, so an idle room doesn't get its save delayed by
// activity in a different room (and a busy room doesn't write on every
// keystroke).
const saveTimers = new Map(); // roomId -> Timeout

// getYDoc returns the same shared Y.Doc instance for every connection to a
// given room, so we guard against attaching a duplicate "update" listener
// each time a new client connects.
const persistedRooms = new Set(); // roomId

function schedulePersist(roomId, ydoc) {
  clearTimeout(saveTimers.get(roomId));
  saveTimers.set(
    roomId,
    setTimeout(async () => {
      saveTimers.delete(roomId);
      try {
        const update = Buffer.from(Y.encodeStateAsUpdate(ydoc));
        await prisma.room.update({
          where: { id: roomId },
          data: { ydocState: update },
        });
      } catch (err) {
        console.error(`Failed to persist room "${roomId}" to Postgres:`, err);
      }
    }, PERSIST_DEBOUNCE_MS)
  );
}

async function handleYjsConnection(ws, req) {
  // docName defaults to the URL path (e.g. "/test-room" -> "test-room"),
  // which is exactly how y-websocket's WebsocketProvider builds its URL.
  const roomId = req.url.slice(1).split("?")[0];

  // setupWSConnection sends sync step 1 (and starts processing incoming
  // messages) synchronously, using whatever is already in the in-memory
  // Y.Doc. The Postgres round-trip below is async, so without pausing the
  // socket here, a fast client could sync against an empty doc before the
  // persisted state has been applied. Pausing/resuming brackets that gap.
  ws.pause();

  const ydoc = getYDoc(roomId);

  try {
    // Upsert (rather than find-then-create) so two clients racing to open
    // the same brand-new room can't both see "not found" and double-create.
    const room = await prisma.room.upsert({
      where: { id: roomId },
      update: {},
      create: { id: roomId },
    });

    if (room.ydocState) {
      Y.applyUpdate(ydoc, new Uint8Array(room.ydocState));
    }
  } catch (err) {
    // Degrade to in-memory-only rather than leaving the client hanging if
    // Postgres is unreachable.
    console.error(`Failed to load room "${roomId}" from Postgres:`, err);
  }

  // Attached after the initial load applies above, so restoring persisted
  // state on connect doesn't itself trigger a redundant save.
  if (!persistedRooms.has(roomId)) {
    persistedRooms.add(roomId);
    ydoc.on("update", () => schedulePersist(roomId, ydoc));
  }

  setupWSConnection(ws, req, { docName: roomId });
  ws.resume();
}

module.exports = { handleYjsConnection };
