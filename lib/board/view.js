'use strict';

// The board as one HTML document: the shell, the five rooms and a sheet per
// task, drawn from model.js. render writes it as a snapshot; serve sends the
// same document with its token and the owner's forms, at a path per room.

const X = require('./parts');
const Now = require('./now');
const Rooms = require('./rooms');
const { sheet } = require('./sheet');
const { CSS } = require('./style');
const { CLIENT, THEME_BOOT, THEME_TOGGLE } = require('./client');
const { preserve } = require('./identity');

const ROOM_IDS = Now.ROOMS.map(([id]) => id);

// opts: { live, owner, token, version, room }
function page(m, opts = {}) {
  opts = { live: false, owner: false, room: 'now', ...opts };
  if (!ROOM_IDS.includes(opts.room)) opts.room = 'now';
  const boot = { live: opts.live, owner: opts.owner, version: opts.version || null, generated_at: m.generated_at, project: m.project.name, attention: m.queue.length, now: m.sentence.now, title: Now.title(m), icon: [X.favicon(false), X.favicon(true)], cli: X.CLI, rooms: ROOM_IDS };
  return preserve(`<!doctype html>
<html lang="en" data-room="${opts.room}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
${opts.live ? `<meta name="tower-crane-token" content="${X.esc(opts.token)}">\n` : ''}<title>${X.esc(Now.title(m))}</title>
<link rel="icon" href="${X.favicon(m.queue.length > 0)}">
<script>${THEME_BOOT}</script>
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#main">Skip to the board</a>
${X.SYMBOLS}
${Now.bar(m, opts)}
${Now.lead(m, opts)}
<main id="main" tabindex="-1">
<div class="notice" role="status" data-notice></div>
${Now.nowRoom(m, opts)}
${Rooms.reviewRoom(m, opts)}
${Rooms.planRoom(m)}
${Rooms.spendRoom(m, opts)}
${Rooms.historyRoom(m)}
</main>
<div data-region="sheets">${m.sheets.map((s) => sheet(s, m, opts)).join('\n')}</div>
<div class="toast" role="status" aria-live="polite" data-toast></div>
<script type="application/json" id="boot">${X.json(boot)}</script>
<script>${THEME_TOGGLE}${CLIENT}</script>
</body>
</html>
`);
}

module.exports = {
  page, ROOM_IDS, bar: Now.bar, lead: Now.lead, title: Now.title,
  PRODUCT: X.PRODUCT, CLI: X.CLI, esc: X.esc, glyph: X.glyph, status: X.status, SYMBOLS: X.SYMBOLS, MARK: X.MARK, favicon: X.favicon, LABEL: X.LABEL, json: X.json,
};
