// The dock (collections as workspaces + system spaces) and the context pane
// that sits next to it, which changes with the active workspace.
import { h, icon, api, toast, showMenu, confirmModal, promptModal, statusClass, selectEl, modal } from './util.js';
import { S, uid, newRequest, findItem, countRequests, reassignIds, clone, saveCollection, activeEnv, getCollection, flattenRequests, parseVarText } from './model.js';
import { app } from './bus.js';

export const SYSTEM = {
  drafts: { label: 'Drafts & History', icon: 'history' },
  services: { label: 'Services', icon: 'server' },
};

// ---------- identity of a collection ----------
export function hueOf(id) {
  let x = 0;
  for (const ch of String(id)) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return x % 360;
}

export function monogram(name) {
  const base = String(name).split('/').pop();
  const words = base.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return words.slice(0, 3).map((w) => w[0]).join('').toUpperCase();
}

function tabCount(ws) {
  return S.tabs.filter((t) => t.ws === ws && t.dirty).length;
}

// ---------- dock ----------
export function renderDock(root) {
  const tile = (ws, label, content, hue, extra = '') =>
    h(
      'button',
      {
        class: `dock-tile ${extra}` + (S.ws === ws ? ' active' : ''),
        style: hue != null ? { '--hue': hue } : null,
        title: label,
        onClick: () => app.switchWs(ws),
        onContextmenu: (e) => {
          const c = getCollection(ws);
          if (c) {
            e.preventDefault();
            showMenu(e, collectionMenu(c));
          }
        },
      },
      content,
      tabCount(ws) ? h('span', { class: 'dock-badge', title: `${tabCount(ws)} unsaved` }, tabCount(ws)) : null,
    );

  root.replaceChildren(
    h('div', { class: 'dock-logo', title: 'ApiDock' }, h('span', {}, 'A'), h('i', {})),
    h(
      'div',
      { class: 'dock-list' },
      S.collections.map((c) => tile(c.id, c.name, h('span', { class: 'mono-gram' }, monogram(c.name)), hueOf(c.id), 'coll')),
      h(
        'button',
        {
          class: 'dock-tile add',
          title: 'New or import collection',
          onClick: (e) =>
            showMenu(e, [
              { label: 'New collection', icon: 'plus', onClick: newCollection },
              { label: 'Import…', icon: 'import', onClick: app.openImport },
            ]),
        },
        icon('plus', 18),
      ),
    ),
    h(
      'div',
      { class: 'dock-sys' },
      Object.entries(SYSTEM).map(([ws, d]) => tile(ws, d.label, icon(d.icon, 18), null, 'sys')),
      h('div', { class: 'dock-sep' }),
      h('button', { class: 'dock-tile sys', title: `Theme: ${app.themeName()}`, onClick: app.cycleTheme }, icon(app.themeName() === 'dark' ? 'moon' : 'sun', 17)),
      h('button', { class: 'dock-tile sys', title: 'Keyboard shortcuts', onClick: app.showShortcuts }, h('span', { class: 'q' }, '?')),
    ),
  );
}

// ---------- pane ----------
// Each workspace keeps its own scroll position, so re-rendering the pane
// (which happens on almost every click) never makes the list jump.
const paneScroll = {};

export function renderPane(root) {
  const old = root.querySelector('.tree');
  if (old && root.dataset.ws) paneScroll[root.dataset.ws] = old.scrollTop;
  const c = getCollection(S.ws);
  let body;
  if (c) body = collectionPane(c);
  else if (S.ws === 'services') body = servicesPane();
  else body = draftsPane();
  root.replaceChildren(...[body, c ? envFooter(c) : null].filter(Boolean));
  root.dataset.ws = S.ws;
  const tree = root.querySelector('.tree');
  if (tree) {
    tree.scrollTop = paneScroll[S.ws] || 0;
    tree.addEventListener('scroll', () => (paneScroll[S.ws] = tree.scrollTop), { passive: true });
  }
}

// ---------- variable sets ----------
// A collection owns several variable sets. "Default" is the set that came with
// the collection (collection.variables); every other set lives in
// collection.environments. Exactly one set is in use at a time.
const kvFrom = (list) =>
  (list || [])
    .filter((x) => x && x.key != null && x.key !== '')
    .map((x) => ({ key: String(x.key), value: x.value == null ? '' : String(x.value), enabled: !x.disabled && x.enabled !== false }));

