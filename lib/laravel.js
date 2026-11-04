// Reads a Laravel app's routes, preferring `php artisan route:list --json`
// and falling back to a rough parse of routes/api.php.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const IGNORED = /^(_ignition|_debugbar|sanctum\/csrf-cookie|telescope|horizon|livewire|storage\/|up$)/;

function artisanRoutes(dir) {
  return new Promise((resolve, reject) => {
    execFile(
      'php',
      ['artisan', 'route:list', '--json'],
      { cwd: dir, timeout: 90_000, maxBuffer: 50 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim().split('\n').slice(-3).join(' ')));
        const start = stdout.indexOf('[');
        try {
          resolve(JSON.parse(stdout.slice(start)));
        } catch {
          reject(new Error('route:list did not return JSON'));
        }
      },
    );
  });
}

function toEndpoint(r) {
  const methods = String(r.method).split('|').filter((m) => m !== 'HEAD');
  const middleware = Array.isArray(r.middleware) ? r.middleware : String(r.middleware || '').split(/[,\n]/);
  return {
    method: methods[0] || 'GET',
    path: '/' + String(r.uri).replace(/^\//, ''),
    name: r.name || String(r.action || '').split('\\').pop(),
    auth: middleware.some((m) => /auth|Authenticate/i.test(m)),
  };
}

function parseRoutesFile(dir) {
  const file = path.join(dir, 'routes', 'api.php');
  const src = fs.readFileSync(file, 'utf8');
  const re = /Route::(get|post|put|patch|delete)\(\s*['"]([^'"]*)['"]/gi;
  const eps = [];
  let m;
  while ((m = re.exec(src))) {
    eps.push({ method: m[1].toUpperCase(), path: '/api/' + m[2].replace(/^\//, ''), name: '', auth: false });
  }
  return eps;
}

async function listRoutes(dir) {
  try {
    const raw = await artisanRoutes(dir);
    const all = raw.filter((r) => !IGNORED.test(String(r.uri))).map(toEndpoint);
    const api = all.filter((e) => e.path === '/api' || e.path.startsWith('/api/'));
    return { endpoints: api.length ? api : all, source: 'artisan' };
  } catch (err) {
    try {
      const eps = parseRoutesFile(dir);
      return {
        endpoints: eps,
        source: 'routes-file',
        warning: `artisan route:list failed (${err.message}). Routes were read from routes/api.php, so group prefixes may be missing.`,
      };
    } catch {
      return { endpoints: [], source: 'none', warning: `Could not read routes: ${err.message}` };
    }
  }
}

module.exports = { listRoutes };
