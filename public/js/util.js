// DOM helpers, icons, API client, toasts, modals and menus.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'value') value = v;
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  // Set after children so <select> options exist and <textarea> gets real content.
  if (value !== undefined) el.value = value;
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const clear = (el) => {
  el.replaceChildren();
  return el;
};

// ---------- icons (24px stroke icons) ----------
const P = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderOpen: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1H7.5a2 2 0 0 0-1.9 1.4L3 19z"/><path d="M3 19l2.6-7.6A2 2 0 0 1 7.5 10H22l-2.7 7.7a2 2 0 0 1-1.9 1.3H3z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  import: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>',
  upload: '<path d="M12 21V9M7 14l5-5 5 5"/><path d="M5 3h14"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  save: '<path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v6h8V3M7 21v-7h10v7"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m14 6 4 4"/>',
  code: '<path d="m8 8-5 4 5 4M16 8l5 4-5 4M14 4l-4 16"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3 3.9M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.8-4L3 9"/><path d="M3 4v5h5"/><path d="M4 13a8 8 0 0 0 14.8 4L21 15"/><path d="M21 20v-5h-5"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
  send: '<path d="M4 12 20 4l-6 16-3-7z"/><path d="m11 13 9-9"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  wrap: '<path d="M3 6h18M3 12h15a3 3 0 0 1 0 6h-4"/><path d="m16 16-2 2 2 2M3 18h7"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.4 3.3-5.5 6.5-5.5s5.9 2.1 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.8c1.6.8 2.7 2.6 3 5.2"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5M5 12h11"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
};

export function icon(name, size = 16, cls = '') {
  const span = document.createElement('span');
  span.className = `icon ${cls}`;
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;
  return span;
}

// ---------- API ----------
export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).catch(() => {
    // The page's own local server is gone (app closed, or this is a stale tab).
    const err = new Error('ApiDock’s local server isn’t running. Reopen the ApiDock app (or restart `npm start`) and reload this page.');
    err.status = 0;
    throw err;
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ---------- formatting ----------
export function fmtBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function fmtMs(ms) {
  if (ms == null) return '';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function timeAgo(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function statusClass(status) {
  if (!status) return 'st-err';
  if (status < 300) return 'st-ok';
  if (status < 400) return 'st-redirect';
  if (status < 500) return 'st-warn';
  return 'st-err';
}

export const STATUS_TEXT = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found',
  304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 409: 'Conflict', 419: 'Page Expired', 422: 'Unprocessable Content',
  429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

export function methodBadge(method, cls = '') {
  return h('span', { class: `method m-${String(method).toLowerCase()} ${cls}` }, method === 'DELETE' ? 'DEL' : method === 'OPTIONS' ? 'OPT' : method);
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    toast('Copy failed', 'error');
  }
}

export function downloadBlob(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 500);
}

// ---------- toasts ----------
export function toast(message, kind = 'info') {
  let host = document.getElementById('toasts');
  if (!host) host = document.body.appendChild(h('div', { id: 'toasts' }));
  const el = h('div', { class: `toast toast-${kind}` }, icon(kind === 'error' ? 'alert' : 'check', 15), h('span', {}, message));
  host.append(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3600);
}

// ---------- modal ----------
export function modal({ title, body, actions = [], width = 520, onClose }) {
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    onClose && onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  const overlay = h(
    'div',
    { class: 'overlay', onMousedown: (e) => e.target === overlay && close() },
    h(
      'div',
      { class: 'modal', style: { width: `min(${width}px, calc(100vw - 32px))` }, role: 'dialog' },
      h('div', { class: 'modal-head' }, h('h3', {}, title), h('button', { class: 'btn-icon', title: 'Close', onClick: close }, icon('x'))),
      h('div', { class: 'modal-body' }, body),
      actions.length
        ? h(
            'div',
            { class: 'modal-foot' },
            actions.map((a) =>
              h('button', { class: `btn ${a.kind || ''}`, onClick: async () => (await a.onClick?.(close)) !== false && a.closes !== false && close() }, a.label),
            ),
          )
        : null,
    ),
  );
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  const first = overlay.querySelector('input, textarea, select');
  if (first) setTimeout(() => first.focus(), 30);
  return { close, el: overlay };
}

export function confirmModal(title, message, confirmLabel = 'Delete', kind = 'danger') {
  return new Promise((resolve) => {
    let answered = false;
    modal({
      title,
      body: h('p', { class: 'muted' }, message),
      width: 420,
      actions: [
        { label: 'Cancel', onClick: () => ((answered = true), resolve(false)) },
        { label: confirmLabel, kind, onClick: () => ((answered = true), resolve(true)) },
      ],
      onClose: () => !answered && resolve(false),
    });
  });
}

export function promptModal(title, label, value = '', confirmLabel = 'Save') {
  return new Promise((resolve) => {
    let answered = false;
    const input = h('input', { class: 'input', value });
    const submit = (close) => {
      answered = true;
      resolve(input.value.trim() || null);
      close();
    };
    const m = modal({
      title,
      width: 420,
      body: h('label', { class: 'field' }, h('span', {}, label), input),
      actions: [
        { label: 'Cancel', onClick: () => ((answered = true), resolve(null)) },
        { label: confirmLabel, kind: 'primary', closes: false, onClick: (close) => submit(close) },
      ],
      onClose: () => !answered && resolve(null),
    });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && submit(m.close));
    setTimeout(() => input.select(), 40);
  });
}

// ---------- dropdown menu ----------
let openMenu = null;
export function closeMenu() {
  if (openMenu) openMenu.remove();
  openMenu = null;
}
document.addEventListener('mousedown', (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());

export function showMenu(anchorOrEvent, items) {
  closeMenu();
  const menu = h(
    'div',
    { class: 'menu' },
    items.filter(Boolean).map((it) =>
      it === '-'
        ? h('div', { class: 'menu-sep' })
        : h(
            'button',
            {
              class: `menu-item ${it.danger ? 'danger' : ''}`,
              onClick: () => {
                closeMenu();
                it.onClick();
              },
            },
            it.icon ? icon(it.icon, 15) : h('span', { class: 'icon' }),
            h('span', {}, it.label),
            it.hint ? h('kbd', {}, it.hint) : null,
          ),
    ),
  );
  document.body.append(menu);
  let x, y;
  if (anchorOrEvent instanceof MouseEvent && anchorOrEvent.type === 'contextmenu') {
    x = anchorOrEvent.clientX;
    y = anchorOrEvent.clientY;
  } else {
    const r = (anchorOrEvent.currentTarget || anchorOrEvent).getBoundingClientRect();
    x = r.left;
    y = r.bottom + 4;
  }
  const mr = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - mr.width - 8))}px`;
  menu.style.top = `${y + mr.height > innerHeight - 8 ? Math.max(8, y - mr.height - 8) : y}px`;
  openMenu = menu;
}

export function selectEl(options, value, onChange, cls = 'select') {
  const s = h(
    'select',
    { class: cls, onChange: (e) => onChange(e.target.value) },
    options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o)).map((o) => h('option', { value: o.value }, o.label)),
  );
  s.value = value;
  return s;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
