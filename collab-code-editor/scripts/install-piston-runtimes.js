// Installs every Piston language package the editor's language switcher
// depends on, then verifies each one actually shows up as a runnable
// runtime. Runs automatically as the `piston-init` service in
// docker-compose.yml on every `docker compose up` — this is what used to be
// a manual, undocumented step (`ppman install <lang> <version>`) that was
// easy to forget after a fresh container, which is exactly what caused
// every code run to silently return empty output.
//
// Keep REQUIRED_RUNTIMES in sync with LANGUAGE_MAP in
// app/api/execute/route.ts. Piston's package registry (GET /api/v2/packages,
// what you install) uses different names than the request-time language
// aliases it resolves internally (GET /api/v2/runtimes) — e.g. installing
// the "node" package is what provides the "javascript" runtime, and "gcc"
// provides "c++". packageLanguage below is the installable package name;
// runtimeAlias is the name LANGUAGE_MAP actually sends as `language` in
// execute requests.

const PISTON_API_URL = process.env.PISTON_API_URL ?? "http://localhost:2000";

const REQUIRED_RUNTIMES = [
  { packageLanguage: "node", packageVersion: "18.15.0", runtimeAlias: "javascript" },
  { packageLanguage: "typescript", packageVersion: "5.0.3", runtimeAlias: "typescript" },
  { packageLanguage: "python", packageVersion: "3.10.0", runtimeAlias: "python" },
  { packageLanguage: "java", packageVersion: "15.0.2", runtimeAlias: "java" },
  { packageLanguage: "gcc", packageVersion: "10.2.0", runtimeAlias: "c++" },
];

const WAIT_FOR_PISTON_RETRIES = 30;
const WAIT_FOR_PISTON_DELAY_MS = 2000;
const INSTALL_POLL_INTERVAL_MS = 5000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000; // gcc alone took ~4min in testing

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPiston() {
  for (let attempt = 1; attempt <= WAIT_FOR_PISTON_RETRIES; attempt++) {
    try {
      const res = await fetch(`${PISTON_API_URL}/api/v2/packages`);
      if (res.ok) return;
    } catch {
      // Piston not accepting connections yet — expected on first boot.
    }
    console.log(`[piston-init] waiting for Piston at ${PISTON_API_URL} (${attempt}/${WAIT_FOR_PISTON_RETRIES})...`);
    await sleep(WAIT_FOR_PISTON_DELAY_MS);
  }
  throw new Error(`Piston never became reachable at ${PISTON_API_URL}`);
}

async function getPackages() {
  const res = await fetch(`${PISTON_API_URL}/api/v2/packages`);
  if (!res.ok) throw new Error(`GET /api/v2/packages failed: ${res.status}`);
  return res.json();
}

async function isInstalled(packageLanguage, packageVersion) {
  const packages = await getPackages();
  const match = packages.find(
    (p) => p.language === packageLanguage && p.language_version === packageVersion
  );
  return match?.installed === true;
}

async function installPackage(packageLanguage, packageVersion) {
  const res = await fetch(`${PISTON_API_URL}/api/v2/packages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language: packageLanguage, version: packageVersion }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Install request for ${packageLanguage}-${packageVersion} failed: ${body.message ?? res.status}`);
  }

  const deadline = Date.now() + INSTALL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isInstalled(packageLanguage, packageVersion)) return;
    await sleep(INSTALL_POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for ${packageLanguage}-${packageVersion} to finish installing`);
}

async function verifyRuntimes() {
  const res = await fetch(`${PISTON_API_URL}/api/v2/runtimes`);
  if (!res.ok) throw new Error(`GET /api/v2/runtimes failed: ${res.status}`);
  const runtimes = await res.json();

  const available = new Set();
  for (const rt of runtimes) {
    available.add(rt.language);
    for (const alias of rt.aliases ?? []) available.add(alias);
  }

  const missing = REQUIRED_RUNTIMES.filter((r) => !available.has(r.runtimeAlias));
  if (missing.length > 0) {
    throw new Error(
      `These runtimes did not come up after install: ${missing.map((r) => r.runtimeAlias).join(", ")}`
    );
  }
}

async function main() {
  await waitForPiston();

  for (const { packageLanguage, packageVersion, runtimeAlias } of REQUIRED_RUNTIMES) {
    if (await isInstalled(packageLanguage, packageVersion)) {
      console.log(`[piston-init] ${runtimeAlias} (${packageLanguage}-${packageVersion}) already installed, skipping`);
      continue;
    }
    console.log(`[piston-init] installing ${runtimeAlias} (${packageLanguage}-${packageVersion})...`);
    await installPackage(packageLanguage, packageVersion);
    console.log(`[piston-init] installed ${runtimeAlias} (${packageLanguage}-${packageVersion})`);
  }

  await verifyRuntimes();
  console.log(`[piston-init] all ${REQUIRED_RUNTIMES.length} runtimes verified available. done.`);
}

main().catch((err) => {
  console.error(`[piston-init] FAILED: ${err.message}`);
  process.exit(1);
});
