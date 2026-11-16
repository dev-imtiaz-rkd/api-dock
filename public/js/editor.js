// Request tab: URL bar, Params / Auth / Headers / Body / Docs, and the response pane.
import { h, icon, api, toast, fmtBytes, fmtMs, statusClass, STATUS_TEXT, copyText, downloadBlob, selectEl, escapeHtml, showMenu, modal, debounce } from './util.js';
import {
  S, METHODS, getCollection, findItem, variableScope, effectiveAuth, buildOutgoing, codeSnippet,
  paramsFromUrl, urlWithParams, syncPathVars, VAR_RE, activeEnv,
} from './model.js';
import { kvTable, jsonTree, setTreeExpanded, highlightJson, highlightMarkup, findInView, clearFind } from './viewers.js';
import { app } from './bus.js';
import { attachVarHover, markVars, closeVarPopover } from './varpop.js';

// ---------- input with {{variable}} highlighting ----------
export function varInput({ value, placeholder, onInput, collectionId, cls = '', onEnter }) {
  const mirror = h('div', { class: 'var-mirror', 'aria-hidden': 'true' });
  const input = h('input', { class: 'var-text', value: value || '', placeholder: placeholder || '', spellcheck: false, autocomplete: 'off' });
  const paint = () => {
    const scope = variableScope(collectionId);
    mirror.innerHTML = markVars(escapeHtml(input.value), scope) + ' ';
    mirror.scrollLeft = input.scrollLeft;
    const vars = [...input.value.matchAll(VAR_RE)].map((m) => m[1]);
    // With a collection the hover popover shows (and edits) values instead of a tooltip.
    input.title = vars.length && !collectionId
      ? vars.map((n) => `${n} = ${scope.has(n) ? scope.get(n).value || '(empty)' : n.startsWith('$') ? '(dynamic)' : '⚠ not defined'}`).join('\n')
      : '';
  };
  attachVarHover(input, mirror, () => collectionId);
  input.addEventListener('input', () => {
    closeVarPopover();
    paint();
    onInput(input.value);
  });
  input.addEventListener('scroll', () => (mirror.scrollLeft = input.scrollLeft));
  input.addEventListener('keyup', () => (mirror.scrollLeft = input.scrollLeft));
  if (onEnter) input.addEventListener('keydown', (e) => e.key === 'Enter' && !e.ctrlKey && onEnter());
  paint();
  const wrap = h('div', { class: `var-input ${cls}` }, mirror, input);
  wrap.input = input;
  wrap.repaint = paint;
  wrap.repaintVars = paint;
  wrap.setValue = (v) => {
    input.value = v;
    paint();
  };
  return wrap;
}

// ---------- code editor (textarea + highlight layer) ----------
export function codeEditor({ value, lang, onInput, placeholder, readOnly, collectionId }) {
  const pre = h('pre', { class: 'code-hl', 'aria-hidden': 'true' });
  const ta = h('textarea', { class: 'code-ta', spellcheck: false, value: value || '', placeholder: placeholder || '', readOnly: !!readOnly });
  const gutter = h('div', { class: 'code-gutter', 'aria-hidden': 'true' });
  let language = lang;
  const paint = () => {
    const t = ta.value;
    const html = language === 'json' ? highlightJson(t) : language === 'xml' || language === 'html' ? highlightMarkup(t) : escapeHtml(t);
    pre.innerHTML = markVars(html, collectionId ? variableScope(collectionId) : null) + '\n';
    const lines = t.split('\n').length;
    if (gutter.childElementCount !== lines) gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
    sync();
  };
  const sync = () => {
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
    gutter.scrollTop = ta.scrollTop;
  };
  ta.addEventListener('input', () => {
    closeVarPopover();
    paint();
    onInput && onInput(ta.value);
  });
  if (collectionId) attachVarHover(ta, pre, () => collectionId);
  ta.addEventListener('scroll', sync);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !readOnly) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en } = ta;
      ta.setRangeText('  ', s, en, 'end');
      ta.dispatchEvent(new Event('input'));
    }
  });
  paint();
  const el = h('div', { class: 'code-editor' }, gutter, h('div', { class: 'code-area' }, pre, ta));
  el.setValue = (v) => {
    ta.value = v;
    paint();
  };
  el.setLang = (l) => {
    language = l;
    paint();
  };
  el.textarea = ta;
  el.repaintVars = paint;
  return el;
}

// ---------- request tab ----------
const AUTH_SHORT = { inherit: 'inherited', none: 'none', bearer: 'bearer', basic: 'basic', apikey: 'api key' };
const BODY_SHORT = { none: '', raw: null, urlencoded: 'form', formdata: 'multipart' };

