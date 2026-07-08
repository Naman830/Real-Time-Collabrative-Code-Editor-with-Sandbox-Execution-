const {
  WORKER_POOL_SIZE,
  PISTON_API_URL,
  JOB_TIMEOUT_MS,
  COMPILE_MEMORY_LIMIT_BYTES,
  RUN_MEMORY_LIMIT_BYTES,
} = require("../config");
const queue = require("../queue/jobQueue");
const { buildExecuteRequest } = require("../piston/buildExecuteRequest");
const { classifyResult } = require("../piston/classifyResult");

// Fixed-size worker pool that pulls jobs from the in-memory queue and runs
// them against Piston. Each job carries its own `resolve`/`reject` (attached
// by index.js's POST /execute handler when it enqueues the job), so
// processJob() delivers a job's outcome by settling that job's promise
// directly rather than through a separate id-keyed lookup table.

/**
 * A single worker's life cycle: wait for a job, dequeue it, process it,
 * repeat forever. Multiple workers may wake on the same "job-added" signal;
 * dequeue() is safe to call from more than one because JS execution is
 * single-threaded, so at most one worker actually gets each job and the
 * rest just loop back to waiting.
 *
 * @returns {Promise<never>}
 */
async function worker() {
  for (;;) {
    await queue.waitForJob();
    const job = queue.dequeue();
    if (!job) continue;

    try {
      await processJob(job);
    } catch (err) {
      // processJob() settles job.resolve/job.reject itself; this only
      // guards against a truly unexpected throw so one bad job can't kill
      // the worker's loop.
      console.error(`Unexpected error processing job ${job.id}:`, err);
    }
  }
}

/**
 * Start the worker pool: spawn WORKER_POOL_SIZE concurrent workers, each
 * running its own pull loop against the shared queue.
 *
 * @returns {void}
 */
function startPool() {
  for (let i = 0; i < WORKER_POOL_SIZE; i++) {
    worker().catch((err) => console.error("Worker loop crashed:", err));
  }
}

/**
 * Process a single job: run it against Piston (bounded by JOB_TIMEOUT_MS)
 * and settle the job's own resolve/reject with the outcome.
 *
 * Every Piston request has resource limits injected via
 * buildExecuteRequest() (see piston/buildExecuteRequest.js) and every
 * response is labeled via classifyResult() (see piston/classifyResult.js)
 * so a timeout, an OOM-kill, and a clean non-zero exit are distinguishable
 * instead of being lumped into one generic error.
 *
 * JOB_TIMEOUT_MS is exec-server's own dead-man switch on the whole Piston
 * HTTP call (separate from the compile_timeout/run_timeout fields Piston
 * enforces internally). If it elapses first, the in-flight fetch is
 * aborted and the job is rejected with a timeout error. The AbortController
 * is only ever aborted before the fetch settles, and the timer is cleared
 * as soon as the fetch settles on its own, so the job is settled exactly
 * once either way.
 *
 * @param {object} job
 * @returns {Promise<void>}
 */
async function processJob(job) {
  const pistonRequest = buildExecuteRequest(job.request);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), JOB_TIMEOUT_MS);

  let pistonRes;
  try {
    pistonRes = await fetch(`${PISTON_API_URL}/api/v2/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pistonRequest),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      job.reject(Object.assign(new Error(`Job timed out after ${JOB_TIMEOUT_MS}ms`), { status: 504 }));
    } else {
      job.reject(Object.assign(new Error(`Could not reach Piston: ${err.message}`), { status: 502 }));
    }
    return;
  } finally {
    clearTimeout(timeoutId);
  }

  let data;
  try {
    data = await pistonRes.json();
  } catch (err) {
    job.reject(Object.assign(new Error(`Piston returned an invalid response: ${err.message}`), { status: 502 }));
    return;
  }

  // A non-2xx here means Piston never ran the job at all (e.g. an unknown
  // language/version, or a malformed request) — its body has no
  // compile/run stages, just an error message. classifyResult() can't
  // distinguish that shape from "ran with nothing to report" on its own
  // (see classifyResult.js), so that distinction has to be made here,
  // before the response reaches it, or this resolves as a fake empty
  // "success".
  if (!pistonRes.ok) {
    job.reject(
      Object.assign(new Error(data?.message || `Piston returned ${pistonRes.status}`), { status: 502 })
    );
    return;
  }

  const result = classifyResult(data, {
    compileMemoryLimitBytes: COMPILE_MEMORY_LIMIT_BYTES,
    runMemoryLimitBytes: RUN_MEMORY_LIMIT_BYTES,
  });

  job.resolve({ pistonStatus: pistonRes.status, data, result });
}

module.exports = {
  startPool,
  processJob,
};