const enabledCount = (vars) => (vars || []).filter((v) => v.enabled !== false && v.key).length;

function envFooter(c) {
  const sets = c.environments || [];
  const env = activeEnv(c.id);
  const n = enabledCount(env ? env.variables : c.variables);
  const editActive = () => (env ? app.openEnvironment(c.id, env.id) : app.openCollection(c.id, 'variables'));
  const menu = (e) =>
    showMenu(e, [
      { label: 'Import variable set…', icon: 'import', onClick: () => importVarSet(c) },
      { label: 'New variable set', icon: 'plus', onClick: () => newEnvironment(c) },
      '-',
      { label: `Edit “${env ? env.name : 'Default'}”`, icon: 'edit', onClick: editActive },
      { label: `Duplicate “${env ? env.name : 'Default'}”`, icon: 'copy', onClick: () => newEnvironment(c, env ? env.id : 'collection') },
      env ? { label: 'Export as Postman environment', icon: 'download', onClick: () => (location.href = `/api/collections/${c.id}/environments/${env.id}/export`) } : null,
      ...(sets.length
        ? ['-', ...[{ id: null, name: 'Default' }, ...sets].filter((x) => (x.id || null) !== (env ? env.id : null)).map((x) => ({ label: `Edit “${x.name}”`, icon: 'globe', onClick: () => (x.id ? app.openEnvironment(c.id, x.id) : app.openCollection(c.id, 'variables')) }))]
        : []),
      env ? '-' : null,
      env ? { label: `Delete “${env.name}”`, icon: 'trash', danger: true, onClick: () => deleteEnv(c, env) } : null,
    ]);
  return h(
    'div',
    { class: 'pane-foot' },
    h('span', { class: 'foot-label' }, 'Variables'),
    selectEl(
      [{ value: '', label: `Default (${enabledCount(c.variables)})` }, ...sets.map((e) => ({ value: e.id, label: `${e.name} (${enabledCount(e.variables)})` }))],
      env ? env.id : '',
      (v) => app.setActiveEnv(c.id, v || null),
      'env-pick',
    ),
    h('button', { class: 'foot-link', title: 'Edit the variables in use', onClick: editActive }, `edit`),
    h('button', { class: 'icon-btn', title: 'Import / manage variable sets', onClick: menu }, icon('more', 14)),
  );
}

