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

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{color-scheme:light dark;--bg:#f4f2ec;--fg:#1f1d1a;--mute:#8a8478;--card:#fff;--line:#e7e3d9}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--fg:#ecebe5;--mute:#8a867c;--card:#1c1c1a;--line:#2a2926}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,'Segoe UI',sans-serif}
.card{max-width:440px;margin:24px;padding:32px;border:1px solid var(--line);border-radius:16px;background:var(--card)}
.logo{width:44px;height:44px;border-radius:12px;background:#1f1d1a;color:#f4f2ec;display:grid;place-items:center;font:700 18px monospace;margin-bottom:16px}
h1{font-size:20px;margin:0 0 8px}p{margin:0 0 10px;color:var(--mute)}code{font-size:13px}</style></head>
<body><div class="card"><div class="logo">A</div>${body}</div></body></html>`;
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

function downloadPage(ua) {
  const all = downloads();
  const list = Object.entries(all);
  const best = pickDownload(all, null, ua || '');
  const btn = 'display:block;text-align:center;margin:18px 0 10px;padding:12px 16px;border-radius:10px;background:#1f1d1a;color:#f4f2ec;text-decoration:none;font-weight:600';
  const row = 'display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid #e7e3d9;font-size:14px;text-decoration:none;color:inherit';
  const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
  const when = best && best.date ? new Date(best.date).toISOString().slice(0, 10) : '';
  const key = best && list.find(([, d]) => d === best)[0];
  const dl = best
    ? `<a href="/download?os=${key}" style="${btn}">Download for ${esc(best.label)}${best.label === 'macOS' ? ` · ${esc(best.note)}` : ''}</a>
<p style="font-size:13px">Version ${esc(best.version)} · ${mb(best.size)}${when ? ' · ' + when : ''}</p>
<h2 style="font-size:15px;margin:26px 0 4px">All downloads</h2>
${list.map(([k, d]) => `<a href="/download?os=${k}" style="${row}"><span><b>${esc(d.label)}</b> · ${esc(d.note)}</span><span style="color:#8a8478">${esc(d.version)} · ${mb(d.size)}</span></a>`).join('\n')}`
    : '<p><b>No release published yet.</b></p>';
  return page('ApiDock', `<h1>ApiDock</h1>
<p>A desktop API client: import Postman collections, keep variable sets per collection, send requests and read responses — and share collections with your team.</p>
${dl}
<h2 style="font-size:15px;margin:26px 0 4px">First start</h2>
<p style="font-size:13px"><b>Windows</b> may show “Windows protected your PC” because the installer isn’t code-signed yet — click <b>More info → Run anyway</b>.</p>
<p style="font-size:13px"><b>macOS</b>: open the .dmg and drag ApiDock to Applications. If macOS says it can’t be opened or is damaged, go to <b>System Settings → Privacy &amp; Security → Open Anyway</b>, or run <code>xattr -cr /Applications/ApiDock.app</code> in Terminal. New versions are installed the same way.</p>
<p style="font-size:13px"><b>Linux</b>: make the AppImage executable (<code>chmod +x ApiDock-*.AppImage</code>) and run it, or install the .deb with <code>sudo apt install ./ApiDock-*.deb</code>.</p>
<p style="font-size:13px">After installing, open <b>Team</b> (bottom-left) to create an account or sign in. Windows and Linux update themselves; on macOS the app tells you when a new version is out.</p>`);
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);
  if (req.method === 'PUT' && url.pathname.startsWith('/admin/updates/')) {
    return handleUpdateUpload(req, res, decodeURIComponent(url.pathname.slice('/admin/updates/'.length)));
  }
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, downloadPage(req.headers['user-agent']));
    // Short, shareable link that always points at the newest installer:
    // /download picks by browser, /download?os=windows|mac|mac-arm64|mac-x64|linux|linux-appimage|linux-deb
    if (req.method === 'GET' && url.pathname === '/download') {
      const rel = pickDownload(downloads(), url.searchParams.get('os'), req.headers['user-agent'] || '');
      if (!rel) return send(res, 404, page('ApiDock', '<h1>No release yet</h1><p>Check back soon.</p>'));
      res.writeHead(302, { Location: `/updates/${encodeURIComponent(rel.file)}`, 'Cache-Control': 'no-store' });
      return res.end();
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
