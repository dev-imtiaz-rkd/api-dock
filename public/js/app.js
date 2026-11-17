// ApiDock shell. Every collection is its own workspace: picking it in the
// dock shows that collection's tree and only that collection's tabs.
import { h, icon, api, toast, modal, showMenu, confirmModal, selectEl, debounce } from './util.js';
import { S, uid, newRequest, normalizeRequest, clone, getCollection, findItem, findAnywhere, saveCollection, activeEnv, findEnv, rememberCloudActive, stripTransient, flattenRequests, buildOutgoing, parseVarText, looksLikeVarText } from './model.js';
import { renderDock, renderPane, SYSTEM, hueOf, monogram, importVarSet } from './sidebar.js';
import { renderRequestTab, renderResponse, importCurl } from './editor.js';
import { renderCollectionTab, renderEnvironmentTab, renderRunnerTab, renderServiceTab } from './pages.js';
import { renderTeamTab, loadCloudStatus, loadMe, syncCloudCollections, startPolling, signIn, signOut, shareCollection, copyToLocal, deleteShared, createTeam, answerInvite, loginView, redeemCode } from './team.js';
import { app } from './bus.js';
import { initUpdates, updatesSupported, checkForUpdates, versionInfo, updateAvailable, showUpdateCard } from './updates.js';

const $ = (sel) => document.querySelector(sel);
const LS = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

// ---------- per-request call state ----------
// Each saved request remembers its last call (response + which sections were
// open) so switching to another request and back never loses it. Kept in
// memory and mirrored to localStorage so it also survives a restart.
const CALLS_KEY = 'apidock.calls';
const CALLS_MAX = 40;
const BODY_MAX = 512 * 1024;
const calls = new Map(Object.entries(LS.get(CALLS_KEY, {}) || {}));

function rememberCall(tab) {
  if (!tab || tab.kind !== 'request' || !tab.itemId) return;
  if (!tab.response && !calls.has(tab.itemId) && (tab.sub || 'params') === 'params') return;
  calls.set(tab.itemId, { response: tab.response || null, sub: tab.sub, resTab: tab.resTab, resView: tab.resView, wrap: tab.wrap, at: Date.now() });
  persistCallsSoon();
}

function restoreCall(tab) {
  const c = tab && tab.itemId && calls.get(tab.itemId);
  if (!c) return tab;
  tab.response = c.response;
  tab.sub = c.sub || tab.sub;
  tab.resTab = c.resTab;
  tab.resView = c.resView;
  tab.wrap = c.wrap;
  return tab;
}

function persistCalls() {
  const entries = [...calls.entries()].sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, CALLS_MAX);
  const out = {};
  for (const [id, c] of entries) {
    const r = c.response;
    // Huge bodies are trimmed on disk only; the in-memory copy stays complete.
    out[id] = r && r.body && r.body.length > BODY_MAX ? { ...c, response: { ...r, body: r.body.slice(0, BODY_MAX), truncated: true } } : c;
  }
  try {
    localStorage.setItem(CALLS_KEY, JSON.stringify(out));
  } catch {
    // Storage full: keep only the 10 most recent.
    try {
      localStorage.setItem(CALLS_KEY, JSON.stringify(Object.fromEntries(Object.entries(out).slice(0, 10))));
    } catch {}
  }
}
const persistCallsSoon = debounce(persistCalls, 500);

