// Non-request tabs: collection & folder settings, environment editor,
// collection runner and service details.
import { h, icon, api, toast, methodBadge, fmtMs, statusClass, STATUS_TEXT, selectEl } from './util.js';
import { S, getCollection, findItem, countRequests, flattenRequests, saveCollection, buildOutgoing, normalizeRequest, clone, findEnv } from './model.js';
import { kvTable } from './viewers.js';
import { authEditor, renderResponse } from './editor.js';
import { app } from './bus.js';
import { newEnvironment, importVarSet, deleteEnv } from './sidebar.js';

function pageHead(iconName, title, sub, ...actions) {
  return h(
    'div',
    { class: 'page-head' },
    h('div', { class: 'page-title' }, h('div', { class: 'page-icon' }, icon(iconName, 20)), h('div', {}, h('h1', {}, title), sub ? h('p', { class: 'muted' }, sub) : null)),
    h('div', { class: 'page-actions' }, actions, h('button', { class: 'icon-btn', title: 'Close (Ctrl W)', onClick: () => app.closeTab(S.activeTabId) }, icon('x', 15))),
  );
}

function subtabs(tab, list, onSwitch) {
  return h(
    'div',
    { class: 'subtabs page-subtabs' },
    list.map(([k, label]) => h('button', { class: 'subtab' + (tab.sub === k ? ' active' : ''), onClick: () => ((tab.sub = k), onSwitch()) }, label)),
  );
}

// ---------- collection / folder ----------
export function renderCollectionTab(tab, root) {
  const coll = getCollection(tab.collectionId);
  if (!coll) return root.replaceChildren(h('div', { class: 'res-empty' }, 'This collection no longer exists.'));
  const isFolder = tab.kind === 'folder';
  const target = isFolder ? findItem(coll, tab.refId)?.item : coll;
  if (!target) return root.replaceChildren(h('div', { class: 'res-empty' }, 'This folder no longer exists.'));
  if (!tab.draft) tab.draft = clone({ name: target.name, description: target.description || '', variables: target.variables || [], auth: target.auth || { type: isFolder ? 'inherit' : 'none' } });
  const d = tab.draft;
  tab.sub = tab.sub || 'overview';
  const changed = () => app.markDirty(tab);

  const save = async () => {
    target.name = d.name;
    target.description = d.description;
    target.auth = d.auth;
    if (!isFolder) target.variables = d.variables.filter((v) => v.key);
    await saveCollection(coll);
    tab.dirty = false;
    app.renderTabs();
    app.renderSidebar();
    toast('Saved');
  };
  tab.save = save;

  const body = h('div', { class: 'page-body' });
  const render = () => {
    body.replaceChildren();
    if (tab.sub === 'overview') {
      const n = countRequests(target);
      const reqs = flattenRequests(target);
      const byMethod = {};
      for (const r of reqs) byMethod[r.item.method] = (byMethod[r.item.method] || 0) + 1;
      body.append(
        h('label', { class: 'field' }, h('span', {}, 'Name'), h('input', { class: 'input', value: d.name, onInput: (e) => ((d.name = e.target.value), changed()) })),
        h('label', { class: 'field' }, h('span', {}, 'Description'), h('textarea', { class: 'textarea', rows: 6, placeholder: 'What is this API for? How do you authenticate?', value: d.description, onInput: (e) => ((d.description = e.target.value), changed()) })),
        h(
          'div',
          { class: 'stats' },
          h('div', { class: 'stat' }, h('div', { class: 'stat-n' }, n), h('div', { class: 'stat-l' }, 'Requests')),
          ...Object.entries(byMethod).map(([m, c]) => h('div', { class: 'stat' }, h('div', { class: 'stat-n' }, c), h('div', { class: 'stat-l' }, methodBadge(m)))),
        ),
        coll.source ? h('p', { class: 'hint' }, 'Imported from ', h('span', { class: 'mono' }, coll.source)) : null,
      );
    } else if (tab.sub === 'auth') {
      body.append(
        h('p', { class: 'hint' }, isFolder ? 'Requests in this folder that use “Inherit auth” will use this.' : 'Every request set to “Inherit auth from parent” uses this authorization.'),
        authEditor(d, coll.id, changed, isFolder),
      );
    } else if (tab.sub === 'variables') {
      body.append(
        setBar(coll, null),
        h(
          'div',
          { class: 'vars-bar' },
          h('p', { class: 'hint' }, coll.activeEnvironmentId ? 'Default set — the variables that came with the collection. Not in use right now.' : 'Default set — the variables that came with the collection. In use now.'),
          h(
            'div',
            { class: 'vars-actions' },
            h('button', { class: 'btn sm', onClick: async () => (tab.dirty && (await save()), newEnvironment(coll, 'collection')) }, icon('copy', 14), 'Copy as new set'),
            coll.activeEnvironmentId ? h('button', { class: 'btn sm primary', onClick: () => app.setActiveEnv(coll.id, null).then(() => renderCollectionTab(tab, root)) }, 'Use Default') : null,
          ),
        ),
        kvTable(d.variables, { keyPh: 'Variable', valuePh: 'Value', descriptions: true, onChange: changed }),
      );
    }
  };

  const tabsList = isFolder
    ? [
        ['overview', 'Overview'],
        ['auth', 'Authorization'],
      ]
    : [
        ['overview', 'Overview'],
        ['auth', 'Authorization'],
        ['variables', 'Variables (Default set)'],
      ];
  const st = subtabs(tab, tabsList, () => renderCollectionTab(tab, root));
  render();
  root.replaceChildren(
    h(
      'div',
      { class: 'page' },
      pageHead(
        isFolder ? 'folder' : 'layers',
        target.name,
        isFolder ? `Folder in ${coll.name}` : `${countRequests(coll)} requests`,
        h('button', { class: 'btn sm', onClick: () => app.openRunner(coll.id, isFolder ? target.id : null) }, icon('play', 14), 'Run'),
        h('button', { class: 'btn primary sm', onClick: save }, icon('save', 14), 'Save'),
      ),
      st,
      body,
    ),
  );
}


