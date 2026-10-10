'use strict';

// The board's browser half, inlined into every page. Everything it adds is an
// enhancement: the snapshot reads fine without it. It makes no request except,
// in serve, to the page's own origin: the event stream, the page itself and
// the token-protected write routes.

const { POSITION } = require('./position');
const { TOKEN } = require('./token');

const CLIENT = `
(function () {
  var doc = document;
  var root = doc.documentElement;
  var boot = JSON.parse(doc.getElementById('boot').textContent);
  var token = ${TOKEN};
  var position = ${POSITION};
  var VIEWS = ['board', 'plan', 'history', 'spend'];
  var view = 'board';
  var seenKey = 'tower-crane:seen:' + boot.project + ':' + location.pathname;
  var seen = null;
  try { seen = localStorage.getItem(seenKey); } catch (e) { /* storage may be off */ }
  root.classList.add('js');

  function $(sel, el) { return (el || doc).querySelector(sel); }
  function $$(sel, el) { return Array.prototype.slice.call((el || doc).querySelectorAll(sel)); }

  // ---- views and sheets ----
  function current() { return decodeURIComponent(location.hash.slice(1)); }
  function openSheet() { return $('.sheet.open'); }
  var invokerKey = null;
  function rememberInvoker(a) { invokerKey = position.key(a); }
  function restoreInvoker() {
    var back = position.find(doc, invokerKey) || $('.views a[data-view="' + view + '"]');
    if (back) back.focus({ preventScroll: true });
    invokerKey = null;
  }
  function route(focus) {
    var previous = openSheet();
    var id = current();
    var sheet = id && VIEWS.indexOf(id) < 0 ? doc.getElementById(id) : null;
    if (sheet && !sheet.classList.contains('sheet')) sheet = null;
    if (!sheet && VIEWS.indexOf(id) >= 0) {
      // A view link is not a jump within the page: start the view at its top.
      if (focus !== 'keep') { window.scrollTo(0, 0); var mn = $('main'); if (mn) mn.scrollTop = 0; }
      view = id;
    }
    root.setAttribute('data-view', view);
    $$('.views a[data-view]').forEach(function (a) {
      if (a.getAttribute('data-view') === view) a.setAttribute('aria-current', 'page');
      else if (a.getAttribute('data-view') !== 'settings') a.removeAttribute('aria-current');
    });
    $$('.sheet.open').forEach(function (s) {
      if (s !== sheet) { s.classList.remove('open'); $('.panel', s).removeAttribute('aria-modal'); }
    });
    $$('.topbar, main, .skip').forEach(function (el) { el.inert = !!sheet; });
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
    var s = openSheet();
    if (!s) return;
    history.pushState(null, '', '#' + view);
    route('keep');
  }
  window.addEventListener('hashchange', function () { route(); });
  // The browser jumps to a fragment after load; a view starts at its top.
  window.addEventListener('load', function () {
    var id = current();
    if (VIEWS.indexOf(id) < 0) return;
    var mn = $('main');
    var x = window.scrollX, y = window.scrollY, top = mn && mn.scrollTop;
    requestAnimationFrame(function () {
      // A delayed frame must not overwrite scrolling or navigation since load.
      if (current() !== id || window.scrollX !== x || window.scrollY !== y || (mn && mn.scrollTop !== top)) return;
      window.scrollTo(0, 0);
      if (mn) mn.scrollTop = 0;
    });
  });
  doc.addEventListener('click', function (e) {
    var a = e.target.closest('[data-close], .sheet .scrim');
    if (a) { e.preventDefault(); closeSheet(); }
    var link = e.target.closest('a[href^="#T"]');
    if (link && !openSheet()) rememberInvoker(link);
  });
  doc.addEventListener('focusin', function (e) {
    var s = openSheet();
    if (s && !$('.panel', s).contains(e.target)) $('h2', s).focus({ preventScroll: true });
  });
  doc.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && openSheet()) { e.preventDefault(); closeSheet(); return; }
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
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input, textarea, select, [contenteditable]')) return;
    var keys = { b: 'board', p: 'plan', h: 'history', s: 'spend' };
    if (keys[e.key] && !openSheet()) { location.hash = keys[e.key]; }
  });

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
  function liveUsage(scope) {
    var now = Date.now();
    var states = [];
    $$('[data-live-state]', scope).forEach(function (row) {
      var at = Date.parse(row.getAttribute('data-live-at'));
      var staleAt = Date.parse(row.getAttribute('data-live-stale-at'));
      var state = row.getAttribute('data-live-state');
      if (now > staleAt) state = 'stale';
      row.setAttribute('data-live-state', state);
      $('.live-state', row).textContent = state;
      var age = Math.max(0, Math.round((now - at) / 1000));
      $('.live-age', row).textContent = (age < 120 ? age + 's' : Math.round(age / 60) + 'm') + ' ago';
      if (states.indexOf(state) < 0) states.push(state);
    });
    $$('[data-live-summary]', scope).forEach(function (el) { el.textContent = states.join(', '); });
    $$('.total[data-live]', scope).forEach(function (el) { el.setAttribute('data-live', states.join(', ')); });
  }
  function times(scope) {
    liveUsage(scope);
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
  }
  function tick() { times(doc); }
  setInterval(tick, 30000);
  setInterval(function () { liveUsage(doc); }, 1000);

  // ---- since you looked ----
  function newest() {
    var top = $('.col-since .ev');
    return top ? top.getAttribute('data-at') : null;
  }
  function since() {
    var col = $('.col-since');
    if (!col) return;
    var items = $$('.ev', col);
    if (!seen) return;
    var fresh = items.filter(function (li) { return li.getAttribute('data-at') > seen; });
    items.forEach(function (li) { li.classList.toggle('new', fresh.indexOf(li) >= 0); });
    var title = $('[data-since-title]', col);
    var when = $('[data-since-when]', col);
    var sum = $('[data-since-sum]', col);
    title.textContent = 'Since you looked';
    when.textContent = 'since ' + rel(seen);
    if (!fresh.length) { sum.textContent = 'Nothing new since you looked. The newest events are below.'; return; }
    var n = { accepted: 0, back: 0, submitted: 0, decisions: 0, messages: 0, trouble: 0 };
    fresh.forEach(function (li) {
      var t = $('.txt', li).textContent;
      var k = li.getAttribute('data-kind');
      if (/ accepted at /.test(t)) n.accepted++;
      else if (/ sent back: /.test(t)) n.back++;
      else if (/ submitted /.test(t)) n.submitted++;
      else if (k === 'decisions') n.decisions++;
      else if (k === 'messages') n.messages++;
      else if (k === 'trouble') n.trouble++;
    });
    var parts = [];
    if (n.accepted) parts.push('<b>' + n.accepted + '</b> accepted');
    if (n.back) parts.push('<b>' + n.back + '</b> sent back');
    if (n.submitted) parts.push('<b>' + n.submitted + '</b> submitted');
    if (n.decisions) parts.push('<b>' + n.decisions + '</b> on decisions');
    if (n.messages) parts.push('<b>' + n.messages + '</b> message' + (n.messages === 1 ? '' : 's'));
    if (n.trouble) parts.push('<b>' + n.trouble + '</b> trouble');
    sum.innerHTML = (parts.length ? parts.join(', ') : '<b>' + fresh.length + '</b> events') + '. New items are marked.';
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
  function badge(count, icon) {
    var title = doc.title.replace(/^\\(\\d+\\) /, '');
    doc.title = (count ? '(' + count + ') ' : '') + title;
    var link = $('link[rel="icon"]');
    if (link && icon) link.href = icon;
  }

  function enhance(scope) {
    times(scope);
    since();
    applyDim();
    filterHistory();
  }
  route(false);
  enhance(doc);

  if (!boot.live) return;

  // ---- live ----
  var known = boot.version;
  var connState = ['connecting', 'Connecting'];
  var pending = false;
  var busy = 0;

  function setConn(state, text) {
    if (state) connState = [state, text];
    var conn = $('.conn');
    conn.setAttribute('data-conn', connState[0]);
    conn.textContent = connState[1];
  }

  function dirty(region) {
    if (region.contains(doc.activeElement) && doc.activeElement.matches('input, textarea, select')) return true;
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
          if (sigs[k] !== el.textContent) el.classList.add('changed');
        });
      });
      pending = held;
      notice(held);
      boot.attention = nb.attention;
      badge(nb.attention, nb.icon[nb.attention ? 1 : 0]);
      setConn();
      position.disclosures(doc, saved);
      enhance(doc);
      route('keep');
      position.restore(doc, saved, openSheet() && $('h2', openSheet()));
      // Say what changed, for people not looking at the column.
      var news = $$('.col-since .ev').filter(function (li) { return before && li.getAttribute('data-at') > before && /\\b(fault|signal|done)\\b/.test(li.className); });
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
    stream = new EventSource('events');
    stream.onopen = function () { setConn('live', 'Live'); };
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

module.exports = { CLIENT };
