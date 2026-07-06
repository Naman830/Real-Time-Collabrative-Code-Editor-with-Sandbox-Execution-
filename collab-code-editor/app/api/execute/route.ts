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

type PistonResponse = {
  language: string;
  version: string;
  run: PistonStage;
  compile?: PistonStage;
  message?: string;
};

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  const { language, code } = (body ?? {}) as { language?: unknown; code?: unknown };

  if (typeof language !== "string" || typeof code !== "string") {
    return NextResponse.json(
      { success: false, error: "Request must include 'language' and 'code' strings." },
      { status: 400 }
    );
  }

  const mapping = LANGUAGE_MAP[language];
  if (!mapping) {
    return NextResponse.json(
      { success: false, error: `Unsupported language: ${language}` },
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
      { success: false, error: "Could not reach the code execution service. Please try again." },
      { status: 502 }
    );
  }

  let data: PistonResponse;
  try {
    data = await execRes.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Code execution service returned an invalid response." },
      { status: 502 }
    );
  }

  if (!execRes.ok) {
    return NextResponse.json(
      { success: false, error: data.message ?? "Code execution service returned an error." },
      { status: 502 }
    );
  }

  return NextResponse.json({
    success: true,
    stdout: data.run?.stdout ?? "",
    stderr: data.run?.stderr ?? "",
    exitCode: data.run?.code ?? null,
    compile: data.compile
      ? {
          stdout: data.compile.stdout ?? "",
          stderr: data.compile.stderr ?? "",
          exitCode: data.compile.code ?? null,
        }
      : null,
  });
}