// Row of every variable set in the collection: shows which one you are looking
// at and which one is in use, and opens any of them with one click.
function setBar(coll, currentId) {
  const sets = [{ id: null, name: 'Default', variables: coll.variables }, ...(coll.environments || [])];
  const inUse = coll.activeEnvironmentId || null;
  const count = (vars) => (vars || []).filter((v) => v.key && v.enabled !== false).length;
  return h(
    'div',
    { class: 'set-bar' },
    h('span', { class: 'set-bar-label' }, 'Variable sets'),
    sets.map((s) =>
      h(
        'button',
        {
          class: 'set-chip' + (s.id === currentId ? ' current' : '') + (s.id === inUse ? ' in-use' : ''),
          title: s.id === inUse ? 'In use' : 'Open this set',
          onClick: () => (s.id ? app.openEnvironment(coll.id, s.id) : app.openCollection(coll.id, 'variables')),
        },
        s.id === inUse ? h('i', { class: 'use-dot' }) : null,
        s.name,
        h('small', {}, count(s.variables)),
      ),
    ),
    h('button', { class: 'set-chip add', onClick: () => importVarSet(coll) }, '+ Import set'),
  );
}

// ---------- environment ----------
export function renderEnvironmentTab(tab, root) {
  const coll = getCollection(tab.collectionId);
  const env = findEnv(tab.collectionId, tab.refId);
  if (!coll || !env) return root.replaceChildren(h('div', { class: 'res-empty' }, 'This environment no longer exists.'));
  if (!tab.draft) tab.draft = clone({ name: env.name, variables: env.variables || [] });
  const d = tab.draft;
  const changed = () => app.markDirty(tab);
  const isActive = coll.activeEnvironmentId === env.id;
  const others = (coll.environments || []).filter((e) => e.id !== env.id);

  tab.save = async () => {
    env.name = d.name.trim() || env.name;
    env.variables = d.variables.filter((v) => v.key);
    await saveCollection(coll);
    tab.dirty = false;
    app.renderTabs();
    renderEnvironmentTab(tab, root);
    toast('Variable set saved');
  };

  root.replaceChildren(
    h(
      'div',
      { class: 'page' },
      pageHead(
        'globe',
        env.name,
        `Variable set of ${coll.name} · ${isActive ? 'in use' : 'not in use'}`,
        h('button', { class: 'btn sm danger-ghost', title: 'Delete this variable set', onClick: () => deleteEnv(coll, env) }, icon('trash', 14), 'Delete set'),
        h('button', { class: 'btn sm', onClick: () => app.setActiveEnv(coll.id, isActive ? null : env.id).then(() => renderEnvironmentTab(tab, root)) }, isActive ? 'Use Default instead' : 'Use this set'),
        h('button', { class: 'btn primary sm', onClick: tab.save }, icon('save', 14), 'Save'),
      ),
      h(
        'div',
        { class: 'page-body' },
        setBar(coll, env.id),
        h('label', { class: 'field' }, h('span', {}, 'Name'), h('input', { class: 'input', value: d.name, onInput: (e) => ((d.name = e.target.value), changed()) })),
        h('div', { class: 'section-title' }, 'Variables'),
        kvTable(d.variables, { keyPh: 'Variable', valuePh: 'Value', descriptions: true, onChange: changed }),
        h(
          'p',
          { class: 'hint' },
          'While this set is selected, only these values are used for ',
          h('code', {}, '{{name}}'),
          ' in this collection — the Default set and other sets are ignored. A response field whose name contains “token” updates the matching variable here.',
        ),
      ),
    ),
  );
}

