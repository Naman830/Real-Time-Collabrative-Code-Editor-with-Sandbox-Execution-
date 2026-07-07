import { NextResponse } from "next/server";

const EXEC_SERVER_EXECUTE_URL = `${process.env.EXEC_SERVER_API_URL ?? "http://localhost:4000"}/execute`;

// Pinned against Piston's /runtimes output for the languages in the editor's
// language switcher. Update these if Piston drops support for a version.
const LANGUAGE_MAP: Record<string, { language: string; version: string; fileExt: string }> = {
  javascript: { language: "javascript", version: "18.15.0", fileExt: "js" },
  typescript: { language: "typescript", version: "5.0.3", fileExt: "ts" },
  python: { language: "python", version: "3.10.0", fileExt: "py" },
  java: { language: "java", version: "15.0.2", fileExt: "java" },
  cpp: { language: "c++", version: "10.2.0", fileExt: "cpp" },
};

type PistonStage = {
  stdout: string;
  stderr: string;
  output: string;
  code: number | null;
  signal: string | null;
};

// exec-server's own execution outcomes (see exec-server/piston/classifyResult.js's
// STATUS enum) — distinguishes a timeout / memory-limit kill / signal kill from a
// plain non-zero exit instead of collapsing them into one generic failure.
type ExecuteStatus =
  | "success"
  | "timeout"
  | "memory_limit_exceeded"
  | "killed"
  | "output_limit_exceeded"
  | "runtime_error"
  | "internal_error";

// Raw response body from Piston's own POST /api/v2/execute.
type PistonResponse = {
  language: string;
  version: string;
  run: PistonStage;
  compile?: PistonStage;
  message?: string;
};

// exec-server's own classification of a job's outcome (see
// exec-server/piston/classifyResult.js's STATUS enum).
type ExecResult = {
  stage: "compile" | "run";
  status: ExecuteStatus;
  detail: string;
};

// exec-server's actual POST /execute response body.
//
// On success (200), exec-server's worker pool wraps the raw Piston response
// and its own classification in an envelope rather than returning either
// flat (see exec-server/worker/workerPool.js's `job.resolve({ pistonStatus,
// data, result })` call and index.js's `res.status(200).json(result)`).
//
// On failure (queue full / job timeout / Piston unreachable), exec-server
// instead sends a flat `{ error }` body with a non-2xx status (see
// exec-server/index.js's catch block) — `data`/`result` are absent there,
// which is why every field below is optional on this one merged type.
type ExecServerResponse = {
  error?: string;
  message?: string;
  pistonStatus?: number;
  data?: PistonResponse;
  result?: ExecResult;
};

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, kind: "error", error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  const { language, code } = (body ?? {}) as { language?: unknown; code?: unknown };

  if (typeof language !== "string" || typeof code !== "string") {
    return NextResponse.json(
      { success: false, kind: "error", error: "Request must include 'language' and 'code' strings." },
      { status: 400 }
    );
  }

  // exec-server's express.json() rejects bodies over its ~100kb default with
  // an HTML error page, which previously surfaced here as a confusing
  // "invalid response" 502. Cap the code size before forwarding so the user
  // gets a clear message instead. 64 KiB leaves room for the JSON envelope.
  const MAX_CODE_BYTES = 64 * 1024;
  if (new TextEncoder().encode(code).length > MAX_CODE_BYTES) {
    return NextResponse.json(
      { success: false, kind: "error", error: "Code is too large to execute (max 64 KB)." },
      { status: 413 }
    );
  }

  const mapping = LANGUAGE_MAP[language];
  if (!mapping) {
    return NextResponse.json(
      { success: false, kind: "error", error: `Unsupported language: ${language}` },
      { status: 400 }
    );
  }

  let execRes: Response;
  try {
    execRes = await fetch(EXEC_SERVER_EXECUTE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language: mapping.language,
        version: mapping.version,
        files: [{ name: `main.${mapping.fileExt}`, content: code }],
      }),
    });
  } catch {
    return NextResponse.json(
      { success: false, kind: "error", error: "Could not reach the code execution service. Please try again." },
      { status: 502 }
    );
  }

  let execBody: ExecServerResponse;
  try {
    execBody = await execRes.json();
  } catch {
    return NextResponse.json(
      { success: false, kind: "error", error: "Code execution service returned an invalid response." },
      { status: 502 }
    );
  }

  // Queue backpressure: exec-server rejects outright with 429 when it's at
  // MAX_QUEUE_DEPTH (see exec-server/README.md's "Queue backpressure"). This
  // is distinct from every other failure mode — it means the job was never
  // run at all, so the frontend needs a dedicated "rejected" branch instead
  // of lumping it in with real execution errors.
  if (execRes.status === 429) {
    return NextResponse.json(
      {
        success: false,
        kind: "rejected",
        error: execBody.error ?? execBody.message ?? "Server is busy. Please try again.",
      },
      { status: 429 }
    );
  }

  if (!execRes.ok) {
    return NextResponse.json(
      {
        success: false,
        kind: "error",
        error: execBody.error ?? execBody.message ?? "Code execution service returned an error.",
      },
      { status: 502 }
    );
  }

  // Unwrap exec-server's success envelope — the raw Piston response lives at
  // execBody.data, and exec-server's own classification at execBody.result
  // (see the ExecServerResponse comment above). Reading run/compile/status/
  // stage/detail directly off the top-level body here was the v0.5
  // regression: those fields don't exist at that level, so they silently
  // resolved to undefined via optional chaining and produced a fake
  // "success" with empty output.
  const data = execBody.data;
  const result = execBody.result;

  const exitCode = data?.run?.code ?? null;
  const compileExitCode = data?.compile?.code ?? null;

  // Prefer exec-server's own classification once it forwards one; fall back
  // to a plain exit-code check for safety if it's ever absent.
  const status: ExecuteStatus =
    result?.status ?? ((compileExitCode ?? 0) !== 0 || (exitCode ?? 0) !== 0 ? "runtime_error" : "success");

  return NextResponse.json({
    success: true,
    status,
    stage: result?.stage ?? null,
    detail: result?.detail ?? null,
    stdout: data?.run?.stdout ?? "",
    stderr: data?.run?.stderr ?? "",
    exitCode,
    compile: data?.compile
      ? {
          stdout: data.compile.stdout ?? "",
          stderr: data.compile.stderr ?? "",
          exitCode: compileExitCode,
        }
      : null,
  });
}