// Import a variable set into collection c, from a file, pasted text, or another collection.
function importVarSet(c) {
  let parsed = null;
  const nameIn = h('input', { class: 'input', placeholder: 'e.g. Staging' });
  let autoName = true;
  nameIn.addEventListener('input', () => (autoName = false));
  const preview = h('div', { class: 'vs-preview muted' }, 'Choose a file, paste text, or pick a collection.');
  const take = (p, sourceLabel) => {
    if (!p || !p.variables.length) {
      parsed = null;
      preview.className = 'vs-preview err';
      preview.textContent = `${sourceLabel}: no variables found.`;
      return;
    }
    parsed = p;
    if (autoName || !nameIn.value.trim()) {
      nameIn.value = p.name;
      autoName = true;
    }
    preview.className = 'vs-preview ok';
    preview.textContent = `${sourceLabel}: ${p.variables.length} variables — ${p.variables.slice(0, 8).map((v) => v.key).join(', ')}${p.variables.length > 8 ? ', …' : ''}`;
  };
  const fromText = (text, fileName) => {
    const t = String(text).replace(/^﻿/, '').trim();
    if (/^[{[]/.test(t)) {
      const j = JSON.parse(t);
      if (j.info && Array.isArray(j.item)) return { name: j.info.name || 'Imported', variables: kvFrom(j.variable) };
      if (Array.isArray(j.values)) return { name: j.name || 'Imported', variables: kvFrom(j.values) };
      if (Array.isArray(j.variable)) return { name: fileName || 'Imported', variables: kvFrom(j.variable) };
      if (!Array.isArray(j)) return { name: fileName || 'Imported', variables: Object.entries(j).map(([key, value]) => ({ key, value: typeof value === 'string' ? value : JSON.stringify(value), enabled: true })) };
      throw new Error('Unrecognised JSON');
    }
    return { name: (fileName || 'Imported').replace(/\.(env|txt)$/i, '').replace(/^\./, '') || 'Imported', variables: parseVarText(t) };
  };

  const fileInput = h('input', {
    type: 'file',
    accept: '.json,.env,.txt,application/json,text/plain',
    hidden: true,
    onChange: async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        take(fromText(await f.text(), f.name.replace(/\.(postman_(collection|environment)\.)?json$/i, '')), f.name);
      } catch (err) {
        take(null, `${f.name} (${err.message})`);
      }
    },
  });
  const drop = h(
    'div',
    {
      class: 'dropzone small',
      onClick: () => fileInput.click(),
      onDragover: (e) => (e.preventDefault(), drop.classList.add('over')),
      onDragleave: () => drop.classList.remove('over'),
      onDrop: async (e) => {
        e.preventDefault();
        drop.classList.remove('over');
        const f = e.dataTransfer.files[0];
        if (!f) return;
        try {
          take(fromText(await f.text(), f.name.replace(/\.(postman_(collection|environment)\.)?json$/i, '')), f.name);
        } catch (err) {
          take(null, `${f.name} (${err.message})`);
        }
      },
    },
    h('b', {}, 'Drop a file or click to browse'),
    h('span', {}, 'Postman collection (its variables only) · Postman environment · .env / KEY=value'),
    fileInput,
  );
  const paste = h('textarea', {
    class: 'textarea mono',
    rows: 4,
    placeholder: 'or paste KEY=value lines, or Postman collection / environment JSON',
    onInput: (e) => {
      if (!e.target.value.trim()) return;
      try {
        take(fromText(e.target.value), 'Pasted');
      } catch (err) {
        take(null, `Pasted (${err.message})`);
      }
    },
  });
  // Every other collection's sets, so variables can be reused across collections.
  const sources = [{ value: '', label: '— pick a collection —' }];
  for (const o of S.collections) {
    if (o.id === c.id) continue;
    sources.push({ value: `${o.id}|`, label: `${o.name} — Default (${enabledCount(o.variables)})` });
    for (const e of o.environments || []) sources.push({ value: `${o.id}|${e.id}`, label: `${o.name} — ${e.name} (${enabledCount(e.variables)})` });
  }
  const fromColl =
    sources.length > 1
      ? selectEl(sources, '', (v) => {
          if (!v) return;
          const [cid, eid] = v.split('|');
          const o = getCollection(cid);
          const e = eid ? (o.environments || []).find((x) => x.id === eid) : null;
          take({ name: e ? `${o.name} · ${e.name}` : o.name, variables: clone(e ? e.variables : o.variables).map(({ key, value, enabled }) => ({ key, value, enabled: enabled !== false })) }, o.name);
        })
      : null;

  modal({
    title: `Import variable set into “${c.name}”`,
    width: 580,
    body: h(
      'div',
      { class: 'stack-v' },
      drop,
      paste,
      fromColl ? h('label', { class: 'field' }, h('span', {}, 'or copy the variables of another collection'), fromColl) : null,
      preview,
      h('label', { class: 'field' }, h('span', {}, 'Name of this set'), nameIn),
      h('p', { class: 'hint' }, 'The set is added next to the collection’s other sets and switched on. Its values never mix with the others — pick the set you want in the Variables dropdown.'),
    ),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Import set',
        kind: 'primary',
        onClick: async () => {
          if (!parsed) {
            toast('Choose something with variables first', 'error');
            return false;
          }
          const env = { id: uid(), name: nameIn.value.trim() || parsed.name || 'Imported', variables: parsed.variables };
          c.environments = [...(c.environments || []), env];
          c.activeEnvironmentId = env.id;
          await saveCollection(c);
          app.openEnvironment(c.id, env.id);
          app.renderAll();
          toast(`Imported ${env.variables.length} variables into “${env.name}” — now in use`);
        },
      },
    ],
  });
}

