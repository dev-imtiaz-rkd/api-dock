// ApiDock Team server — Google login, teams, invites and shared collections.
// Zero dependencies: Node's http + built-in SQLite (node:sqlite, Node >= 22.13).
//
// Config (environment, or a .env file next to this script):
//   PUBLIC_URL            https://apidock.example.com   (no trailing slash)
//   GOOGLE_CLIENT_ID      from Google Cloud Console
//   GOOGLE_CLIENT_SECRET
//   PORT                  default 4010 (nginx proxies to it)
//   DB_PATH               default ./apidock-cloud.db
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

// ---------- config ----------
(function loadDotEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
})();
const PUBLIC_URL = (process.env.PUBLIC_URL || 'http://localhost:4010').replace(/\/+$/, '');
const PORT = Number(process.env.PORT) || 4010;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'apidock-cloud.db');
const SESSION_DAYS = 90;
const MAX_BODY = 20 * 1024 * 1024;

// ---------- database ----------
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, google_sub TEXT UNIQUE, email TEXT UNIQUE NOT NULL,
    name TEXT, picture TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS team_members (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
    joined_at TEXT NOT NULL, PRIMARY KEY (team_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    email TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
    grants TEXT NOT NULL DEFAULT '[]', invited_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, data TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by TEXT
  );
  CREATE TABLE IF NOT EXISTS collection_access (
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
    PRIMARY KEY (collection_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email);
  CREATE INDEX IF NOT EXISTS idx_access_user ON collection_access(user_id);
`);
(function migrate() {
  const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!has('users', 'password_hash')) db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
  if (!has('invites', 'code')) db.exec('ALTER TABLE invites ADD COLUMN code TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_code ON invites(code)');
})();

const q = (sql) => db.prepare(sql);
const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const normEmail = (e) => String(e || '').trim().toLowerCase();

// ---------- http helpers ----------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string';
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function redirect(res, url) {
  res.writeHead(302, { Location: url, 'Cache-Control': 'no-store' });
  res.end();
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new HttpError(400, 'Body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// The app icon (build/icon.svg), used on every page and served as /icon.svg.
const APP_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect x="16" y="16" width="480" height="480" rx="112" fill="#1f1d1a"/><rect x="16" y="16" width="480" height="480" rx="112" fill="none" stroke="#3a3833" stroke-width="6"/><g fill="none" stroke="#f4f2ec" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"><path d="M256 128 L392 202 L256 276 L120 202 Z"/><path d="M120 268 L256 342 L392 268"/><path d="M120 330 L256 404 L392 330" stroke-opacity="0.55"/></g><circle cx="396" cy="396" r="46" fill="#e8823c" stroke="#1f1d1a" stroke-width="14"/></svg>';

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="icon" href="/icon.svg"><style>
:root{color-scheme:light dark;--bg:#f4f2ec;--fg:#1f1d1a;--mute:#8a8478;--card:#fff;--line:#e7e3d9}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--fg:#ecebe5;--mute:#8a867c;--card:#1c1c1a;--line:#2a2926}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,'Segoe UI',sans-serif}
.card{max-width:440px;margin:24px;padding:32px;border:1px solid var(--line);border-radius:16px;background:var(--card)}
.logo{width:48px;height:48px;margin-bottom:16px}.logo svg{width:100%;height:100%;display:block}
h1{font-size:20px;margin:0 0 8px}p{margin:0 0 10px;color:var(--mute)}code{font-size:13px}</style></head>
<body><div class="card"><div class="logo">${APP_ICON}</div>${body}</div></body></html>`;
}

// ---------- auth ----------
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  q('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), userId, now(), expires);
  return token;
}

function authUser(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!m) fail(401, 'Not signed in');
  const row = q(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(m[1]), now());
  if (!row) fail(401, 'Session expired — sign in again');
  return row;
}

// Google-verified accounts get invites by email; password accounts join with an invite code.
const publicUser = (u) => u && { id: u.id, email: u.email, name: u.name, picture: u.picture, verified: !!u.google_sub };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function checkPassword(password, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

// At most 10 failed sign-ins per email (and per IP) every 15 minutes.
const failures = new Map();
function throttle(keys) {
  const cutoff = Date.now() - 15 * 60e3;
  for (const k of keys) {
    const list = (failures.get(k) || []).filter((t) => t > cutoff);
    failures.set(k, list);
    if (list.length >= 10) fail(429, 'Too many attempts. Wait 15 minutes and try again.');
  }
}
const recordFailure = (keys) => keys.forEach((k) => failures.set(k, [...(failures.get(k) || []), Date.now()]));
const clientIp = (req) => String(req.headers['x-real-ip'] || req.socket.remoteAddress || '');

// Short, unambiguous invite codes (no 0/O/1/I).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  const bytes = crypto.randomBytes(10);
  let c = '';
  for (const b of bytes) c += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `${c.slice(0, 5)}-${c.slice(5)}`;
}

// Pending Google sign-ins: key -> { redirect, state, at }
const pending = new Map();
setInterval(() => {
  const cutoff = Date.now() - 15 * 60e3;
  for (const [k, v] of pending) if (v.at < cutoff) pending.delete(k);
}, 60e3).unref();

// The ApiDock app receives the session on its own local server, so only loopback redirects are allowed.
function isLoopback(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

// ---------- permissions ----------
function teamRole(teamId, userId) {
  return q('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId)?.role || null;
}
function requireTeam(teamId, userId, roles = ['owner', 'admin', 'member']) {
  const role = teamRole(teamId, userId);
  if (!role) fail(404, 'Team not found');
  if (!roles.includes(role)) fail(403, 'You need to be a team owner or admin for that');
  return role;
}
function collectionRole(collId, userId) {
  return q('SELECT role FROM collection_access WHERE collection_id = ? AND user_id = ?').get(collId, userId)?.role || null;
}
function requireCollection(collId, userId, roles = ['owner', 'editor', 'viewer']) {
  const coll = q('SELECT * FROM collections WHERE id = ?').get(collId);
  const role = coll && collectionRole(collId, userId);
  if (!coll || !role) fail(404, 'Collection not found or not shared with you');
  if (!roles.includes(role)) fail(403, role === 'viewer' ? 'You have view-only access to this collection' : 'Only the owner can do that');
  return { coll, role };
}

function collectionMeta(c, role) {
  const team = q('SELECT name FROM teams WHERE id = ?').get(c.team_id);
  const by = c.updated_by && q('SELECT name, email FROM users WHERE id = ?').get(c.updated_by);
  return { id: c.id, name: c.name, teamId: c.team_id, teamName: team?.name || '', role, version: c.version, updatedAt: c.updated_at, updatedBy: by ? by.name || by.email : null };
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler, auth: opts.auth !== false });
};

