// Starts and stops local API servers and keeps their recent output.
const { spawn, execFile } = require('child_process');
const net = require('net');

const MAX_LOG_LINES = 400;
const procs = new Map(); // id -> { child, status, logs, port, error }

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function findFreePort(preferred, taken) {
  for (let p = preferred; p < preferred + 200; p++) {
    if (!taken.has(p) && (await portFree(p))) return p;
  }
  throw new Error('No free port found');
}

function pushLog(entry, text) {
  // eslint-disable-next-line no-control-regex
  for (const raw of String(text).replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    const line = raw.replace(/\s*\.{6,}\s*/g, ' … ');
    if (!line.trim()) continue;
    entry.logs.push(line);
  }
  if (entry.logs.length > MAX_LOG_LINES) entry.logs.splice(0, entry.logs.length - MAX_LOG_LINES);
}

async function waitUntilUp(entry, url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && entry.status === 'starting') {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'manual' });
      entry.status = 'running';
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (entry.status === 'starting') {
    entry.status = 'running';
    pushLog(entry, '[apidock] server did not answer within 30s; it may still be booting.');
  }
}

function start(id, { cmd, args, cwd, readyUrl, port }) {
  const existing = procs.get(id);
  if (existing && ['starting', 'running'].includes(existing.status)) return existing;

  const entry = { status: 'starting', logs: [], port, error: null, child: null };
  procs.set(id, entry);
  pushLog(entry, `[apidock] ${cmd} ${args.join(' ')}  (in ${cwd})`);

  const child = spawn(cmd, args, { cwd, windowsHide: true, env: process.env });
  entry.child = child;
  child.stdout.on('data', (d) => pushLog(entry, d));
  child.stderr.on('data', (d) => pushLog(entry, d));
  child.on('error', (err) => {
    entry.status = 'crashed';
    entry.error = err.message;
    pushLog(entry, `[apidock] failed to start: ${err.message}`);
  });
  child.on('exit', (code) => {
    if (entry.status !== 'stopped') {
      entry.status = code === 0 ? 'stopped' : 'crashed';
      if (code) entry.error = `exited with code ${code}`;
    }
    pushLog(entry, `[apidock] process exited (code ${code})`);
  });

  waitUntilUp(entry, readyUrl);
  return entry;
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    } else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
      resolve();
    }
  });
}

async function stop(id) {
  const entry = procs.get(id);
  if (!entry || !entry.child) return;
  entry.status = 'stopped';
  await killTree(entry.child.pid);
}

async function stopAll() {
  await Promise.all([...procs.keys()].map(stop));
}

function info(id) {
  const e = procs.get(id);
  if (!e) return { status: 'stopped', logs: [] };
  return { status: e.status, logs: e.logs, port: e.port, error: e.error };
}

function usedPorts() {
  return new Set([...procs.values()].filter((e) => e.status !== 'stopped').map((e) => e.port));
}

module.exports = { start, stop, stopAll, info, findFreePort, usedPorts };
