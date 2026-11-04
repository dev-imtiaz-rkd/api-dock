// Team features: Google sign-in, teams & invites, and collections shared through
// the ApiDock Team server (always via the local proxy at /api/cloud/...).
import { h, icon, api, toast, modal, confirmModal, promptModal, selectEl, timeAgo, copyText } from './util.js';
import { S, getCollection, cloudApi, fromCloud, toCloudData, clone, findItem, normalizeRequest } from './model.js';
import { app } from './bus.js';

const POLL_MS = 15_000;
let pollTimer = null;

// ---------- account ----------
export async function loadCloudStatus() {
  S.cloud = await api('GET', '/api/cloud/status').catch(() => ({ signedIn: false }));
  return S.cloud;
}

export async function loadMe() {
  if (!S.cloud?.signedIn) {
    S.me = null;
    return null;
  }
  try {
    S.me = await cloudApi('GET', '/me');
  } catch (err) {
    if (err.status === 401) await loadCloudStatus();
    S.me = S.me || null;
  }
  return S.me;
}

export async function signIn() {
  let url;
  try {
    ({ url } = await api('POST', '/api/cloud/login'));
  } catch (err) {
    return toast(err.message, 'error');
  }
  // Desktop: opens the system browser. Browser version: a new tab.
  window.open(url, '_blank', 'noopener');
  toast('Finish signing in with Google in your browser…');
  const until = Date.now() + 5 * 60e3;
  const tick = async () => {
    await loadCloudStatus();
    if (S.cloud.signedIn) {
      await afterSignIn();
      toast(`Signed in as ${S.cloud.user?.email || ''}`);
      return;
    }
    if (Date.now() < until) setTimeout(tick, 2000);
  };
  setTimeout(tick, 2000);
}

export async function afterSignIn() {
  await loadMe();
  await syncCloudCollections();
  startPolling();
  app.renderAll();
}

export async function signOut() {
  if (!(await confirmModal('Sign out', 'Shared collections will disappear from this computer until you sign in again. Your own local collections stay.', 'Sign out', 'primary'))) return;
  await api('POST', '/api/cloud/logout').catch(() => {});
  stopPolling();
  S.cloud = { ...S.cloud, signedIn: false, user: null };
  S.me = null;
  for (const c of S.collections.filter((x) => x.cloud)) app.dropWorkspace(c.id);
  S.collections = S.collections.filter((x) => !x.cloud);
  if (S.ws !== 'team') S.ws = 'team';
  app.renderAll();
}