// --- Google sign-in ---
route(
  'GET',
  '/auth/google/start',
  (req, res, { query }) => {
    if (!GOOGLE_CLIENT_ID) fail(503, 'Google login is not configured on this server yet');
    const back = query.get('redirect') || '';
    if (!isLoopback(back)) fail(400, 'Invalid redirect');
    const key = crypto.randomBytes(18).toString('base64url');
    pending.set(key, { redirect: back, state: query.get('state') || '', at: Date.now() });
    const p = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: `${PUBLIC_URL}/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state: key,
      prompt: 'select_account',
    });
    redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${p}`);
  },
  { auth: false },
);

route(
  'GET',
  '/auth/google/callback',
  async (req, res, { query }) => {
    const p = pending.get(query.get('state') || '');
    if (!p) return send(res, 400, page('Sign-in expired', '<h1>Sign-in link expired</h1><p>Go back to ApiDock and click <b>Sign in with Google</b> again.</p>'));
    pending.delete(query.get('state'));
    if (query.get('error')) return send(res, 400, page('Sign-in cancelled', `<h1>Sign-in cancelled</h1><p>${esc(query.get('error'))}</p>`));

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: query.get('code') || '',
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: `${PUBLIC_URL}/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
    });
    const tok = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tok.access_token) return send(res, 502, page('Sign-in failed', `<h1>Google sign-in failed</h1><p>${esc(tok.error_description || tok.error || tokenRes.status)}</p>`));
    const info = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tok.access_token}` } })).json();
    if (!info.sub || !info.email || info.email_verified === false) return send(res, 403, page('Sign-in failed', '<h1>Google account has no verified email</h1>'));

    const email = normEmail(info.email);
    let user = q('SELECT * FROM users WHERE google_sub = ? OR email = ?').get(info.sub, email);
    if (user) {
      q('UPDATE users SET google_sub = ?, email = ?, name = ?, picture = ? WHERE id = ?').run(info.sub, email, info.name || email, info.picture || null, user.id);
    } else {
      const id = newId();
      q('INSERT INTO users (id, google_sub, email, name, picture, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, info.sub, email, info.name || email, info.picture || null, now());
      user = { id };
    }
    const session = createSession(user.id);
    const back = new URL(p.redirect);
    back.searchParams.set('token', session);
    back.searchParams.set('state', p.state);
    redirect(res, back.toString());
  },
  { auth: false },
);

route('GET', '/auth/config', () => ({ google: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET), password: true }), { auth: false });

route(
  'POST',
  '/auth/register',
  (req, res, { body }) => {
    const email = normEmail(body.email);
    const name = String(body.name || '').trim().slice(0, 80);
    const password = String(body.password || '');
    if (!name) fail(400, 'Enter your name');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'Enter a valid email address');
    if (password.length < 8) fail(400, 'Use a password of at least 8 characters');
    throttle([`ip:${clientIp(req)}`]);
    const existing = q('SELECT * FROM users WHERE email = ?').get(email);
    if (existing) {
      recordFailure([`ip:${clientIp(req)}`]);
      fail(409, existing.password_hash ? 'An account with this email already exists — sign in instead' : 'This email signs in with Google — use Continue with Google');
    }
    const id = newId();
    q('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(id, email, name, hashPassword(password), now());
    return { token: createSession(id), user: publicUser(q('SELECT * FROM users WHERE id = ?').get(id)) };
  },
  { auth: false },
);

route(
  'POST',
  '/auth/login',
  (req, res, { body }) => {
    const email = normEmail(body.email);
    const keys = [`email:${email}`, `ip:${clientIp(req)}`];
    throttle(keys);
    const user = q('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !user.password_hash || !checkPassword(String(body.password || ''), user.password_hash)) {
      recordFailure(keys);
      if (user && !user.password_hash) fail(401, 'This email signs in with Google — use Continue with Google');
      fail(401, 'Wrong email or password');
    }
    failures.delete(`email:${email}`);
    return { token: createSession(user.id), user: publicUser(user) };
  },
  { auth: false },
);

route('POST', '/api/logout', (req, res) => {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (m) q('DELETE FROM sessions WHERE token_hash = ?').run(sha256(m[1]));
  return { ok: true };
});

// --- me ---
route('GET', '/api/me', (req, res, { user }) => {
  const teams = q(`SELECT t.id, t.name, m.role, (SELECT COUNT(*) FROM team_members x WHERE x.team_id = t.id) AS members
                   FROM teams t JOIN team_members m ON m.team_id = t.id WHERE m.user_id = ? ORDER BY t.name`).all(user.id);
  const invites = q(`SELECT i.id, i.role, i.created_at AS createdAt, t.name AS teamName, u.name AS invitedBy, i.grants
                     FROM invites i JOIN teams t ON t.id = i.team_id JOIN users u ON u.id = i.invited_by
                     WHERE i.email = ? AND ? = 1 ORDER BY i.created_at DESC`).all(user.email, user.google_sub ? 1 : 0)
    .map((i) => ({ ...i, collections: JSON.parse(i.grants || '[]').length, grants: undefined }));
  return { user: publicUser(user), teams, invites };
});

