"use client";

import { useEffect, useRef, useState } from "react";
import Editor, { OnChange, OnMount } from "@monaco-editor/react";
import * as Y from "yjs";
import type { MonacoBinding } from "y-monaco";
import type { WebsocketProvider } from "y-websocket";
import type { Awareness } from "y-protocols/awareness";

const LANGUAGES = [
  { label: "JavaScript", value: "javascript" },
  { label: "Python", value: "python" },
  { label: "TypeScript", value: "typescript" },
  { label: "Java", value: "java" },
  { label: "C++", value: "cpp" },
] as const;

const DEFAULT_CODE = `console.log("Hello, world!");\n`;

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";

// Dev-only escape hatch for manual multi-instance testing (see server/'s
// `dev:cluster` script): open a room as usual, then add e.g. `?wsPort=8081`
// to just that tab's URL to point it at a different local server/ instance
// while every other tab still uses WS_URL. Stripped out in production
// builds so it can never affect a deployed environment.
function resolveWsUrl(): string {
  if (process.env.NODE_ENV !== "development" || typeof window === "undefined") {
    return WS_URL;
  }
  const portOverride = new URLSearchParams(window.location.search).get("wsPort");
  if (!portOverride) return WS_URL;

  try {
    const url = new URL(WS_URL);
    url.port = portOverride;
    return url.toString();
  } catch {
    return WS_URL;
  }
}

// Fixed palette so remote cursor colors stay legible on the vs-dark theme.
const CURSOR_COLORS = [
  "#e57373",
  "#64b5f6",
  "#81c784",
  "#ffb74d",
  "#ba68c8",
  "#4dd0e1",
  "#f06292",
  "#a1887f",
];

function randomUser() {
  const id = Math.floor(Math.random() * 9000) + 1000;
  const color = CURSOR_COLORS[Math.floor(Math.random() * CURSOR_COLORS.length)];
  return { name: `User ${id}`, color };
}

// Rebuilds the remote-cursor <style> tag from current awareness state, keyed
// by clientID. Regenerating the whole block (rather than patching it) means
// rules for clients who've left are simply dropped instead of lingering.
const AWARENESS_STYLE_ID = "yjs-remote-cursor-styles";

function renderAwarenessStyles(awareness: Awareness, localClientID: number) {
  let styleEl = document.getElementById(AWARENESS_STYLE_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = AWARENESS_STYLE_ID;
    document.head.appendChild(styleEl);
  }

  const rules: string[] = [];
  awareness.getStates().forEach((state, clientID) => {
    if (clientID === localClientID) return;
    const user = (state as { user?: { name: string; color: string } }).user;
    if (!user) return;

    const { name, color } = user;
    rules.push(`
      .yRemoteSelection-${clientID} {
        background-color: ${color}55;
      }
      .yRemoteSelectionHead-${clientID} {
        position: relative;
        border-left: 2px solid ${color};
      }
      .yRemoteSelectionHead-${clientID}::after {
        content: "${name.replace(/"/g, "'")}";
        position: absolute;
        top: -1.1em;
        left: -2px;
        white-space: nowrap;
        font-size: 11px;
        font-family: sans-serif;
        padding: 1px 4px;
        border-radius: 2px;
        color: #1e1e1e;
        background-color: ${color};
        pointer-events: none;
        z-index: 10;
      }
    `);
  });

  styleEl.textContent = rules.join("\n");
}

type SyncStatus = "connecting" | "connected" | "disconnected";

// Mirrors exec-server's classifyResult() STATUS enum (see
// exec-server/piston/classifyResult.js) — distinguishes a timeout /
// memory-limit kill / signal kill from a plain non-zero exit.
type ExecuteStatus =
  | "success"
  | "timeout"
  | "memory_limit_exceeded"
  | "killed"
  | "output_limit_exceeded"
  | "runtime_error"
  | "internal_error";

type ExecuteSuccess = {
  success: true;
  status: ExecuteStatus;
  stage: "compile" | "run" | null;
  detail: string | null;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  compile: { stdout: string; stderr: string; exitCode: number | null } | null;
};

type ExecuteFailure = {
  success: false;
  kind?: "rejected" | "error";
  error: string;
};

// "queued"/"running" are both in-flight — exec-server holds the HTTP request
// open for a job's whole lifecycle (see exec-server/README.md's "Queue
// design"), so there's no server push to tell the client when a queued job
// actually starts running; see the heuristic timer in handleRun() below.
// "timeout"/"memory_limit_exceeded" get their own terminal states (rather
// than folding into "completed") because they're sandbox-imposed outcomes,
// not the user's program actually finishing. "rejected" is the queue-full/
// server-busy case (429) — the job was never run at all.
type RunState =
  | { status: "idle" }
  | { status: "queued" }
  | { status: "running" }
  | { status: "completed"; result: ExecuteSuccess }
  | { status: "timeout"; result: ExecuteSuccess }
  | { status: "memory_limit_exceeded"; result: ExecuteSuccess }
  | { status: "rejected"; message: string }
  | { status: "error"; message: string };