// ---------- login screen ----------
// Email + password always; "Continue with Google" only when the server has it set up.
export function loginView() {
  let mode = 'login';
  let busy = false;
  let cfg = null;
  const wrap = h('div', { class: 'auth-screen' });
  const fields = { name: '', email: '', password: '' };

  api('GET', '/api/cloud/config')
    .then((c) => (cfg = c))
    .catch(() => (cfg = { google: false, reachable: false }))
    .finally(render);

  function input(key, label, type, attrs = {}) {
    const el = h('input', {
      class: 'input auth-input',
      type,
      value: fields[key],
      autocomplete: attrs.autocomplete || 'off',
      placeholder: attrs.placeholder || '',
      onInput: (e) => (fields[key] = e.target.value),
    });
    return { el, node: h('label', { class: 'field' }, h('span', {}, label), el) };
  }

  function render() {
    const error = h('div', { class: 'auth-error', role: 'alert' });
    const name = input('name', 'Your name', 'text', { autocomplete: 'name', placeholder: 'Imtiaz' });
    const email = input('email', 'Email', 'email', { autocomplete: 'email', placeholder: 'you@company.com' });
    const pass = input('password', 'Password', 'password', { autocomplete: mode === 'login' ? 'current-password' : 'new-password', placeholder: mode === 'register' ? 'At least 8 characters' : '' });
    const reveal = h('button', { type: 'button', class: 'icon-btn auth-reveal', title: 'Show password', onClick: () => ((pass.el.type = pass.el.type === 'password' ? 'text' : 'password'), pass.el.focus()) }, icon('eye', 15));
    pass.node.append(reveal);

    const submit = h('button', { type: 'submit', class: 'btn primary auth-submit' }, mode === 'login' ? 'Sign in' : 'Create account');
    const form = h(
      'form',
      {
        class: 'auth-form',
        onSubmit: async (e) => {
          e.preventDefault();
          if (busy) return;
          busy = true;
          submit.disabled = true;
          submit.textContent = mode === 'login' ? 'Signing in…' : 'Creating account…';
          error.textContent = '';
          try {
            await api('POST', '/api/cloud/auth', { mode, ...fields });
            fields.password = '';
            await loadCloudStatus();
            await afterSignIn();
            toast(mode === 'login' ? `Welcome back, ${S.cloud.user?.name || ''}` : `Welcome, ${S.cloud.user?.name || ''} — create a team to get started`);
          } catch (err) {
            error.textContent = err.message;
            submit.disabled = false;
            submit.textContent = mode === 'login' ? 'Sign in' : 'Create account';
          } finally {
            busy = false;
          }
        },
      },
      mode === 'register' ? name.node : null,
      email.node,
      pass.node,
      error,
      submit,
    );

    const tabs = h(
      'div',
      { class: 'auth-tabs' },
      [
        ['login', 'Sign in'],
        ['register', 'Create account'],
      ].map(([k, label]) => h('button', { type: 'button', class: 'auth-tab' + (mode === k ? ' active' : ''), onClick: () => ((mode = k), render()) }, label)),
    );

    const google = cfg && cfg.google ? [h('div', { class: 'auth-or' }, h('span', {}, 'or')), h('button', { type: 'button', class: 'google-btn wide', onClick: signIn }, h('span', { class: 'g' }, 'G'), 'Continue with Google')] : [];

    wrap.replaceChildren(
      h(
        'div',
        { class: 'auth-card' },
        h('div', { class: 'auth-logo' }, h('span', {}, 'A'), h('i', {})),
        h('h1', {}, mode === 'login' ? 'Sign in to ApiDock Team' : 'Create your ApiDock account'),
        h('p', { class: 'auth-sub' }, 'Share collections with your team and keep them in sync.'),
        tabs,
        form,
        ...google,
        cfg && !cfg.reachable ? h('p', { class: 'auth-warn' }, 'Can’t reach the team server right now — check your internet connection.') : null,
        h('p', { class: 'auth-foot' }, 'Your local collections stay on this computer. Only collections you share go to ', h('span', { class: 'mono' }, (S.cloud?.server || '').replace(/^https?:\/\//, '')), '.'),
      ),
    );
    setTimeout(() => (mode === 'register' && !fields.name ? name.el : !fields.email ? email.el : pass.el).focus(), 30);
  }
  render();
  return wrap;
}

export async function redeemCode(code) {
  try {
    const r = await cloudApi('POST', '/invites/redeem', { code });
    await loadMe();
    await syncCloudCollections();
    toast(`You joined ${r.teamName}`);
    app.openTeam(r.teamId);
    app.renderAll();
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}

// ---------- shared collections ----------
// Brings shared collections in line with the server: adds new ones, refreshes
// changed ones (unless you have unsaved edits there) and drops revoked ones.
export async function syncCloudCollections({ quiet = true } = {}) {
  if (!S.cloud?.signedIn) return;
  let list;
  try {
    list = await cloudApi('GET', '/collections');
  } catch (err) {
    if (err.status === 401) await loadCloudStatus();
    if (!quiet) toast(err.message, 'error');
    return;
  }
  const ids = new Set(list.map((m) => m.id));
  let changed = false;

  // Removed or access revoked.
  for (const c of S.collections.filter((x) => x.cloud && !ids.has(x.id))) {
    S.collections = S.collections.filter((x) => x !== c);
    app.dropWorkspace(c.id);
    toast(`“${c.name}” is no longer shared with you`);
    changed = true;
  }

  for (const meta of list) {
    const local = getCollection(meta.id);
    if (local && local.cloud && local.cloud.version === meta.version && local.cloud.role === meta.role) continue;
    if (local && !local.cloud) continue; // a local collection with the same id: leave it alone
    const busy = S.tabs.some((t) => t.collectionId === meta.id && t.dirty);
    if (local && busy && local.cloud.role === meta.role) continue; // pick it up after you save
    const full = await cloudApi('GET', `/collections/${meta.id}`).catch(() => null);
    if (!full) continue;
    const fresh = fromCloud(full);
    if (local) {
      Object.keys(local).forEach((k) => delete local[k]);
      Object.assign(local, fresh);
      refreshOpenViews(local);
      if (!quiet || S.ws === local.id) toast(`“${local.name}” was updated by ${meta.updatedBy || 'a teammate'}`);
    } else {
      S.collections.push(fresh);
    }
    changed = true;
  }
  if (changed) {
    S.collections.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    app.renderDock();
    app.renderPane();
  }
}

// Non-edited views of an updated collection show the new content.
function refreshOpenViews(coll) {
  for (const t of S.tabs) {
    if (t.collectionId !== coll.id || t.dirty) continue;
    if (t.kind === 'request' && t.itemId) {
      const f = findItem(coll, t.itemId);
      if (f) t.draft = normalizeRequest(clone(f.item));
    }
    if (['collection', 'folder', 'environment'].includes(t.kind)) t.draft = null;
  }
  const active = S.tabs.find((t) => t.id === S.activeTabId);
  if (active && active.collectionId === coll.id && !active.dirty) app.renderActive();
}

export function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') {
      syncCloudCollections();
      loadMe().then(() => S.ws === 'team' && app.renderPane());
    }
  }, POLL_MS);
}
function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