// ---------- runner ----------
export function renderRunnerTab(tab, root) {
  const coll = getCollection(tab.collectionId);
  if (!coll) return root.replaceChildren(h('div', { class: 'res-empty' }, 'This collection no longer exists.'));
  const scopeNode = tab.refId ? findItem(coll, tab.refId)?.item : coll;
  const all = flattenRequests(scopeNode || coll);
  tab.opts = tab.opts || { onlyGet: true, delay: 0, stopOnError: false };
  tab.results = tab.results || [];

  const selected = tab.selected || (tab.selected = new Set(all.filter((r) => !tab.opts.onlyGet || r.item.method === 'GET').map((r) => r.item.id)));

  const summary = () => {
    const done = tab.results.filter((r) => r.res);
    const pass = done.filter((r) => r.res.ok && r.res.status < 400).length;
    const warn = done.filter((r) => r.res.ok && r.res.status >= 400 && r.res.status < 500).length;
    const fail = done.filter((r) => !r.res.ok || r.res.status >= 500).length;
    const total = done.reduce((s, r) => s + (r.res.ms || 0), 0);
    return { done: done.length, pass, warn, fail, total };
  };

  const run = async () => {
    const queue = all.filter((r) => selected.has(r.item.id));
    if (!queue.length) return toast('Select at least one request', 'error');
    tab.running = true;
    tab.stop = false;
    tab.results = queue.map((r) => ({ item: r.item, folder: r.folder, res: null }));
    render();
    for (const row of tab.results) {
      if (tab.stop) break;
      row.running = true;
      render();
      const req = normalizeRequest(clone(row.item));
      const out = buildOutgoing(req, coll.id);
      row.res = await api('POST', '/api/send', { ...out, requestId: req.id, collectionId: coll.id }).catch((e) => ({ ok: false, error: e.message, request: out }));
      row.running = false;
      app.captureTokens(row.res, coll.id);
      render();
      if (tab.opts.stopOnError && (!row.res.ok || row.res.status >= 500)) break;
      if (tab.opts.delay) await new Promise((r) => setTimeout(r, tab.opts.delay));
    }
    tab.running = false;
    render();
    app.loadHistory();
  };

  const body = h('div', { class: 'runner' });
  function render() {
    const s = summary();
    const left = h(
      'div',
      { class: 'runner-config' },
      h('div', { class: 'section-title' }, `Requests (${selected.size}/${all.length})`),
      h(
        'div',
        { class: 'runner-tools' },
        h('button', { class: 'link-btn', onClick: () => (all.forEach((r) => selected.add(r.item.id)), render()) }, 'Select all'),
        h('button', { class: 'link-btn', onClick: () => (selected.clear(), render()) }, 'None'),
        h('button', { class: 'link-btn', onClick: () => (selected.clear(), all.filter((r) => r.item.method === 'GET').forEach((r) => selected.add(r.item.id)), render()) }, 'GET only'),
      ),
      h(
        'div',
        { class: 'runner-list' },
        all.map((r) =>
          h(
            'label',
            { class: 'runner-pick' },
            h('input', { type: 'checkbox', checked: selected.has(r.item.id), onChange: (e) => (e.target.checked ? selected.add(r.item.id) : selected.delete(r.item.id), render()) }),
            methodBadge(r.item.method),
            h('span', { class: 'tree-label' }, r.item.name),
            r.folder ? h('span', { class: 'muted small' }, r.folder) : null,
          ),
        ),
      ),
      h('div', { class: 'runner-opts' },
        h('label', { class: 'field inline' }, h('span', {}, 'Delay (ms)'), h('input', { class: 'input sm', type: 'number', min: 0, value: tab.opts.delay, onInput: (e) => (tab.opts.delay = Number(e.target.value) || 0) })),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: tab.opts.stopOnError, onChange: (e) => (tab.opts.stopOnError = e.target.checked) }), 'Stop on first failure'),
      ),
      h('p', { class: 'hint' }, 'Non-GET requests change data on the server. Only tick them when you mean to.'),
    );

    const results = h('div', { class: 'runner-results' });
    if (tab.results.length) {
      results.append(
        h(
          'div',
          { class: 'run-summary' },
          h('div', { class: 'stat' }, h('div', { class: 'stat-n' }, `${s.done}/${tab.results.length}`), h('div', { class: 'stat-l' }, 'Completed')),
          h('div', { class: 'stat ok' }, h('div', { class: 'stat-n' }, s.pass), h('div', { class: 'stat-l' }, 'Passed (2xx/3xx)')),
          h('div', { class: 'stat warn' }, h('div', { class: 'stat-n' }, s.warn), h('div', { class: 'stat-l' }, 'Client errors (4xx)')),
          h('div', { class: 'stat err' }, h('div', { class: 'stat-n' }, s.fail), h('div', { class: 'stat-l' }, 'Failed (5xx / no response)')),
          h('div', { class: 'stat' }, h('div', { class: 'stat-n' }, fmtMs(s.total)), h('div', { class: 'stat-l' }, 'Total time')),
        ),
      );
      for (const row of tab.results) {
        const r = row.res;
        results.append(
          h(
            'div',
            { class: 'run-row' + (tab.inspect === row ? ' selected' : ''), onClick: () => r && ((tab.inspect = row), render()) },
            methodBadge(row.item.method),
            h('div', { class: 'svc-main' }, h('div', { class: 'tree-label' }, row.item.name), h('div', { class: 'svc-sub mono' }, r ? r.request.url : row.folder)),
            row.running ? h('div', { class: 'spinner sm' }) : r ? h('span', { class: `pill ${statusClass(r.status)}` }, r.ok ? `${r.status} ${r.statusText || STATUS_TEXT[r.status] || ''}` : 'Error') : h('span', { class: 'muted small' }, 'queued'),
            r ? h('span', { class: 'meta' }, fmtMs(r.ms)) : null,
          ),
        );
      }
    } else {
      results.append(h('div', { class: 'res-empty' }, h('div', { class: 'res-empty-art' }, icon('play', 30)), h('p', { class: 'res-empty-title' }, 'Pick requests and press Run'), h('p', { class: 'muted' }, 'Each request runs in order with the active environment.')));
    }

    let inspector = null;
    if (tab.inspect && tab.inspect.res) {
      inspector = h('div', { class: 'run-inspect' });
      const fake = { response: tab.inspect.res, resTab: tab.inspectTab, resView: undefined };
      renderResponse(fake, inspector);
    }

    body.replaceChildren(left, h('div', { class: 'runner-right' }, results, inspector));
  }

  render();
  root.replaceChildren(
    h(
      'div',
      { class: 'page wide' },
      pageHead(
        'play',
        `Run ${scopeNode && scopeNode !== coll ? scopeNode.name : coll.name}`,
        scopeNode && scopeNode !== coll ? `Folder in ${coll.name}` : 'Collection runner',
        h('button', { class: 'btn sm', onClick: () => ((tab.stop = true), toast('Stopping after the current request')) }, icon('stop', 14), 'Stop'),
        h('button', { class: 'btn primary sm', onClick: () => !tab.running && run() }, icon('play', 14), 'Run'),
      ),
      body,
    ),
  );
}