export function renderRequestTab(tab, root) {
  const req = tab.draft;
  const coll = getCollection(tab.collectionId);
  const changed = () => {
    app.markDirty(tab);
    refreshState();
    updateResolved();
  };

  // head: path / name  ...  state, layout, Code, Save, more
  const found = coll && tab.itemId && findItem(coll, tab.itemId);
  const path = found ? found.parents.map((p) => p.name) : [];
  const nameInput = h('input', {
    class: 'req-name',
    value: req.name,
    spellcheck: false,
    onInput: (e) => {
      req.name = e.target.value;
      changed();
      app.renderTabs();
    },
  });
  const state = h('span', { class: 'req-state' });
  const refreshState = () => {
    const where = tab.itemId ? 'saved' : coll ? 'draft · not saved' : 'loose draft';
    state.textContent = tab.dirty && tab.itemId ? 'edited' : where;
    state.classList.toggle('edited', !!tab.dirty);
  };
  tab.refreshState = refreshState;
  refreshState();

  const layoutBtn = h(
    'button',
    {
      class: 'tbtn',
      title: 'Switch between side-by-side and stacked',
      onClick: () => {
        app.setLayoutMode(app.layoutMode() === 'side' ? 'stack' : 'side');
        renderRequestTab(tab, root);
      },
    },
    app.layoutMode() === 'side' ? 'Stack' : 'Side by side',
  );

  const head = h(
    'div',
    { class: 'req-head' },
    h('div', { class: 'req-title' }, path.length ? h('span', { class: 'req-path' }, path.join(' / '), ' /') : null, nameInput),
    h(
      'div',
      { class: 'req-actions' },
      state,
      layoutBtn,
      h('button', { class: 'tbtn', onClick: () => showCode(tab) }, 'Code'),
      h('button', { class: 'tbtn strong', title: 'Save (Ctrl S)', onClick: () => app.saveTab(tab) }, 'Save'),
      h(
        'button',
        {
          class: 'icon-btn',
          title: 'More',
          onClick: (e) =>
            showMenu(e, [
              { label: 'Save as…', icon: 'save', onClick: () => app.saveTab(tab, true) },
              { label: 'Duplicate as draft', icon: 'copy', onClick: () => app.openDraft({ ...JSON.parse(JSON.stringify(req)), name: req.name + ' copy' }, tab.collectionId) },
              { label: 'Copy as cURL', icon: 'terminal', onClick: () => copyText(codeSnippet('curl', buildOutgoing(req, tab.collectionId))) },
            ]),
        },
        icon('more', 16),
      ),
      h('button', { class: 'icon-btn', title: 'Close (Ctrl W)', onClick: () => app.closeTab(tab.id) }, icon('x', 15)),
    ),
  );

  // address line: METHOD  url  Send
  const methodBtn = h('button', { class: `method-btn m-${req.method.toLowerCase()}`, title: 'Change method' });
  const paintMethod = () => {
    methodBtn.className = `method-btn m-${req.method.toLowerCase()}`;
    methodBtn.replaceChildren(req.method, icon('chevronDown', 11));
  };
  paintMethod();
  methodBtn.addEventListener('click', (e) =>
    showMenu(
      e,
      METHODS.map((m) => ({
        label: m,
        onClick: () => {
          req.method = m;
          paintMethod();
          changed();
          app.renderTabs();
        },
      })),
    ),
  );

  const urlIn = varInput({
    value: req.url,
    placeholder: 'https://api.example.com/users  ·  or paste a cURL command',
    collectionId: tab.collectionId,
    cls: 'url-input',
    onEnter: () => app.send(tab),
    onInput: (v) => {
      req.url = v;
      req.params.splice(0, req.params.length, ...paramsFromUrl(v, req.params));
      const before = req.pathVars.map((p) => p.key).join();
      syncPathVars(req);
      changed();
      if (tab.sub === 'params') {
        if (before !== req.pathVars.map((p) => p.key).join()) renderSub();
        else if (paramsTable) paramsTable.refresh();
      }
      updateCounts();
    },
  });
  urlIn.input.addEventListener('paste', (e) => {
    const text = e.clipboardData.getData('text');
    if (/^\s*curl\s/i.test(text)) {
      e.preventDefault();
      importCurl(text, tab);
    }
  });

  const sendBtn = h('button', { class: 'send', onClick: () => (tab.sending ? app.cancel(tab) : app.send(tab)) });
  tab.refreshSendButton = () => {
    sendBtn.replaceChildren(...(tab.sending ? ['Cancel'] : ['Send', h('kbd', {}, 'Ctrl ↵')]));
    sendBtn.classList.toggle('busy', !!tab.sending);
  };
  tab.refreshSendButton();

  // What will actually be sent, after variables and path params are filled in.
  const resolved = h('div', { class: 'resolved' });
  function updateResolved() {
    const out = buildOutgoing(req, tab.collectionId);
    const { auth, from } = effectiveAuth(req, tab.collectionId);
    const env = activeEnv(tab.collectionId);
    const parts = [
      h('span', { class: 'arrow' }, '→'),
      h('span', { class: 'resolved-url', title: out.url }, out.url || '—'),
      out.missing.length ? h('span', { class: 'flag bad' }, `${out.missing.join(', ')} undefined`) : null,
      out.empty.length ? h('span', { class: 'flag bad' }, `${out.empty.join(', ')} empty`) : null,
      auth.type !== 'none' ? h('span', { class: 'flag' }, AUTH_SHORT[auth.type] + (from && from !== 'request' ? ` · from ${from.split(' ')[0]}` : '')) : null,
      coll ? h('span', { class: 'flag env', title: 'Variable set in use' }, env ? env.name : 'Default') : null,
    ];
    resolved.replaceChildren(...parts.filter(Boolean));
  }
  updateResolved();
  resolved.repaintVars = updateResolved;

  const address = h('div', { class: 'address' }, h('div', { class: 'address-line' }, methodBtn, urlIn, sendBtn), resolved);

  // sections
  const SUBS = [
    ['params', 'Params'],
    ['auth', 'Auth'],
    ['headers', 'Headers'],
    ['body', 'Body'],
    ['docs', 'Docs'],
  ];
  const subBar = h('div', { class: 'sections' });
  const subBody = h('div', { class: 'section-body' });
  let paramsTable = null;

  function info() {
    const n = (l) => (l || []).filter((x) => x.enabled !== false && x.key).length;
    const b = req.body;
    return {
      params: n(req.params) + n(req.pathVars) || '',
      headers: n(req.headers) || '',
      body: b.mode === 'raw' ? b.rawType || 'raw' : BODY_SHORT[b.mode] || '',
      auth: AUTH_SHORT[req.auth.type] || '',
      docs: req.description ? '✓' : '',
    };
  }
  function updateCounts() {
    const i = info();
    subBar.querySelectorAll('.sec').forEach((b) => (b.querySelector('small').textContent = i[b.dataset.key]));
  }
  function renderSubBar() {
    subBar.replaceChildren(
      ...SUBS.map(([key, label]) =>
        h('button', { class: 'sec' + (tab.sub === key ? ' active' : ''), 'data-key': key, onClick: () => ((tab.sub = key), renderSubBar(), renderSub()) }, label, h('small', {})),
      ),
    );
    updateCounts();
  }

  function renderSub() {
    paramsTable = null;
    subBody.replaceChildren();
    const after = () => (changed(), updateCounts());
    if (tab.sub === 'params') {
      paramsTable = kvTable(req.params, {
        descriptions: true,
        onChange: () => {
          req.url = urlWithParams(req.url, req.params);
          urlIn.setValue(req.url);
          after();
        },
      });
      subBody.append(h('div', { class: 'section-title' }, 'Query'), paramsTable);
      if (req.pathVars.length) subBody.append(h('div', { class: 'section-title' }, 'Path variables'), kvTable(req.pathVars, { readOnlyKeys: true, descriptions: true, onChange: after }));
      else subBody.append(h('p', { class: 'hint' }, 'Path variables: write ', h('code', {}, '/users/:id'), ' in the URL.'));
    } else if (tab.sub === 'headers') {
      subBody.append(h('div', { class: 'section-title' }, 'Headers'), kvTable(req.headers, { descriptions: true, onChange: after }), autoHeaders());
    } else if (tab.sub === 'auth') {
      subBody.append(authEditor(req, tab.collectionId, after, true));
    } else if (tab.sub === 'body') {
      subBody.append(bodyEditor(req, after, tab.collectionId));
    } else if (tab.sub === 'docs') {
      subBody.append(
        h('textarea', {
          class: 'textarea docs-area',
          placeholder: 'What does this request do? Expected inputs, example responses, gotchas…',
          value: req.description || '',
          onInput: (e) => ((req.description = e.target.value), after()),
        }),
      );
    }
  }

  function autoHeaders() {
    const out = buildOutgoing(req, tab.collectionId);
    const user = new Set(req.headers.filter((x) => x.enabled !== false).map((x) => x.key.toLowerCase()));
    const auto = out.headers.filter((x) => !user.has(x.key.toLowerCase()));
    if (!auto.length) return null;
    return h(
      'div',
      { class: 'auto-headers' },
      h('div', { class: 'section-title' }, 'Added automatically'),
      auto.map((x) => h('div', { class: 'auto-row' }, h('span', {}, x.key), h('span', { class: 'mono' }, x.key === 'Authorization' ? x.value.replace(/(\S{6})\S+/, '$1…') : x.value))),
    );
  }

  renderSubBar();
  renderSub();

  const reqPane = h('div', { class: 'req-pane' }, subBar, subBody);
  const resPane = h('div', { class: 'res-pane' });
  tab.resPaneEl = resPane;
  renderResponse(tab, resPane);

  const mode = app.layoutMode();
  const splitter = h('div', { class: 'split-handle', title: 'Drag to resize' });
  const split = h('div', { class: `work ${mode}` }, reqPane, splitter, resPane);
  reqPane.style.flexBasis = `${app.splitRatio() * 100}%`;
  splitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const rect = split.getBoundingClientRect();
    document.body.classList.add(mode === 'side' ? 'resizing-x' : 'resizing-y');
    let ratio = app.splitRatio();
    const move = (ev) => {
      ratio = mode === 'side' ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      ratio = Math.min(0.8, Math.max(0.2, ratio));
      reqPane.style.flexBasis = `${ratio * 100}%`;
    };
    const up = () => {
      document.body.classList.remove('resizing-x', 'resizing-y');
      app.setSplitRatio(ratio);
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  root.replaceChildren(h('div', { class: 'req-page' }, head, address, split));
  tab.focusUrl = () => urlIn.input.focus();
}

// ---------- auth ----------
export function authEditor(target, collectionId, onChange, allowInherit) {
  const wrap = h('div', { class: 'auth-editor' });
  const TYPES = [
    ...(allowInherit ? [{ value: 'inherit', label: 'Inherit auth from parent' }] : []),
    { value: 'none', label: 'No Auth' },
    { value: 'bearer', label: 'Bearer Token' },
    { value: 'basic', label: 'Basic Auth' },
    { value: 'apikey', label: 'API Key' },
  ];
  if (!target.auth) target.auth = { type: allowInherit ? 'inherit' : 'none' };

  const render = () => {
    const a = target.auth;
    const field = (label, obj, key, ph, type) =>
      h(
        'label',
        { class: 'field' },
        h('span', {}, label),
        type === 'password'
          ? passwordVar(obj[key] || '', (v) => ((obj[key] = v), onChange()), collectionId, ph)
          : varInput({ value: obj[key] || '', placeholder: ph, collectionId, cls: 'input-like', onInput: (v) => ((obj[key] = v), onChange()) }),
      );

    let fields = null;
    if (a.type === 'inherit') {
      const eff = effectiveAuth(target, collectionId);
      fields = h(
        'div',
        { class: 'info-box' },
        icon('lock', 16),
        eff.from
          ? h('span', {}, 'This request uses ', h('b', {}, labelFor(eff.auth.type)), ' from the ', eff.from, '.')
          : h('span', {}, 'No auth is set on any parent, so none will be sent.'),
      );
    } else if (a.type === 'bearer') {
      a.bearer = a.bearer || { token: '' };
      fields = field('Token', a.bearer, 'token', '{{access_token}}', 'password');
    } else if (a.type === 'basic') {
      a.basic = a.basic || { username: '', password: '' };
      fields = [field('Username', a.basic, 'username', 'username'), field('Password', a.basic, 'password', 'password', 'password')];
    } else if (a.type === 'apikey') {
      a.apikey = a.apikey || { key: 'X-API-Key', value: '', in: 'header' };
      fields = [
        field('Key', a.apikey, 'key', 'X-API-Key'),
        field('Value', a.apikey, 'value', 'secret', 'password'),
        h('label', { class: 'field' }, h('span', {}, 'Add to'), selectEl([{ value: 'header', label: 'Header' }, { value: 'query', label: 'Query Params' }], a.apikey.in || 'header', (v) => ((a.apikey.in = v), onChange()))),
      ];
    } else {
      fields = h('p', { class: 'hint' }, 'This request does not use any authorization.');
    }

    wrap.replaceChildren(
      h(
        'div',
        { class: 'auth-grid' },
        h(
          'div',
          { class: 'auth-type' },
          h('label', { class: 'field' }, h('span', {}, 'Auth Type'), selectEl(TYPES, a.type, (v) => ((target.auth = { ...target.auth, type: v }), onChange(), render()))),
          h('p', { class: 'hint' }, 'Use {{variables}} to keep secrets in an environment instead of in the request.'),
        ),
        h('div', { class: 'auth-fields' }, fields),
      ),
    );
  };
  render();
  return wrap;
}

function labelFor(t) {
  return { bearer: 'Bearer Token', basic: 'Basic Auth', apikey: 'API Key', none: 'No Auth' }[t] || t;
}

function passwordVar(value, onInput, collectionId, ph) {
  const v = varInput({ value, placeholder: ph, collectionId, cls: 'input-like secret', onInput });
  v.input.type = 'password';
  v.classList.add('masked');
  const btn = h(
    'button',
    {
      class: 'btn-icon reveal',
      type: 'button',
      title: 'Show / hide',
      onClick: () => {
        const show = v.input.type === 'password';
        v.input.type = show ? 'text' : 'password';
        v.classList.toggle('masked', !show);
        btn.replaceChildren(icon(show ? 'eyeOff' : 'eye', 15));
      },
    },
    icon('eye', 15),
  );
  return h('div', { class: 'with-reveal' }, v, btn);
}

// ---------- body ----------
function bodyEditor(req, onChange, collectionId) {
  const b = req.body;
  const wrap = h('div', { class: 'body-editor' });
  const MODES = [
    ['none', 'none'],
    ['formdata', 'form-data'],
    ['urlencoded', 'x-www-form-urlencoded'],
    ['raw', 'raw'],
  ];
  const content = h('div', { class: 'body-content' });
  const status = h('span', { class: 'json-status' });

  const checkJson = () => {
    if (b.mode !== 'raw' || b.rawType !== 'json' || !b.raw.trim()) return (status.textContent = '');
    try {
      JSON.parse(b.raw.replace(/\{\{[^}]+\}\}/g, '0'));
      status.textContent = 'Valid JSON';
      status.className = 'json-status ok';
    } catch (e) {
      status.textContent = e.message.replace(/^JSON\.parse: /, '');
      status.className = 'json-status bad';
    }
  };

  let editor;
  const renderContent = () => {
    editor = null;
    if (b.mode === 'none') {
      content.replaceChildren(h('div', { class: 'empty-small' }, 'This request does not have a body.'));
    } else if (b.mode === 'raw') {
      editor = codeEditor({
        value: b.raw,
        lang: b.rawType,
        collectionId,
        placeholder: b.rawType === 'json' ? '{\n  "name": "value"\n}' : '',
        onInput: (v) => {
          b.raw = v;
          checkJson();
          onChange();
        },
      });
      content.replaceChildren(editor);
    } else if (b.mode === 'urlencoded') {
      content.replaceChildren(kvTable(b.urlencoded, { descriptions: true, onChange }));
    } else if (b.mode === 'formdata') {
      content.replaceChildren(kvTable(b.formdata, { files: true, onChange }));
    }
    checkJson();
  };

  const rawControls = h('div', { class: 'raw-controls' });
  const renderRawControls = () => {
    rawControls.replaceChildren();
    if (b.mode !== 'raw') return;
    rawControls.append(
      selectEl(
        [
          { value: 'json', label: 'JSON' },
          { value: 'text', label: 'Text' },
          { value: 'xml', label: 'XML' },
          { value: 'html', label: 'HTML' },
          { value: 'javascript', label: 'JavaScript' },
        ],
        b.rawType || 'json',
        (v) => {
          b.rawType = v;
          editor && editor.setLang(v);
          checkJson();
          onChange();
        },
        'select sm',
      ),
      h(
        'button',
        {
          class: 'link-btn',
          onClick: () => {
            try {
              const placeholders = [];
              const safe = b.raw.replace(/\{\{[^}]+\}\}/g, (m) => {
                placeholders.push(m);
                return `"__VAR${placeholders.length - 1}__"`;
              });
              let pretty = JSON.stringify(JSON.parse(safe), null, 2);
              pretty = pretty.replace(/"__VAR(\d+)__"/g, (_, i) => placeholders[i]);
              b.raw = pretty;
              editor.setValue(pretty);
              onChange();
            } catch {
              toast('Body is not valid JSON', 'error');
            }
          },
        },
        'Beautify',
      ),
      status,
    );
  };

  const modeBar = h(
    'div',
    { class: 'body-modes' },
    MODES.map(([value, label]) =>
      h(
        'label',
        { class: 'radio' },
        h('input', {
          type: 'radio',
          name: `mode-${req.id}`,
          checked: b.mode === value,
          onChange: () => {
            b.mode = value;
            if (value === 'raw' && !b.rawType) b.rawType = 'json';
            renderRawControls();
            renderContent();
            onChange();
          },
        }),
        h('span', {}, label),
      ),
    ),
    rawControls,
  );
  renderRawControls();
  renderContent();
  wrap.append(modeBar, content);
  return wrap;
}