// --- teams ---
route('POST', '/api/teams', async (req, res, { user, body }) => {
  const name = String(body.name || '').trim();
  if (!name) fail(400, 'Team name is required');
  const id = newId();
  q('INSERT INTO teams (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)').run(id, name.slice(0, 80), user.id, now());
  q('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(id, user.id, 'owner', now());
  return { id, name, role: 'owner', members: 1 };
});

route('GET', '/api/teams/:id', (req, res, { user, params }) => {
  const role = requireTeam(params.id, user.id);
  const team = q('SELECT id, name, owner_id AS ownerId, created_at AS createdAt FROM teams WHERE id = ?').get(params.id);
  const members = q(`SELECT u.id, u.email, u.name, u.picture, m.role, m.joined_at AS joinedAt FROM team_members m JOIN users u ON u.id = m.user_id
                     WHERE m.team_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.name`).all(params.id);
  const invites = ['owner', 'admin'].includes(role)
    ? q(`SELECT i.id, i.email, i.role, i.code, i.created_at AS createdAt, u.name AS invitedBy FROM invites i JOIN users u ON u.id = i.invited_by WHERE i.team_id = ? ORDER BY i.created_at DESC`).all(params.id)
    : [];
  const collections = q(`SELECT c.*, a.role AS my_role FROM collections c LEFT JOIN collection_access a ON a.collection_id = c.id AND a.user_id = ? WHERE c.team_id = ? ORDER BY c.name`)
    .all(user.id, params.id)
    .map((c) => {
      const access = q(`SELECT u.id, u.email, u.name, a.role FROM collection_access a JOIN users u ON u.id = a.user_id WHERE a.collection_id = ? ORDER BY u.name`).all(c.id);
      return { ...collectionMeta(c, c.my_role), access, visible: !!c.my_role };
    })
    .filter((c) => c.visible || ['owner', 'admin'].includes(role));
  return { team, role, members, invites, collections };
});

route('PATCH', '/api/teams/:id', (req, res, { user, params, body }) => {
  requireTeam(params.id, user.id, ['owner', 'admin']);
  const name = String(body.name || '').trim();
  if (!name) fail(400, 'Team name is required');
  q('UPDATE teams SET name = ? WHERE id = ?').run(name.slice(0, 80), params.id);
  return { ok: true };
});

route('DELETE', '/api/teams/:id', (req, res, { user, params }) => {
  requireTeam(params.id, user.id, ['owner']);
  q('DELETE FROM teams WHERE id = ?').run(params.id);
  return { ok: true };
});

// --- invites ---
route('POST', '/api/teams/:id/invites', (req, res, { user, params, body }) => {
  requireTeam(params.id, user.id, ['owner', 'admin']);
  const email = normEmail(body.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'Enter a valid email address');
  const role = body.role === 'admin' ? 'admin' : 'member';
  const existing = q('SELECT u.id FROM users u JOIN team_members m ON m.user_id = u.id WHERE m.team_id = ? AND u.email = ?').get(params.id, email);
  if (existing) fail(409, 'That person is already in the team');
  // Collections the person gets once they accept; only collections this team owns.
  const grants = (Array.isArray(body.collections) ? body.collections : [])
    .filter((g) => g && q('SELECT 1 FROM collections WHERE id = ? AND team_id = ?').get(g.id, params.id))
    .map((g) => ({ id: g.id, role: g.role === 'editor' ? 'editor' : 'viewer' }));
  q('DELETE FROM invites WHERE team_id = ? AND email = ?').run(params.id, email);
  const id = newId();
  const code = newCode();
  q('INSERT INTO invites (id, team_id, email, role, grants, invited_by, created_at, code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, params.id, email, role, JSON.stringify(grants), user.id, now(), code);
  return { id, email, role, code };
});

route('DELETE', '/api/teams/:id/invites/:inviteId', (req, res, { user, params }) => {
  requireTeam(params.id, user.id, ['owner', 'admin']);
  q('DELETE FROM invites WHERE id = ? AND team_id = ?').run(params.inviteId, params.id);
  return { ok: true };
});

function joinFromInvite(inv, user) {
  if (!teamRole(inv.team_id, user.id)) q('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(inv.team_id, user.id, inv.role, now());
  for (const g of JSON.parse(inv.grants || '[]')) {
    if (q('SELECT 1 FROM collections WHERE id = ? AND team_id = ?').get(g.id, inv.team_id) && !collectionRole(g.id, user.id)) {
      q('INSERT INTO collection_access (collection_id, user_id, role) VALUES (?, ?, ?)').run(g.id, user.id, g.role);
    }
  }
  q('DELETE FROM invites WHERE id = ?').run(inv.id);
  const team = q('SELECT name FROM teams WHERE id = ?').get(inv.team_id);
  return { ok: true, teamId: inv.team_id, teamName: team?.name || '' };
}

route('POST', '/api/invites/:id/accept', (req, res, { user, params }) => {
  if (!user.google_sub) fail(403, 'Join with the invite code you were given');
  const inv = q('SELECT * FROM invites WHERE id = ? AND email = ?').get(params.id, user.email);
  if (!inv) fail(404, 'Invite not found');
  return joinFromInvite(inv, user);
});

route('POST', '/api/invites/redeem', (req, res, { user, body }) => {
  const keys = [`code:${user.id}`];
  throttle(keys);
  const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const inv = code.length === 10 && q('SELECT * FROM invites WHERE code = ?').get(`${code.slice(0, 5)}-${code.slice(5)}`);
  if (!inv) {
    recordFailure(keys);
    fail(404, 'That invite code is not valid (it may have been used or cancelled)');
  }
  return joinFromInvite(inv, user);
});

route('POST', '/api/invites/:id/decline', (req, res, { user, params }) => {
  q('DELETE FROM invites WHERE id = ? AND email = ?').run(params.id, user.email);
  return { ok: true };
});

// --- members ---
route('PATCH', '/api/teams/:id/members/:userId', (req, res, { user, params, body }) => {
  requireTeam(params.id, user.id, ['owner', 'admin']);
  const target = teamRole(params.id, params.userId);
  if (!target) fail(404, 'Member not found');
  if (target === 'owner') fail(400, "The owner's role can't be changed");
  q('UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?').run(body.role === 'admin' ? 'admin' : 'member', params.id, params.userId);
  return { ok: true };
});

route('DELETE', '/api/teams/:id/members/:userId', (req, res, { user, params }) => {
  const self = params.userId === user.id;
  requireTeam(params.id, user.id, self ? ['admin', 'member'] : ['owner', 'admin']);
  const target = teamRole(params.id, params.userId);
  if (!target) fail(404, 'Member not found');
  if (target === 'owner') fail(400, 'The owner can’t be removed — delete the team instead');
  // Leaving a team also removes access to its collections.
  q(`DELETE FROM collection_access WHERE user_id = ? AND collection_id IN (SELECT id FROM collections WHERE team_id = ?)`).run(params.userId, params.id);
  q('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(params.id, params.userId);
  return { ok: true };
});

// --- collections ---
route('GET', '/api/collections', (req, res, { user }) => {
  return q(`SELECT c.*, a.role AS my_role FROM collections c JOIN collection_access a ON a.collection_id = c.id WHERE a.user_id = ? ORDER BY c.name`)
    .all(user.id)
    .map((c) => collectionMeta(c, c.my_role));
});

route('GET', '/api/collections/:id', (req, res, { user, params }) => {
  const { coll, role } = requireCollection(params.id, user.id);
  return { ...collectionMeta(coll, role), data: JSON.parse(coll.data) };
});

route('POST', '/api/collections', (req, res, { user, body }) => {
  requireTeam(body.teamId, user.id);
  const data = body.data;
  if (!data || typeof data !== 'object') fail(400, 'Collection data is required');
  const id = data.id && !q('SELECT 1 FROM collections WHERE id = ?').get(data.id) ? data.id : newId();
  data.id = id;
  const t = now();
  q('INSERT INTO collections (id, team_id, owner_id, name, data, version, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').run(id, body.teamId, user.id, String(data.name || 'Collection').slice(0, 200), JSON.stringify(data), t, user.id);
  q('INSERT INTO collection_access (collection_id, user_id, role) VALUES (?, ?, ?)').run(id, user.id, 'owner');
  return { ...collectionMeta(q('SELECT * FROM collections WHERE id = ?').get(id), 'owner'), data };
});

route('PUT', '/api/collections/:id', (req, res, { user, params, body }) => {
  const { coll, role } = requireCollection(params.id, user.id, ['owner', 'editor']);
  if (body.baseVersion != null && Number(body.baseVersion) !== coll.version) {
    const by = coll.updated_by && q('SELECT name, email FROM users WHERE id = ?').get(coll.updated_by);
    res.statusCode = 409;
    return { error: `${by ? by.name || by.email : 'Someone'} changed this collection meanwhile`, current: { ...collectionMeta(coll, role), data: JSON.parse(coll.data) } };
  }
  const data = { ...body.data, id: coll.id };
  q('UPDATE collections SET data = ?, name = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?').run(JSON.stringify(data), String(data.name || coll.name).slice(0, 200), now(), user.id, coll.id);
  return collectionMeta(q('SELECT * FROM collections WHERE id = ?').get(coll.id), role);
});

route('DELETE', '/api/collections/:id', (req, res, { user, params }) => {
  const { coll } = requireCollection(params.id, user.id);
  const isOwner = collectionRole(coll.id, user.id) === 'owner' || ['owner', 'admin'].includes(teamRole(coll.team_id, user.id));
  if (!isOwner) fail(403, 'Only the collection owner or a team admin can delete it');
  q('DELETE FROM collections WHERE id = ?').run(coll.id);
  return { ok: true };
});

// Grant / change / revoke a team member's access to a collection.
route('PUT', '/api/collections/:id/access', (req, res, { user, params, body }) => {
  const coll = q('SELECT * FROM collections WHERE id = ?').get(params.id);
  if (!coll) fail(404, 'Collection not found');
  const mine = collectionRole(coll.id, user.id);
  if (mine !== 'owner' && !['owner', 'admin'].includes(teamRole(coll.team_id, user.id))) fail(403, 'Only the collection owner or a team admin can change access');
  if (!teamRole(coll.team_id, body.userId)) fail(400, 'That person is not in the team');
  if (body.userId === coll.owner_id) fail(400, "The owner's access can't be changed");
  if (!body.role) q('DELETE FROM collection_access WHERE collection_id = ? AND user_id = ?').run(coll.id, body.userId);
  else
    q(`INSERT INTO collection_access (collection_id, user_id, role) VALUES (?, ?, ?)
       ON CONFLICT(collection_id, user_id) DO UPDATE SET role = excluded.role`).run(coll.id, body.userId, body.role === 'editor' ? 'editor' : 'viewer');
  return { ok: true };
});

// ---------- app updates ----------
// nginx serves UPDATES_DIR at /updates/ for the in-app updater. New releases are
// uploaded here by `npm run release`. The server only keeps the SHA-256 of the
// release token (UPDATES_TOKEN_SHA256); the token itself stays with the releaser.
const UPDATES_DIR = process.env.UPDATES_DIR || path.join(__dirname, 'updates');
const UPDATES_TOKEN_SHA256 = (process.env.UPDATES_TOKEN_SHA256 || '').toLowerCase();
const UPDATE_FILE = /^(ApiDock-Setup-\d+\.\d+\.\d+\.exe(\.blockmap)?|ApiDock-\d+\.\d+\.\d+-(mac|linux)-[a-z0-9_]+\.(dmg|zip|AppImage|deb)(\.blockmap)?|latest(-mac|-linux)?\.yml)$/;
const MAX_UPDATE_BYTES = 400 * 1024 * 1024;

function handleUpdateUpload(req, res, name) {
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const ok = /^[0-9a-f]{64}$/.test(UPDATES_TOKEN_SHA256) && given && crypto.timingSafeEqual(Buffer.from(sha256(given)), Buffer.from(UPDATES_TOKEN_SHA256));
  if (!ok) return send(res, 401, { error: 'Bad release token' });
  if (!UPDATE_FILE.test(name)) return send(res, 400, { error: 'File name not allowed' });
  fs.mkdirSync(UPDATES_DIR, { recursive: true });
  const tmp = path.join(UPDATES_DIR, `.upload-${process.pid}-${Date.now()}-${name}`);
  const out = fs.createWriteStream(tmp, { mode: 0o644 });
  const hash = crypto.createHash('sha512');
  let size = 0;
  let failed = false;
  const abort = (status, message) => {
    if (failed) return;
    failed = true;
    out.destroy();
    fs.rm(tmp, { force: true }, () => {});
    if (!res.headersSent) send(res, status, { error: message });
  };
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_UPDATE_BYTES) return abort(413, 'File too large'), req.destroy();
    hash.update(chunk);
    if (!out.write(chunk)) req.pause();
  });
  out.on('drain', () => req.resume());
  req.on('error', () => abort(400, 'Upload interrupted'));
  req.on('end', () => {
    if (failed) return;
    out.end(() => {
      // Atomic replace: the updater never sees a half-written file.
      fs.rename(tmp, path.join(UPDATES_DIR, name), (err) => {
        if (err) return abort(500, 'Could not store the file');
        send(res, 200, { ok: true, name, size, sha512: hash.digest('base64') });
      });
    });
  });
}

// ---------- download page ----------
// The newest published build of each platform, as described by the updater's
// latest*.yml (Windows: latest.yml, macOS: latest-mac.yml, Linux: latest-linux.yml).
function readManifest(name) {
  try {
    const yml = fs.readFileSync(path.join(UPDATES_DIR, name), 'utf8');
    const version = ((yml.match(/^version:\s*(.+)$/m) || [])[1] || '').trim();
    const date = (yml.match(/^releaseDate:\s*'?([^'\n]+)/m) || [])[1];
    const files = [...yml.matchAll(/-\s*url:\s*(.+)\r?\n(?:\s+\w+:.*\r?\n)*?\s+size:\s*(\d+)/g)].map(([, url, size]) => ({ file: url.trim(), size: Number(size) }));
    if (!version) return null;
    return { version, date, files };
  } catch {
    return null;
  }
}