type StatusKind =
  | "queued"
  | "running"
  | "success"
  | "runtime_error"
  | "timeout"
  | "memory_limit_exceeded"
  | "rejected"
  | "error";

// Same visual language as the sync-status pill above: low-opacity tinted
// border/background, bright text, small colored dot.
const STATUS_STYLES: Record<
  StatusKind,
  { label: string; pill: string; dot: string; panel: string }
> = {
  queued: {
    label: "Queued",
    pill: "border-slate-700/60 bg-slate-800/60 text-slate-300",
    dot: "animate-pulse bg-slate-400",
    panel: "border-zinc-800 bg-black",
  },
  running: {
    label: "Running",
    pill: "border-blue-900/60 bg-blue-950/60 text-blue-400",
    dot: "animate-pulse bg-blue-500",
    panel: "border-zinc-800 bg-black",
  },
  success: {
    label: "Completed",
    pill: "border-green-900/60 bg-green-950/60 text-green-400",
    dot: "bg-green-500",
    panel: "border-zinc-800 bg-black",
  },
  runtime_error: {
    label: "Exited with error",
    pill: "border-amber-900/60 bg-amber-950/60 text-amber-400",
    dot: "bg-amber-500",
    panel: "border-amber-900 bg-[#2a2114]",
  },
  timeout: {
    label: "Timed out",
    pill: "border-orange-900/60 bg-orange-950/60 text-orange-400",
    dot: "bg-orange-500",
    panel: "border-orange-900 bg-[#2a1c14]",
  },
  memory_limit_exceeded: {
    label: "Memory limit exceeded",
    pill: "border-purple-900/60 bg-purple-950/60 text-purple-400",
    dot: "bg-purple-500",
    panel: "border-purple-900 bg-[#241a2a]",
  },
  rejected: {
    label: "Server busy",
    pill: "border-pink-900/60 bg-pink-950/60 text-pink-400",
    dot: "bg-pink-500",
    panel: "border-pink-900 bg-[#2a1420]",
  },
  error: {
    label: "Error",
    pill: "border-red-900/60 bg-red-950/60 text-red-400",
    dot: "bg-red-500",
    panel: "border-red-900 bg-[#2a1414]",
  },
};

function getStatusKind(runState: RunState, hasRuntimeFailure: boolean): StatusKind | null {
  switch (runState.status) {
    case "idle":
      return null;
    case "completed":
      return hasRuntimeFailure ? "runtime_error" : "success";
    default:
      return runState.status;
  }
}

type CodeEditorProps = {
  roomId: string;
};

