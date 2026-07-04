"use client";

import { useEffect, useState } from "react";
import * as Y from "yjs";

// Encodes without spreading the whole array into String.fromCharCode at once,
// which blows the call stack on large updates.
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

type YjsDebugPanelProps = {
  doc: Y.Doc;
};

/**
 * Temporary panel proving the local Monaco <-> Yjs binding actually produces
 * update events. Safe to delete once y-websocket sync is wired up.
 */
export default function YjsDebugPanel({ doc }: YjsDebugPanelProps) {
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [updateCount, setUpdateCount] = useState(0);

  useEffect(() => {
    const handleUpdate = (update: Uint8Array) => {
      const base64 = uint8ArrayToBase64(update);
      console.log("[yjs-debug] Y.Doc update (base64):", base64);
      setLastUpdate(base64);
      setUpdateCount((count) => count + 1);
    };

    doc.on("update", handleUpdate);
    return () => {
      doc.off("update", handleUpdate);
    };
  }, [doc]);

  return (
    <div className="border-t border-zinc-800 bg-[#252526] px-4 py-2 text-xs text-zinc-400">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-semibold text-amber-400">
          Yjs debug panel (local only, no networking)
        </span>
        <span className="text-zinc-500">updates seen: {updateCount}</span>
      </div>
      <pre className="max-h-16 overflow-auto whitespace-pre-wrap break-all font-mono text-zinc-500">
        {lastUpdate ?? "(no updates yet — type in the editor)"}
      </pre>
    </div>
  );
}