// preset: 'collection' (copy Default) | 'empty' | a set id
async function newEnvironment(c, preset) {
  const sets = c.environments || [];
  const options = [
    { value: 'collection', label: `Copy of Default (${enabledCount(c.variables)})` },
    ...sets.map((e) => ({ value: e.id, label: `Copy of “${e.name}” (${enabledCount(e.variables)})` })),
    { value: 'empty', label: 'Empty' },
  ];
  const fromSel = selectEl(options, preset && options.some((o) => o.value === preset) ? preset : 'collection', () => {});
  const nameIn = h('input', { class: 'input', value: sets.length ? 'Staging' : 'Local' });
  const create = async () => {
    const from = fromSel.value;
    const src = from === 'collection' ? c.variables || [] : from === 'empty' ? [] : sets.find((e) => e.id === from)?.variables || [];
    const env = {
      id: uid(),
      name: nameIn.value.trim() || 'Variables',
      variables: clone(src)
        .filter((v) => v.key)
        .map(({ key, value, enabled, description }) => ({ key, value, enabled: enabled !== false, ...(description ? { description } : {}) })),
    };
    c.environments = [...sets, env];
    c.activeEnvironmentId = env.id;
    await saveCollection(c);
    app.openEnvironment(c.id, env.id);
  };
  modal({
    title: 'New variable set',
    width: 460,
    body: h('div', { class: 'stack-v' }, h('label', { class: 'field' }, h('span', {}, `Name — in “${c.name}”`), nameIn), h('label', { class: 'field' }, h('span', {}, 'Start from'), fromSel)),
    actions: [{ label: 'Cancel' }, { label: 'Create', kind: 'primary', onClick: create }],
  });
}

async function deleteEnv(c, env) {
  if (!(await confirmModal('Delete variable set', `Delete “${env.name}” from ${c.name}? The collection switches back to Default.`))) return;
  c.environments = c.environments.filter((x) => x.id !== env.id);
  if (c.activeEnvironmentId === env.id) c.activeEnvironmentId = null;
  await saveCollection(c);
  app.closeTabsByRef(env.id);
  app.openCollection(c.id, 'variables');
  toast(`Deleted “${env.name}”`);
}

export { newEnvironment, importVarSet, deleteEnv };


function paneHead({ kicker, title, meta, actions, onTitle }) {
  return h(
    'div',
    { class: 'pane-head' },
    kicker ? h('div', { class: 'kicker' }, kicker) : null,
    h('div', { class: 'pane-title-row' }, h(onTitle ? 'button' : 'div', { class: 'pane-title', onClick: onTitle, title: onTitle ? 'Open overview' : null }, title), h('div', { class: 'pane-actions' }, actions)),
    meta ? h('div', { class: 'pane-meta' }, meta) : null,
  );
}

function searchBox(placeholder) {
  const input = h('input', {
    class: 'pane-search',
    placeholder,
    value: S.filter,
    spellcheck: false,
    onInput: (e) => {
      S.filter = e.target.value;
      const pos = e.target.selectionStart;
      app.renderPane();
      const again = document.querySelector('.pane-search');
      again.focus();
      again.setSelectionRange(pos, pos);
    },
  });
  return h('label', { class: 'search-row' }, icon('search', 13), input, S.filter ? h('kbd', {}, 'esc') : h('kbd', {}, 'Ctrl K'));
}

// Items open in this workspace that the tree can't show: unsaved drafts and
// pages such as Overview or Runner. Requests opened from the tree are marked there.
function openList() {
  // Only things that would otherwise be lost: unsaved requests that are not in the tree yet.
  const items = app.wsTabs().filter((t) => t.kind === 'request' && !t.itemId && t.dirty);
  if (!items.length) return null;
  return h(
    'div',
    { class: 'draft-rows' },
    items.map((t) =>
      h(
        'div',
        { class: 'trow draft-row' + (t.id === S.activeTabId ? ' active' : ''), title: 'Unsaved — press Ctrl S to save it into the collection', onClick: () => app.activate(t.id) },
        app.tabLead(t),
        h('span', { class: 'tlabel' }, app.tabTitle(t), h('span', { class: 'draft-tag' }, 'unsaved')),
        h('button', { class: 'icon-btn row-act', title: 'Discard', onClick: (e) => (e.stopPropagation(), app.closeTab(t.id)) }, icon('x', 13)),
      ),
    ),
  );
}