// ---------- share a local collection ----------
export async function shareCollection(coll) {
  if (!S.cloud?.signedIn) {
    const ok = await confirmModal('Sign in to share', 'Sharing needs an ApiDock account so teammates can be invited.', 'Sign in', 'primary');
    if (ok) app.switchWs('team');
    return;
  }
  await loadMe();
  const teams = (S.me?.teams || []).filter(Boolean);
  const body = h('div', { class: 'stack-v' });
  let teamId = teams[0]?.id || '';
  const picks = new Map(); // userId -> role
  const membersBox = h('div', { class: 'share-members' });

  const renderMembers = async () => {
    picks.clear();
    membersBox.replaceChildren(h('p', { class: 'hint' }, 'Loading members…'));
    if (!teamId) return membersBox.replaceChildren(h('p', { class: 'hint' }, 'Create a team first — you can invite people right after.'));
    const t = await cloudApi('GET', `/teams/${teamId}`).catch(() => null);
    const others = (t?.members || []).filter((m) => m.id !== S.cloud.user?.id);
    if (!others.length) return membersBox.replaceChildren(h('p', { class: 'hint' }, 'Nobody else is in this team yet. Share now, then invite people from the Team page — you can give them access to this collection there.'));
    membersBox.replaceChildren(
      h('div', { class: 'section-title' }, 'Who gets access'),
      ...others.map((m) => {
        const sel = selectEl(
          [
            { value: '', label: 'No access' },
            { value: 'viewer', label: 'Viewer — can send requests' },
            { value: 'editor', label: 'Editor — can change requests' },
          ],
          'editor',
          (v) => (v ? picks.set(m.id, v) : picks.delete(m.id)),
          'select sm',
        );
        picks.set(m.id, 'editor');
        return h('div', { class: 'member-row' }, avatar(m), h('div', { class: 'member-main' }, h('b', {}, m.name || m.email), h('span', {}, m.email)), sel);
      }),
    );
  };

  const teamSel = teams.length
    ? selectEl(
        teams.map((t) => ({ value: t.id, label: `${t.name} · ${t.members} member${t.members === 1 ? '' : 's'}` })),
        teamId,
        (v) => ((teamId = v), renderMembers()),
      )
    : null;
  body.append(
    h('p', { class: 'hint' }, `“${coll.name}” moves to the team server. Everyone you give access gets every request and every variable set (values included).`),
    teamSel ? h('label', { class: 'field' }, h('span', {}, 'Team'), teamSel) : h('button', { class: 'btn', onClick: async () => (await createTeam()) && (m.close(), shareCollection(coll)) }, icon('plus', 14), 'Create a team'),
    membersBox,
  );
  renderMembers();

  const m = modal({
    title: `Share “${coll.name}”`,
    width: 560,
    body,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Share',
        kind: 'primary',
        onClick: async () => {
          if (!teamId) return (toast('Pick or create a team first', 'error'), false);
          try {
            const created = await cloudApi('POST', '/collections', { teamId, data: toCloudData(coll) });
            for (const [userId, role] of picks) await cloudApi('PUT', `/collections/${created.id}/access`, { userId, role });
            // The shared copy replaces the local one.
            await api('DELETE', `/api/collections/${coll.id}`);
            const shared = fromCloud(created);
            shared.activeEnvironmentId = coll.activeEnvironmentId || null;
            const i = S.collections.indexOf(coll);
            if (i >= 0) S.collections[i] = shared;
            for (const t of S.tabs) if (t.collectionId === coll.id) (t.collectionId = shared.id), (t.ws = shared.id);
            if (S.ws === coll.id) S.ws = shared.id;
            app.renderAll();
            toast(`Shared with ${picks.size} ${picks.size === 1 ? 'person' : 'people'}`);
          } catch (err) {
            toast(err.message, 'error');
            return false;
          }
        },
      },
    ],
  });
}

