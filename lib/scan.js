// Walks the project roots and finds Laravel apps and Postman collections.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { APP_DIR } = require('./store');

const SKIP_DIRS = new Set([
  'node_modules', 'vendor', 'build', 'dist', 'storage', 'bootstrap',
  'public', 'resources', 'app', 'database', 'tests', 'frontend', 'agent-workspaces',
]);
const MAX_DEPTH = 4;

function walk(dir, depth, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const names = new Set(entries.map((e) => e.name));
  const isLaravel = names.has('artisan') && names.has('composer.json');
  if (isLaravel) out.laravel.push(dir);

  for (const e of entries) {
    if (!e.isFile()) continue;
    if (/\.postman_collection\.json$/i.test(e.name)) out.collections.push(path.join(dir, e.name));
    if (/\.postman_environment\.json$/i.test(e.name)) out.environments.push(path.join(dir, e.name));
  }

  // A Laravel app's own sub-folders never contain other APIs.
  if (isLaravel || depth <= 0) return;
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (full === APP_DIR) continue;
    walk(full, depth - 1, out);
  }
}

function fileHash(file) {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
}

// The same collection is often copied into several folders; keep one.
function dedupe(files) {
  const seen = new Set();
  return files.filter((f) => {
    let h;
    try {
      h = fileHash(f);
    } catch {
      return false;
    }
    if (seen.has(h)) return false;
    seen.add(h);
    return true;
  });
}

function scanRoots(roots) {
  const out = { laravel: [], collections: [], environments: [] };
  for (const root of roots) walk(root, MAX_DEPTH, out);
  out.collections = dedupe(out.collections);
  out.environments = dedupe(out.environments);
  return out;
}

module.exports = { scanRoots };