// ---------- layout ----------
function layout() {
  document.body.replaceChildren(
    h(
      'div',
      { class: 'shell', id: 'shell' },
      h('nav', { class: 'dock', id: 'dock' }),
      h('aside', { class: 'pane', id: 'pane' }),
      h('div', { class: 'pane-resize', id: 'pane-resize' }),
      h('main', { class: 'stage' }, h('div', { class: 'view', id: 'view' })),
    ),
  );
  const pane = $('#pane');
  pane.style.width = `${LS.get('apidock.paneW', 280)}px`;
  $('#pane-resize').addEventListener('mousedown', (e) => {
    e.preventDefault();
    document.body.classList.add('resizing-x');
    const move = (ev) => (pane.style.width = `${Math.min(520, Math.max(220, ev.clientX - pane.getBoundingClientRect().left))}px`);
    const up = () => {
      document.body.classList.remove('resizing-x');
      LS.set('apidock.paneW', parseInt(pane.style.width, 10));
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

// The workspace's identity colour drives the accent everywhere.
function applyWorkspaceColor() {
  const shell = $('#shell');
  const c = getCollection(S.ws);
  shell.style.setProperty('--hue', c ? hueOf(c.id) : 250);
  shell.dataset.ws = c ? 'collection' : S.ws;
}

function renderAll() {
  applyWorkspaceColor();
  renderDock($('#dock'));
  renderTabs();
  renderActive();
}

function renderPaneNow() {
  renderPane($('#pane'));
}

// ---------- workspaces ----------
function switchWs(ws) {
  if (S.ws === ws) return;
  if (getCollection(ws)) S.lastCollection = ws;
  stopTimers();
  S.ws = ws;
  S.filter = '';
  if (ws === 'drafts') loadHistory();
  if (ws === 'services') refreshDiscover();
  persistUi();
  renderAll();
}

function wsForTab(tab) {
  if (tab.kind === 'service') return 'services';
  if (tab.kind === 'team') return 'team';
  return tab.collectionId && getCollection(tab.collectionId) ? tab.collectionId : 'drafts';
}

function dropWorkspace(id) {
  S.tabs = S.tabs.filter((t) => t.ws !== id);
  delete S.activeByWs[id];
  if (S.ws === id) S.ws = S.collections[0]?.id || 'drafts';
  persistUi();
  renderAll();
}

const wsTabs = () => S.tabs.filter((t) => t.ws === S.ws);

// ---------- tabs ----------
function tabTitle(t) {
  if (t.kind === 'request') return t.draft.name || 'Untitled';
  if (t.kind === 'collection') return 'Overview';
  if (t.kind === 'folder') return findItem(getCollection(t.collectionId) || { items: [] }, t.refId)?.item.name || 'Folder';
  if (t.kind === 'environment') return findEnv(t.collectionId, t.refId)?.name || 'Environment';
  if (t.kind === 'runner') return t.refId ? `Run · ${findItem(getCollection(t.collectionId) || { items: [] }, t.refId)?.item.name || ''}` : 'Runner';
  if (t.kind === 'service') return S.discover?.services.find((s) => s.id === t.refId)?.name.split('/').pop() || 'Service';
  if (t.kind === 'team') return (S.me?.teams || []).find((x) => x.id === t.refId)?.name || 'Team';
  return 'Tab';
}

function tabLead(t) {
  if (t.kind === 'request') return h('span', { class: `verb m-${t.draft.method.toLowerCase()}` }, t.draft.method === 'DELETE' ? 'DEL' : t.draft.method);
  return icon({ collection: 'layers', folder: 'folder', environment: 'globe', runner: 'play', service: 'server' }[t.kind] || 'file', 13, 'tab-ico');
}

// There is no tab strip: open items live in the pane ("Open" list + tree
// markers), so refreshing tabs means refreshing the pane.
function renderTabs() {
  persistTabs();
  renderPaneNow();
}

function stopTimers() {
  for (const t of S.tabs) if (t.timer) clearInterval(t.timer), (t.timer = null);
}

function renderActive() {
  const t = S.tabs.find((x) => x.id === S.activeTabId && x.ws === S.ws);
  const root = $('#view');
  if (!t) return root.replaceChildren(emptyStage());
  ({ request: renderRequestTab, collection: renderCollectionTab, folder: renderCollectionTab, environment: renderEnvironmentTab, runner: renderRunnerTab, service: renderServiceTab, team: renderTeamTab })[t.kind](t, root);
}

// What the stage shows when a workspace has no open tab.
function emptyStage() {
  const c = getCollection(S.ws);
  if (c) {
    const reqs = flattenRequests(c);
    const recent = S.history.filter((x) => x.collectionId === c.id).slice(0, 6);
    const byMethod = {};
    for (const r of reqs) byMethod[r.item.method] = (byMethod[r.item.method] || 0) + 1;
    const out = (() => {
      const any = reqs[0];
      return any ? buildOutgoing(normalizeRequest(clone(any.item)), c.id) : null;
    })();
    const base = out && out.url ? out.url.replace(/^(https?:\/\/[^/]+).*$/, '$1') : null;
    return h(
      'div',
      { class: 'empty-stage' },
      h('div', { class: 'es-gram' }, monogram(c.name)),
      h('h1', {}, c.name),
      c.description ? h('p', { class: 'es-desc' }, c.description.split('\n')[0].slice(0, 220)) : null,
      h(
        'dl',
        { class: 'facts' },
        h('div', {}, h('dt', {}, 'Requests'), h('dd', {}, reqs.length)),
        h('div', {}, h('dt', {}, 'Methods'), h('dd', {}, Object.entries(byMethod).map(([m, n]) => h('span', { class: `verb m-${m.toLowerCase()}` }, `${m} ${n} `)))),
        h('div', {}, h('dt', {}, 'Variables'), h('dd', {}, activeEnv(c.id)?.name || 'Default', h('span', { class: 'muted' }, ` · ${1 + (c.environments || []).length} set${(c.environments || []).length ? 's' : ''}`))),
        h('div', {}, h('dt', {}, 'Auth'), h('dd', {}, { bearer: 'Bearer token', basic: 'Basic', apikey: 'API key', none: 'None' }[c.auth?.type] || 'None')),
        h('div', {}, h('dt', {}, 'Host'), h('dd', { class: 'mono' }, base && /^https?:\/\/[^/{]+$/.test(base) ? base : h('span', { class: 'warn-text' }, 'base_url not set'))),
      ),
      h('div', { class: 'es-actions' }, h('button', { class: 'pill-btn accent', onClick: () => newDraft() }, 'New request'), h('button', { class: 'pill-btn', onClick: () => openCollection(c.id) }, 'Variables & auth'), h('button', { class: 'pill-btn', onClick: () => openRunner(c.id, null) }, 'Run all')),
      recent.length
        ? h(
            'div',
            { class: 'es-recent' },
            h('div', { class: 'group-label' }, 'Recently sent'),
            recent.map((r) => h('button', { class: 'trow hist', onClick: () => openHistory(r) }, h('span', { class: `verb m-${r.method.toLowerCase()}` }, r.method), h('span', { class: 'tlabel mono' }, r.url), h('span', { class: `code ${r.status < 300 && r.status ? 'st-ok' : r.status < 500 && r.status ? 'st-warn' : 'st-err'}` }, r.status || 'ERR'))),
          )
        : h('p', { class: 'es-hint' }, 'Pick a request on the left, or press ', h('kbd', {}, 'Ctrl'), ' ', h('kbd', {}, 'T'), ' for a new one.'),
    );
  }
  if (S.ws === 'team') {
    if (!S.cloud?.signedIn) return loginView();
    return h('div', { class: 'empty-stage' }, h('h1', {}, 'Teams'), h('p', { class: 'es-desc' }, 'Pick a team on the left to manage members, invites and who can use each shared collection — or create a new one.'), h('div', { class: 'es-actions' }, h('button', { class: 'pill-btn accent', onClick: createTeam }, 'New team')));
  }
  if (S.ws === 'services') return h('div', { class: 'empty-stage' }, h('h1', {}, 'Services'), h('p', { class: 'es-desc' }, 'Laravel apps found in your projects. Start one, then turn its routes into a collection.'));
  return h(
    'div',
    { class: 'empty-stage' },
    h('div', { class: 'es-gram plain' }, 'A'),
    h('h1', {}, 'ApiDock'),
    h('p', { class: 'es-desc' }, 'Drafts are requests that don’t belong to a collection yet. Pick a collection in the dock to work inside it.'),
    h('div', { class: 'es-actions' }, h('button', { class: 'pill-btn accent', onClick: () => newDraft() }, 'New draft'), h('button', { class: 'pill-btn', onClick: openImport }, 'Import')),
    h('p', { class: 'es-hint' }, 'Paste a cURL command into any URL bar to fill the whole request.'),
  );
}

function activate(id) {
  const t = S.tabs.find((x) => x.id === id);
  if (!t) return;
  stopTimers();
  const wsChanged = S.ws !== t.ws;
  S.ws = t.ws;
  S.activeTabId = id;
  if (wsChanged) return renderAll();
  renderTabs();
  renderActive();
  renderPaneNow();
}

function addTab(tab, { preview = false } = {}) {
  tab.ws = wsForTab(tab);
  if (S.ws !== tab.ws) S.ws = tab.ws;
  tab.preview = preview;
  // One view at a time: whatever was open in this workspace is replaced,
  // unless it has unsaved changes or a request in flight.
  const replaced = S.tabs.filter((t) => t.ws === tab.ws && !t.dirty && !t.sending);
  for (const t of replaced) {
    if (t.timer) clearInterval(t.timer);
    rememberCall(t);
  }
  S.tabs = S.tabs.filter((t) => !replaced.includes(t));
  S.tabs.push(tab);
  S.activeTabId = tab.id;
  persistUi();
  renderAll();
  return tab;
}

async function closeTab(id) {
  const t = S.tabs.find((x) => x.id === id);
  if (!t) return;
  if (t.dirty && !(await confirmModal('Unsaved changes', `“${tabTitle(t)}” has unsaved changes. Close it anyway?`, 'Discard'))) return;
  if (t.timer) clearInterval(t.timer);
  rememberCall(t);
  const siblings = S.tabs.filter((x) => x.ws === t.ws);
  const i = siblings.indexOf(t);
  S.tabs.splice(S.tabs.indexOf(t), 1);
  if (S.activeByWs[t.ws] === id) S.activeByWs[t.ws] = (siblings[i + 1] || siblings[i - 1] || {}).id || null;
  renderTabs();
  renderActive();
  renderPaneNow();
  renderDock($('#dock'));
}

async function closeMany(list) {
  const dirty = list.filter((t) => t.dirty);
  if (dirty.length && !(await confirmModal('Unsaved changes', `${dirty.length} tab(s) have unsaved changes. Close anyway?`, 'Discard'))) return;
  for (const t of list) if (t.timer) clearInterval(t.timer);
  S.tabs = S.tabs.filter((t) => !list.includes(t));
  if (!S.tabs.find((t) => t.id === S.activeTabId)) S.activeTabId = wsTabs().at(-1)?.id || null;
  renderAll();
}

function markDirty(tab) {
  tab.preview = false;
  if (!tab.dirty) {
    tab.dirty = true;
    renderTabs();
    renderPaneNow();
  } else persistTabsSoon();
}

// ---------- opening things ----------
function openRequest(collectionId, itemId, opts = {}) {
  const existing = S.tabs.find((t) => t.kind === 'request' && t.itemId === itemId);
  if (existing) return activate(existing.id);
  const coll = getCollection(collectionId);
  const found = coll && findItem(coll, itemId);
  if (!found) return;
  // Reveal where the request lives: open the folders that contain it.
  for (const p of found.parents) S.expanded.add(p.id);
  persistUi();
  const tab = addTab(restoreCall({ id: uid(), kind: 'request', collectionId, itemId, draft: normalizeRequest(clone(found.item)), dirty: false, sub: 'params' }), { preview: !opts.focusUrl });
  if (opts.focusUrl) setTimeout(() => tab.focusUrl && tab.focusUrl(), 30);
}

// New request in the current workspace (a collection draft, or a loose draft).
function newDraft(req = newRequest()) {
  const c = getCollection(S.ws);
  if (c && !req.url && c.variables?.some((v) => v.key === 'base_url')) req.url = '{{base_url}}/';
  return openDraft(req, c ? c.id : null);
}

function openDraft(req, collectionId = null) {
  const tab = addTab({ id: uid(), kind: 'request', collectionId, itemId: null, draft: normalizeRequest(req), dirty: true, sub: 'params' });
  setTimeout(() => tab.focusUrl && tab.focusUrl(), 30);
  return tab;
}

function openSingleton(kind, refId, collectionId = null) {
  const existing = S.tabs.find((t) => t.kind === kind && t.refId === refId && t.collectionId === collectionId);
  if (existing) return activate(existing.id);
  addTab({ id: uid(), kind, refId, collectionId, dirty: false });
}

function openCollection(id, sub) {
  openSingleton('collection', id, id);
  const t = S.tabs.find((x) => x.kind === 'collection' && x.collectionId === id);
  if (sub && t && t.sub !== sub) {
    t.sub = sub;
    renderActive();
  }
}
const openFolder = (collId, folderId) => openSingleton('folder', folderId, collId);
const openEnvironment = (collId, envId) => openSingleton('environment', envId, collId);
const openService = (id) => openSingleton('service', id);
const openRunner = (collId, folderId) => openSingleton('runner', folderId, collId);

function openHistory(entry) {
  if (entry.requestId) {
    const f = findAnywhere(entry.requestId);
    if (f) return openRequest(f.collection.id, entry.requestId);
  }
  const req = entry.snapshot ? normalizeRequest(clone(entry.snapshot)) : newRequest();
  if (!entry.snapshot) {
    req.method = entry.method;
    req.url = entry.url;
  }
  req.id = uid();
  req.name = req.name || entry.url;
  openDraft(req, entry.collectionId && getCollection(entry.collectionId) ? entry.collectionId : null);
}

function closeTabsFor(node) {
  const ids = new Set();
  (function walk(n) {
    ids.add(n.id);
    (n.items || []).forEach(walk);
  })(node);
  S.tabs = S.tabs.filter((t) => !(ids.has(t.itemId) || (t.kind !== 'environment' && ids.has(t.refId))));
  if (!S.tabs.find((t) => t.id === S.activeTabId)) S.activeTabId = wsTabs().at(-1)?.id || null;
  renderAll();
}

function closeTabsByRef(id) {
  S.tabs = S.tabs.filter((t) => t.refId !== id);
  if (!S.tabs.find((t) => t.id === S.activeTabId)) S.activeTabId = wsTabs().at(-1)?.id || null;
  renderAll();
}

// ---------- sending ----------
async function send(tab) {
  if (tab.sending) return;
  if (!tab.draft.url.trim()) {
    toast('Enter a URL first', 'error');
    tab.focusUrl && tab.focusUrl();
    return;
  }
  const out = buildOutgoing(tab.draft, tab.collectionId);
  if (out.missing.length) toast(`Undefined: ${out.missing.join(', ')}`, 'error');
  else if (out.empty.length) toast(`Empty variable: ${out.empty.join(', ')} — set it in the collection or environment`, 'error');
  tab.sending = true;
  tab.preview = false;
  const ctrl = new AbortController();
  tab.abort = ctrl;
  tab.refreshSendButton && tab.refreshSendButton();
  renderResponse(tab, tab.resPaneEl);
  try {
    const res = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...out, requestId: tab.itemId, collectionId: tab.collectionId, snapshot: stripTransient(tab.draft) }),
      signal: ctrl.signal,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Send failed');
    tab.response = data;
    tab.resTab = 'body';
    tab.resView = undefined;
    captureTokens(data, tab.collectionId);
  } catch (err) {
    if (err.name !== 'AbortError') tab.response = { ok: false, error: err.message, ms: 0, request: out };
  } finally {
    tab.sending = false;
    tab.abort = null;
    rememberCall(tab);
    if (S.activeTabId === tab.id) {
      tab.refreshSendButton && tab.refreshSendButton();
      renderResponse(tab, tab.resPaneEl);
    }
    loadHistory();
  }
}

function cancel(tab) {
  if (tab.abort) tab.abort.abort();
  toast('Request cancelled');
}

// A JSON response field whose name contains "token" updates the variable of the same name.
async function captureTokens(res, collectionId) {
  if (!res || !res.ok || !res.isText || !/json/i.test(res.contentType || '')) return;
  let data;
  try {
    data = JSON.parse(res.body);
  } catch {
    return;
  }
  const found = {};
  (function walk(o, depth) {
    if (!o || typeof o !== 'object' || depth > 4) return;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && /token/i.test(k) && v.length >= 8) found[k] = v;
      else walk(v, depth + 1);
    }
  })(data, 0);
  if (!Object.keys(found).length) return;

  const coll = collectionId && getCollection(collectionId);
  if (!coll) return;
  const updated = [];
  const env = activeEnv(coll.id);
  for (const v of (env ? env.variables : coll.variables) || []) if (found[v.key] && v.value !== found[v.key]) (v.value = found[v.key]), updated.push(v.key);
  if (updated.length) await saveCollection(coll);
  if (updated.length) toast(`Saved ${[...new Set(updated)].join(', ')} from the response`);
}

// ---------- saving ----------
async function saveTab(tab, saveAs = false) {
  if (tab.kind !== 'request') {
    if (tab.save) await tab.save();
    return;
  }
  const draft = stripTransient(tab.draft);
  if (tab.itemId && !saveAs) {
    const coll = getCollection(tab.collectionId);
    const found = coll && findItem(coll, tab.itemId);
    if (found) {
      found.list[found.list.indexOf(found.item)] = { ...draft, id: tab.itemId, type: 'request' };
      await saveCollection(coll);
      tab.dirty = false;
      renderTabs();
      renderPaneNow();
      tab.refreshState && tab.refreshState();
      toast('Saved');
      return;
    }
  }
  saveDialog(tab);
}

function saveDialog(tab) {
  const NEW = '__new';
  const nameIn = h('input', { class: 'input', value: tab.draft.name });
  const newCollIn = h('input', { class: 'input', placeholder: 'Collection name', value: 'My API' });
  let collId = tab.collectionId && getCollection(tab.collectionId) ? tab.collectionId : S.collections[0]?.id || NEW;
  let folderId = '';
  const folderWrap = h('div');
  const renderFolders = () => {
    folderId = '';
    if (collId === NEW) return folderWrap.replaceChildren(h('label', { class: 'field' }, h('span', {}, 'New collection name'), newCollIn));
    const opts = [{ value: '', label: 'Top level' }];
    (function walk(n, prefix) {
      for (const it of n.items || []) if (it.type === 'folder') opts.push({ value: it.id, label: prefix + it.name }), walk(it, prefix + it.name + ' / ');
    })(getCollection(collId), '');
    folderWrap.replaceChildren(h('label', { class: 'field' }, h('span', {}, 'Folder'), selectEl(opts, '', (v) => (folderId = v))));
  };
  renderFolders();
  const collSel = selectEl([...S.collections.map((c) => ({ value: c.id, label: c.name })), { value: NEW, label: '+ New collection…' }], collId, (v) => ((collId = v), renderFolders()));
  modal({
    title: 'Save request',
    body: h('div', { class: 'stack-v' }, h('label', { class: 'field' }, h('span', {}, 'Name'), nameIn), h('label', { class: 'field' }, h('span', {}, 'Collection'), collSel), folderWrap),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save',
        kind: 'primary',
        onClick: async () => {
          let coll = getCollection(collId);
          if (collId === NEW) {
            coll = await api('POST', '/api/collections', { name: newCollIn.value.trim() || 'My API' });
            S.collections.push(coll);
            S.collections.sort((a, b) => a.name.localeCompare(b.name));
          }
          const item = { ...stripTransient(tab.draft), id: uid(), type: 'request', name: nameIn.value.trim() || 'Untitled request' };
          const parent = folderId ? findItem(coll, folderId).item : coll;
          parent.items = parent.items || [];
          parent.items.push(item);
          await saveCollection(coll);
          // The tab moves into that collection's workspace.
          tab.collectionId = coll.id;
          tab.itemId = item.id;
          tab.draft = normalizeRequest(clone(item));
          tab.dirty = false;
          const from = tab.ws;
          tab.ws = coll.id;
          if (S.activeByWs[from] === tab.id) S.activeByWs[from] = null;
          S.ws = coll.id;
          S.activeTabId = tab.id;
          if (folderId) S.expanded.add(folderId);
          renderAll();
          toast(`Saved to ${coll.name}`);
        },
      },
    ],
  });
}

