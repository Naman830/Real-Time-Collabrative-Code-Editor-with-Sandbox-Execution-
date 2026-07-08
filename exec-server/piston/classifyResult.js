// Classifies a Piston /api/v2/execute response into a distinct, labeled
// outcome, instead of lumping "timed out", "killed for exceeding the memory
// limit", and "ran fine but exited non-zero" together as one generic error.
//
// Piston's `compile`/`run` stage objects carry isolate's raw status code
// (see engineer-man/piston's api/src/job.js), which this module reads
// directly rather than only the derived `signal` field Piston's public docs
// mention, because the raw status is what actually distinguishes these
// cases:
//   - "TO"          - the stage hit its compile_timeout/run_timeout
//   - "SG"          - the process was killed by a signal (could be the
//                     cgroup OOM killer sending SIGKILL, or another signal
//                     such as SIGSEGV)
//   - "OL" / "EL"   - stdout/stderr output size limit exceeded
//   - "XX"          - isolate itself hit an internal error
//   - "RE" / absent - process ran to completion; check its exit code
//
// Piston does not report a dedicated "out of memory" status distinct from
// "killed by signal" (see engineer-man/piston/api/src/job.js — there is no
// cg-oom-killed style field surfaced in the response). So "memory limit
// exceeded" below is a best-effort heuristic: a signal-killed stage whose
// reported memory usage is at or near the configured limit. This can't be
// 100% certain — a legitimate SIGSEGV that happens to occur under memory
// pressure could be misclassified — but it's a reasonable label for a
// portfolio-scale demo. Document this heuristic if you rely on it.

const MEMORY_LIMIT_HEURISTIC_THRESHOLD = 0.9;

const STATUS = {
  SUCCESS: "success",
  TIMEOUT: "timeout",
  MEMORY_LIMIT_EXCEEDED: "memory_limit_exceeded",
  KILLED: "killed",
  OUTPUT_LIMIT_EXCEEDED: "output_limit_exceeded",
  RUNTIME_ERROR: "runtime_error",
  INTERNAL_ERROR: "internal_error",
};

/**
 * @param {object} stage - A Piston `compile` or `run` stage object.
 * @param {number} memoryLimitBytes - The limit that was requested for this
 *   stage, used only for the OOM heuristic above.
 * @returns {{status: string, detail: string}|null} null if the stage wasn't
 *   run at all (e.g. no compile stage for an interpreted language).
 */
function classifyStage(stage, memoryLimitBytes) {
  if (!stage) return null;

  const { status, signal, code, memory } = stage;

  if (status === "TO") {
    return { status: STATUS.TIMEOUT, detail: "execution exceeded its configured timeout" };
  }

  if (status === "SG") {
    if (
      typeof memory === "number" &&
      memoryLimitBytes > 0 &&
      memory >= memoryLimitBytes * MEMORY_LIMIT_HEURISTIC_THRESHOLD
    ) {
      return {
        status: STATUS.MEMORY_LIMIT_EXCEEDED,
        detail: `process was killed (signal ${signal ?? "unknown"}) after using ~${memory} bytes, at or near the ${memoryLimitBytes}-byte limit`,
      };
    }
    return { status: STATUS.KILLED, detail: `process was terminated by signal ${signal ?? "unknown"}` };
  }

  if (status === "OL" || status === "EL") {
    return { status: STATUS.OUTPUT_LIMIT_EXCEEDED, detail: "stdout/stderr output limit exceeded" };
  }

  if (status === "XX") {
    return { status: STATUS.INTERNAL_ERROR, detail: "sandbox internal error (isolate failure)" };
  }

  if (typeof code === "number" && code !== 0) {
    return { status: STATUS.RUNTIME_ERROR, detail: `process ran and exited with non-zero code ${code}` };
  }

  return { status: STATUS.SUCCESS, detail: "completed successfully" };
}

/**
 * @param {object} pistonResponse - The parsed JSON body from Piston's
 *   /api/v2/execute response (`{ language, version, compile?, run }`).
 * @param {{compileMemoryLimitBytes: number, runMemoryLimitBytes: number}} limits
 * @returns {{stage: "compile"|"run", status: string, detail: string}}
 */
function classifyResult(pistonResponse, limits) {
  const compileResult = classifyStage(pistonResponse.compile, limits.compileMemoryLimitBytes);
  if (compileResult && compileResult.status !== STATUS.SUCCESS) {
    return { stage: "compile", ...compileResult };
  }

  const runResult = classifyStage(pistonResponse.run, limits.runMemoryLimitBytes);
  if (runResult) {
    return { stage: "run", ...runResult };
  }

  // No compile stage and no run stage means Piston never actually executed
  // anything (e.g. an error response body) — this is not a successful,
  // output-less run. workerPool.js is expected to catch this earlier via
  // pistonRes.ok, but that check living in a separate module makes this a
  // fragile invariant, not a guarantee, so this fallback must not assume it.
  return { stage: "run", status: STATUS.INTERNAL_ERROR, detail: "Piston response had no compile or run stage" };
}

module.exports = { classifyResult, STATUS };