// ---------- collection pane ----------
function matches(node, q) {
  if (!q) return true;
  if (node.type === 'request') return `${node.name} ${node.method} ${node.url}`.toLowerCase().includes(q);
  return node.name.toLowerCase().includes(q) || (node.items || []).some((c) => matches(c, q));
}

function collectionPane(c) {
  const q = S.filter.trim().toLowerCase();
  const reqs = flattenRequests(c);
  const folders = (function count(n) {
    return (n.items || []).reduce((s, it) => s + (it.type === 'folder' ? 1 + count(it) : 0), 0);
  })(c);
  const byMethod = {};
  for (const r of reqs) byMethod[r.item.method] = (byMethod[r.item.method] || 0) + 1;

  const tree = h('div', { class: 'tree' }, (c.items || []).filter((it) => matches(it, q)).map((it) => node(c, it, q, 0)));
  if (!(c.items || []).length) {
    tree.append(h('div', { class: 'pane-empty' }, h('p', {}, 'This collection is empty.'), h('button', { class: 'tbtn accent', onClick: () => addRequest(c, c) }, '+ Add a request')));
  } else if (q && !tree.childElementCount) {
    tree.append(h('div', { class: 'pane-empty' }, h('p', {}, `Nothing matches “${S.filter}”.`)));
  }

  return h(
    'div',
    { class: 'pane-body' },
    paneHead({
      kicker: 'Collection',
      title: c.name,
      onTitle: () => app.openCollection(c.id),
      meta: h(
        'div',
        { class: 'meta-line' },
        h('span', {}, `${reqs.length} requests`),
        folders ? h('span', {}, `${folders} folders`) : null,
        h('span', { class: 'method-bar', title: Object.entries(byMethod).map(([m, n]) => `${m} ${n}`).join(' · ') }, Object.entries(byMethod).map(([m, n]) => h('i', { class: `mb m-${m.toLowerCase()}`, style: { flexGrow: n } }))),
      ),
      actions: [
        h('button', { class: 'icon-btn', title: 'New request in this collection', onClick: () => addRequest(c, c) }, icon('plus', 16)),
        h('button', { class: 'icon-btn', title: 'Run collection', onClick: () => app.openRunner(c.id, null) }, icon('play', 14)),
        h('button', { class: 'icon-btn', title: 'More', onClick: (e) => showMenu(e, collectionMenu(c)) }, icon('more', 16)),
      ],
    }),
    openList(),
    reqs.length ? searchBox('Filter requests') : null,
    tree,
  );
}

function node(coll, it, q, depth) {
  return it.type === 'folder' ? folderNode(coll, it, q, depth) : requestNode(coll, it, depth);
}

function toggle(id) {
  S.expanded.has(id) ? S.expanded.delete(id) : S.expanded.add(id);
  app.persistUi();
  app.renderPane();
}

function folderNode(coll, f, q, depth) {
  const open = !!q || S.expanded.has(f.id);
  const kids = (f.items || []).filter((x) => matches(x, q));
  return h(
    'div',
    { class: 'tnode folder-node' + (open ? ' open' : '') + (depth === 0 ? ' top' : ' nested') },
    h(
      'div',
      {
        class: 'trow folder' + (open ? ' is-open' : '') + (depth === 0 ? ' top' : ''),
        style: { '--d': depth },
        title: `${f.name} — ${countRequests(f)} requests`,
        onClick: () => toggle(f.id),
        onDblclick: () => app.openFolder(coll.id, f.id),
        onContextmenu: (e) => (e.preventDefault(), showMenu(e, folderMenu(coll, f))),
      },
      h('span', { class: 'chev' + (open ? ' open' : '') }, icon('chevron', 11)),
      h('span', { class: 'tlabel' }, f.name),
      h('span', { class: 'tcount' }, countRequests(f)),
      h('button', { class: 'icon-btn row-act', onClick: (e) => (e.stopPropagation(), showMenu(e, folderMenu(coll, f))) }, icon('more', 14)),
    ),
    open ? h('div', { class: 'tkids', style: { '--d': depth } }, kids.length ? kids.map((k) => node(coll, k, q, depth + 1)) : h('div', { class: 'tree-empty-folder', style: { '--d': depth + 1 } }, 'Empty folder')) : null,
  );
}

