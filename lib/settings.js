'use strict';

// The Settings view serve shows: the ladder and every task's tier, as forms
// that post back to serve. It sits in the board's shell and design system.

const S = require('./state');
const T = require('./tasks');
const L = require('./ladder');
const Board = require('./board/model');
const View = require('./board/view');
const { CSS: BOARD_CSS } = require('./board/style');
const { POSITION } = require('./board/position');
const { THEME_BOOT, THEME_TOGGLE } = require('./board/client');
const { TOKEN } = require('./board/token');
const { preserve } = require('./board/identity');
const { byId, shortTime } = require('./util');

const esc = View.esc;

const COLUMNS = [
  ['harness', 'Harness'], ['model', 'Model'], ['profile', 'Profile'], ['provider', 'Provider'],
  ['effort', 'Effort'], ['args', 'Args'], ['command', 'Command'],
];

const CSS = `
.settings { max-width: 1480px; }
.settings section { margin: 0 0 var(--s6); }
.settings h3 { margin: 0 0 var(--s2); font-size: var(--t-item); font-weight: var(--w-strong); }
.settings .panel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-room); overflow-x: auto; }
.settings table { width: 100%; border-collapse: collapse; font-size: var(--t-dense); }
.settings th, .settings td { text-align: left; padding: var(--s2) var(--s3); border-top: 1px solid var(--line); vertical-align: middle; }
.settings thead th { border-top: 0; background: var(--surface-2); color: var(--text-2); font-size: var(--t-meta); font-weight: var(--w-strong); white-space: nowrap; }
.settings td.id { font-weight: var(--w-strong); white-space: nowrap; }
.settings input, .settings select { width: 100%; min-width: 0; min-height: 32px; padding: var(--s1) var(--s2); background: var(--surface); border: 1px solid var(--line-strong); border-radius: var(--r-item); font-size: var(--t-dense); color: var(--text); }
.settings input { font-family: var(--mono); }
.settings input::placeholder { color: var(--text-3); opacity: 1; font-family: var(--sans); }
.settings input:hover, .settings select:hover { border-color: var(--text-2); }
.settings input.na:placeholder-shown { background: var(--surface-2); }
.settings select { appearance: none; padding-right: 26px; cursor: pointer; background-image: linear-gradient(45deg, transparent 50%, var(--text-2) 50%), linear-gradient(135deg, var(--text-2) 50%, transparent 50%); background-position: calc(100% - 14px) 52%, calc(100% - 9px) 52%; background-size: 5px 5px; background-repeat: no-repeat; }
.lead-in { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2) var(--s4); padding: var(--s3) var(--s4); border-bottom: 1px solid var(--line); }
.lead-in label { font-weight: var(--w-strong); font-size: var(--t-body); }
.lead-in select { width: 180px; }
.lead-in .hint { color: var(--text-2); font-size: var(--t-dense); }
table.ladder { min-width: 1020px; table-layout: fixed; }
table.ladder th:first-child, table.ladder td:first-child { padding-left: var(--s4); }
table.ladder th:last-child, table.ladder td:last-child { padding-right: var(--s4); }
th.rowh { color: var(--text); font-size: var(--t-dense); font-weight: var(--w-body); box-shadow: inset 4px 0 0 transparent; }
th.rowh .rung { font-weight: var(--w-strong); }
th.rowh .use { display: block; color: var(--text-2); font-size: var(--t-meta); line-height: 1.4; }
th.rowh .from { display: inline-block; margin-left: var(--s1); padding: 0 var(--s1); border: 1px solid var(--line-strong); border-radius: var(--r-item); color: var(--text-2); font-size: var(--t-meta); font-weight: var(--w-mid); vertical-align: 1px; }
tr.dirty th.rowh, table.tiers tr.dirty td.id { box-shadow: inset 4px 0 0 var(--live); }
tr.invalid { background: var(--alarm-wash); }
tr.invalid th.rowh { box-shadow: inset 4px 0 0 var(--alarm); }
table.tiers select { width: 140px; }
table.tiers td .g { margin-right: var(--s1); }
.settings .actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); margin: var(--s3) 0 0; }
.settings button { min-height: 32px; padding: 0 var(--s3); border: 1px solid var(--line-strong); border-radius: var(--r-item); background: var(--surface); color: var(--text); font-size: var(--t-dense); font-weight: var(--w-mid); cursor: pointer; }
.settings button:hover { border-color: var(--text); }
.settings button.primary { background: var(--text); border-color: var(--text); color: var(--surface); }
.settings button.primary:hover { background: var(--text-2); border-color: var(--text-2); }
.settings button:disabled { opacity: 0.5; cursor: default; }
.settings .msg { color: var(--text-2); font-size: var(--t-dense); }
.settings .err { margin: var(--s3) 0 0; padding: var(--s2) var(--s3); border-left: 3px solid var(--alarm); background: var(--alarm-wash); color: var(--text); font-size: var(--t-dense); }
.settings .err:empty { display: none; }
.settings .err ul { padding-left: 18px; list-style: disc; }
.banner { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); margin: 0 0 var(--s4); padding: var(--s2) var(--s3); border: 1px solid var(--line); border-left: 3px solid var(--live); border-radius: var(--r-item); background: var(--surface); font-size: var(--t-dense); }
.banner[hidden] { display: none; }
`;

