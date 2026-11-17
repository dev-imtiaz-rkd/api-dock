// Publishes a release to the Dhaka server, where the in-app updater and the
// download page pick it up (https://apidock.ebareidechutionek.cfd/updates/).
//
//   1. bump "version" in package.json, commit and push to main
//   2. GitHub Actions sees the new version, builds Windows, macOS and Linux and
//      attaches the files to the GitHub Release v<version> (.github/workflows/build.yml)
//   3. npm run release            (waits for that build, then uploads it)
//
//   npm run release -- --local    Windows only, built on this machine (the old way)
//
// Needs .release.env (git-ignored) with UPDATES_URL and UPDATES_TOKEN.
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const version = pkg.version;
const REPO = process.env.GITHUB_REPO || 'dev-imtiaz-rkd/api-dock';
const args = process.argv.slice(2);
const LOCAL = args.includes('--local');

// ---- config ----
const envFile = path.join(ROOT, '.release.env');
const cfg = { ...process.env };
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) cfg[m[1]] = m[2];
  }
}
const BASE = (cfg.UPDATES_URL || '').replace(/\/+$/, '');
const TOKEN = cfg.UPDATES_TOKEN || '';
if (!BASE || !TOKEN) {
  console.error('Missing UPDATES_URL / UPDATES_TOKEN (put them in .release.env).');
  process.exit(1);
}

const sha512 = (file) => crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The update manifest of each platform; they are uploaded last.
const MANIFESTS = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml'];

async function main() {
  // Every update needs a new version number.
  const live = await fetch(`${BASE}/updates/latest.yml`, { cache: 'no-store' }).then((r) => (r.ok ? r.text() : ''));
  const liveVersion = ((live.match(/^version:\s*(.+)$/m) || [])[1] || '').trim();
  if (liveVersion && !isNewer(version, liveVersion) && !args.includes('--force')) {
    console.error(`The server already has ${liveVersion} — bump "version" in package.json above it first.`);
    process.exit(1);
  }

  const dir = LOCAL ? buildLocally() : await downloadFromGitHub();
  const files = fs.readdirSync(dir);
  const manifests = MANIFESTS.filter((m) => files.includes(m));
  if (!manifests.length) throw new Error(`No latest*.yml found in ${dir}`);

  // Every file a manifest lists must be here with the same checksum, and the
  // manifests must all be for this version.
  const upload = new Set();
  for (const m of manifests) {
    const yml = fs.readFileSync(path.join(dir, m), 'utf8');
    if (!new RegExp(`^version: ${version.replace(/\./g, '\\.')}$`, 'm').test(yml)) throw new Error(`${m} is not for version ${version}`);
    for (const [, url, sha] of yml.matchAll(/-\s*url:\s*(.+)\r?\n\s*sha512:\s*(.+)/g)) {
      const name = url.trim();
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) throw new Error(`${m} lists ${name}, which is missing`);
      if (sha512(file) !== sha.trim()) throw new Error(`${name} does not match ${m}`);
      upload.add(name);
      if (files.includes(`${name}.blockmap`)) upload.add(`${name}.blockmap`);
    }
  }
  // Installers people download by hand but that no manifest lists (.dmg, .deb).
  for (const f of files) if (/\.(dmg|deb)$/.test(f) && f.includes(`-${version}-`)) upload.add(f), files.includes(`${f}.blockmap`) && upload.add(`${f}.blockmap`);

  console.log(`\nPublishing ApiDock ${version} (${manifests.map((m) => m.replace(/^latest-?|\.yml$/g, '') || 'windows').join(', ')})`);
  // Installers first, manifests last: apps never see an update that isn't there yet.
  for (const name of [...upload, ...manifests]) await put(dir, name);

  const check = await fetch(`${BASE}/updates/latest.yml`, { cache: 'no-store' }).then((r) => r.text());
  if (manifests.includes('latest.yml') && !check.includes(`version: ${version}`)) throw new Error('The server is not serving the new latest.yml');
  console.log(`\nPublished ApiDock ${version}. Installed apps will offer it within a few hours (or via ? → Check for updates).`);
  console.log(`Download page: ${BASE}/`);
}

async function put(dir, name) {
  const file = path.join(dir, name);
  const size = fs.statSync(file).size;
  process.stdout.write(`Uploading ${name} (${(size / 1048576).toFixed(1)} MB)… `);
  const res = await fetch(`${BASE}/admin/updates/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
    body: fs.createReadStream(file),
    duplex: 'half',
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${name}: ${out.error || res.status}`);
  if (out.sha512 !== sha512(file)) throw new Error(`${name}: checksum mismatch after upload`);
  console.log('ok');
}

// ---- Windows-only build on this machine ----
function buildLocally() {
  console.log(`\nBuilding ApiDock ${version} for Windows…`);
  // Optional release notes: npm run release -- --local "What changed"
  const notes = args.filter((a) => !a.startsWith('--')).join(' ').trim();
  const notesArgs = notes ? [`"-c.releaseInfo.releaseNotes=${notes.replace(/"/g, "'")}"`] : [];
  execFileSync('npx', ['electron-builder', '--win', 'nsis', '--publish', 'never', ...notesArgs], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  });
  // Only this version's Windows files, so older builds in dist/ are never uploaded.
  const out = path.join(ROOT, 'dist', `release-${version}-win`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const f of ['latest.yml', `ApiDock-Setup-${version}.exe`, `ApiDock-Setup-${version}.exe.blockmap`]) fs.copyFileSync(path.join(ROOT, 'dist', f), path.join(out, f));
  return out;
}

// ---- all platforms, from the GitHub Release made by .github/workflows/build.yml ----
async function downloadFromGitHub() {
  const tag = `v${version}`;
  const api = `https://api.github.com/repos/${REPO}/releases/tags/${tag}`;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'apidock-release' };
  if (cfg.GITHUB_TOKEN) headers.Authorization = `Bearer ${cfg.GITHUB_TOKEN}`;
  console.log(`\nWaiting for the GitHub build of ${tag} (https://github.com/${REPO}/actions)…`);
  let rel;
  for (let i = 0; ; i++) {
    const res = await fetch(api, { headers });
    if (res.ok) {
      rel = await res.json();
      const names = rel.assets.map((a) => a.name);
      if (MANIFESTS.every((m) => names.includes(m))) break;
    } else if (res.status !== 404) {
      throw new Error(`GitHub: ${res.status} ${await res.text()}`);
    }
    if (i === 0 && res.status === 404) console.log(`  No release ${tag} yet — the build starts when the version bump is pushed to main.`);
    if (i > 120) throw new Error('Gave up after 60 minutes — check the Build workflow on GitHub.');
    await sleep(30_000);
    process.stdout.write('.');
  }
  const dir = path.join(ROOT, 'dist', `release-${version}`);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`\nDownloading ${rel.assets.length} files to ${path.relative(ROOT, dir)}…`);
  for (const a of rel.assets) {
    const file = path.join(dir, a.name);
    if (fs.existsSync(file) && fs.statSync(file).size === a.size) continue;
    process.stdout.write(`  ${a.name} (${(a.size / 1048576).toFixed(1)} MB)… `);
    const res = await fetch(a.browser_download_url, { headers: { 'User-Agent': 'apidock-release' } });
    if (!res.ok) throw new Error(`${a.name}: ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    console.log('ok');
  }
  return dir;
}

function isNewer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

main().catch((err) => {
  console.error(`\nRelease failed: ${err.message}`);
  process.exit(1);
});
