import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const controlDir = path.join(projectRoot, '.ui-control');
const statePath = path.join(controlDir, 'ui-server-state.json');
const logPath = path.join(controlDir, 'ui-launcher.log');
const bootstrapPath = path.join(projectRoot, 'server', 'ui-bootstrap.mjs');
const START_TIMEOUT_MS = 25000;
const STOP_TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 350;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureControlDir() {
  fs.mkdirSync(controlDir, { recursive: true });
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    if (parsed && parsed.projectRoot === projectRoot) {
      return parsed;
    }
  } catch (error) {
    const ioError = error;
    if (ioError && typeof ioError === 'object' && 'code' in ioError && ioError.code === 'ENOENT') {
      return null;
    }
  }
  return null;
}

function clearState() {
  try {
    fs.rmSync(statePath, { force: true });
  } catch {
    // Best-effort cleanup only.
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM');
  }
}

async function isHealthy(url) {
  if (!url) return false;
  try {
    const response = await fetch(new URL('/health', url), {
      cache: 'no-store',
      signal: AbortSignal.timeout(1200),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function tailLog() {
  try {
    const text = fs.readFileSync(logPath, 'utf-8').trim();
    if (!text) return 'No launcher log output yet.';
    return text.split('\n').slice(-20).join('\n');
  } catch {
    return 'No launcher log output yet.';
  }
}

function startDetachedServer() {
  ensureControlDir();
  const logFd = fs.openSync(logPath, 'a');

  try {
    const child = spawn(process.execPath, [bootstrapPath], {
      cwd: projectRoot,
      detached: true,
      env: {
        ...process.env,
        UI_AUTO_OPEN_BROWSER: 'false',
        UI_CONTROL_DIR: controlDir,
        UI_PROJECT_ROOT: projectRoot,
      },
      stdio: ['ignore', logFd, logFd],
    });

    child.unref();
    return child.pid ?? null;
  } finally {
    fs.closeSync(logFd);
  }
}

async function waitForHealthyUi(timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = readState();
    if (state?.url && await isHealthy(state.url)) {
      return state.url;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  return null;
}

async function waitForStop(state, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const alive = isPidAlive(state?.pid);
    const healthy = state?.url ? await isHealthy(state.url) : false;
    if (!alive && !healthy) return true;
    await sleep(POLL_INTERVAL_MS);
  }

  return false;
}

async function ensureServerRunning() {
  const existingState = readState();
  if (existingState?.url && await isHealthy(existingState.url)) {
    return existingState.url;
  }

  if (existingState?.pid && isPidAlive(existingState.pid)) {
    const recoveredUrl = await waitForHealthyUi(START_TIMEOUT_MS);
    if (recoveredUrl) return recoveredUrl;
    throw new Error(`AgenticAGI UI process ${existingState.pid} did not become healthy.\n\n${tailLog()}`);
  }

  clearState();
  const startedPid = startDetachedServer();
  const url = await waitForHealthyUi(START_TIMEOUT_MS);

  if (url) return url;

  throw new Error(
    `Timed out waiting for AgenticAGI UI to start${startedPid ? ` (pid ${startedPid})` : ''}.\n\n${tailLog()}`,
  );
}

function openBrowser(url) {
  const command = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];

  execFileSync(command[0], command[1], { stdio: 'ignore' });
}

async function handleStart(shouldOpenBrowser) {
  const url = await ensureServerRunning();
  if (shouldOpenBrowser) {
    openBrowser(url);
  }
  console.log(url);
}

async function handleStatus() {
  const state = readState();
  const running = Boolean(state?.url && await isHealthy(state.url));
  console.log(JSON.stringify({ running, state }, null, 2));
  if (!running) process.exitCode = 1;
}

async function handleStop() {
  const state = readState();
  if (!state) {
    console.log('AgenticAGI UI is not running.');
    return;
  }

  const alive = isPidAlive(state.pid);
  const healthy = state.url ? await isHealthy(state.url) : false;
  if (!alive && !healthy) {
    clearState();
    console.log('AgenticAGI UI is not running.');
    return;
  }

  if (alive) {
    try {
      process.kill(state.pid, 'SIGTERM');
    } catch (error) {
      const ioError = error;
      if (!(ioError && typeof ioError === 'object' && 'code' in ioError && ioError.code === 'ESRCH')) {
        throw error;
      }
    }
  }

  if (!await waitForStop(state, STOP_TIMEOUT_MS) && alive) {
    process.kill(state.pid, 'SIGKILL');
    if (!await waitForStop(state, 3000)) {
      throw new Error(`AgenticAGI UI process ${state.pid} did not stop cleanly.`);
    }
  }

  clearState();
  console.log('Stopped AgenticAGI UI.');
}

async function main() {
  const command = process.argv[2] ?? 'open';

  switch (command) {
    case 'open':
      await handleStart(true);
      return;
    case 'start':
      await handleStart(false);
      return;
    case 'status':
      await handleStatus();
      return;
    case 'stop':
      await handleStop();
      return;
    default:
      throw new Error(`Unknown command "${command}". Use: open, start, status, stop.`);
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