function requestNode(coll, r, depth) {
  const tab = S.tabs.find((t) => t.kind === 'request' && t.itemId === r.id);
  const active = tab && tab.id === S.activeTabId;
  return h(
    'div',
    {
      class: 'trow req' + (active ? ' active' : '') + (tab ? ' open' : ''),
      style: { '--d': depth },
      title: r.url,
      onClick: () => app.openRequest(coll.id, r.id),
      onContextmenu: (e) => (e.preventDefault(), showMenu(e, requestMenu(coll, r))),
    },
    h('span', { class: `verb m-${r.method.toLowerCase()}` }, r.method === 'DELETE' ? 'DEL' : r.method === 'OPTIONS' ? 'OPT' : r.method),
    h('span', { class: 'tlabel' }, r.name),
    tab && tab.dirty ? h('span', { class: 'dirty' }) : null,
    h('button', { class: 'icon-btn row-act', onClick: (e) => (e.stopPropagation(), showMenu(e, requestMenu(coll, r))) }, icon('more', 14)),
  );
}

// ---------- collection actions ----------
async function newCollection() {
  const name = await promptModal('New collection', 'Name', 'My API', 'Create');
  if (!name) return;
  const c = await api('POST', '/api/collections', { name });
  S.collections.push(c);
  S.collections.sort((a, b) => a.name.localeCompare(b.name));
  app.switchWs(c.id);
}

async function addRequest(coll, parent) {
  const r = newRequest('New request');
  r.url = coll.variables?.some((v) => v.key === 'base_url') ? '{{base_url}}/' : '';
  parent.items = parent.items || [];
  parent.items.push(r);
  S.expanded.add(parent.id);
  await saveCollection(coll);
  app.renderPane();
  app.openRequest(coll.id, r.id, { focusUrl: true });
}

async function addFolder(coll, parent) {
  const name = await promptModal('New folder', 'Folder name', 'New folder', 'Create');
  if (!name) return;
  const f = { id: uid(), type: 'folder', name, description: '', auth: { type: 'inherit' }, items: [] };
  parent.items = parent.items || [];
  parent.items.push(f);
  S.expanded.add(parent.id);
  S.expanded.add(f.id);
  await saveCollection(coll);
  app.renderPane();
}

async function rename(coll, n) {
  const name = await promptModal('Rename', 'Name', n.name, 'Rename');
  if (!name) return;
  n.name = name;
  await saveCollection(coll);
  for (const t of S.tabs) if (t.itemId === n.id && t.draft) t.draft.name = name;
  app.renderAll();
}

async function removeNode(coll, n) {
  const what = n.type === 'folder' ? `folder “${n.name}” and its ${countRequests(n)} request(s)` : `request “${n.name}”`;
  if (!(await confirmModal('Delete', `Delete the ${what}? This cannot be undone.`))) return;
  const found = findItem(coll, n.id);
  if (!found) return;
  found.list.splice(found.list.indexOf(found.item), 1);
  await saveCollection(coll);
  app.closeTabsFor(n);
  app.renderPane();
}

async function duplicate(coll, n) {
  const found = findItem(coll, n.id);
  const copy = reassignIds(clone(n));
  copy.name = `${n.name} copy`;
  found.list.splice(found.list.indexOf(found.item) + 1, 0, copy);
  await saveCollection(coll);
  app.renderPane();
}

async function move(coll, n, dir) {
  const found = findItem(coll, n.id);
  const i = found.list.indexOf(found.item);
  const j = i + dir;
  if (j < 0 || j >= found.list.length) return;
  [found.list[i], found.list[j]] = [found.list[j], found.list[i]];
  await saveCollection(coll);
  app.renderPane();
}

function setFolders(c, open) {
  (function walk(n) {
    for (const it of n.items || []) if (it.type === 'folder') (open ? S.expanded.add(it.id) : S.expanded.delete(it.id)), walk(it);
  })(c);
  app.persistUi();
  app.renderPane();
}

