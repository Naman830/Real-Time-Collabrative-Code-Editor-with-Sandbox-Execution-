"use client";

import { useEffect, useRef, useState } from "react";
import Editor, { OnChange, OnMount } from "@monaco-editor/react";
import * as Y from "yjs";
import type { MonacoBinding } from "y-monaco";
import YjsDebugPanel from "./YjsDebugPanel";

const LANGUAGES = [
  { label: "JavaScript", value: "javascript" },
  { label: "Python", value: "python" },
  { label: "TypeScript", value: "typescript" },
  { label: "Java", value: "java" },
  { label: "C++", value: "cpp" },
] as const;

const DEFAULT_CODE = `console.log("Hello, world!");\n`;

type ExecuteSuccess = {
  success: true;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  compile: { stdout: string; stderr: string; exitCode: number | null } | null;
};

type ExecuteFailure = {
  success: false;
  error: string;
};

type RunState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; result: ExecuteSuccess }
  | { status: "error"; message: string };

export default function CodeEditor() {
  const [language, setLanguage] = useState<string>("javascript");
  const [code, setCode] = useState<string>(DEFAULT_CODE);
  const [runState, setRunState] = useState<RunState>({ status: "idle" });

  // Local-only Yjs doc backing the editor. No provider/network yet — this
  // just proves the Monaco <-> Yjs binding works within a single tab.
  const [yDoc] = useState(() => new Y.Doc());
  const bindingRef = useRef<MonacoBinding | null>(null);

  useEffect(() => {
    return () => {
      bindingRef.current?.destroy();
      yDoc.destroy();
    };
  }, [yDoc]);

  const handleEditorMount: OnMount = async (editor) => {
    const yText = yDoc.getText("monaco");
    if (yText.length === 0) {
      yText.insert(0, DEFAULT_CODE);
    }

    const model = editor.getModel();
    if (model) {
      // y-monaco pulls in raw monaco-editor, which touches `window` at
      // import time — load it client-side only, after the editor mounts.
      const { MonacoBinding } = await import("y-monaco");
      bindingRef.current = new MonacoBinding(yText, model, new Set([editor]));
    }
  };

  const handleEditorChange: OnChange = (value) => {
    setCode(value ?? "");
  };

  const handleRun = async () => {
    setRunState({ status: "loading" });

    try {
      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language, code }),
      });

      const data: ExecuteSuccess | ExecuteFailure = await res.json();

      if (!res.ok || !data.success) {
        setRunState({
          status: "error",
          message: !data.success ? data.error : "Execution failed.",
        });
        return;
      }

      setRunState({ status: "success", result: data });
    } catch {
      setRunState({
        status: "error",
        message: "Could not reach the execution service. Please try again.",
      });
    }
  };

  const isLoading = runState.status === "loading";

  const hasRuntimeFailure =
    runState.status === "success" &&
    ((runState.result.compile && runState.result.compile.exitCode !== 0) ||
      runState.result.exitCode !== 0 ||
      runState.result.stderr.length > 0);

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
      </div>

      <div className="flex-1 min-h-0">
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
          disabled={isLoading}
          className="flex items-center gap-2 rounded bg-green-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-green-500 disabled:cursor-not-allowed disabled:bg-green-800 disabled:text-zinc-300"
        >
          {isLoading && (
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          )}
          {isLoading ? "Running..." : "Run"}
        </button>
        {runState.status === "success" && (
          <span className="text-xs text-zinc-500">
            Exit code: {runState.result.exitCode ?? "—"}
          </span>
        )}
      </div>

      <div
        className={`h-48 overflow-auto border-t px-4 py-3 transition-colors ${
          runState.status === "error" || hasRuntimeFailure
            ? "border-red-900 bg-[#2a1414]"
            : "border-zinc-800 bg-black"
        }`}
      >
        {runState.status === "idle" && (
          <pre className="whitespace-pre-wrap font-mono text-sm text-zinc-600">
            Output will appear here...
          </pre>
        )}

        {runState.status === "loading" && (
          <pre className="whitespace-pre-wrap font-mono text-sm text-zinc-500">
            Running your code...
          </pre>
        )}

        {runState.status === "error" && (
          <pre className="whitespace-pre-wrap font-mono text-sm text-red-400">
            {runState.message}
          </pre>
        )}

        {runState.status === "success" && (
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

      {/* Temporary debug panel — remove once y-websocket sync lands. */}
      <YjsDebugPanel doc={yDoc} />
    </div>
  );
}