// ---------- response ----------
export function renderResponse(tab, pane) {
  if (!pane) return;
  const r = tab.response;
  if (tab.sending) {
    pane.replaceChildren(
      h('div', { class: 'res-wait' }, h('div', { class: 'pulse-line' }), h('p', {}, 'Waiting for response…'), h('button', { class: 'tbtn', onClick: () => app.cancel(tab) }, 'Cancel')),
    );
    return;
  }
  if (!r) {
    pane.replaceChildren(
      h(
        'div',
        { class: 'res-idle' },
        h('div', { class: 'res-idle-code' }, '···'),
        h('p', {}, 'No response yet'),
        h('p', { class: 'muted' }, h('kbd', {}, 'Ctrl'), ' ', h('kbd', {}, 'Enter'), ' sends  ·  ', h('kbd', {}, 'Ctrl'), ' ', h('kbd', {}, 'S'), ' saves'),
      ),
    );
    return;
  }
  if (!r.ok) {
    pane.replaceChildren(
      h('div', { class: 'res-head' }, h('div', { class: 'res-status st-err' }, h('span', { class: 'code' }, '—'), h('span', { class: 'text' }, 'No response')), h('div', { class: 'facts-row' }, h('span', {}, h('b', {}, fmtMs(r.ms)), ' elapsed'))),
      h('div', { class: 'res-error' }, h('p', { class: 'err-msg' }, r.error), h('p', { class: 'mono muted small' }, `${r.request.method} ${r.request.url}`)),
    );
    return;
  }

  const TABS = [
    ['body', 'Body'],
    ['headers', `Headers ${r.headers.length}`],
    ['request', 'Request'],
  ];
  tab.resTab = tab.resTab || 'body';
  const content = h('div', { class: 'res-content' });
  const tabsEl = h('div', { class: 'res-tabs' });
  const toolbar = h('div', { class: 'res-tools' });

  const renderTabs = () =>
    tabsEl.replaceChildren(
      ...TABS.map(([k, label]) => h('button', { class: 'rt' + (tab.resTab === k ? ' active' : ''), onClick: () => ((tab.resTab = k), renderTabs(), renderBody()) }, label)),
    );

  const isJson = /json/i.test(r.contentType) || (r.isText && /^\s*[{[]/.test(r.body));
  const isHtml = /html/i.test(r.contentType);
  const isXml = /xml/i.test(r.contentType);
  const isImage = /^image\//i.test(r.contentType);
  let parsed;
  if (isJson) {
    try {
      parsed = JSON.parse(r.body);
    } catch {
      parsed = undefined;
    }
  }
  tab.resView = tab.resView || (parsed !== undefined ? 'pretty' : isHtml ? 'preview' : 'raw');
  if (tab.wrap === undefined) tab.wrap = true;

  function renderBody() {
    toolbar.replaceChildren();
    content.replaceChildren();
    if (tab.resTab === 'headers') {
      content.append(
        h('div', { class: 'hdr-table' }, r.headers.map((x) => h('div', { class: 'hdr-row' }, h('span', { class: 'hdr-k' }, x.key), h('span', { class: 'hdr-v' }, x.value)))),
      );
      return;
    }
    if (tab.resTab === 'request') {
      content.append(
        h(
          'div',
          { class: 'sent-req' },
          h('div', { class: 'sent-line' }, h('span', { class: 'method m-' + r.request.method.toLowerCase() }, r.request.method), h('span', { class: 'mono break' }, r.request.url)),
          r.url && r.url !== r.request.url ? h('p', { class: 'hint' }, 'Redirected to ', h('span', { class: 'mono' }, r.url)) : null,
          h('div', { class: 'section-title' }, 'Request Headers'),
          h('div', { class: 'hdr-table' }, r.request.headers.map((x) => h('div', { class: 'hdr-row' }, h('span', { class: 'hdr-k' }, x.key), h('span', { class: 'hdr-v' }, x.value)))),
        ),
      );
      return;
    }

    // Body
    const views = [];
    if (parsed !== undefined) views.push(['pretty', 'Pretty']);
    views.push(['raw', 'Raw']);
    if (isHtml || isImage) views.push(['preview', 'Preview']);
    if (!views.some(([k]) => k === tab.resView)) tab.resView = views[0][0];

    toolbar.append(
      h('div', { class: 'seg' }, views.map(([k, label]) => h('button', { class: 'seg-btn' + (tab.resView === k ? ' active' : ''), onClick: () => ((tab.resView = k), renderBody()) }, label))),
      h('div', { class: 'spacer' }),
    );
    clearFind();

    if (!r.isText && !isImage) {
      content.append(h('div', { class: 'res-empty' }, icon('file', 30), h('p', {}, `Binary response (${r.contentType || 'unknown type'}, ${fmtBytes(r.size)})`), h('button', { class: 'btn sm', onClick: download }, icon('download', 14), 'Download')));
      return;
    }

    let tree = null;
    const searchable = tab.resView !== 'preview';
    if (searchable) toolbar.append(findBox());
    if (tab.resView === 'pretty' && parsed !== undefined) {
      tree = jsonTree(parsed);
      toolbar.append(
        h('button', { class: 'btn-icon', title: 'Expand all', onClick: () => setTreeExpanded(tree, true) }, icon('chevronDown', 15)),
        h('button', { class: 'btn-icon', title: 'Collapse all', onClick: () => setTreeExpanded(tree, false) }, icon('chevron', 15)),
      );
      content.append(h('div', { class: 'res-scroll' }, tree));
    } else if (tab.resView === 'preview') {
      if (isImage) content.append(h('div', { class: 'img-preview' }, h('img', { src: `data:${r.contentType};base64,${r.body}`, alt: 'Response image' })));
      else content.append(h('iframe', { class: 'html-preview', sandbox: '', srcdoc: r.body, title: 'HTML preview' }));
    } else {
      const text = parsed !== undefined ? JSON.stringify(parsed, null, 2) : r.body;
      const pre = h('pre', { class: 'raw-view' + (tab.wrap ? ' wrap' : '') });
      if (parsed !== undefined && text.length < 2_000_000) pre.innerHTML = highlightJson(text);
      else if ((isXml || isHtml) && text.length < 2_000_000) pre.innerHTML = highlightMarkup(text);
      else pre.textContent = text;
      toolbar.append(h('button', { class: 'btn-icon' + (tab.wrap ? ' on' : ''), title: 'Wrap lines', onClick: () => ((tab.wrap = !tab.wrap), renderBody()) }, icon('wrap', 15)));
      content.append(h('div', { class: 'res-scroll' }, pre));
    }
    toolbar.append(
      h('button', { class: 'btn-icon', title: 'Copy response', onClick: () => copyText(parsed !== undefined ? JSON.stringify(parsed, null, 2) : r.body) }, icon('copy', 15)),
      h('button', { class: 'btn-icon', title: 'Download response', onClick: download }, icon('download', 15)),
    );
    if (r.truncated) content.prepend(h('div', { class: 'warn-bar' }, 'Response is larger than 10 MB — showing the first 10 MB.'));
    // Re-apply a search that was typed before (switching Pretty/Raw, coming back to the request).
    if (searchable && tab.resFind) setTimeout(() => runFind(false), 0);
  }

  // ---- find in response ----
  let finder = null;
  let findInput = null;
  let findCount = null;
  function findBox() {
    findInput = h('input', {
      class: 'res-find-input',
      placeholder: 'Find',
      spellcheck: 'false',
      value: tab.resFind || '',
      onInput: debounce(() => {
        tab.resFind = findInput.value;
        tab.resFindIdx = 0;
        runFind(true);
      }, 120),
      onKeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          step(e.shiftKey ? -1 : 1);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          tab.resFind = '';
          findInput.value = '';
          runFind(false);
          findInput.blur();
        }
      },
    });
    findCount = h('span', { class: 'res-find-count' });
    return h(
      'label',
      { class: 'res-find', title: 'Find in response (Ctrl F) · Enter next · Shift Enter previous' },
      icon('search', 13),
      findInput,
      findCount,
      h('button', { class: 'btn-icon sm', title: 'Previous match (Shift Enter)', onClick: (e) => (e.preventDefault(), step(-1)) }, h('span', { class: 'rot-up' }, icon('chevronDown', 13))),
      h('button', { class: 'btn-icon sm', title: 'Next match (Enter)', onClick: (e) => (e.preventDefault(), step(1)) }, icon('chevronDown', 13)),
    );
  }

  function runFind(scroll) {
    const q = tab.resFind || '';
    const scroller = content.querySelector('.res-scroll');
    if (!scroller || !scroller.isConnected) return;
    const tree = scroller.querySelector('.json-tree');
    // Matches can sit inside collapsed objects: open everything while searching.
    if (q && tree) setTreeExpanded(tree, true);
    finder = findInView(scroller, q);
    if (tab.resFindIdx >= finder.count) tab.resFindIdx = 0;
    updateCount();
    if (finder.count) finder.show(tab.resFindIdx || 0, scroll);
  }

  function step(dir) {
    if (!finder || !finder.count) return runFind(true);
    tab.resFindIdx = ((tab.resFindIdx || 0) + dir + finder.count) % finder.count;
    finder.show(tab.resFindIdx);
    updateCount();
  }

  function updateCount() {
    if (!findCount) return;
    const q = tab.resFind || '';
    findCount.textContent = !q ? '' : finder.count ? `${(tab.resFindIdx || 0) + 1}/${finder.count}${finder.capped ? '+' : ''}` : 'No results';
    findCount.classList.toggle('none', !!q && !finder.count);
  }

  function download() {
    const ext = isJson ? 'json' : isHtml ? 'html' : isXml ? 'xml' : isImage ? r.contentType.split('/')[1] : r.isText ? 'txt' : 'bin';
    const data = r.isText ? r.body : Uint8Array.from(atob(r.body), (c) => c.charCodeAt(0));
    downloadBlob(new Blob([data], { type: r.contentType || 'application/octet-stream' }), `response.${ext}`);
  }

  const ctype = (r.contentType || '').split(';')[0] || 'no content-type';
  const speed = r.ms < 300 ? 'fast' : r.ms < 1000 ? 'ok' : 'slow';
  const bar = h(
    'div',
    { class: 'res-head' },
    h('div', { class: `res-status ${statusClass(r.status)}` }, h('span', { class: 'code' }, r.status), h('span', { class: 'text' }, r.statusText || STATUS_TEXT[r.status] || '')),
    h(
      'div',
      { class: 'facts-row' },
      h('span', { class: `t-${speed}`, title: 'Round-trip time' }, h('b', {}, fmtMs(r.ms))),
      h('span', { title: 'Body size' }, h('b', {}, fmtBytes(r.size))),
      h('span', { class: 'mono', title: 'Content-Type' }, ctype),
    ),
    tabsEl,
  );
  renderTabs();
  renderBody();
  pane.replaceChildren(bar, h('div', { class: 'res-toolbar-row' }, toolbar), content);
}

