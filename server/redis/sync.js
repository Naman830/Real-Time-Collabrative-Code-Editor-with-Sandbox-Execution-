// Cross-instance Yjs sync wiring.
//
// SCAFFOLD ONLY: this module is where the Redis pub/sub fan-out will connect to
// the Yjs document lifecycle. None of the core logic is implemented yet — the
// handlers below are intentionally empty and marked with TODO(core-logic).
//
// The intended flow, for context:
//   local Y.Doc "update"  --publish-->  Redis  --deliver-->  other instances
//                                                              --apply--> their Y.Doc
// so that clients connected to different server instances converge on the same
// document even though y-websocket only broadcasts within a single process.
const { publisher, subscriber } = require("./client");
const { syncChannel } = require("./channels");
const { INSTANCE_ID } = require("../instanceId");

// Per-room "update" listener this module has attached, so a room that already
// has cross-instance sync wired up doesn't get a duplicate listener each time
// startRoomSync is called again (getYDoc's Y.Doc is shared across every
// connection to the room, same reasoning as persistedRooms in
// yjsConnection.js). Also lets stopRoomSync remove the exact listener
// instance it added.
const roomSyncListeners = new Map(); // roomId -> update listener function

/**
 * Begin mirroring a room's Yjs updates across instances.
 *
 * Called once per room this instance starts hosting (i.e. where a first client
 * connects). Invoked from the Yjs connection setup in yjsConnection.js.
 *
 * @param {string} roomId
 * @param {import("yjs").Doc} ydoc  The shared per-room Y.Doc from getYDoc().
 */
function startRoomSync(roomId, ydoc) {
  void publisher;
  void syncChannel;

  if (roomSyncListeners.has(roomId)) {
    return;
  }

  // Independent from the debounced-snapshot listener in yjsConnection.js —
  // this one is not chained off it and does not touch schedulePersist.
  const onUpdate = (update, origin) => {
    // TODO(core-logic): publish this update + this instance's ID to Redis on the room's channel.
    // Variables already in scope for this:
    //   update      - Uint8Array, the binary Yjs update payload to publish (this is the
    //                 "update" argument Yjs passes to Y.Doc's "update" event handler).
    //   origin      - the origin tag passed to whatever called Y.applyUpdate/the local
    //                 transaction; needed to skip re-publishing updates this instance applied
    //                 because they arrived from Redis in the first place (echo-loop prevention,
    //                 see subscribe-and-apply TODO below and the teardown TODO in stopRoomSync).
    //   roomId      - string, this room's ID; pass to syncChannel(roomId) for the channel name.
    //   INSTANCE_ID - string, this process's ID (from ../instanceId); goes in the SyncEnvelope
    //                 (see redis/channels.js) so receivers can recognize and drop their own echoes.
    void update;
    void origin;
    void roomId;
    void INSTANCE_ID;
  };

  roomSyncListeners.set(roomId, onUpdate);
  ydoc.on("update", onUpdate);

  // TODO(core-logic): subscribe-and-apply.
  // Problem: updates published by other instances arrive on this room's sync
  // channel and must be integrated into this instance's Y.Doc so its connected
  // clients see the remote edit. What must be decided/handled: subscribing to
  // the correct per-room channel exactly once (getYDoc is shared across
  // connections); decoding the envelope back into a Uint8Array; and applying it
  // to the Y.Doc in a way that is distinguishable from a local edit so the
  // publish path above can tell them apart.
  void subscriber;
}

/**
 * Stop mirroring a room once this instance no longer hosts it (last client of
 * the room disconnected). Detaches the "update" listener startRoomSync
 * attached; unsubscribing from Redis is still NOT implemented (see TODO
 * below).
 *
 * @param {string} roomId
 * @param {import("yjs").Doc} ydoc
 */
function stopRoomSync(roomId, ydoc) {
  const onUpdate = roomSyncListeners.get(roomId);
  if (onUpdate) {
    ydoc.off("update", onUpdate);
    roomSyncListeners.delete(roomId);
  }

  // TODO(core-logic): echo-loop prevention (teardown half).
  // Problem: whatever mechanism distinguishes "update that originated here" from
  // "update that arrived from Redis" — an origin tag on Y.applyUpdate, a
  // recently-seen set keyed by envelope, comparing originInstanceId to
  // INSTANCE_ID, or similar — has to be established when sync starts and torn
  // down here, without leaking listeners or letting a late-arriving echo be
  // reprocessed after the room is gone. The choice of mechanism is what the two
  // TODOs above depend on, so it must be decided alongside them, not after.
}

module.exports = { startRoomSync, stopRoomSync };