// ---------- import ----------
function openImport() {
  const status = h('div', { class: 'import-status' });
  let m;
  const handleText = async (text, label) => {
    text = text.trim();
    if (!text) return;
    if (/^curl\s/i.test(text)) {
      m.close();
      importCurl(text, newDraft(newRequest('Imported cURL')));
      return;
    }
    if (!/^[{[]/.test(text) && looksLikeVarText(text)) {
      const coll = getCollection(target());
      if (!coll) return status.append(h('div', { class: 'import-err' }, icon('alert', 14), 'Create a collection first.'));
      const env = { id: uid(), name: label === 'Pasted' ? 'Imported' : label.replace(/\.(env|txt)$/i, '').replace(/^\./, '') || 'Imported', variables: parseVarText(text) };
      coll.environments = [...(coll.environments || []), env];
      coll.activeEnvironmentId = env.id;
      await saveCollection(coll);
      renderPaneNow();
      status.append(h('div', { class: 'import-ok' }, icon('check', 14), `${label}: environment “${env.name}” with ${env.variables.length} variables → ${coll.name}`));
      return;
    }
    try {
      const out = await api('POST', '/api/import', { content: text, collectionId: target() });
      await afterImport(out, false);
      status.append(h('div', { class: 'import-ok' }, icon('check', 14), `${label}: ${out.kind} “${out.item.name}”`));
    } catch (err) {
      status.append(h('div', { class: 'import-err' }, icon('alert', 14), `${label}: ${err.message}`));
    }
  };
  const handleFiles = async (files) => {
    for (const f of files) await handleText(await f.text(), f.name);
  };
  const fileInput = h('input', { type: 'file', accept: '.json,.env,.txt,application/json,text/plain', multiple: true, hidden: true, onChange: (e) => handleFiles(e.target.files) });
  const drop = h(
    'div',
    {
      class: 'dropzone',
      onClick: () => fileInput.click(),
      onDragover: (e) => (e.preventDefault(), drop.classList.add('over')),
      onDragleave: () => drop.classList.remove('over'),
      onDrop: (e) => {
        e.preventDefault();
        drop.classList.remove('over');
        handleFiles(e.dataTransfer.files);
      },
    },
    h('b', {}, 'Drop Postman files'),
    h('span', {}, 'or click to browse — Postman collections & environments, .env files'),
    fileInput,
  );
  const paste = h('textarea', { class: 'textarea mono', rows: 4, placeholder: 'Paste a cURL command, Postman JSON, or KEY=value lines (becomes an environment)' });
  const found = S.discover ? [...S.discover.collections, ...S.discover.environments].filter((x) => !x.imported) : [];
  // Environment files are added to this collection.
  const targetSel = S.collections.length
    ? selectEl(S.collections.map((c) => ({ value: c.id, label: c.name })), getCollection(S.ws) ? S.ws : S.lastCollection || S.collections[0].id, () => {}, 'select sm')
    : null;
  const target = () => (targetSel ? targetSel.value : null);
  m = modal({
    title: 'Import',
    width: 560,
    body: h(
      'div',
      { class: 'stack-v' },
      drop,
      paste,
      targetSel
        ? h(
            'div',
            { class: 'vs-callout' },
            h('span', {}, 'Only want the variables? Add them as a separate variable set of'),
            targetSel,
            h('button', { class: 'tbtn accent', onClick: () => (m.close(), importVarSet(getCollection(target()))) }, 'Import variable set →'),
          )
        : null,
      found.length
        ? h(
            'div',
            { class: 'found' },
            h('div', { class: 'group-label' }, `Found in your projects · ${found.length}`),
            found.map((f) =>
              h(
                'div',
                { class: 'trow file' },
                icon(/environment/i.test(f.file) ? 'globe' : 'layers', 13, 'ficon'),
                h('span', { class: 'tlabel' }, f.name),
                h(
                  'button',
                  {
                    class: 'tbtn accent sm',
                    onClick: async (e) => {
                      const b = e.currentTarget;
                      b.disabled = true;
                      await importDiscovered(f.file, false, target());
                      b.textContent = 'Imported';
                    },
                  },
                  'Import',
                ),
              ),
            ),
          )
        : null,
      status,
    ),
    actions: [{ label: 'Done' }, { label: 'Import pasted text', kind: 'primary', closes: false, onClick: () => handleText(paste.value, 'Pasted') }],
  });
}

async function afterImport(out, go = true) {
  if (out.kind === 'collection') {
    S.collections.push(out.item);
    S.collections.sort((a, b) => a.name.localeCompare(b.name));
    if (go) S.ws = out.item.id;
  } else {
    const i = S.collections.findIndex((c) => c.id === out.collection.id);
    if (i >= 0) S.collections[i] = out.collection;
    if (go) S.ws = out.collection.id;
  }
  renderAll();
}

async function importDiscovered(file, go = true, collectionId) {
  try {
    if (/environment\.json$/i.test(file) && !collectionId) {
      collectionId = await pickCollection('Add this environment to which collection?');
      if (!collectionId) return;
    }
    const out = await api('POST', '/api/import-file', { file, collectionId });
    await afterImport(out, go);
    await refreshDiscover();
    toast(`Imported “${out.item.name}”`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function pickCollection(title) {
  return new Promise((resolve) => {
    if (!S.collections.length) {
      toast('Create or import a collection first', 'error');
      return resolve(null);
    }
    let done = false;
    const sel = selectEl(S.collections.map((c) => ({ value: c.id, label: c.name })), S.lastCollection || S.collections[0].id, () => {});
    modal({
      title,
      width: 420,
      body: h('label', { class: 'field' }, h('span', {}, 'Collection'), sel),
      actions: [
        { label: 'Cancel', onClick: () => ((done = true), resolve(null)) },
        { label: 'Add', kind: 'primary', onClick: () => ((done = true), resolve(sel.value)) },
      ],
      onClose: () => !done && resolve(null),
    });
  });
}

// ---------- environments ----------
async function setActiveEnv(collectionId, envId) {
  const coll = getCollection(collectionId);
  if (!coll) return;
  coll.activeEnvironmentId = envId || null;
  if (coll.cloud) rememberCloudActive(coll);
  else await saveCollection(coll);
  renderPaneNow();
  const t = S.tabs.find((x) => x.id === S.activeTabId);
  if (!t || t.kind === 'request' || t.kind === 'environment') renderActive();
}

// ---------- history & services ----------
async function loadHistory() {
  S.history = await api('GET', '/api/history').catch(() => S.history);
  if (S.ws === 'drafts') renderPaneNow();
}

async function refreshDiscover() {
  S.discover = await api('GET', '/api/discover').catch(() => S.discover);
  if (S.ws === 'services') {
    renderPaneNow();
    const t = S.tabs.find((x) => x.id === S.activeTabId);
    if (t && t.kind === 'service') renderActive();
  }
  if (S.discover && S.discover.scanning) setTimeout(refreshDiscover, 1500);
}

async function rescan() {
  S.discover = { ...(S.discover || { services: [], collections: [], environments: [] }), scanning: true };
  renderPaneNow();
  try {
    S.discover = await api('POST', '/api/discover/rescan');
    toast(`Found ${S.discover.services.length} Laravel apps and ${S.discover.collections.length} collections`);
  } catch (err) {
    toast(err.message, 'error');
  }
  renderPaneNow();
}

let svcPoll = null;
function pollServices() {
  clearTimeout(svcPoll);
  svcPoll = setTimeout(async () => {
    await refreshDiscover();
    if (S.discover?.services.some((s) => s.status === 'starting')) pollServices();
  }, 1000);
}

async function startService(id) {
  try {
    await api('POST', `/api/services/${id}/start`);
    toast('Starting server…');
  } catch (err) {
    toast(err.message, 'error');
  }
  await refreshDiscover();
  pollServices();
}

async function stopService(id) {
  await api('POST', `/api/services/${id}/stop`).catch((e) => toast(e.message, 'error'));
  await refreshDiscover();
  toast('Server stopped');
}

// ---------- theme ----------
const themeName = () => LS.get('apidock.theme', 'auto');
function applyTheme() {
  const t = themeName();
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}
function cycleTheme() {
  LS.set('apidock.theme', { auto: 'light', light: 'dark', dark: 'auto' }[themeName()]);
  applyTheme();
  renderDock($('#dock'));
  toast(`Theme: ${themeName()}`);
}

// ---------- persistence ----------
function persistUi() {
  LS.set('apidock.ui', { ws: S.ws, expanded: [...S.expanded] });
}

function persistTabs() {
  LS.set('apidock.tabs.v2', {
    activeByWs: S.activeByWs,
    tabs: S.tabs
      .filter((t) => t.kind !== 'runner')
      .map((t) => ({ id: t.id, ws: t.ws, kind: t.kind, refId: t.refId, collectionId: t.collectionId, itemId: t.itemId, dirty: t.kind === 'request' && t.dirty, draft: t.kind === 'request' ? stripTransient(t.draft) : undefined, sub: t.sub })),
  });
}
const persistTabsSoon = debounce(persistTabs, 400);

function restoreTabs() {
  const saved = LS.get('apidock.tabs.v2', null);
  if (!saved) return;
  for (const t of saved.tabs || []) {
    if (t.kind === 'request') {
      if (t.itemId && !t.dirty) {
        const coll = getCollection(t.collectionId);
        const found = coll && findItem(coll, t.itemId);
        if (!found) continue;
        t.draft = clone(found.item);
      }
      if (!t.draft) continue;
      t.draft = normalizeRequest(t.draft);
    } else if (['collection', 'folder'].includes(t.kind) && !getCollection(t.collectionId)) continue;
    else if (t.kind === 'environment' && !findEnv(t.collectionId, t.refId)) continue;
    t.ws = wsForTab(t);
    restoreCall(t);
    S.tabs.push(t);
  }
  for (const [ws, id] of Object.entries(saved.activeByWs || {})) if (S.tabs.find((t) => t.id === id && t.ws === ws)) S.activeByWs[ws] = id;
  // Keep only each workspace's current view plus anything unsaved.
  S.tabs = S.tabs.filter((t) => t.dirty || S.activeByWs[t.ws] === t.id);
}

// ---------- shortcuts ----------
function showShortcuts() {
  const rows = [
    ['Ctrl Enter', 'Send request'],
    ['Ctrl S', 'Save'],
    ['Ctrl T', 'New request in this workspace'],
    ['Ctrl W', 'Close tab'],
    ['Ctrl Tab', 'Next tab (this workspace)'],
    ['Alt 1…9', 'Jump to collection 1…9'],
    ['Ctrl K', 'Filter requests'],
    ['Ctrl O', 'Import'],
  ];
  const v = versionInfo();
  modal({
    title: 'ApiDock',
    width: 440,
    body: h(
      'div',
      {},
      updatesSupported
        ? h(
            'div',
            { class: 'about-row' },
            h('div', {}, h('b', {}, `Version ${v?.version || ''}`), h('div', { class: 'muted small' }, v?.supported ? 'Checks for updates automatically.' : v?.reason || '')),
            v?.supported ? h('button', { class: 'btn sm', onClick: checkForUpdates }, icon('refresh', 14), 'Check for updates') : null,
          )
        : null,
      h('div', { class: 'section-title' }, 'Keyboard shortcuts'),
      h('div', { class: 'shortcuts' }, rows.map(([k, d]) => h('div', { class: 'sc-row' }, h('span', {}, d), h('span', {}, k.split(' ').map((x) => h('kbd', {}, x)))))),
    ),
  });
}

document.addEventListener('keydown', (e) => {
  if (e.altKey && /^[1-9]$/.test(e.key)) {
    const c = S.collections[Number(e.key) - 1];
    if (c) {
      e.preventDefault();
      switchWs(c.id);
    }
    return;
  }
  if (e.key === 'Escape' && S.filter && document.activeElement?.classList.contains('pane-search')) {
    S.filter = '';
    renderPaneNow();
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const t = S.tabs.find((x) => x.id === S.activeTabId && x.ws === S.ws);
  const k = e.key.toLowerCase();
  if (k === 'enter' && t && t.kind === 'request') {
    e.preventDefault();
    send(t);
  } else if (k === 's') {
    e.preventDefault();
    if (t) saveTab(t);
  } else if (k === 't') {
    e.preventDefault();
    newDraft();
  } else if (k === 'w') {
    e.preventDefault();
    if (t) closeTab(t.id);
  } else if (k === 'o') {
    e.preventDefault();
    openImport();
  } else if (k === 'f' && document.querySelector('.res-find-input')) {
    e.preventDefault();
    const box = document.querySelector('.res-find-input');
    box.focus();
    box.select();
  } else if (k === 'k') {
    e.preventDefault();
    document.querySelector('.pane-search')?.focus();
  } else if (e.key === 'Tab') {
    const list = wsTabs();
    if (list.length < 2) return;
    e.preventDefault();
    const i = list.findIndex((x) => x.id === S.activeTabId);
    activate(list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length].id);
  }
});

window.addEventListener('unhandledrejection', (e) => {
  const err = e.reason;
  if (!err || !err.message) return;
  toast(err.message, 'error');
  if (err.conflict) renderAll();
});

window.addEventListener('beforeunload', () => {
  for (const t of S.tabs) rememberCall(t);
  persistTabs();
  persistCalls();
});

// ---------- wire up & boot ----------
Object.assign(app, {
  renderAll,
  renderDock: () => renderDock($('#dock')),
  openTeam: (id) => openSingleton('team', id),
  signIn,
  signOut,
  shareCollection,
  copyToLocal,
  deleteShared,
  createTeam,
  answerInvite,
  redeemCode,
  tabTitle,
  tabLead,
  activate,
  closeTab,
  closeMany,
  wsTabs,
  renderPane: renderPaneNow,
  renderSidebar: renderPaneNow,
  renderTabs,
  renderActive,
  renderTopbar: renderPaneNow,
  switchWs,
  dropWorkspace,
  markDirty,
  openRequest,
  openDraft,
  newDraft,
  openCollection,
  openFolder,
  openEnvironment,
  openRunner,
  openService,
  openHistory,
  openImport,
  importDiscovered,
  closeTabsFor,
  closeTabsForCollection: dropWorkspace,
  closeTabsByRef,
  send,
  cancel,
  saveTab,
  setActiveEnv,
  loadHistory,
  refreshDiscover,
  rescan,
  startService,
  stopService,
  captureTokens,
  persistUi,
  themeName,
  cycleTheme,
  showShortcuts,
  updateAvailable,
  showUpdateCard,
  layoutMode: () => LS.get('apidock.layout', 'side'),
  setLayoutMode: (m) => LS.set('apidock.layout', m),
  splitRatio: () => Number(LS.get('apidock.split2', 0.5)) || 0.5,
  setSplitRatio: (r) => LS.set('apidock.split2', r),
});

async function boot() {
  applyTheme();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  layout();
  const ui = LS.get('apidock.ui', {});
  S.expanded = new Set(ui.expanded || []);
  try {
    const data = await api('GET', '/api/bootstrap');
    S.collections = data.collections;
    S.settings = data.settings;
    await loadCloudStatus();
    if (S.cloud.signedIn) await Promise.race([Promise.all([loadMe(), syncCloudCollections()]), new Promise((r) => setTimeout(r, 6000))]);
  } catch (err) {
    document.body.replaceChildren(h('div', { class: 'empty-stage' }, h('h1', {}, 'ApiDock server is not reachable'), h('p', {}, err.message)));
    return;
  }
  const valid = (ws) => ws && ((SYSTEM[ws] && !(SYSTEM[ws].hidden && S.collections.length)) || getCollection(ws));
  S.ws = valid(ui.ws) ? ui.ws : S.collections[0]?.id || 'drafts';
  restoreTabs();
  for (const t of S.tabs) {
    const f = t.kind === 'request' && t.itemId && getCollection(t.collectionId) && findItem(getCollection(t.collectionId), t.itemId);
    if (f) for (const p of f.parents) S.expanded.add(p.id);
  }
  renderAll();
  loadHistory().then(() => !S.activeTabId && renderActive());
  refreshDiscover();
  if (S.cloud?.signedIn) startPolling();
  initUpdates();
}

boot();
