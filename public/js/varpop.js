// Hover a {{variable}} in an input or the body editor to see and edit its value.
// Enter saves it to the variable set in use (the active environment, or Default).
import { h, toast } from './util.js';
import { getCollection, activeEnv, saveCollection, isViewOnly } from './model.js';

let pop = null; // { el, anchor, name, collectionId }
let hideTimer = 0;

const VAR_SPAN = '.var-ok, .var-missing';

function setFor(collectionId) {
  const coll = getCollection(collectionId);
  if (!coll) return null;
  const env = activeEnv(collectionId);
  return { coll, env, name: env ? env.name : 'Default', vars: env ? (env.variables ||= []) : (coll.variables ||= []) };
}

// Re-highlight every visible editor and the resolved URL line after a change.
function repaintAll() {
  for (const el of document.querySelectorAll('.var-input, .code-editor, .resolved')) el.repaintVars && el.repaintVars();
}

export function closeVarPopover() {
  clearTimeout(hideTimer);
  if (pop) pop.el.remove();
  pop = null;
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!pop) return;
    if (pop.el.matches(':hover') || pop.el.contains(document.activeElement)) return;
    closeVarPopover();
  }, 220);
}

function open(span, name, collectionId) {
  if (pop && pop.anchor === span && pop.name === name) return;
  closeVarPopover();
  if (name.startsWith('$')) return openInfo(span, name, 'Dynamic — generated on every send');
  const set = setFor(collectionId);
  if (!set) return;
  const existing = set.vars.find((v) => v.key === name);
  const readOnly = isViewOnly(set.coll);
  const input = h('input', {
    class: 'varpop-input',
    value: existing ? existing.value || '' : '',
    placeholder: existing ? '(empty)' : 'Not defined — type a value to add it',
    spellcheck: false,
    autocomplete: 'off',
    readOnly,
  });
  const status = h('span', { class: 'varpop-hint' }, readOnly ? 'View only' : existing && existing.enabled === false ? 'Disabled · Enter to save & enable' : 'Enter to save · Esc to close');
  let saving = false;
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeVarPopover();
      return;
    }
    if (e.key !== 'Enter' || readOnly || saving) return;
    e.preventDefault();
    const s = setFor(collectionId);
    if (!s) return;
    let v = s.vars.find((x) => x.key === name);
    const added = !v;
    if (added) s.vars.push((v = { key: name, value: '', enabled: true }));
    const before = { value: v.value, enabled: v.enabled };
    v.value = input.value;
    v.enabled = true;
    saving = true;
    status.textContent = 'Saving…';
    try {
      await saveCollection(s.coll);
      repaintAll();
      toast(`${name} saved to ${s.name}`, 'ok');
      closeVarPopover();
    } catch (err) {
      if (added) s.vars.splice(s.vars.indexOf(v), 1);
      else Object.assign(v, before);
      saving = false;
      status.textContent = err.message;
      toast(err.message, 'error');
    }
  });
  const el = h(
    'div',
    { class: 'varpop' },
    h('div', { class: 'varpop-head' }, h('span', { class: 'varpop-name' }, name), h('span', { class: 'varpop-set' + (existing ? '' : ' missing') }, existing ? set.name : `not in ${set.name}`)),
    input,
    status,
  );
  show(el, span, name, collectionId);
}

function openInfo(span, name, text) {
  const el = h('div', { class: 'varpop' }, h('div', { class: 'varpop-head' }, h('span', { class: 'varpop-name' }, name)), h('span', { class: 'varpop-hint' }, text));
  show(el, span, name, null);
}

function show(el, span, name, collectionId) {
  el.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  el.addEventListener('mouseleave', scheduleHide);
  el.addEventListener('focusout', () => setTimeout(() => pop && pop.el === el && !el.contains(document.activeElement) && scheduleHide()));
  document.body.append(el);
  const r = span.getBoundingClientRect();
  const w = el.offsetWidth;
  const left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
  const below = r.bottom + 6 + el.offsetHeight < innerHeight;
  el.style.left = `${left}px`;
  el.style.top = `${below ? r.bottom + 6 : r.top - el.offsetHeight - 6}px`;
  pop = { el, anchor: span, name, collectionId };
}

// The highlight layer sits under a transparent input/textarea, so hit-test the
// variable spans against the pointer instead of listening on them directly.
export function attachVarHover(target, layer, getCollectionId) {
  target.addEventListener('mousemove', (e) => {
    const collectionId = getCollectionId();
    if (!collectionId || getComputedStyle(layer).visibility === 'hidden') return; // masked secret field
    for (const span of layer.querySelectorAll(VAR_SPAN)) {
      for (const r of span.getClientRects()) {
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          clearTimeout(hideTimer);
          const name = span.textContent.replace(/^\{\{\s*|\s*\}\}$/g, '');
          open(span, name, collectionId);
          return;
        }
      }
    }
    if (pop) scheduleHide();
  });
  target.addEventListener('mouseleave', () => pop && scheduleHide());
  target.addEventListener('scroll', () => pop && !pop.el.contains(document.activeElement) && closeVarPopover());
}

// Wraps {{name}} in already-escaped/highlighted HTML, marking undefined ones.
export function markVars(html, scope) {
  return html.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (m, name) => {
    const ok = !scope || name.startsWith('$') || scope.has(name);
    return `<span class="${ok ? 'var-ok' : 'var-missing'}">${m}</span>`;
  });
}