const exists = (file) => fs.existsSync(path.join(UPDATES_DIR, file));
const sizeOf = (file) => {
  try {
    return fs.statSync(path.join(UPDATES_DIR, file)).size;
  } catch {
    return 0;
  }
};

// Every download, keyed by what /download?os=… accepts.
function downloads() {
  const out = {};
  const win = readManifest('latest.yml');
  const winFile = win && win.files.find((f) => f.file.endsWith('.exe'));
  if (winFile && exists(winFile.file)) out.windows = { label: 'Windows', note: 'Installer (.exe)', version: win.version, date: win.date, file: winFile.file, size: winFile.size };
  const mac = readManifest('latest-mac.yml');
  if (mac) {
    for (const [arch, label] of [['arm64', 'Apple Silicon (M1–M4)'], ['x64', 'Intel']]) {
      const file = `ApiDock-${mac.version}-mac-${arch}.dmg`;
      if (exists(file)) out[`mac-${arch}`] = { label: 'macOS', note: label, version: mac.version, date: mac.date, file, size: sizeOf(file) };
    }
  }
  const linux = readManifest('latest-linux.yml');
  if (linux) {
    const appImage = linux.files.find((f) => f.file.endsWith('.AppImage'));
    if (appImage && exists(appImage.file)) out['linux-appimage'] = { label: 'Linux', note: 'AppImage — any distro', version: linux.version, date: linux.date, file: appImage.file, size: appImage.size };
    const deb = fs.readdirSync(UPDATES_DIR).find((f) => f === `ApiDock-${linux.version}-linux-amd64.deb` || f === `ApiDock-${linux.version}-linux-x64.deb`);
    if (deb) out['linux-deb'] = { label: 'Linux', note: 'Debian / Ubuntu (.deb)', version: linux.version, date: linux.date, file: deb, size: sizeOf(deb) };
  }
  return out;
}