export function collectionMenu(c) {
  return [
    { label: 'Overview & variables', icon: 'layers', onClick: () => app.openCollection(c.id) },
    { label: 'New request', icon: 'plus', onClick: () => addRequest(c, c) },
    { label: 'New folder', icon: 'folder', onClick: () => addFolder(c, c) },
    { label: 'Run collection', icon: 'play', onClick: () => app.openRunner(c.id, null) },
    '-',
    { label: 'Collapse all folders', icon: 'chevron', onClick: () => setFolders(c, false) },
    { label: 'Expand all folders', icon: 'chevronDown', onClick: () => setFolders(c, true) },
    '-',
    { label: 'Rename', icon: 'edit', onClick: () => rename(c, c) },
    {
      label: 'Duplicate',
      icon: 'copy',
      onClick: async () => {
        const copy = clone(c);
        delete copy.source;
        copy.name = `${c.name} copy`;
        (copy.items || []).forEach(reassignIds);
        const saved = await api('POST', '/api/collections', copy);
        S.collections.push(saved);
        app.renderAll();
      },
    },
    { label: 'Export as Postman v2.1', icon: 'download', onClick: () => (location.href = `/api/collections/${c.id}/export`) },
    '-',
    {
      label: 'Delete collection',
      icon: 'trash',
      danger: true,
      onClick: async () => {
        if (!(await confirmModal('Delete collection', `Delete “${c.name}” and all ${countRequests(c)} requests in it? This cannot be undone.`))) return;
        await api('DELETE', `/api/collections/${c.id}`);
        S.collections = S.collections.filter((x) => x.id !== c.id);
        app.dropWorkspace(c.id);
        toast('Collection deleted');
      },
    },
  ];
}

function folderMenu(coll, f) {
  return [
    { label: 'Folder settings', icon: 'folder', onClick: () => app.openFolder(coll.id, f.id) },
    { label: 'New request', icon: 'plus', onClick: () => addRequest(coll, f) },
    { label: 'New folder', icon: 'folder', onClick: () => addFolder(coll, f) },
    { label: 'Run folder', icon: 'play', onClick: () => app.openRunner(coll.id, f.id) },
    '-',
    { label: 'Rename', icon: 'edit', onClick: () => rename(coll, f) },
    { label: 'Duplicate', icon: 'copy', onClick: () => duplicate(coll, f) },
    { label: 'Move up', onClick: () => move(coll, f, -1) },
    { label: 'Move down', onClick: () => move(coll, f, 1) },
    '-',
    { label: 'Delete', icon: 'trash', danger: true, onClick: () => removeNode(coll, f) },
  ];
}

function requestMenu(coll, r) {
  return [
    { label: 'Open', icon: 'external', onClick: () => app.openRequest(coll.id, r.id) },
    ...(S.tabs.some((t) => t.itemId === r.id) ? [{ label: 'Close', icon: 'x', hint: 'Ctrl W', onClick: () => app.closeTab(S.tabs.find((t) => t.itemId === r.id).id) }] : []),
    { label: 'Rename', icon: 'edit', onClick: () => rename(coll, r) },
    { label: 'Duplicate', icon: 'copy', onClick: () => duplicate(coll, r) },
    { label: 'Move up', onClick: () => move(coll, r, -1) },
    { label: 'Move down', onClick: () => move(coll, r, 1) },
    '-',
    { label: 'Delete', icon: 'trash', danger: true, onClick: () => removeNode(coll, r) },
  ];
}