// ---------- code generation modal ----------
function showCode(tab) {
  const out = buildOutgoing(tab.draft, tab.collectionId);
  let lang = 'curl';
  const ed = codeEditor({ value: codeSnippet(lang, out), lang: 'text', readOnly: true });
  const langs = [
    ['curl', 'cURL'],
    ['fetch', 'JavaScript (fetch)'],
    ['python', 'Python (requests)'],
    ['php', 'PHP (cURL)'],
  ];
  const seg = h('div', { class: 'seg' });
  const renderSeg = () =>
    seg.replaceChildren(...langs.map(([k, l]) => h('button', { class: 'seg-btn' + (lang === k ? ' active' : ''), onClick: () => ((lang = k), ed.setValue(codeSnippet(lang, out)), renderSeg()) }, l)));
  renderSeg();
  modal({
    title: 'Code snippet',
    width: 760,
    body: h('div', { class: 'code-modal' }, seg, ed, out.missing.length ? h('p', { class: 'hint warn' }, `Undefined variables: ${out.missing.join(', ')}`) : null),
    actions: [{ label: 'Copy', kind: 'primary', closes: false, onClick: () => copyText(codeSnippet(lang, out)) }],
  });
}

// ---------- paste cURL into URL bar ----------
export function importCurl(text, tab) {
  const tokens = [];
  const re = /'((?:[^'\\]|\\.|'\\'')*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g;
  const src = text.replace(/\\\r?\n/g, ' ');
  let m;
  while ((m = re.exec(src))) tokens.push(m[1] ?? m[2] ?? m[3]);
  const req = tab.draft;
  req.headers = [];
  let method = null;
  let data = null;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-X' || t === '--request') method = tokens[++i];
    else if (t === '-H' || t === '--header') {
      const hv = tokens[++i];
      const j = hv.indexOf(':');
      req.headers.push({ key: hv.slice(0, j).trim(), value: hv.slice(j + 1).trim(), enabled: true });
    } else if (/^(-d|--data|--data-raw|--data-binary|--data-urlencode)$/.test(t)) data = (data ? data + '&' : '') + tokens[++i];
    else if (t === '-u' || t === '--user') {
      const [u, p = ''] = tokens[++i].split(':');
      req.auth = { type: 'basic', basic: { username: u, password: p } };
    } else if (!t.startsWith('-') && !req._urlSet) {
      req.url = t;
      req._urlSet = true;
    }
  }
  delete req._urlSet;
  if (data != null) {
    const isJson = /^\s*[{[]/.test(data);
    req.body = { ...req.body, mode: 'raw', rawType: isJson ? 'json' : 'text', raw: data };
  }
  req.method = (method || (data != null ? 'POST' : 'GET')).toUpperCase();
  req.params = paramsFromUrl(req.url, []);
  syncPathVars(req);
  app.markDirty(tab);
  app.renderActive();
  toast('Imported cURL command');
}