// Picks the download for a browser: ?os=… when given, else a guess from the user agent.
function pickDownload(all, os, ua) {
  if (os && all[os]) return all[os];
  if (os === 'mac') return all['mac-arm64'] || all['mac-x64'];
  if (os === 'linux') return all['linux-appimage'] || all['linux-deb'];
  if (/Macintosh|Mac OS X/i.test(ua)) return all['mac-arm64'] || all['mac-x64'] || all.windows;
  if (/Linux|X11/i.test(ua) && !/Android/i.test(ua)) return all['linux-appimage'] || all['linux-deb'] || all.windows;
  return all.windows || Object.values(all)[0];
}

// ---------- landing page ----------
// The public page at /: what ApiDock is, and the right download for each OS.
const LANDING_CSS = `
:root{color-scheme:light;--paper:#f4f2ec;--surface:#fbfaf6;--raise:#fff;--line:#e7e3d9;--line-2:#d7d1c3;--ink:#1f1d1a;--ink-2:#4a463f;--mute:#8a8478;--faint:#b9b3a6;
--accent:#c4562d;--accent-ink:#9c3f1d;--accent-soft:#f6e6dc;--ok:#2f7d4f;--var:#2b6c8f;--var-soft:#e1eef5;--key:#8a3fb0;--str:#2f7d4f;--num:#b5651d;
--shadow:0 30px 80px rgba(31,29,26,.16),0 4px 14px rgba(31,29,26,.06)}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--paper:#121211;--surface:#171715;--raise:#1e1e1b;--line:#2a2926;--line-2:#383631;--ink:#ecebe5;--ink-2:#c4c1b8;--mute:#8f8b80;--faint:#5d5a53;
--accent:#ec8a5f;--accent-ink:#f2a481;--accent-soft:#3a241a;--ok:#6fcf97;--var:#7cc4e8;--var-soft:#1c2f3a;--key:#d39bf0;--str:#8fd6a8;--num:#f0b27a;--shadow:0 30px 80px rgba(0,0,0,.55),0 4px 14px rgba(0,0,0,.3)}}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 'IBM Plex Sans',system-ui,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}
code{font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:.86em;background:var(--surface);border:1px solid var(--line);border-radius:5px;padding:1px 5px;white-space:nowrap}
.wrap{max-width:1120px;margin:0 auto;padding:0 24px}
.nav{display:flex;align-items:center;justify-content:space-between;height:72px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:17px;text-decoration:none}
.mark{width:34px;height:34px;flex:none}.mark svg{width:100%;height:100%;display:block}
.nav nav{display:flex;gap:26px;font-size:14px;color:var(--ink-2)}
.nav nav a{text-decoration:none}.nav nav a:hover{color:var(--ink)}
.hero{display:grid;grid-template-columns:1fr 1.15fr;gap:56px;align-items:center;padding:56px 24px 88px}
.eyebrow{display:inline-flex;align-items:center;gap:8px;font:500 12px 'IBM Plex Mono',monospace;color:var(--accent-ink);background:var(--accent-soft);border-radius:99px;padding:4px 12px;margin-bottom:22px}
.eyebrow i{width:6px;height:6px;border-radius:50%;background:var(--accent)}
h1{font-size:clamp(36px,5vw,56px);line-height:1.04;letter-spacing:-.035em;margin:0 0 20px;font-weight:700}
h1 em{font-style:normal;color:var(--accent)}
.lede{font-size:18px;color:var(--ink-2);margin:0 0 30px;max-width:30em}
.cta{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.btn{display:inline-flex;align-items:center;gap:10px;height:50px;padding:0 22px;border-radius:12px;font-weight:600;font-size:15px;text-decoration:none;transition:transform .12s,background .12s}
.btn:hover{transform:translateY(-1px)}
.btn-primary{background:var(--ink);color:var(--paper)}
.btn-ghost{border:1px solid var(--line-2);color:var(--ink)}
.btn-ghost:hover{background:var(--surface)}
.btn small{font-weight:400;opacity:.65;font-size:13px}
.meta{margin-top:16px;font-size:13px;color:var(--mute)}
.shot{position:relative;border-radius:14px;background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow);overflow:hidden;font-size:12.5px;min-width:0}
.bar{display:flex;align-items:center;gap:6px;padding:9px 14px;border-bottom:1px solid var(--line);background:var(--raise)}
.bar .t{display:flex;align-items:center;gap:7px;margin:0 auto;font-size:12px;font-weight:600;color:var(--ink-2);padding-right:42px}.bar .t svg{width:16px;height:16px}
.bar i{width:10px;height:10px;border-radius:50%;background:var(--line-2)}
.app{display:grid;grid-template-columns:170px 1fr;min-height:360px}
.side{border-right:1px solid var(--line);padding:14px 10px;background:var(--paper)}
.side b{display:block;font-size:10px;letter-spacing:.08em;color:var(--mute);margin:0 6px 8px}
.side div{display:flex;gap:8px;padding:5px 6px;border-radius:6px;white-space:nowrap;overflow:hidden;color:var(--ink-2)}
.side div.on{background:var(--accent-soft);color:var(--ink)}
.m{font:600 9.5px 'IBM Plex Mono',monospace;width:30px;flex:none;padding-top:2px}.m.post{color:var(--num)}.m.get{color:var(--ok)}
.main{padding:16px;min-width:0}
.url{display:flex;align-items:center;border:1px solid var(--line);border-radius:9px;background:var(--raise);height:38px;overflow:hidden}
.url .m{width:auto;padding:0 12px;font-size:11px;border-right:1px solid var(--line);height:100%;display:grid;place-items:center}
.url .path{padding:0 12px;font-family:'IBM Plex Mono',monospace;white-space:nowrap;overflow:hidden;flex:1}
.v{color:var(--var);background:var(--var-soft);border-radius:4px;padding:0 2px}
.send{margin:0 4px 0 auto;background:var(--accent);color:#fff;font-weight:600;border-radius:7px;padding:6px 14px;font-size:12px}
.tabs{display:flex;gap:16px;margin:14px 2px 10px;color:var(--mute);font-size:12px}.tabs .on{color:var(--ink);font-weight:600;box-shadow:inset 0 -2px var(--accent);padding-bottom:6px}
.code{font:12px/1.75 'IBM Plex Mono',monospace;background:var(--raise);border:1px solid var(--line);border-radius:9px;padding:10px 14px;white-space:pre;overflow:hidden}
.k{color:var(--key)}.s{color:var(--str)}.n{color:var(--num)}
.res{display:flex;align-items:center;gap:10px;margin:14px 2px 8px;font-size:12px;color:var(--mute)}
.res strong{font-size:18px;color:var(--ok);font-family:'IBM Plex Mono',monospace}
.pop{position:absolute;right:18px;top:196px;width:224px;background:var(--raise);border:1px solid var(--line-2);border-radius:10px;box-shadow:var(--shadow);padding:10px;font-size:12px;animation:float 5s ease-in-out infinite}
.pop .h{display:flex;justify-content:space-between;margin-bottom:7px}.pop .h b{font-family:'IBM Plex Mono',monospace;color:var(--var)}
.pop .h span{font-size:10.5px;color:var(--mute);border:1px solid var(--line);border-radius:99px;padding:0 7px}
.pop .in{border:1px solid var(--accent);border-radius:6px;padding:6px 9px;font-family:'IBM Plex Mono',monospace}
.pop .hint{font-size:10.5px;color:var(--faint);margin-top:6px}
@keyframes float{50%{transform:translateY(-6px)}}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}.pop{animation:none}.btn{transition:none}}
section{padding:84px 0;border-top:1px solid var(--line)}
.sec-head{max-width:620px;margin-bottom:44px}
h2{font-size:clamp(28px,3.4vw,38px);letter-spacing:-.03em;line-height:1.1;margin:0 0 12px}
.sec-head p{color:var(--ink-2);margin:0;font-size:17px}
.features{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.feature{background:var(--surface);padding:26px 24px}
.feature .ic{width:36px;height:36px;border-radius:9px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent-ink);margin-bottom:16px}
.feature h3{font-size:16px;margin:0 0 6px}.feature p{margin:0;color:var(--ink-2);font-size:14.5px}
.plats{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.plat{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:26px;display:flex;flex-direction:column}
.plat.best{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.plat-top{display:flex;align-items:center;gap:12px;margin-bottom:6px}
.plat-top .ic{width:40px;height:40px;border-radius:10px;background:var(--ink);color:var(--paper);display:grid;place-items:center}
.plat h3{font-size:19px;margin:0}
.tag{margin-left:auto;font:500 11px 'IBM Plex Mono',monospace;color:var(--accent-ink);background:var(--accent-soft);border-radius:99px;padding:2px 9px;white-space:nowrap}
.plat .sub{color:var(--mute);font-size:13.5px;margin:0 0 14px}
.dl{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border:1px solid var(--line-2);border-radius:10px;text-decoration:none;margin-top:10px;background:var(--raise);transition:border-color .12s}
.dl:hover{border-color:var(--ink)}
.dl b{font-size:14.5px;display:block;font-weight:600}.dl span{font-size:12.5px;color:var(--mute)}
.dl svg{flex:none;color:var(--ink-2)}
.plat .note{margin:auto 0 0;padding-top:18px;font-size:13px;color:var(--mute)}
.none{color:var(--mute);font-size:14px;padding:12px 0}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.step{padding:24px;border-radius:14px;border:1px dashed var(--line-2)}
.step h3{font-size:15px;margin:0 0 12px;display:flex;gap:10px;align-items:center}
.step ol{margin:0;padding-left:18px;color:var(--ink-2);font-size:14px}.step li{margin-bottom:8px}
footer{border-top:1px solid var(--line);padding:30px 0 40px;font-size:13px;color:var(--mute)}
footer .wrap{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
footer .fb{display:flex;align-items:center;gap:8px}footer .fb svg{width:20px;height:20px}
@media (max-width:920px){.hero{grid-template-columns:1fr;gap:44px;padding-top:28px}.features,.plats,.steps{grid-template-columns:1fr}.nav nav{display:none}}
@media (max-width:560px){code{white-space:normal;overflow-wrap:anywhere}.wrap,.hero{padding-left:16px;padding-right:16px}.app{grid-template-columns:1fr}.side{display:none}.pop{right:12px;width:200px}section{padding:60px 0}.cta .btn{width:100%;justify-content:center}}
`;