// ---------- drafts & history ----------
function draftsPane() {
  const q = S.filter.trim().toLowerCase();
  const items = S.history.filter((x) => !q || `${x.method} ${x.url}`.toLowerCase().includes(q));
  const list = h('div', { class: 'tree' });
  let lastDay = '';
  for (const it of items) {
    const day = new Date(it.at).toDateString();
    if (day !== lastDay) {
      lastDay = day;
      list.append(h('div', { class: 'group-label' }, day === new Date().toDateString() ? 'Today' : day));
    }
    const coll = it.collectionId && getCollection(it.collectionId);
    list.append(
      h(
        'div',
        { class: 'trow hist', title: it.url, onClick: () => app.openHistory(it) },
        h('span', { class: `verb m-${it.method.toLowerCase()}` }, it.method === 'DELETE' ? 'DEL' : it.method),
        h('span', { class: 'tlabel' }, h('span', { class: 'hist-url' }, it.url.replace(/^https?:\/\//, '')), coll ? h('span', { class: 'hist-coll', style: { '--hue': hueOf(coll.id) } }, monogram(coll.name)) : null),
        h('span', { class: `code ${statusClass(it.status)}` }, it.status || 'ERR'),
      ),
    );
  }
  if (!S.history.length) list.append(h('div', { class: 'pane-empty' }, h('p', {}, 'Requests you send show up here.')));
  return h(
    'div',
    { class: 'pane-body' },
    paneHead({
      kicker: 'Workspace',
      title: 'Drafts & History',
      meta: h('div', { class: 'meta-line' }, h('span', {}, `${S.tabs.filter((t) => t.ws === 'drafts').length} open drafts`), h('span', {}, `${S.history.length} sent`)),
      actions: [
        h('button', { class: 'icon-btn', title: 'New draft request', onClick: () => app.newDraft() }, icon('plus', 16)),
        S.history.length
          ? h(
              'button',
              {
                class: 'icon-btn',
                title: 'Clear history',
                onClick: async () => {
                  if (!(await confirmModal('Clear history', 'Remove all history entries?', 'Clear'))) return;
                  await api('DELETE', '/api/history');
                  S.history = [];
                  app.renderPane();
                },
              },
              icon('trash', 15),
            )
          : null,
      ],
    }),
    openList(),
    S.history.length ? searchBox('Filter history') : null,
    list,
  );
}

// ---------- services ----------
function servicesPane() {
  const d = S.discover;
  const list = h('div', { class: 'tree' });
  if (!d || (d.scanning && !d.services.length)) {
    list.append(h('div', { class: 'pane-empty' }, h('div', { class: 'spinner' }), h('p', {}, 'Scanning your projects…')));
  } else {
    const running = d.services.filter((s) => s.status === 'running' || s.status === 'starting').length;
    list.append(h('div', { class: 'group-label' }, `Laravel apps · ${running} running`));
    for (const s of d.services) {
      const on = s.status === 'running' || s.status === 'starting';
      const tab = S.tabs.find((t) => t.kind === 'service' && t.refId === s.id);
      const parts = s.name.split('/');
      list.append(
        h(
          'div',
          { class: 'trow svc' + (tab && tab.id === S.activeTabId ? ' active' : ''), onClick: () => app.openService(s.id) },
          h('span', { class: `led ${s.status}`, title: s.status }),
          h('span', { class: 'tlabel' }, parts.length > 1 ? h('span', { class: 'svc-parent' }, parts.slice(0, -1).join('/') + '/') : null, parts.at(-1)),
          on ? h('span', { class: 'tcount mono' }, `:${s.port}`) : null,
          h(
            'button',
            { class: 'icon-btn row-act' + (on ? ' show' : ''), title: on ? 'Stop' : 'Start', onClick: (e) => (e.stopPropagation(), on ? app.stopService(s.id) : app.startService(s.id)) },
            icon(on ? 'stop' : 'play', 13),
          ),
        ),
      );
    }
    const files = [...d.collections.map((x) => ({ ...x, kind: 'collection' })), ...d.environments.map((x) => ({ ...x, kind: 'environment' }))];
    list.append(h('div', { class: 'group-label' }, `Postman files · ${files.filter((f) => !f.imported).length} not imported`));
    for (const f of files) {
      const parts = f.name.split('/');
      list.append(
        h(
          'div',
          { class: 'trow file', title: f.file },
          icon(f.kind === 'collection' ? 'layers' : 'globe', 13, 'ficon'),
          h('span', { class: 'tlabel' }, parts.at(-1).replace(/\.postman_(collection|environment)\.json$/i, '')),
          f.imported ? h('span', { class: 'tcount' }, 'imported') : h('button', { class: 'tbtn accent sm', onClick: () => app.importDiscovered(f.file) }, 'Import'),
        ),
      );
    }
  }
  return h(
    'div',
    { class: 'pane-body' },
    paneHead({
      kicker: 'Workspace',
      title: 'Services',
      meta: d && d.roots ? h('div', { class: 'meta-line' }, h('span', { class: 'mono' }, d.roots.join(', '))) : null,
      actions: [h('button', { class: 'icon-btn', title: 'Rescan projects', onClick: app.rescan }, icon('refresh', 15, d && d.scanning ? 'spin' : ''))],
    }),
    list,
  );
}