export default function CodeEditor({ roomId }: CodeEditorProps) {
  const [language, setLanguage] = useState<string>("javascript");
  const [code, setCode] = useState<string>(DEFAULT_CODE);
  const [runState, setRunState] = useState<RunState>({ status: "idle" });

  const [yDoc] = useState(() => new Y.Doc());
  const bindingRef = useRef<MonacoBinding | null>(null);
  // handleEditorMount races the provider's dynamic import — await this
  // instead of a plain ref so the binding always picks up awareness even if
  // the editor finishes mounting first.
  const providerReadyRef = useRef<Promise<WebsocketProvider | null>>(Promise.resolve(null));
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("connecting");

  useEffect(() => {
    let cancelled = false;
    let provider: WebsocketProvider | null = null;
    let awarenessChangeHandler: (() => void) | null = null;

    const providerReady = (async () => {
      // y-websocket reads the `WebSocket` global at construction time — load
      // it client-side only, same as the y-monaco import in handleEditorMount.
      const { WebsocketProvider } = await import("y-websocket");
      if (cancelled) return null;

      // y-websocket appends the room name to the URL verbatim — a room id
      // containing "#", "?", or spaces would produce an invalid WebSocket URL
      // and throw, so it must be percent-encoded here. The server uses the
      // encoded path segment as the room's persistence key, which stays
      // identical for ids that need no encoding.
      provider = new WebsocketProvider(resolveWsUrl(), encodeURIComponent(roomId), yDoc);
      provider.on("status", ({ status }: { status: SyncStatus }) => {
        setSyncStatus(status);
      });

      // Seed the default snippet only after the initial server sync reports
      // the room is genuinely empty. Seeding at editor mount raced this sync:
      // a client rejoining an existing room would see an empty local doc,
      // insert a second copy of DEFAULT_CODE, and CRDT-merge it with the
      // persisted one. "sync" also fires on reconnect, so the length guard
      // keeps this idempotent.
      provider.on("sync", (isSynced: boolean) => {
        if (isSynced) {
          const yText = yDoc.getText("monaco");
          if (yText.length === 0) {
            yText.insert(0, DEFAULT_CODE);
          }
        }
      });

      // Reuse the awareness instance the provider already creates — assign
      // this client a random name/color pair as its local presence state.
      const { awareness } = provider;
      awareness.setLocalStateField("user", randomUser());

      awarenessChangeHandler = () => renderAwarenessStyles(awareness, yDoc.clientID);
      awareness.on("change", awarenessChangeHandler);
      renderAwarenessStyles(awareness, yDoc.clientID);

      return provider;
    })();
    providerReadyRef.current = providerReady;

    return () => {
      cancelled = true;
      if (provider && awarenessChangeHandler) {
        provider.awareness.off("change", awarenessChangeHandler);
        // Clear local presence immediately so peers drop this cursor right
        // away instead of waiting on the server to notice the socket close.
        provider.awareness.setLocalState(null);
      }
      provider?.destroy();
      bindingRef.current?.destroy();
      yDoc.destroy();
      document.getElementById(AWARENESS_STYLE_ID)?.remove();
    };
  }, [yDoc, roomId]);

  const handleEditorMount: OnMount = async (editor) => {
    const yText = yDoc.getText("monaco");
    const model = editor.getModel();
    if (model) {
      // y-monaco pulls in raw monaco-editor, which touches `window` at
      // import time — load it client-side only, after the editor mounts.
      const [{ MonacoBinding }, provider] = await Promise.all([
        import("y-monaco"),
        providerReadyRef.current,
      ]);
      bindingRef.current = new MonacoBinding(
        yText,
        model,
        new Set([editor]),
        provider?.awareness,
      );
    }
  };

  const handleEditorChange: OnChange = (value) => {
    setCode(value ?? "");
  };

  const handleRun = async () => {
    setRunState({ status: "queued" });

    // No server push distinguishes "waiting behind other jobs" from "a
    // worker picked this up" (see the RunState comment above) — this timer
    // is a client-side approximation so the button doesn't sit on
    // "Queued..." for what's usually a sub-second wait. It's a no-op (and
    // gets cleared) once the real response arrives.
    const runningTimer = setTimeout(() => {
      setRunState((prev) => (prev.status === "queued" ? { status: "running" } : prev));
    }, 350);

    try {
      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language, code }),
      });

      const data: ExecuteSuccess | ExecuteFailure = await res.json();

      if (!data.success) {
        if (res.status === 429 || data.kind === "rejected") {
          setRunState({ status: "rejected", message: data.error });
        } else {
          setRunState({ status: "error", message: data.error });
        }
        return;
      }

      if (!res.ok) {
        setRunState({ status: "error", message: "Execution failed." });
        return;
      }

      if (data.status === "timeout") {
        setRunState({ status: "timeout", result: data });
      } else if (data.status === "memory_limit_exceeded") {
        setRunState({ status: "memory_limit_exceeded", result: data });
      } else {
        setRunState({ status: "completed", result: data });
      }
    } catch {
      setRunState({
        status: "error",
        message: "Could not reach the execution service. Please try again.",
      });
    } finally {
      clearTimeout(runningTimer);
    }
  };

  const isInFlight = runState.status === "queued" || runState.status === "running";

  // Trust exec-server's classification rather than re-deriving failure from
  // stderr: a program can write warnings to stderr and still exit 0, and
  // labeling that "Exited with error" next to "Exit code: 0" contradicted
  // itself. stderr is still rendered in red below either way.
  const hasRuntimeFailure =
    runState.status === "completed" && runState.result.status !== "success";

  const statusKind = getStatusKind(runState, hasRuntimeFailure);
  const panelClass = statusKind ? STATUS_STYLES[statusKind].panel : "border-zinc-800 bg-black";

  return (
    <div className="flex h-full flex-col bg-[#1e1e1e] text-zinc-200">
      <div className="flex items-center gap-3 border-b border-zinc-800 bg-[#252526] px-4 py-2">
        <label htmlFor="language-select" className="text-sm text-zinc-400">
          Language
        </label>
        <select
          id="language-select"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          className="rounded border border-zinc-700 bg-[#3c3c3c] px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.value} value={lang.value}>
              {lang.label}
            </option>
          ))}
        </select>

        <span className="text-xs text-zinc-500">
          Room: <span className="font-mono text-zinc-300">{roomId}</span>
        </span>
      </div>

      <div className="relative flex-1 min-h-0">
        <div
          className={`pointer-events-none absolute right-2 top-2 z-10 flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] backdrop-blur-sm ${
            syncStatus === "connected"
              ? "border-green-900/60 bg-green-950/60 text-green-400"
              : syncStatus === "connecting"
                ? "border-amber-900/60 bg-amber-950/60 text-amber-400"
                : "border-red-900/60 bg-red-950/60 text-red-400"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              syncStatus === "connected"
                ? "bg-green-500"
                : syncStatus === "connecting"
                  ? "animate-pulse bg-amber-500"
                  : "bg-red-500"
            }`}
          />
          {syncStatus === "connected"
            ? "Connected"
            : syncStatus === "connecting"
              ? "Reconnecting"
              : "Disconnected"}
        </div>
        <Editor
          height="100%"
          language={language}
          defaultValue={DEFAULT_CODE}
          theme="vs-dark"
          onMount={handleEditorMount}
          onChange={handleEditorChange}
          options={{
            fontSize: 14,
            minimap: { enabled: false },
            automaticLayout: true,
            scrollBeyondLastLine: false,
          }}
        />
      </div>

      <div className="flex items-center gap-3 border-t border-zinc-800 bg-[#252526] px-4 py-2">
        <button
          type="button"
          onClick={handleRun}
          disabled={isInFlight}
          className="flex items-center gap-2 rounded bg-green-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-green-500 disabled:cursor-not-allowed disabled:bg-green-800 disabled:text-zinc-300"
        >
          {runState.status === "running" && (
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          )}
          {runState.status === "queued" && (
            <span className="h-2 w-2 animate-pulse rounded-full bg-white/70" />
          )}
          {runState.status === "running" ? "Running…" : runState.status === "queued" ? "Queued…" : "Run"}
        </button>

        {statusKind && (
          <span
            className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ${STATUS_STYLES[statusKind].pill}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${STATUS_STYLES[statusKind].dot}`} />
            {STATUS_STYLES[statusKind].label}
          </span>
        )}

        {(runState.status === "completed" ||
          runState.status === "timeout" ||
          runState.status === "memory_limit_exceeded") && (
          <span className="text-xs text-zinc-500">
            Exit code: {runState.result.exitCode ?? "—"}
          </span>
        )}
      </div>

      <div className={`h-48 overflow-auto border-t px-4 py-3 transition-colors ${panelClass}`}>
        {runState.status === "idle" && (
          <pre className="whitespace-pre-wrap font-mono text-sm text-zinc-600">
            Output will appear here...
          </pre>
        )}

        {runState.status === "queued" && (
          <pre className="whitespace-pre-wrap font-mono text-sm text-slate-400">
            Waiting for a free worker…
          </pre>
        )}

        {runState.status === "running" && (
          <pre className="whitespace-pre-wrap font-mono text-sm text-blue-400">
            Running your code...
          </pre>
        )}

        {runState.status === "rejected" && (
          <pre className="whitespace-pre-wrap font-mono text-sm text-pink-400">
            {runState.message}
          </pre>
        )}

        {runState.status === "error" && (
          <pre className="whitespace-pre-wrap font-mono text-sm text-red-400">
            {runState.message}
          </pre>
        )}

        {runState.status === "timeout" && (
          <pre className="whitespace-pre-wrap font-mono text-sm text-orange-400">
            Execution exceeded its time limit and was terminated
            {runState.result.stage ? ` during the ${runState.result.stage} stage` : ""}.
            {runState.result.detail ? `\n${runState.result.detail}` : ""}
          </pre>
        )}

        {runState.status === "memory_limit_exceeded" && (
          <pre className="whitespace-pre-wrap font-mono text-sm text-purple-400">
            Execution was terminated for exceeding its memory limit
            {runState.result.stage ? ` during the ${runState.result.stage} stage` : ""}.
            {runState.result.detail ? `\n${runState.result.detail}` : ""}
          </pre>
        )}

        {runState.status === "completed" && (
          <>
            {runState.result.compile && runState.result.compile.exitCode !== 0 && (
              <pre className="whitespace-pre-wrap font-mono text-sm text-red-400">
                {runState.result.compile.stderr}
              </pre>
            )}
            {runState.result.stdout && (
              <pre className="whitespace-pre-wrap font-mono text-sm text-zinc-300">
                {runState.result.stdout}
              </pre>
            )}
            {runState.result.stderr && (
              <pre className="whitespace-pre-wrap font-mono text-sm text-red-400">
                {runState.result.stderr}
              </pre>
            )}
            {!runState.result.stdout && !runState.result.stderr && (
              <pre className="whitespace-pre-wrap font-mono text-sm text-zinc-600">
                (no output)
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}