// Keep a private local copy of a shared collection.
export async function copyToLocal(coll) {
  const data = toCloudData(coll);
  data.name = `${coll.name} (local copy)`;
  const saved = await api('POST', '/api/collections', data);
  S.collections.push(saved);
  S.collections.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  app.switchWs(saved.id);
  app.renderAll();
  toast('Saved a private copy on this computer');
}

export async function deleteShared(coll) {
  if (!(await confirmModal('Delete shared collection', `Delete “${coll.name}” for everyone in ${coll.cloud.teamName}? This cannot be undone.`))) return;
  try {
    await cloudApi('DELETE', `/collections/${coll.id}`);
    S.collections = S.collections.filter((x) => x !== coll);
    app.dropWorkspace(coll.id);
    toast('Deleted for everyone');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------- teams ----------
export async function createTeam() {
  const name = await promptModal('New team', 'Team name', 'My team', 'Create');
  if (!name) return null;
  try {
    const t = await cloudApi('POST', '/teams', { name });
    await loadMe();
    app.openTeam(t.id);
    return t;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
}

export async function answerInvite(inv, accept) {
  try {
    const r = await cloudApi('POST', `/invites/${inv.id}/${accept ? 'accept' : 'decline'}`);
    await loadMe();
    if (accept) {
      await syncCloudCollections();
      toast(`You joined ${inv.teamName}`);
      app.openTeam(r.teamId);
    }
    app.renderAll();
  } catch (err) {
    toast(err.message, 'error');
  }
}

export function avatar(u, size = 28) {
  const initials = String(u?.name || u?.email || '?')
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
  return u?.picture
    ? h('img', { class: 'avatar', src: u.picture, alt: '', width: size, height: size, referrerpolicy: 'no-referrer' })
    : h('span', { class: 'avatar', style: { width: `${size}px`, height: `${size}px` } }, initials);
}

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Member', editor: 'Editor', viewer: 'Viewer' };

// ---------- team page ----------
export function renderTeamTab(tab, root) {
  const body = h('div', { class: 'page-body team-page' }, h('p', { class: 'hint' }, 'Loading team…'));
  root.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'page-head', id: 'team-head' }), body));
  load();

  async function load() {
    try {
      tab.data = await cloudApi('GET', `/teams/${tab.refId}`);
    } catch (err) {
      body.replaceChildren(h('div', { class: 'res-empty' }, err.message));
      return;
    }
    render();
  }

  function render() {
    const d = tab.data;
    const me = S.cloud.user?.id;
    const canManage = ['owner', 'admin'].includes(d.role);
    const head = root.querySelector('#team-head');
    head.replaceChildren(
      h('div', { class: 'page-title' }, h('div', { class: 'page-icon' }, icon('users', 20)), h('div', {}, h('h1', {}, d.team.name), h('p', { class: 'muted' }, `${d.members.length} member${d.members.length === 1 ? '' : 's'} · you are ${ROLE_LABEL[d.role]}`))),
      h(
        'div',
        { class: 'page-actions' },
        canManage
          ? h(
              'button',
              {
                class: 'btn sm',
                onClick: async () => {
                  const name = await promptModal('Rename team', 'Team name', d.team.name, 'Rename');
                  if (!name) return;
                  await cloudApi('PATCH', `/teams/${d.team.id}`, { name }).catch((e) => toast(e.message, 'error'));
                  await loadMe();
                  app.renderPane();
                  load();
                },
              },
              'Rename',
            )
          : null,
        d.role === 'owner'
          ? h(
              'button',
              {
                class: 'btn sm danger-ghost',
                onClick: async () => {
                  if (!(await confirmModal('Delete team', `Delete “${d.team.name}”? Its shared collections are deleted for everyone.`))) return;
                  await cloudApi('DELETE', `/teams/${d.team.id}`).catch((e) => toast(e.message, 'error'));
                  await loadMe();
                  await syncCloudCollections();
                  app.closeTabsByRef(d.team.id);
                },
              },
              icon('trash', 14),
              'Delete team',
            )
          : h(
              'button',
              {
                class: 'btn sm danger-ghost',
                onClick: async () => {
                  if (!(await confirmModal('Leave team', `Leave “${d.team.name}”? You lose access to its shared collections.`, 'Leave'))) return;
                  await cloudApi('DELETE', `/teams/${d.team.id}/members/${me}`).catch((e) => toast(e.message, 'error'));
                  await loadMe();
                  await syncCloudCollections();
                  app.closeTabsByRef(d.team.id);
                },
              },
              'Leave team',
            ),
        h('button', { class: 'icon-btn', title: 'Refresh', onClick: load }, icon('refresh', 15)),
        h('button', { class: 'icon-btn', title: 'Close', onClick: () => app.closeTab(tab.id) }, icon('x', 15)),
      ),
    );

    const sections = [];

    // Members
    sections.push(
      h('div', { class: 'section-title' }, 'Members'),
      h(
        'div',
        { class: 'member-list' },
        d.members.map((m) =>
          h(
            'div',
            { class: 'member-row' },
            avatar(m),
            h('div', { class: 'member-main' }, h('b', {}, m.name || m.email, m.id === me ? h('span', { class: 'you' }, ' (you)') : null), h('span', {}, m.email)),
            canManage && m.role !== 'owner' && m.id !== me
              ? selectEl([{ value: 'member', label: 'Member' }, { value: 'admin', label: 'Admin' }], m.role, async (v) => {
                  await cloudApi('PATCH', `/teams/${d.team.id}/members/${m.id}`, { role: v }).catch((e) => toast(e.message, 'error'));
                  load();
                }, 'select sm')
              : h('span', { class: 'role-tag' }, ROLE_LABEL[m.role]),
            canManage && m.role !== 'owner' && m.id !== me
              ? h(
                  'button',
                  {
                    class: 'icon-btn',
                    title: 'Remove from team',
                    onClick: async () => {
                      if (!(await confirmModal('Remove member', `Remove ${m.name || m.email} from the team? They lose access to its collections.`, 'Remove'))) return;
                      await cloudApi('DELETE', `/teams/${d.team.id}/members/${m.id}`).catch((e) => toast(e.message, 'error'));
                      load();
                    },
                  },
                  icon('x', 14),
                )
              : h('span', { class: 'icon-spacer' }),
          ),
        ),
      ),
    );

    // Invite
    if (canManage) {
      const email = h('input', { class: 'input', type: 'email', placeholder: 'teammate@gmail.com' });
      const role = selectEl([{ value: 'member', label: 'Member' }, { value: 'admin', label: 'Admin' }], 'member', () => {}, 'select');
      const grants = new Map();
      const collPicks = d.collections.length
        ? h(
            'div',
            { class: 'grant-list' },
            h('span', { class: 'muted small' }, 'Give access to:'),
            d.collections.map((c) =>
              h(
                'label',
                { class: 'grant' },
                h('span', {}, c.name),
                selectEl(
                  [
                    { value: '', label: 'No access' },
                    { value: 'viewer', label: 'Viewer' },
                    { value: 'editor', label: 'Editor' },
                  ],
                  '',
                  (v) => (v ? grants.set(c.id, v) : grants.delete(c.id)),
                  'select sm',
                ),
              ),
            ),
          )
        : null;
      const sendInvite = async () => {
        try {
          const inv = await cloudApi('POST', `/teams/${d.team.id}/invites`, { email: email.value, role: role.value, collections: [...grants].map(([id, r]) => ({ id, role: r })) });
          await load();
          modal({
            title: 'Invite created',
            width: 460,
            body: h(
              'div',
              { class: 'stack-v' },
              h('p', {}, `Send this code to ${inv.email}:`),
              h('div', { class: 'invite-code big' }, inv.code, h('button', { class: 'icon-btn', title: 'Copy', onClick: () => copyText(inv.code) }, icon('copy', 15))),
              h('p', { class: 'hint' }, 'They open ApiDock → Team, sign in, and enter the code under “Join with invite code”. If they sign in with Google using this email, the invite also appears for them automatically.'),
            ),
            actions: [{ label: 'Copy code', kind: 'primary', onClick: () => copyText(inv.code) }],
          });
        } catch (err) {
          toast(err.message, 'error');
        }
      };
      email.addEventListener('keydown', (e) => e.key === 'Enter' && sendInvite());
      sections.push(
        h('div', { class: 'section-title' }, 'Invite someone'),
        h('div', { class: 'invite-box' }, h('div', { class: 'invite-line' }, email, role, h('button', { class: 'btn primary', onClick: sendInvite }, 'Invite')), collPicks, h('p', { class: 'hint' }, 'You get an invite code to send them. They enter it in ApiDock → Team → Join with invite code.')),
      );
      if (d.invites.length) {
        sections.push(
          h('div', { class: 'section-title' }, `Pending invites · ${d.invites.length}`),
          h(
            'div',
            { class: 'member-list' },
            d.invites.map((i) =>
              h(
                'div',
                { class: 'member-row pending' },
                avatar({ email: i.email }),
                h('div', { class: 'member-main' }, h('b', {}, i.email), h('span', {}, `invited by ${i.invitedBy} · ${timeAgo(i.createdAt)}`)),
                i.code ? h('span', { class: 'invite-code', title: 'Invite code — click to copy', onClick: () => copyText(i.code) }, i.code, icon('copy', 12)) : null,
                h('span', { class: 'role-tag' }, ROLE_LABEL[i.role]),
                h(
                  'button',
                  {
                    class: 'icon-btn',
                    title: 'Cancel invite',
                    onClick: async () => {
                      await cloudApi('DELETE', `/teams/${d.team.id}/invites/${i.id}`).catch((e) => toast(e.message, 'error'));
                      load();
                    },
                  },
                  icon('x', 14),
                ),
              ),
            ),
          ),
        );
      }
    }

    // Shared collections and who can use them
    sections.push(h('div', { class: 'section-title' }, `Shared collections · ${d.collections.length}`));
    if (!d.collections.length) {
      sections.push(h('p', { class: 'hint' }, 'No collections yet. Open one of your collections and choose ⋯ → Share with team.'));
    }
    for (const c of d.collections) {
      const canEditAccess = c.role === 'owner' || canManage;
      const accessBy = new Map(c.access.map((a) => [a.id, a.role]));
      sections.push(
        h(
          'div',
          { class: 'shared-coll' },
          h(
            'div',
            { class: 'shared-head' },
            h('div', {}, h('b', {}, c.name), h('span', { class: 'muted small' }, ` · updated ${timeAgo(c.updatedAt)}${c.updatedBy ? ` by ${c.updatedBy}` : ''}`)),
            c.visible ? h('button', { class: 'tbtn accent', onClick: () => app.switchWs(c.id) }, 'Open') : h('span', { class: 'muted small' }, 'no access for you'),
          ),
          h(
            'div',
            { class: 'access-grid' },
            d.members.map((m) => {
              const r = accessBy.get(m.id) || '';
              const fixed = r === 'owner' || !canEditAccess;
              return h(
                'div',
                { class: 'access-row' },
                h('span', {}, m.name || m.email),
                fixed
                  ? h('span', { class: 'role-tag' }, r ? ROLE_LABEL[r] : 'No access')
                  : selectEl(
                      [
                        { value: '', label: 'No access' },
                        { value: 'viewer', label: 'Viewer' },
                        { value: 'editor', label: 'Editor' },
                      ],
                      r,
                      async (v) => {
                        await cloudApi('PUT', `/collections/${c.id}/access`, { userId: m.id, role: v || null }).catch((e) => toast(e.message, 'error'));
                        load();
                      },
                      'select sm',
                    ),
              );
            }),
          ),
        ),
      );
    }
    body.replaceChildren(...sections);
  }
}
