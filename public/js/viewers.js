// Collapsible JSON tree, syntax highlighting, and the key/value table editor.
import { h, icon, escapeHtml } from './util.js';
import { parseVarText } from './model.js';

// ---------- JSON tree ----------
const CHUNK = 200;

function primitive(v) {
  if (v === null) return h('span', { class: 'j-null' }, 'null');
  if (typeof v === 'string') return h('span', { class: 'j-str' }, JSON.stringify(v));
  if (typeof v === 'number') return h('span', { class: 'j-num' }, String(v));
  if (typeof v === 'boolean') return h('span', { class: 'j-bool' }, String(v));
  return h('span', {}, String(v));
}

function keyEl(key) {
  if (key === undefined) return null;
  return [h('span', { class: typeof key === 'number' ? 'j-idx' : 'j-key' }, typeof key === 'number' ? key : JSON.stringify(key)), h('span', { class: 'j-punc' }, ': ')];
}

function node(key, value, last, depth) {
  const comma = last ? null : h('span', { class: 'j-punc' }, ',');
  if (value === null || typeof value !== 'object') {
    return h('div', { class: 'j-line' }, keyEl(key), primitive(value), comma);
  }
  const isArr = Array.isArray(value);
  const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
  const [open, close] = isArr ? ['[', ']'] : ['{', '}'];
  if (!entries.length) return h('div', { class: 'j-line' }, keyEl(key), h('span', { class: 'j-punc' }, open + close), comma);

  const children = h('div', { class: 'j-children' });
  const renderFrom = (start) => {
    const end = Math.min(entries.length, start + CHUNK);
    for (let i = start; i < end; i++) children.append(node(entries[i][0], entries[i][1], i === entries.length - 1, depth + 1));
    if (end < entries.length) {
      const more = h('button', { class: 'j-more', onClick: () => (more.remove(), renderFrom(end)) }, `Show ${Math.min(CHUNK, entries.length - end)} more of ${entries.length - end}…`);
      children.append(more);
    }
  };
  const wrap = h('div', { class: 'j-node' + (depth > 3 ? ' collapsed' : '') });
  let rendered = false;
  const ensure = () => {
    if (!rendered) {
      rendered = true;
      renderFrom(0);
    }
  };
  if (depth <= 3) ensure();
  const toggle = () => {
    ensure();
    wrap.classList.toggle('collapsed');
  };
  wrap.append(
    h(
      'div',
      { class: 'j-line j-head', onClick: toggle },
      h('span', { class: 'j-caret' }, icon('chevronDown', 12)),
      keyEl(key),
      h('span', { class: 'j-punc' }, open),
      h('span', { class: 'j-summary' }, ` ${entries.length} ${isArr ? (entries.length === 1 ? 'item' : 'items') : entries.length === 1 ? 'key' : 'keys'} `, h('span', { class: 'j-punc' }, close), comma ? ',' : ''),
    ),
    children,
    h('div', { class: 'j-line j-close' }, h('span', { class: 'j-punc' }, close), comma),
  );
  return wrap;
}

export function jsonTree(value) {
  const root = h('div', { class: 'json-tree' }, node(undefined, value, true, 0));
  return root;
}

export function setTreeExpanded(root, expanded) {
  if (!expanded) {
    root.querySelectorAll('.j-node').forEach((n, i) => i > 0 && n.classList.add('collapsed'));
    return;
  }
  // Children render lazily, so expand level by level.
  for (let pass = 0; pass < 12; pass++) {
    const collapsed = root.querySelectorAll('.j-node.collapsed');
    if (!collapsed.length) break;
    collapsed.forEach((n) => n.querySelector(':scope > .j-head').click());
  }
}

