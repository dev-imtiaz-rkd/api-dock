// Builds the Windows installer and publishes it to the Dhaka server, where the
// in-app updater picks it up (https://apidock.ebareidechutionek.cfd/updates/).
//
//   1. bump "version" in package.json   2. commit   3. npm run release -- "What changed"
//
// Needs .release.env (git-ignored) with UPDATES_URL and UPDATES_TOKEN.
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const version = pkg.version;
const dist = path.join(ROOT, 'dist');
const exe = `ApiDock-Setup-${version}.exe`;

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

async function main() {
  // Every update needs a new version number.
  const live = await fetch(`${BASE}/updates/latest.yml`, { cache: 'no-store' }).then((r) => (r.ok ? r.text() : ''));
  const liveVersion = (live.match(/^version:\s*(.+)$/m) || [])[1];
  if (liveVersion && !isNewer(version, liveVersion.trim())) {
    console.error(`The server already has ${liveVersion.trim()} — bump "version" in package.json above it first.`);
    process.exit(1);
  }

  console.log(`\nBuilding ApiDock ${version}…`);
  // Optional release notes: npm run release -- "What changed" (shown under "What's new" in the app).
  const notes = process.argv.slice(2).join(' ').trim();
  // Quoted because the command runs through the Windows shell; quotes inside the notes are dropped.
  const notesArgs = notes ? [`"-c.releaseInfo.releaseNotes=${notes.replace(/"/g, "'")}"`] : [];
  execFileSync('npx', ['electron-builder', '--win', 'nsis', '--publish', 'never', ...notesArgs], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  });

  // latest.yml must describe exactly the installer we upload.
  const exePath = path.join(dist, exe);
  const sha = sha512(exePath);
  const yml = fs.readFileSync(path.join(dist, 'latest.yml'), 'utf8');
  if (!yml.includes(sha) || !yml.includes(`version: ${version}`)) {
    console.error('latest.yml does not match the built installer — aborting.');
    process.exit(1);
  }

  // Installer first, latest.yml last: apps never see an update that isn't there yet.
  for (const name of [exe, `${exe}.blockmap`, 'latest.yml']) {
    const file = path.join(dist, name);
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

  const check = await fetch(`${BASE}/updates/latest.yml`, { cache: 'no-store' }).then((r) => r.text());
  if (!check.includes(`version: ${version}`)) throw new Error('The server is not serving the new latest.yml');
  console.log(`\nPublished ApiDock ${version}. Installed apps will offer it within a few hours (or via ? → Check for updates).`);
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