// The newest ladder or tier change, so a reload after Save shows what landed.
function lastChange(dir) {
  const events = S.readEvents(dir);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const d = e.detail || {};
    let what = null;
    if (e.cmd === 'ladder set') what = `ladder set ${d.rung}`;
    else if (e.cmd === 'ladder harness') what = `default harness ${d.harness}`;
    else if (e.cmd === 'ladder save-user') what = 'ladder saved to the user file';
    else if (e.cmd === 'task update' && d.tier) what = `${e.task} tier ${d.tier}`;
    else if (e.cmd === 'init') what = 'init';
    if (what) return `Last change: ${what} by ${e.agent}${d.via ? ` from ${d.via}` : ''}, ${shortTime(e.at)}`;
  }
  return 'No ladder or tier changes yet';
}

function options(list, selected, labels = {}) {
  return list.map((v) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(labels[v] || v)}</option>`).join('');
}

function fieldText(rung, k) {
  const v = rung[k];
  if (v === undefined) return '';
  return Array.isArray(v) ? JSON.stringify(v) : String(v);
}

function ladderRows(layers, writable = true) {
  return L.RUNGS.map((n) => {
    const e = layers.ladder[n];
    const id = `r-${n}`;
    const cells = COLUMNS.map(([k]) => {
      if (!writable) return `<td class="mono">${esc(fieldText(L.rungOf(layers, n), k) || '-')}</td>`;
      const label = `${id} c-${k}`;
      if (k === 'harness') {
        const own = e.own.harness || '';
        const opts = `<option value=""${own ? '' : ' selected'}>default (${esc(layers.harness)})</option>${options(L.HARNESSES, own)}`;
        return `<td><select name="harness" aria-labelledby="${label}" data-initial="${esc(own)}">${opts}</select></td>`;
      }
      const v = fieldText(e.own, k);
      return `<td><input name="${k}" value="${esc(v)}" data-initial="${esc(v)}" aria-labelledby="${label}" autocomplete="off" spellcheck="false"></td>`;
    }).join('');
    return `<tr data-rung="${n}"><th scope="row" class="rowh"><span class="rung" id="${id}">${n}</span><span class="from" title="where this rung comes from">${esc(L.SOURCE[e.from])}</span><span class="use">${esc(L.USES[n])}</span></th>${cells}</tr>`;
  }).join('\n');
}

function tierRows(st, now, writable = true) {
  const tasks = st.tasks.tasks.filter((t) => t.status !== 'cancelled').sort(byId);
  if (!tasks.length) return { count: 0, html: '<p class="empty">No tasks yet.</p>' };
  const rows = tasks.map((t) => {
    const s = T.displayStatus(st, t, now);
    return `<tr data-task="${esc(t.id)}"><td class="id" id="t-${esc(t.id)}">${esc(t.id)}</td><td>${esc(t.title)}</td><td>${esc(t.kind)}</td><td>${esc(t.size)}</td>`
      + `<td>${View.glyph(s)}${esc(View.LABEL[s])}</td>`
      + `<td>${writable ? `<select name="tier" aria-labelledby="t-${esc(t.id)} c-tier" data-initial="${esc(t.tier)}">${options(L.TIERS, t.tier)}</select>` : esc(t.tier)}</td></tr>`;
  }).join('\n');
  const html = `<table class="tiers"><thead><tr><th scope="col">Task</th><th scope="col">Title</th><th scope="col">Kind</th><th scope="col">Size</th><th scope="col">Status</th><th scope="col" id="c-tier">Tier</th></tr></thead><tbody>\n${rows}\n</tbody></table>`;
  return { count: tasks.length, html };
}

// The browser half: tracks what changed, posts only that with the run's
// token and the values it was based on, and shows a refusal inline. It holds
// off the live reload while there are unsaved edits, so a write elsewhere does
// not throw them away. A form is read-only while its save is in flight, so
// nothing typed then can be lost when the reply lands; after a save the page
// reloads only when the other form has nothing unsaved, and otherwise shows
// the server's state in the saved form.
const SCRIPT = `
(function () {
  var token = ${TOKEN};
  var position = ${POSITION};
  position.restoreReload();
  var efforts = JSON.parse(document.getElementById('efforts').textContent);
  var loaded = JSON.parse(document.getElementById('loaded').textContent);
  var hint = { profile: 'codex profile', provider: 'pi provider', command: '["prog", "{prompt}"]' };
  var only = { profile: 'codex', provider: 'pi', command: 'command' };
  var defaultSel = document.getElementById('harness');
  var stale = document.getElementById('stale');
  var forms = [];
  // known is the state version this page has seen, including its own writes;
  // a reload event for any other version is a change made elsewhere.
  var known = loaded.version;
  // Saves in flight; while any is, reload events wait in heard.
  var saving = 0;
  var heard = null;

  function each(list, fn) { Array.prototype.forEach.call(list, fn); }
  function controls(root) { return Array.prototype.slice.call(root.querySelectorAll('input, select')); }
  function changed(el) { return el.value !== el.getAttribute('data-initial'); }
  function dirty(root) { return controls(root).some(changed); }
  function reset(el, value) { el.value = value; el.setAttribute('data-initial', value); }

  function shape(row) {
    var own = row.querySelector('select[name="harness"]').value;
    var h = own || defaultSel.value;
    Object.keys(only).forEach(function (k) {
      var input = row.querySelector('input[name="' + k + '"]');
      var fits = h === only[k];
      input.classList.toggle('na', !fits);
      input.placeholder = fits ? hint[k] : only[k] + ' only';
    });
    var effort = row.querySelector('input[name="effort"]');
    var list = efforts[h];
    if (list && list.length) { effort.setAttribute('list', 'effort-' + h); effort.placeholder = list.join(', '); }
    else { effort.removeAttribute('list'); effort.placeholder = h === 'command' ? 'n/a' : 'provider variant'; }
    effort.classList.toggle('na', h === 'command');
    row.querySelector('input[name="model"]').placeholder = h === 'command' ? 'n/a' : 'model id';
  }
  function shapeAll() { each(document.querySelectorAll('tr[data-rung]'), shape); }

  function mark(form) {
    each(form.querySelectorAll('tbody tr'), function (row) { row.classList.toggle('dirty', dirty(row)); });
  }

  function say(form, text, error) {
    form.querySelector('.msg').textContent = error ? '' : text;
    var box = form.querySelector('.err');
    box.textContent = '';
    if (!error) return;
    var parts = text.split('; ');
    if (parts.length === 1) { box.textContent = text; return; }
    var ul = document.createElement('ul');
    parts.forEach(function (p) { var li = document.createElement('li'); li.textContent = p; ul.appendChild(li); });
    box.appendChild(ul);
  }

  function flag(form, message) {
    each(form.querySelectorAll('tbody tr'), function (row) {
      var key = row.getAttribute('data-rung') ? 'ladder ' + row.getAttribute('data-rung') + ' ' : row.getAttribute('data-task') + ':';
      var bad = !!message && message.split('; ').some(function (p) { return p.indexOf(key) === 0 || p.indexOf(key.replace(/ $/, ':')) === 0; });
      row.classList.toggle('invalid', bad);
      controls(row).forEach(function (el) {
        if (bad) { el.setAttribute('aria-invalid', 'true'); el.setAttribute('aria-describedby', form.querySelector('.err').id); }
        else { el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby'); }
      });
    });
  }

  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tower-crane-token': token }, body: JSON.stringify(body) })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) { var e = new Error(data.error || res.statusText); e.status = res.status; throw e; }
          return data;
        });
      });
  }

  function busy(form, on) {
    var button = form.querySelector('button[type="submit"]');
    if (!button.hasAttribute('data-label')) button.setAttribute('data-label', button.textContent);
    button.textContent = on ? 'Saving...' : button.getAttribute('data-label');
    Array.prototype.forEach.call(form.querySelectorAll('input, select, button'), function (el) { el.disabled = on; });
    if (on) form.setAttribute('aria-busy', 'true');
    else form.removeAttribute('aria-busy');
  }

  // A reload event heard while a save was in flight, handled once none is.
  function drain() {
    if (saving || !heard) return;
    var version = heard;
    heard = null;
    changeSeen(version);
  }

  function changeSeen(version) {
    if (version === known) return;
    if (forms.some(dirty)) stale.hidden = false;
    else position.reload();
  }

  function wire(form, build, apply, url) {
    forms.push(form);
    form.addEventListener('input', function () { mark(form); });
    form.addEventListener('change', function (e) {
      if (e.target.name === 'harness') shapeAll();
      mark(form);
    });
    form.querySelector('[data-discard]').addEventListener('click', function () {
      controls(form).forEach(function (el) { el.value = el.getAttribute('data-initial'); });
      shapeAll();
      mark(form); flag(form, ''); say(form, 'Changes discarded.');
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var body = build();
      if (!body) { say(form, 'Nothing to save.'); return; }
      busy(form, true);
      saving += 1;
      say(form, 'Saving...');
      post(url, body).then(function (data) {
        known = data.version;
        var others = forms.filter(function (f) { return f !== form && dirty(f); });
        if (!others.length) { position.reload(); return; }
        // Reloading would drop the other form's unsaved edits.
        apply(data);
        saving -= 1;
        busy(form, false);
        mark(form); flag(form, '');
        say(form, 'Saved. The page did not reload, so your unsaved edits in the other form stay.');
        drain();
      }, function (err) {
        saving -= 1;
        busy(form, false);
        if (err.status === 409) stale.hidden = false;
        flag(form, err.message);
        say(form, err.message, true);
        drain();
      });
    });
  }

  function text(v) { return v === undefined ? '' : Array.isArray(v) ? JSON.stringify(v) : String(v); }

  var ladderForm = document.getElementById('ladder-form');
  wire(ladderForm, function () {
    var body = { rungs: {}, base: { harness: loaded.harness, rungs: {} } };
    var any = false;
    if (changed(defaultSel)) { body.harness = defaultSel.value; any = true; }
    each(ladderForm.querySelectorAll('tr[data-rung]'), function (row) {
      if (!dirty(row)) return;
      var name = row.getAttribute('data-rung');
      var rung = {};
      controls(row).forEach(function (el) { rung[el.name] = el.value; });
      body.rungs[name] = rung;
      body.base.rungs[name] = loaded.rungs[name];
      any = true;
    });
    return any ? body : null;
  }, function (data) {
    loaded.harness = data.harness;
    reset(defaultSel, data.harness);
    each(ladderForm.querySelectorAll('tr[data-rung]'), function (row) {
      var name = row.getAttribute('data-rung');
      var e = data.ladder[name];
      var own = {};
      loaded.fields.forEach(function (k) { if (e[k] !== undefined && (k !== 'harness' || e.harness_from === 'rung')) own[k] = e[k]; });
      loaded.rungs[name] = own;
      controls(row).forEach(function (el) { reset(el, text(own[el.name])); });
      row.querySelector('select[name="harness"] option[value=""]').textContent = 'default (' + data.harness + ')';
      row.querySelector('.from').textContent = loaded.sources[e.from];
    });
    shapeAll();
  }, 'api/ladder');

  var tierForm = document.getElementById('tier-form');
  if (tierForm) wire(tierForm, function () {
    var tiers = {};
    var base = {};
    var any = false;
    controls(tierForm).forEach(function (el) {
      if (!changed(el)) return;
      var id = el.closest('tr').getAttribute('data-task');
      tiers[id] = el.value;
      base[id] = loaded.tiers[id];
      any = true;
    });
    return any ? { tiers: tiers, base: base } : null;
  }, function (data) {
    data.tiers.forEach(function (t) {
      loaded.tiers[t.id] = t.tier;
      reset(tierForm.querySelector('tr[data-task="' + t.id + '"] select'), t.tier);
    });
  }, 'api/tiers');

  shapeAll();
  document.getElementById('reload').addEventListener('click', function () { position.reload(); });
  var stream = new EventSource('events');
  var conn = document.querySelector('.conn');
  stream.onopen = function () { conn.setAttribute('data-conn', 'live'); conn.textContent = 'Live'; };
  stream.onerror = function () { conn.setAttribute('data-conn', 'lost'); conn.textContent = 'Reconnecting'; };
  stream.addEventListener('reload', function (e) {
    var version = JSON.parse(e.data || '{}').version;
    if (saving) { heard = version; return; }
    changeSeen(version);
  });
})();
`;

function renderSettings(st, token, version, opts = {}) {
  const now = opts.now ?? Date.now();
  const writable = opts.owner === true;
  const p = st.project;
  const layers = L.resolve(p);
  const model = Board.build(st, { now });
  const n = model.queue.length;
  if (!writable) {
    return preserve(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Settings · ${esc(View.title(model))}</title>
<link rel="icon" href="${View.favicon(n > 0)}">
<script>${THEME_BOOT}</script>
<style>${BOARD_CSS}${CSS}</style>
</head>
<body>
${View.SYMBOLS}
${View.bar(model, { live: true, room: 'settings' })}
${View.lead(model, { live: true })}
<main class="settings">
<div class="roomh"><h2>Settings</h2><p>Read-only. The default harness is ${esc(layers.harness)}. For ladder and tier edits, start <code>tower-crane serve --agent owner</code>.</p></div>
<section aria-labelledby="h-ladder"><h3 id="h-ladder">Ladder</h3><div class="panel" data-scroll="ladder"><table class="ladder"><thead><tr><th scope="col">Rung</th>${COLUMNS.map(([, label]) => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${ladderRows(layers, false)}</tbody></table></div></section>
<section aria-labelledby="h-tiers"><h3 id="h-tiers">Task tiers</h3><div class="panel" data-scroll="tiers">${tierRows(st, now, false).html}</div></section>
</main>
<script>${THEME_TOGGLE}
(function () {
  var position = ${POSITION};
  position.restoreReload();
  var known = ${JSON.stringify(version)};
  var stream = new EventSource('events');
  var conn = document.querySelector('.conn');
  stream.onopen = function () { conn.dataset.conn = 'live'; conn.textContent = 'Live'; };
  stream.onerror = function () { conn.dataset.conn = 'lost'; conn.textContent = 'Reconnecting'; };
  stream.addEventListener('reload', function (e) {
    var next = JSON.parse(e.data || '{}').version;
    if (next && next === known) return;
    known = next;
    position.reload();
  });
})();
</script>
</body>
</html>`);
  }
  const datalists = Object.entries(L.EFFORTS)
    .filter(([, list]) => list && list.length)
    .map(([h, list]) => `<datalist id="effort-${h}">${list.map((v) => `<option value="${v}"></option>`).join('')}</datalist>`)
    .join('');
  const efforts = JSON.stringify(L.EFFORTS).replace(/</g, '\\u003c');
  // What the forms were drawn from: a save sends the part it edits back as
  // its base, so the server can refuse it if that part changed since.
  const loaded = JSON.stringify({
    version,
    harness: layers.harness,
    rungs: Object.fromEntries(L.RUNGS.map((n) => [n, layers.ladder[n].own])),
    tiers: Object.fromEntries(st.tasks.tasks.map((t) => [t.id, t.tier])),
    fields: L.FIELDS,
    sources: L.SOURCE,
  }).replace(/</g, '\\u003c');
  const tiers = tierRows(st, now);
  const head = COLUMNS.map(([k, label]) => `<th scope="col" id="c-${k}">${label}</th>`).join('');
  return preserve(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="tower-crane-token" content="${esc(token)}">
<title>Settings · ${esc(View.title(model))}</title>
<link rel="icon" href="${View.favicon(n > 0)}">
<script>${THEME_BOOT}</script>
<style>${BOARD_CSS}${CSS}</style>
</head>
<body>
${View.SYMBOLS}
${View.bar(model, { live: true, room: 'settings' })}
${View.lead(model, { live: true })}
<main class="settings">
<div class="roomh"><h2>Settings</h2><p>The harness, model and effort each rung runs, and the tier of each task. Saving runs the same checks as ${esc(View.CLI)} ladder set and ${esc(View.CLI)} task update; a refused change writes nothing. ${esc(lastChange(st.dir))}.</p></div>
<div class="banner" id="stale" role="status" hidden>The state changed on disk while you were editing. <button type="button" id="reload">Reload</button> shows it and drops your unsaved edits.</div>
<section aria-labelledby="h-ladder">
<h3 id="h-ladder">Ladder</h3>
<form id="ladder-form" novalidate>
<div class="panel" data-scroll="ladder">
<div class="lead-in">
<label for="harness">Default harness</label>
<select id="harness" name="harness" data-initial="${esc(layers.harness)}" aria-describedby="harness-hint">${options(L.HARNESSES, layers.harness)}</select>
<p class="hint" id="harness-hint">Every rung without its own harness runs here. Now from ${esc(L.SOURCE[layers.harness_from])}.</p>
</div>
<table class="ladder">
<colgroup><col style="width: 196px"><col style="width: 142px"><col><col style="width: 104px"><col style="width: 104px"><col style="width: 100px"><col style="width: 156px"><col style="width: 156px"></colgroup>
<thead><tr><th scope="col">Rung</th>${head}</tr></thead>
<tbody>
${ladderRows(layers)}
</tbody>
</table>
</div>
<div class="err" id="ladder-err" role="alert"></div>
<div class="actions"><button type="submit" class="primary">Save ladder</button><button type="button" data-discard>Discard changes</button><p class="msg" role="status"></p></div>
</form>
</section>
<section aria-labelledby="h-tiers">
<h3 id="h-tiers">Task tiers <span class="faint">${tiers.count}</span></h3>
${tiers.count ? `<form id="tier-form" novalidate>
<div class="panel" data-scroll="tiers">${tiers.html}</div>
<div class="err" id="tier-err" role="alert"></div>
<div class="actions"><button type="submit" class="primary">Save tiers</button><button type="button" data-discard>Discard changes</button><p class="msg" role="status"></p></div>
</form>` : `<div class="panel" data-scroll="tiers">${tiers.html}</div>`}
</section>
${datalists}
<script type="application/json" id="efforts">${efforts}</script>
<script type="application/json" id="loaded">${loaded}</script>
<script>${THEME_TOGGLE}${SCRIPT}</script>
</main>
</body>
</html>
`);
}

module.exports = { renderSettings };
