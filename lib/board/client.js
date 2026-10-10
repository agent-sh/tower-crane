'use strict';

// The board's browser half, inlined into every page. Everything it adds is an
// enhancement: the snapshot reads fine without it. It makes no request except,
// in serve, to the page's own origin: the event stream, the page itself and
// the token-protected write routes.

const { POSITION } = require('./position');
const { TOKEN } = require('./token');

// Runs in the head, before the first paint, so a stored theme never flashes.
const THEME_BOOT = `try { var t = localStorage.getItem('tower-crane:theme'); if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); } catch (e) { /* storage may be off */ }`;

// The theme button: the system's choice, then light, then dark.
const THEME_TOGGLE = `
(function () {
  var root = document.documentElement;
  var names = { auto: 'Auto', light: 'Light', dark: 'Dark' };
  var says = { auto: 'Theme: follows the system; switch to light', light: 'Theme: light; switch to dark', dark: 'Theme: dark; switch to follow the system' };
  function now() { return root.getAttribute('data-theme') || 'auto'; }
  function show() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-theme-toggle]'), function (b) { b.textContent = names[now()]; b.setAttribute('aria-label', says[now()]); });
  }
  document.addEventListener('click', function (e) {
    if (!e.target.closest('[data-theme-toggle]')) return;
    var next = { auto: 'light', light: 'dark', dark: 'auto' }[now()];
    if (next === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', next);
    try { if (next === 'auto') localStorage.removeItem('tower-crane:theme'); else localStorage.setItem('tower-crane:theme', next); } catch (err) { /* storage may be off */ }
    show();
  });
  window.towerCraneTheme = show;
  show();
})();
`;