const svgIcon = (d, s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  download: svgIcon('<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>', 18),
  windows: svgIcon('<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>'),
  mac: svgIcon('<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>'),
  linux: svgIcon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3"/><path d="M13 15h4"/>'),
  import: svgIcon('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><rect x="3" y="17" width="18" height="4" rx="1"/>'),
  vars: svgIcon('<path d="M8 4c-2 0-3 1-3 3v2c0 1.5-1 3-2 3 1 0 2 1.5 2 3v2c0 2 1 3 3 3"/><path d="M16 4c2 0 3 1 3 3v2c0 1.5 1 3 2 3-1 0-2 1.5-2 3v2c0 2-1 3-3 3"/>'),
  edit: svgIcon('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/>'),
  form: svgIcon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10"/>'),
  team: svgIcon('<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 4.5a3.2 3.2 0 0 1 0 6.3M21 20c0-2.6-1.6-4.8-4-5.6"/>'),
  update: svgIcon('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>'),
};

function landingPage(ua) {
  const all = downloads();
  const best = pickDownload(all, null, ua || '');
  const bestKey = best ? Object.keys(all).find((k) => all[k] === best) : null;
  const bestOs = bestKey ? bestKey.split('-')[0] : null;
  const mb = (n) => `${Math.round(n / 1048576)} MB`;
  const shown = best || Object.values(all)[0] || {};
  const version = shown.version;
  const when = shown.date ? new Date(shown.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

  const heroCta = best
    ? `<a class="btn btn-primary" href="/download?os=${bestKey}">${ICONS.download} Download for ${esc(best.label)}${best.label === 'macOS' ? ` <small>${esc(best.note.split(' (')[0])}</small>` : ''}</a>
      <a class="btn btn-ghost" href="#download">Other platforms</a>`
    : '<a class="btn btn-ghost" href="#download">Downloads coming soon</a>';

  const dl = (key, title) => {
    const d = all[key];
    if (!d) return '';
    return `<a class="dl" href="/download?os=${key}"><div><b>${esc(title)}</b><span>Version ${esc(d.version)} · ${mb(d.size)}</span></div>${ICONS.download}</a>`;
  };
  const plat = (os, name, icon, sub, links, note) => {
    const body = links.filter(Boolean).join('');
    return `<div class="plat${bestOs === os ? ' best' : ''}">
      <div class="plat-top"><div class="ic">${icon}</div><h3>${name}</h3>${bestOs === os ? '<span class="tag">Your system</span>' : ''}</div>
      <p class="sub">${sub}</p>
      ${body || '<p class="none">Not published yet.</p>'}
      <p class="note">${note}</p>
    </div>`;
  };
  const feature = (icon, title, text) => `<div class="feature"><div class="ic">${ICONS[icon]}</div><h3>${title}</h3><p>${text}</p></div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ApiDock</title>
<link rel="icon" href="/icon.svg">
<meta name="description" content="ApiDock is a desktop API client for Windows, macOS and Linux: import Postman collections, keep variable sets, send requests and share collections with your team.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${LANDING_CSS}</style></head><body>
<header class="wrap nav">
  <a class="brand" href="/"><span class="mark">${APP_ICON}</span>ApiDock</a>
  <nav><a href="#features">Features</a><a href="#download">Download</a><a href="#install">Install</a></nav>
</header>
<main>
<div class="wrap hero">
  <div>
    <span class="eyebrow"><i></i>${version ? `Version ${esc(version)}${when ? ' · ' + esc(when) : ''}` : 'Desktop API client'}</span>
    <h1>Send requests,<br>not <em>sign-up forms.</em></h1>
    <p class="lede">ApiDock is a desktop API client that runs on your machine. Import your Postman collections, switch environments in one click, and share collections with your team.</p>
    <div class="cta">${heroCta}</div>
    <p class="meta">Free · Windows, macOS and Linux · Updates itself</p>
  </div>
  <div class="shot" aria-hidden="true">
    <div class="bar"><i></i><i></i><i></i><span class="t">${APP_ICON}ApiDock</span></div>
    <div class="app">
      <div class="side">
        <b>01 AUTH</b>
        <div class="on"><span class="m post">POST</span>Login</div>
        <div><span class="m get">GET</span>Current user</div>
        <div><span class="m post">POST</span>Refresh token</div>
        <b style="margin-top:14px">04 VEHICLE</b>
        <div><span class="m get">GET</span>Vehicle list</div>
        <div><span class="m get">GET</span>Vehicle details</div>
      </div>
      <div class="main">
        <div class="url"><span class="m post">POST</span><span class="path"><span class="v">{{baseUrl}}</span>/auth/login</span><span class="send">Send</span></div>
        <div class="tabs"><span>Params</span><span>Headers</span><span class="on">Body</span><span>Docs</span></div>
<div class="code">{
  <span class="k">"username"</span>: <span class="v">"{{username}}"</span>,
  <span class="k">"password"</span>: <span class="v">"{{password}}"</span>,
  <span class="k">"platform"</span>: <span class="s">"android"</span>
}</div>
        <div class="res"><strong>200</strong> OK · 155 ms · 1.2 KB</div>
<div class="code"><span class="k">"token"</span>: <span class="s">"eyJhbGciOiJIUzI1NiJ9…"</span>,
<span class="k">"expires_in"</span>: <span class="n">3600</span></div>
      </div>
    </div>
    <div class="pop"><div class="h"><b>username</b><span>Staging</span></div><div class="in">demo@example.com</div><div class="hint">Enter to save · Esc to close</div></div>
  </div>
</div>

<section id="features"><div class="wrap">
  <div class="sec-head"><h2>Everything you need to work with an API.</h2><p>Your data stays on your computer, and the app opens straight to your requests, with no sign-up.</p></div>
  <div class="features">
    ${feature('import', 'Import from Postman', 'Bring in Postman collections, environments and <code>.env</code> files. Folders, auth and examples come with them.')}
    ${feature('vars', 'Variable sets', 'Keep Staging, Production and Local values per collection and switch between them in one click. Missing variables are flagged before you send.')}
    ${feature('edit', 'Edit values where you use them', 'Hover any <code>{{variable}}</code> to see its value, type a new one and press Enter.')}
    ${feature('form', 'Typed form-data', 'Text, Number, Boolean, JSON or File fields, checked as you type, so a bad value is caught before the server sees it.')}
    ${feature('team', 'Team collections', 'Share collections with Viewer or Editor access. ApiDock warns you if two people edit at once instead of overwriting.')}
    ${feature('update', 'Always up to date', 'The app checks for new versions and installs them in one click, so everyone on the team runs the same build.')}
  </div>
</div></section>

<section id="download"><div class="wrap">
  <div class="sec-head"><h2>Download ApiDock${version ? ` ${esc(version)}` : ''}</h2><p>Pick your platform. Every download is the full app, with nothing else to install.</p></div>
  <div class="plats">
    ${plat('windows', 'Windows', ICONS.windows, 'Windows 10 and 11, 64-bit', [dl('windows', 'Installer (.exe)')], 'Updates itself.')}
    ${plat('mac', 'macOS', ICONS.mac, 'macOS 12 Monterey or newer', [dl('mac-arm64', 'Apple Silicon · M1–M4'), dl('mac-x64', 'Intel')], 'Not sure which? Apple menu → About This Mac → Chip.')}
    ${plat('linux', 'Linux', ICONS.linux, '64-bit (x86_64)', [dl('linux-appimage', 'AppImage · any distro'), dl('linux-deb', 'Debian / Ubuntu (.deb)')], 'Updates itself.')}
  </div>
</div></section>

<section id="install"><div class="wrap">
  <div class="sec-head"><h2>First start</h2><p>The builds aren’t code-signed yet, so your system asks once before opening ApiDock.</p></div>
  <div class="steps">
    <div class="step"><h3>${ICONS.windows} Windows</h3><ol><li>Run <b>ApiDock-Setup</b>.</li><li>If you see “Windows protected your PC”, click <b>More info → Run anyway</b>.</li><li>Open ApiDock from the Start menu.</li></ol></div>
    <div class="step"><h3>${ICONS.mac} macOS</h3><ol><li>Open the <code>.dmg</code> and drag ApiDock to Applications.</li><li>If macOS blocks it: <b>System Settings → Privacy &amp; Security → Open Anyway</b>.</li><li>Or run <code>xattr -cr /Applications/ApiDock.app</code> in Terminal.</li></ol></div>
    <div class="step"><h3>${ICONS.linux} Linux</h3><ol><li>AppImage: <code>chmod +x ApiDock-*.AppImage</code>, then run it.</li><li>Debian / Ubuntu: <code>sudo apt install ./ApiDock-*.deb</code></li><li>To share collections, open <b>Team</b> at the bottom left.</li></ol></div>
  </div>
</div></section>
</main>
<footer><div class="wrap"><span class="fb">${APP_ICON}ApiDock${version ? ` ${esc(version)}` : ''}</span><span>Windows and Linux update themselves. On macOS the app tells you when a new version is out.</span></div></footer>
</body></html>`;
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);
  if (req.method === 'PUT' && url.pathname.startsWith('/admin/updates/')) {
    return handleUpdateUpload(req, res, decodeURIComponent(url.pathname.slice('/admin/updates/'.length)));
  }
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, landingPage(req.headers['user-agent']));
    // Short, shareable link that always points at the newest installer:
    // /download picks by browser, /download?os=windows|mac|mac-arm64|mac-x64|linux|linux-appimage|linux-deb
    if (req.method === 'GET' && url.pathname === '/download') {
      const rel = pickDownload(downloads(), url.searchParams.get('os'), req.headers['user-agent'] || '');
      if (!rel) return send(res, 404, page('ApiDock', '<h1>No release yet</h1><p>Check back soon.</p>'));
      res.writeHead(302, { Location: `/updates/${encodeURIComponent(rel.file)}`, 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (req.method === 'GET' && (url.pathname === '/icon.svg' || url.pathname === '/favicon.ico')) {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
      return res.end(APP_ICON);
    }
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, google: !!GOOGLE_CLIENT_ID });
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const user = r.auth ? authUser(req) : null;
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
      const out = await r.handler(req, res, { params, user, body, query: url.searchParams });
      if (!res.headersSent) send(res, res.statusCode && res.statusCode !== 200 ? res.statusCode : 200, out ?? { ok: true });
      return;
    }
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Server error' : err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`ApiDock Team server on 127.0.0.1:${PORT} (${PUBLIC_URL})`));