// ---------- service ----------
export function renderServiceTab(tab, root) {
  const svc = S.discover?.services.find((s) => s.id === tab.refId);
  if (!svc) return root.replaceChildren(h('div', { class: 'res-empty' }, 'Service not found. Try rescanning.'));
  const running = svc.status === 'running' || svc.status === 'starting';
  const coll = S.collections.find((c) => c.source === svc.dir);
  const logs = h('pre', { class: 'logs mono' }, 'Loading logs…');

  const loadLogs = async () => {
    try {
      const lines = await api('GET', `/api/services/${svc.id}/logs`);
      const atBottom = logs.scrollTop + logs.clientHeight >= logs.scrollHeight - 20;
      logs.textContent = lines.length ? lines.join('\n') : 'No output yet. Start the service to see its logs.';
      if (atBottom) logs.scrollTop = logs.scrollHeight;
    } catch {}
  };
  loadLogs();
  clearInterval(tab.timer);
  tab.timer = setInterval(() => (S.activeTabId === tab.id ? loadLogs() : null), 1500);

  root.replaceChildren(
    h(
      'div',
      { class: 'page' },
      pageHead(
        'server',
        svc.name,
        svc.dir,
        running
          ? h('button', { class: 'btn sm', onClick: () => app.stopService(svc.id) }, icon('stop', 14), 'Stop')
          : h('button', { class: 'btn primary sm', onClick: () => app.startService(svc.id) }, icon('play', 14), 'Start'),
      ),
      h(
        'div',
        { class: 'page-body' },
        h(
          'div',
          { class: 'svc-cards' },
          h('div', { class: 'card' }, h('div', { class: 'card-l' }, 'Status'), h('div', { class: 'card-v' }, h('span', { class: `svc-dot ${svc.status}` }), ' ', svc.status), svc.error ? h('div', { class: 'small muted' }, svc.error) : null),
          h('div', { class: 'card' }, h('div', { class: 'card-l' }, 'Base URL'), h('div', { class: 'card-v mono' }, svc.baseUrl || 'assigned on first start')),
          h(
            'div',
            { class: 'card' },
            h('div', { class: 'card-l' }, 'Collection'),
            coll
              ? h('button', { class: 'btn sm', onClick: () => app.openCollection(coll.id) }, icon('layers', 14), coll.name)
              : h(
                  'button',
                  {
                    class: 'btn sm primary',
                    onClick: async (e) => {
                      e.currentTarget.disabled = true;
                      e.currentTarget.textContent = 'Reading routes…';
                      try {
                        const c = await api('POST', `/api/services/${svc.id}/collection`);
                        S.collections.push(c);
                        S.expanded.add(c.id);
                        await app.refreshDiscover();
                        toast(`Created “${c.name}” with ${countRequests(c)} requests`);
                        app.renderSidebar();
                        app.openCollection(c.id);
                      } catch (err) {
                        toast(err.message, 'error');
                        renderServiceTab(tab, root);
                      }
                    },
                  },
                  icon('plus', 14),
                  'Create from routes',
                ),
          ),
        ),
        h('div', { class: 'section-title' }, 'Server output'),
        logs,
        h('p', { class: 'hint' }, 'ApiDock runs ', h('code', {}, `php artisan serve --port=${svc.port || '…'}`), ' in this folder. Servers stop when ApiDock exits.'),
      ),
    ),
  );
}