// ---------- syntax highlighting ----------
export function highlightJson(text) {
  return escapeHtml(text).replace(
    /(&quot;(?:\\.|(?!&quot;)[^\\])*&quot;)(\s*:)?|\b(true|false)\b|\bnull\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g,
    (m, str, colon, bool) => {
      if (str) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`;
      if (bool) return `<span class="j-bool">${m}</span>`;
      if (m === 'null') return `<span class="j-null">${m}</span>`;
      return `<span class="j-num">${m}</span>`;
    },
  );
}

export function highlightMarkup(text) {
  return escapeHtml(text).replace(
    /(&lt;\/?)([\w:-]+)((?:[^&]|&(?!gt;))*?)(\/?&gt;)/g,
    (m, open, tag, attrs, close) =>
      `<span class="x-punc">${open}</span><span class="x-tag">${tag}</span>${attrs.replace(/([\w:-]+)(=)(&quot;.*?&quot;|&#39;.*?&#39;)/g, '<span class="x-attr">$1</span>$2<span class="j-str">$3</span>')}<span class="x-punc">${close}</span>`,
  );
}

// ---------- key/value table ----------
// rows: array mutated in place. opts: { onChange, keyPh, valuePh, files, descriptions, readOnlyKeys, bulk }
export function kvTable(rows, opts = {}) {
  const { onChange = () => {}, keyPh = 'Key', valuePh = 'Value', files = false, descriptions = false, readOnlyKeys = false } = opts;
  let bulkMode = false;
  const wrap = h('div', { class: 'kv-wrap' });

  const emit = () => onChange(rows);

  function rowEl(row, isGhost) {
    const tr = h('div', { class: 'kv-row' + (isGhost ? ' ghost' : '') + (row && row.enabled === false ? ' off' : '') });
    const r = row || { key: '', value: '', enabled: true, ...(files ? { type: 'text' } : {}) };

    const promote = () => {
      if (!tr.classList.contains('ghost')) return;
      tr.classList.remove('ghost');
      rows.push(r);
      body.append(rowEl(null, true));
    };

    const cb = h('input', {
      type: 'checkbox',
      class: 'kv-check',
      checked: r.enabled !== false,
      onChange: (e) => {
        r.enabled = e.target.checked;
        tr.classList.toggle('off', !r.enabled);
        promote();
        emit();
      },
    });
    const keyIn = h('input', {
      class: 'kv-input',
      placeholder: keyPh,
      value: r.key || '',
      readOnly: readOnlyKeys,
      spellcheck: false,
      onInput: (e) => {
        r.key = e.target.value;
        promote();
        emit();
      },
    });

    let valueCell;
    const valIn = () =>
      h('input', {
        class: 'kv-input',
        placeholder: valuePh,
        value: r.value || '',
        spellcheck: false,
        onInput: (e) => {
          r.value = e.target.value;
          promote();
          emit();
        },
      });
    const fileIn = () => {
      const label = h('span', { class: 'file-name' }, r.fileName ? (r.fileData ? r.fileName : `${r.fileName} (re-select file)`) : 'Choose file…');
      const input = h('input', {
        type: 'file',
        hidden: true,
        onChange: async (e) => {
          const f = e.target.files[0];
          if (!f) return;
          const buf = new Uint8Array(await f.arrayBuffer());
          let bin = '';
          for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          r.fileName = f.name;
          r.fileType = f.type;
          r.fileData = btoa(bin);
          label.textContent = f.name;
          promote();
          emit();
        },
      });
      return h('label', { class: 'kv-input file-pick' }, icon('file', 14), label, input);
    };

    const renderValue = () => {
      valueCell.replaceChildren(files && r.type === 'file' ? fileIn() : valIn());
    };
    valueCell = h('div', { class: 'kv-cell kv-value' });
    renderValue();

    const typeSel = files
      ? h(
          'select',
          {
            class: 'kv-type',
            onChange: (e) => {
              r.type = e.target.value;
              renderValue();
              promote();
              emit();
            },
          },
          h('option', { value: 'text' }, 'Text'),
          h('option', { value: 'file' }, 'File'),
        )
      : null;
    if (typeSel) typeSel.value = r.type || 'text';

    const desc = descriptions
      ? h('input', {
          class: 'kv-input',
          placeholder: 'Description',
          value: r.description || '',
          onInput: (e) => {
            r.description = e.target.value;
            promote();
            emit();
          },
        })
      : null;

    const del = h(
      'button',
      {
        class: 'btn-icon kv-del',
        title: 'Remove',
        onClick: () => {
          const i = rows.indexOf(r);
          if (i >= 0) rows.splice(i, 1);
          tr.remove();
          emit();
        },
      },
      icon('trash', 14),
    );

    tr.append(
      h('div', { class: 'kv-cell kv-cb' }, cb),
      h('div', { class: 'kv-cell kv-key' }, keyIn, typeSel),
      valueCell,
      descriptions ? h('div', { class: 'kv-cell kv-desc' }, desc) : null,
      h('div', { class: 'kv-cell kv-actions' }, readOnlyKeys ? null : del),
    );
    return tr;
  }

  const head = h(
    'div',
    { class: 'kv-row kv-head' },
    h('div', { class: 'kv-cell kv-cb' }),
    h('div', { class: 'kv-cell kv-key' }, keyPh),
    h('div', { class: 'kv-cell kv-value' }, valuePh),
    descriptions ? h('div', { class: 'kv-cell kv-desc' }, 'Description') : null,
    h(
      'div',
      { class: 'kv-cell kv-actions' },
      readOnlyKeys || files
        ? null
        : h('button', { class: 'link-btn', title: 'Edit as text', onClick: () => ((bulkMode = !bulkMode), render()) }, 'Bulk'),
    ),
  );
  const body = h('div', { class: 'kv-body' });

  function render() {
    if (bulkMode) {
      const ta = h('textarea', {
        class: 'bulk-edit mono',
        spellcheck: false,
        placeholder: 'key: value  or  KEY=value — one per line. Prefix with // to disable.',
        value: rows.map((r) => `${r.enabled === false ? '//' : ''}${r.key}:${r.value}`).join('\n'),
        onInput: (e) => {
          const next = parseVarText(e.target.value);
          rows.splice(0, rows.length, ...next);
          emit();
        },
      });
      wrap.replaceChildren(head, ta);
      head.querySelector('.link-btn').textContent = 'Table';
      return;
    }
    body.replaceChildren(...rows.map((r) => rowEl(r, false)), ...(readOnlyKeys ? [] : [rowEl(null, true)]));
    wrap.replaceChildren(head, body);
    const lb = head.querySelector('.link-btn');
    if (lb) lb.textContent = 'Bulk edit';
  }
  render();
  wrap.refresh = render;
  return wrap;
}