const CLIENT = `
(function () {
  var doc = document;
  var root = doc.documentElement;
  var boot = JSON.parse(doc.getElementById('boot').textContent);
  var token = ${TOKEN};
  var position = ${POSITION};
  var ROOMS = boot.rooms;
  var room = root.getAttribute('data-room') || 'now';
  var seenKey = 'tower-crane:seen:' + boot.project + ':/';
  var seen = null;
  try { seen = localStorage.getItem(seenKey); } catch (e) { /* storage may be off */ }
  root.classList.add('js');

  function $(sel, el) { return (el || doc).querySelector(sel); }
  function $$(sel, el) { return Array.prototype.slice.call((el || doc).querySelectorAll(sel)); }

  // ---- rooms and sheets ----
  // The URL names the room: a path in serve, a fragment in the snapshot. A
  // fragment that names a room also wins in serve, and becomes its path.
  function fragment() { return decodeURIComponent(location.hash.slice(1)); }
  function pathRoom() {
    var p = location.pathname.replace(/\\/+$/, '').split('/').pop();
    return ROOMS.indexOf(p) >= 0 ? p : 'now';
  }
  function hrefOf(r) { return boot.live ? (r === 'now' ? '/' : '/' + r) : '#' + r; }
  function openSheet() { return $('.sheet.open'); }
  var invokerKey = null;
  function rememberInvoker(a) { invokerKey = position.key(a); }
  function restoreInvoker() {
    var back = position.find(doc, invokerKey) || $('.rooms a[data-room="' + room + '"]');
    if (back) back.focus({ preventScroll: true });
    invokerKey = null;
  }
  function route(focus) {
    var previous = openSheet();
    var id = fragment();
    var next = room;
    if (ROOMS.indexOf(id) >= 0) {
      next = id;
      if (boot.live) history.replaceState(null, '', hrefOf(id));
    } else if (boot.live) next = pathRoom();
    var sheet = id && ROOMS.indexOf(id) < 0 ? doc.getElementById(id) : null;
    if (sheet && !sheet.classList.contains('sheet')) sheet = null;
    if (next !== room || focus === 'room') {
      // A room link is not a jump within the page: the room starts at its top.
      if (focus !== 'keep') { window.scrollTo(0, 0); }
    }
    room = next;
    root.setAttribute('data-room', room);
    $$('.rooms a[data-room]').forEach(function (a) {
      if (a.getAttribute('data-room') === room) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    $$('.sheet.open').forEach(function (s) {
      if (s !== sheet) { s.classList.remove('open'); $('.panel', s).removeAttribute('aria-modal'); }
    });
    $$('.bar, .lead, main, .skip').forEach(function (el) { el.inert = !!sheet; });
    if (sheet) {
      var was = sheet.classList.contains('open');
      if (!previous && !invokerKey && doc.activeElement.matches('a[href]') && !sheet.contains(doc.activeElement)) rememberInvoker(doc.activeElement);
      sheet.classList.add('open');
      $('.panel', sheet).setAttribute('aria-modal', 'true');
      doc.body.style.overflow = 'hidden';
      if (!was && focus !== 'keep') { var h = $('h2', sheet); if (h) h.focus({ preventScroll: true }); }
    } else {
      doc.body.style.overflow = '';
      if (previous) restoreInvoker();
    }
  }
  function closeSheet() {
    if (!openSheet()) return;
    history.pushState(null, '', boot.live ? location.pathname : '#' + room);
    route('keep');
  }
  window.addEventListener('hashchange', function () { route(); });
  window.addEventListener('popstate', function () { route(); });
  // The browser jumps to a fragment after load; a room starts at its top.
  window.addEventListener('load', function () {
    var id = fragment();
    if (ROOMS.indexOf(id) < 0) return;
    var x = window.scrollX, y = window.scrollY;
    requestAnimationFrame(function () {
      // A delayed frame must not overwrite scrolling or navigation since load.
      if (fragment() !== id || window.scrollX !== x || window.scrollY !== y) return;
      window.scrollTo(0, 0);
    });
  });
  doc.addEventListener('click', function (e) {
    var a = e.target.closest('[data-close], .sheet .scrim');
    if (a) { e.preventDefault(); closeSheet(); return; }
    var nav = e.target.closest('a[data-room]');
    if (nav && boot.live && nav.getAttribute('data-room') !== 'settings' && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
      e.preventDefault();
      history.pushState(null, '', nav.getAttribute('href'));
      route('room');
      return;
    }
    var link = e.target.closest('a[href^="#T"]');
    if (link && !openSheet()) rememberInvoker(link);
    var keep = e.target.closest('[data-close-details]');
    if (keep) { var d = keep.closest('details'); if (d) { d.open = false; var s = $(':scope > summary', d); if (s) s.focus(); } }
    var tab = e.target.closest('[data-tab]');
    if (tab) selectTab(tab.getAttribute('data-tab'), true);
  });
  doc.addEventListener('focusin', function (e) {
    var s = openSheet();
    if (s && !$('.panel', s).contains(e.target)) $('h2', s).focus({ preventScroll: true });
  });
  doc.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      var d = e.target.closest && e.target.closest('details[open].act-stop, details[open].act-message');
      if (d) { e.preventDefault(); d.open = false; $(':scope > summary', d).focus(); return; }
      if (openSheet()) { e.preventDefault(); closeSheet(); return; }
    }
    if (e.key === 'Tab' && openSheet()) {
      var s = openSheet();
      var stops = $$('a[href], button, input, textarea, select, summary, [tabindex]', $('.panel', s)).filter(function (el) { return !el.disabled && el.tabIndex >= 0 && el.getClientRects().length; });
      var index = stops.indexOf(doc.activeElement);
      if (!stops.length) { e.preventDefault(); $('h2', s).focus(); }
      else if (index < 0 || (e.shiftKey && index === 0) || (!e.shiftKey && index === stops.length - 1)) {
        e.preventDefault(); stops[e.shiftKey ? stops.length - 1 : 0].focus();
      }
      return;
    }
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && e.target.matches('[role="tab"]')) {
      e.preventDefault();
      selectTab(tab === 'next' ? 'recent' : 'next', true);
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input, textarea, select, [contenteditable]')) return;
    var keys = { n: 'now', r: 'review', p: 'plan', s: 'spend', h: 'history' };
    if (keys[e.key] && !openSheet()) {
      if (boot.live) { history.pushState(null, '', hrefOf(keys[e.key])); route('room'); } else location.hash = keys[e.key];
    }
  });

  // ---- tabs under the floor ----
  var tab = 'next';
  function selectTab(name, focus) {
    tab = name;
    $$('[data-tab]').forEach(function (b) {
      var on = b.getAttribute('data-tab') === name;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    $$('.lower [role="tabpanel"]').forEach(function (p) { p.hidden = p.id !== 'p-' + name; });
  }

  // ---- time ----
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hm(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function rel(iso) {
    var d = new Date(iso);
    var ms = Date.now() - d.getTime();
    if (isNaN(ms)) return null;
    if (ms < 60000 && ms > -60000) return 'now';
    if (ms > 0 && ms < 3600000) return Math.round(ms / 60000) + ' min ago';
    var today = new Date();
    if (d.toDateString() === today.toDateString()) return hm(d);
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + ' ' + hm(d);
  }
  function span(ms) {
    var m = Math.round(Math.abs(ms) / 60000);
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60);
    return m % 60 && h < 10 ? h + ' h ' + (m % 60) + ' min' : h + ' h';
  }
  // A reading's age, as the server words it.
  function ago(ms) { return ms < 90000 ? Math.max(0, Math.round(ms / 1000)) + ' s' : span(ms); }
  function times(scope) {
    $$('time[datetime]', scope).forEach(function (t) {
      if (t.closest('.conn')) return;
      var r = rel(t.getAttribute('datetime'));
      if (!r) return;
      t.textContent = r;
      t.title = new Date(t.getAttribute('datetime')).toLocaleString();
    });
    if (!boot.live) return;
    $$('.lease[data-until]', scope).forEach(function (l) {
      var until = Date.parse(l.getAttribute('data-until'));
      var since = Date.parse(l.getAttribute('data-since'));
      var left = until - Date.now();
      var text = $('.lt', l);
      if (text) text.textContent = left > 0 ? 'lease ends in ' + span(left) : 'lease ran out ' + span(left) + ' ago';
      var fill = $('.fill', l);
      if (fill && until > since) fill.style.width = Math.max(0, Math.min(100, Math.round(left / (until - since) * 100))) + '%';
      l.classList.toggle('warn', left < 600000);
    });
    // A reading that stops arriving changes nothing on disk, so the page ages
    // it: past its stale limit the page draws it stale, then asks the server
    // to redraw the queue and status with it.
    var stale = false;
    $$('[data-usage][data-live-state="live"][data-at]', scope).forEach(function (u) {
      var age = Date.now() - Date.parse(u.getAttribute('data-at'));
      var f = $('.fresh', u);
      var limit = Number(u.getAttribute('data-stale-ms'));
      var old = ago(age) + ' old';
      if (limit && age > limit) {
        stale = true;
        u.setAttribute('data-live-state', 'stale');
        if (f) f.textContent = 'stale, ' + old;
      } else if (f) f.textContent = 'live, ' + old;
    });
    $$('tr[data-live-at]', scope).forEach(function (row) {
      var age = Math.max(0, Date.now() - Date.parse(row.getAttribute('data-live-at')));
      if (row.getAttribute('data-live-state') === 'live' && Date.now() > Date.parse(row.getAttribute('data-live-stale-at'))) {
        stale = true;
        row.setAttribute('data-live-state', 'stale');
        $('.live-state', row).textContent = 'stale';
      }
      $('.live-age', row).textContent = ago(age) + ' ago';
    });
    if (stale && onStale) onStale();
  }
  var onStale = null;
  // A snapshot has no stream, so it has no connection line to age.
  setInterval(function () { times(doc); if (boot.live) fresh(); }, 5000);

  // ---- since you looked ----
  function newest() {
    var top = $$('.recent .ev').map(function (li) { return li.getAttribute('data-at'); }).sort().pop();
    return top || null;
  }
  function since() {
    var box = $('.recent');
    if (!box) return;
    var items = $$('.ev', box);
    var sum = $('[data-since-sum]');
    var title = $('[data-since-title]');
    if (!seen || !sum || !title) return;
    var fresh = items.filter(function (li) { return li.getAttribute('data-at') > seen; });
    items.forEach(function (li) { li.classList.toggle('new', fresh.indexOf(li) >= 0); });
    var when = hm(new Date(seen));
    title.textContent = 'Since you looked';
    if (!fresh.length) { sum.textContent = 'Nothing new since ' + when + '. The newest events are below.'; return; }
    var n = {};
    fresh.forEach(function (li) { var g = li.closest('[data-group]'); var k = g ? g.querySelector('h3').firstChild.textContent.trim().toLowerCase() : 'other'; n[k] = (n[k] || 0) + 1; });
    sum.innerHTML = '<b>' + fresh.length + '</b> new since ' + when + ': ' + Object.keys(n).map(function (k) { return '<b>' + n[k] + '</b> ' + k; }).join(', ') + '. New items are marked.';
  }
  function remember() {
    var top = newest();
    if (!top) return;
    try { localStorage.setItem(seenKey, top); } catch (e) { /* storage may be off */ }
  }
  // A tab left open counts as looked at while it is visible: leaving stores
  // the newest event, and coming back starts the digest from that mark.
  doc.addEventListener('visibilitychange', function () {
    if (doc.visibilityState === 'hidden') { remember(); return; }
    try { seen = localStorage.getItem(seenKey) || seen; } catch (e) { /* storage may be off */ }
    since();
  });
  window.addEventListener('pagehide', remember);

  // ---- copy ----
  var toastTimer = null;
  function toast(text) {
    var t = $('[data-toast]');
    t.textContent = text;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, 2600);
  }
  doc.addEventListener('click', function (e) {
    var b = e.target.closest('[data-copy]');
    if (!b) return;
    var text = b.getAttribute('data-copy');
    function fallback() {
      var ta = doc.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      doc.body.appendChild(ta); ta.select();
      try { doc.execCommand('copy'); toast('Copied'); } catch (err) { toast('Select the command and copy it'); }
      doc.body.removeChild(ta);
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(function () { toast('Copied'); }, fallback);
    else fallback();
  });

  // ---- plan ----
  function hot(id, on) {
    $$('.graph .edge').forEach(function (p) {
      if (p.getAttribute('data-from') === id || p.getAttribute('data-to') === id) p.classList.toggle('hot', on);
    });
  }
  ['mouseover', 'focusin'].forEach(function (type) {
    doc.addEventListener(type, function (e) { var n = e.target.closest && e.target.closest('.graph .node'); if (n) hot(n.getAttribute('data-id'), true); });
  });
  ['mouseout', 'focusout'].forEach(function (type) {
    doc.addEventListener(type, function (e) { var n = e.target.closest && e.target.closest('.graph .node'); if (n) hot(n.getAttribute('data-id'), false); });
  });
  var dim = false;
  doc.addEventListener('change', function (e) {
    if (e.target.matches('[data-hide-done]')) { dim = e.target.checked; applyDim(); }
  });
  function applyDim() {
    var g = $('.graph');
    if (g) g.classList.toggle('hide-done', dim);
    var box = $('[data-hide-done]');
    if (box) box.checked = dim;
  }

  // ---- history task filter ----
  var taskFilter = '';
  function filterHistory() {
    var q = taskFilter.trim().toUpperCase();
    $$('#history .ev').forEach(function (li) {
      li.hidden = !!q && (li.getAttribute('data-task') || '').toUpperCase() !== q && li.textContent.toUpperCase().indexOf(q + ' ') < 0;
    });
    $$('#history .day').forEach(function (d) { d.hidden = !!q && !$$('.ev', d).some(function (li) { return !li.hidden; }); });
  }
  doc.addEventListener('input', function (e) {
    if (e.target.id === 'hf-task') { taskFilter = e.target.value; filterHistory(); }
  });

  // ---- attention in the tab ----
  function badge(title, icon) {
    if (title) doc.title = title;
    var link = $('link[rel="icon"]');
    if (link && icon) link.href = icon;
  }

  function enhance(scope) {
    times(scope);
    since();
    applyDim();
    filterHistory();
    selectTab(tab, false);
    if (window.towerCraneTheme) window.towerCraneTheme();
  }
  route(false);
  enhance(doc);

  if (!boot.live) return;

  // ---- live ----
  var known = boot.version;
  var connState = ['connecting', 'Connecting'];
  var pending = false;
  var busy = 0;
  var updated = null;
  var focusNext = null;

  function setConn(state, text) {
    if (state) connState = [state, text];
    var conn = $('.conn');
    conn.setAttribute('data-conn', connState[0]);
    conn.textContent = connState[1];
  }
  // Liveness is words, not a breathing dot: a perpetual motion in the corner
  // of the eye competes with real change.
  function fresh() {
    if (connState[0] !== 'live' || !updated) return;
    var s = Math.round((Date.now() - updated) / 1000);
    setConn('live', 'Live, updated ' + (s < 10 ? 'just now' : s < 90 ? s + ' s ago' : span(s * 1000) + ' ago'));
  }

  function dirty(region) {
    if (region.contains(doc.activeElement) && doc.activeElement.matches('input:not([type=hidden]), textarea, select')) return true;
    return $$('form[data-api]', region).some(function (f) {
      return f.getAttribute('aria-busy') === 'true' || $$('input:not([type=hidden]), textarea', f).some(function (el) { return el.value !== el.defaultValue; })
        || $$('select', f).some(function (s) { return $$('option', s).some(function (o) { return o.selected !== o.defaultSelected; }); });
    });
  }

  function notice(on) {
    var n = $('[data-notice]');
    n.classList.toggle('on', on);
    n.textContent = on ? 'The state changed while you were typing. Those parts update when you send or clear your text.' : '';
  }

  var refreshing = null;
  function refresh() {
    if (refreshing) { refreshing.again = true; return; }
    refreshing = { again: false };
    fetch(location.pathname, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('status ' + r.status);
      return r.text();
    }).then(function (html) {
      var next = new DOMParser().parseFromString(html, 'text/html');
      var nb = JSON.parse(next.getElementById('boot').textContent);
      var before = newest();
      var held = false;
      var saved = position.capture(doc);
      root.removeAttribute('data-position-restored');
      $$('[data-region]', next).forEach(function (fresh) {
        var name = fresh.getAttribute('data-region');
        var old = $('[data-region="' + name + '"]');
        if (!old) return;
        if (dirty(old)) { held = true; return; }
        var sigs = {};
        $$('[data-key]', old).forEach(function (el) { sigs[el.getAttribute('data-key')] = el.textContent; });
        var openId = openSheet() && old.contains(openSheet()) ? openSheet().id : null;
        var imported = doc.importNode(fresh, true);
        old.replaceWith(imported);
        if (openId) { var s = doc.getElementById(openId); if (s) s.classList.add('open'); }
        $$('[data-key]', imported).forEach(function (el) {
          var k = el.getAttribute('data-key');
          if (k.indexOf('sheet-') === 0) return;
          if (!(k in sigs) && el.classList.contains('qi')) el.classList.add('arrived');
          else if (sigs[k] !== el.textContent) el.classList.add('changed');
        });
      });
      pending = held;
      notice(held);
      boot.attention = nb.attention;
      badge(nb.title, nb.icon[nb.attention ? 1 : 0]);
      updated = Date.now();
      setConn('live', 'Live, updated just now');
      position.disclosures(doc, saved);
      enhance(doc);
      route('keep');
      position.restore(doc, saved, openSheet() && $('h2', openSheet()));
      // After an answer, the next item in the queue is where the owner goes.
      if (focusNext) {
        var item = $('#queue [data-key="' + focusNext + '"]') || $('#queue .qi');
        var target = item && ($('button, input:not([type=hidden]), a[href], summary', item));
        if (target) target.focus({ preventScroll: true });
        focusNext = null;
      }
      // Say what changed, for people not looking at the digest.
      var news = $$('.recent .ev').filter(function (li) { return before && li.getAttribute('data-at') > before && /\\b(fault|signal|done)\\b/.test(li.className); });
      if (news.length) toast(news.slice(0, 2).map(function (li) { return $('.txt', li).textContent; }).join('. '));
    }).catch(function () {
      setConn('lost', 'Reconnecting');
    }).then(function () {
      var again = refreshing.again;
      refreshing = null;
      if (again) refresh();
    });
  }

  var stream = null;
  function connect() {
    stream = new EventSource('/events');
    stream.onopen = function () { updated = updated || Date.now(); setConn('live', 'Live, updated just now'); fresh(); };
    stream.onerror = function () { setConn('lost', 'Reconnecting'); };
    stream.addEventListener('reload', function (e) {
      var v = null;
      try { v = JSON.parse(e.data || '{}').version; } catch (err) { /* an old server sends no data */ }
      if (v && v === known) return;
      known = v;
      if (busy) { pending = true; return; }
      refresh();
    });
  }
  connect();
  var staleAsked = 0;
  onStale = function () { if (Date.now() - staleAsked > 5000) { staleAsked = Date.now(); refresh(); } };

  // ---- writes ----
  doc.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form.matches('form[data-api]')) return;
    e.preventDefault();
    var out = $('output', form);
    var data = new FormData(form, e.submitter || null);
    var body = {};
    data.forEach(function (v, k) { body[k] = String(v); });
    if (form.getAttribute('data-kind') === 'tier') {
      var id = form.getAttribute('data-task');
      var tiers = {}; var base = {};
      tiers[id] = body.tier; base[id] = form.getAttribute('data-base');
      body = { tiers: tiers, base: base };
    }
    if (form.hasAttribute('data-next')) {
      var item = form.closest('.qi');
      var after = item && (item.nextElementSibling || item.previousElementSibling);
      focusNext = after ? after.getAttribute('data-key') : null;
    }
    var controls = $$('input, textarea, select, button', form);
    controls.forEach(function (c) { c.disabled = true; });
    form.setAttribute('aria-busy', 'true');
    out.className = ''; out.textContent = 'Sending';
    busy += 1;
    fetch(form.getAttribute('data-api'), { method: 'POST', headers: { 'content-type': 'application/json', 'x-tower-crane-token': token }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) { var err = new Error(d.error || r.statusText); err.status = r.status; throw err; } return d; }); })
      .then(function (d) {
        if (d.version) known = d.version;
        form.reset();
        out.textContent = '';
        toast(form.getAttribute('data-done') || 'Saved');
      }, function (err) {
        focusNext = null;
        out.className = 'err';
        out.textContent = err.status === 409 && !/reload/i.test(err.message) ? err.message + ' Reload to see the current state.' : err.message;
      })
      .then(function () {
        busy -= 1;
        controls.forEach(function (c) { c.disabled = false; });
        form.removeAttribute('aria-busy');
        refresh();
      });
  });
  doc.addEventListener('input', function () {
    if (pending && !$$('[data-region]').some(dirty)) { pending = false; refresh(); }
  });
  doc.addEventListener('focusout', function () {
    setTimeout(function () { if (pending && !$$('[data-region]').some(dirty)) { pending = false; refresh(); } }, 0);
  });
})();
`;

module.exports = { CLIENT, THEME_BOOT, THEME_TOGGLE };
