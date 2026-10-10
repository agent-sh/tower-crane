'use strict';

// The board's design system as CSS: tokens, then the shell, the components and
// the rooms. docs/design.md is the contract for these values, and
// docs/human-experience.md section 5.4 gives the reason for each.

// Three hues, each with one meaning: attention (a person is needed), alarm
// (failed, or must stop now), live (an agent is working). There is no success
// green: a pass is ink with a check and a receipt.
const LIGHT = {
  ground: '#f4f3ef', surface: '#ffffff', 'surface-2': '#ecebe6', line: '#dcdad3', 'line-strong': '#8f8b82',
  text: '#1a1916', 'text-2': '#45423b', 'text-3': '#5f5b53',
  attn: '#f2b705', 'on-attn': '#1a1916', 'attn-ink': '#7a5100', 'attn-wash': '#fdf3d6',
  alarm: '#b0261c', 'on-alarm': '#ffffff', 'alarm-wash': '#fbeae7',
  live: '#0a5fae', 'live-wash': '#e7f0fa', focus: '#0a5fae',
  scrim: 'rgba(26, 25, 22, 0.32)', shadow: '0 16px 40px rgba(26, 25, 22, 0.18), 0 2px 6px rgba(26, 25, 22, 0.08)',
};
const DARK = {
  ground: '#111215', surface: '#191b1f', 'surface-2': '#212429', line: '#2c3036', 'line-strong': '#6a717b',
  text: '#eceae6', 'text-2': '#bab8b1', 'text-3': '#96938c',
  attn: '#f2b705', 'on-attn': '#1a1916', 'attn-ink': '#f4c64a', 'attn-wash': '#2f2712',
  alarm: '#ff8b7b', 'on-alarm': '#1a1916', 'alarm-wash': '#351b18',
  live: '#7cb5ff', 'live-wash': '#15263a', focus: '#7cb5ff',
  scrim: 'rgba(0, 0, 0, 0.55)', shadow: '0 16px 40px rgba(0, 0, 0, 0.55), 0 2px 6px rgba(0, 0, 0, 0.4)',
};
const vars = (set) => Object.entries(set).map(([k, v]) => `--${k}: ${v};`).join(' ');

// The theme follows the system unless the owner picked one on this browser.
const TOKENS = `
:root {
  color-scheme: light; ${vars(LIGHT)}
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", Ubuntu, Cantarell, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace;
  --t-meta: 12px; --t-dense: 13px; --t-body: 15px; --t-item: 17px; --t-room: 21px; --t-lead: 28px;
  --w-body: 400; --w-mid: 500; --w-strong: 650;
  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px; --s7: 48px;
  --r-item: 6px; --r-room: 10px;
  --ease: cubic-bezier(0.2, 0.7, 0.2, 1);
}
:root[data-theme="dark"] { color-scheme: dark; ${vars(DARK)} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark; ${vars(DARK)} } }
`;

const BASE = `
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; background: var(--ground); }
body { margin: 0; background: var(--ground); color: var(--text); font: var(--w-body) var(--t-body)/1.5 var(--sans); font-variant-numeric: tabular-nums; }
h1, h2, h3, h4, p, ol, ul, figure, blockquote, dl, dd { margin: 0; }
h1, h2, h3, h4 { line-height: 1.25; }
ol, ul { padding: 0; list-style: none; }
a { color: inherit; text-underline-offset: 3px; text-decoration-thickness: 1px; }
button, input, select, textarea { font: inherit; color: inherit; }
code, .mono { font-family: var(--mono); font-size: var(--t-dense); }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: var(--r-item); }
.skip { position: absolute; left: var(--s4); top: -48px; z-index: 50; padding: var(--s2) var(--s3); background: var(--text); color: var(--surface); border-radius: var(--r-item); }
.skip:focus { top: var(--s2); }
.vh { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
time { white-space: nowrap; }
.id { font-weight: var(--w-strong); white-space: nowrap; }
.t2 { color: var(--text-2); }
.t3 { color: var(--text-3); }
.meta { font-size: var(--t-meta); color: var(--text-3); }
.empty { color: var(--text-2); font-size: var(--t-dense); padding: var(--s2) 0; }
`;

const SHELL = `
/* The bar: who, where, the rooms, and how fresh the page is */
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2) var(--s5); padding: var(--s2) var(--s5); background: var(--surface); border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: var(--s2); min-width: 0; }
.brand svg { width: 24px; height: 24px; flex: none; color: var(--text); }
.brand .product { font-size: var(--t-dense); color: var(--text-2); white-space: nowrap; }
.brand .project { font-size: var(--t-body); font-weight: var(--w-strong); white-space: nowrap; }
.rooms { display: flex; flex-wrap: wrap; gap: var(--s1); margin-right: auto; }
.rooms a { display: inline-flex; align-items: center; gap: var(--s2); min-height: 40px; padding: 0 var(--s3); border-radius: var(--r-item); color: var(--text-2); text-decoration: none; font-weight: var(--w-mid); white-space: nowrap; }
.rooms a:hover { color: var(--text); background: var(--surface-2); }
.rooms a[aria-current="page"] { color: var(--text); background: var(--surface-2); box-shadow: inset 0 -3px 0 var(--text); }
.count { display: inline-flex; align-items: center; justify-content: center; min-width: 24px; height: 24px; padding: 0 var(--s1); border-radius: 12px; background: var(--surface-2); color: var(--text); font-size: var(--t-dense); font-weight: var(--w-strong); }
.count.attn { background: var(--attn); color: var(--on-attn); }
.count.alarm { background: var(--alarm); color: var(--on-alarm); }
.state { display: flex; align-items: center; gap: var(--s3); font-size: var(--t-dense); color: var(--text-3); }
.conn[data-conn="lost"] { color: var(--alarm); font-weight: var(--w-strong); }
.theme { display: inline-flex; align-items: center; gap: var(--s1); min-height: 32px; padding: 0 var(--s2); border: 1px solid var(--line); border-radius: var(--r-item); background: transparent; color: var(--text-2); font-size: var(--t-dense); cursor: pointer; }
.theme:hover { color: var(--text); border-color: var(--line-strong); }
html:not(.js) .theme { display: none; }

/* The lead: the status sentence and the spend line */
.lead { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s2) var(--s6); padding: var(--s3) var(--s5) var(--s2); }
.sentence { font-size: var(--t-lead); font-weight: var(--w-strong); letter-spacing: -0.01em; }
.sentence a { text-decoration: none; }
.sentence a:hover { text-decoration: underline; }
.sentence .sep { color: var(--text-3); font-weight: var(--w-body); padding: 0 0.15em; }
.sentence .now { color: var(--alarm); }
.sentence .calm { color: var(--text-2); font-weight: var(--w-mid); }
.spendline { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s1) var(--s4); font-size: var(--t-dense); color: var(--text-2); }
.spendline > span { display: inline-flex; align-items: center; gap: var(--s2); white-space: nowrap; }
.spendline b { color: var(--text); font-weight: var(--w-strong); }
.bar-len { position: relative; display: inline-block; width: 96px; height: 8px; background: var(--surface-2); border: 1px solid var(--line-strong); vertical-align: middle; }
.bar-len > span { position: absolute; inset: 0 auto 0 0; background: var(--text-2); }
.bar-len.near > span { background: var(--attn); }
.bar-len.over > span { background: var(--alarm); }
.bar-len.live > span { background: var(--live); }
`;

const COMPONENTS = `
/* Status glyphs: a shape and a word for every status, never color alone */
.g { width: 14px; height: 14px; flex: none; vertical-align: -2px; }
.g-ready, .g-submitted, .g-accepted { color: var(--text); }
.g-blocked, .g-cancelled { color: var(--text-3); }
.g-in_progress { color: var(--live); }
.g-rework, .g-now, .g-stopping { color: var(--alarm); }
.g-turn { color: var(--attn-ink); }

/* Buttons and fields: 32 px targets, words for every action */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--s1); min-height: 32px; padding: 0 var(--s3); border: 1px solid var(--line-strong); border-radius: var(--r-item); background: var(--surface); color: var(--text); font-size: var(--t-dense); font-weight: var(--w-mid); line-height: 1.25; text-decoration: none; cursor: pointer; white-space: nowrap; list-style: none; transition: background 120ms var(--ease), border-color 120ms var(--ease); }
.btn::-webkit-details-marker { display: none; }
.btn:hover { border-color: var(--text); }
.btn.primary { background: var(--text); border-color: var(--text); color: var(--surface); }
.btn.primary:hover { background: var(--text-2); border-color: var(--text-2); }
.btn.danger { background: var(--alarm); border-color: var(--alarm); color: var(--on-alarm); }
.btn.danger:hover { filter: brightness(0.92); }
.btn.quiet { border-color: transparent; background: transparent; color: var(--text-2); }
.btn.quiet:hover { color: var(--text); border-color: var(--line); }
.btn[disabled] { opacity: 0.5; cursor: default; pointer-events: none; }
.btn .rec { font-weight: var(--w-body); font-size: var(--t-meta); }
.acts { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); margin: var(--s2) 0 0; }
.acts > details.more { margin: 0; }
.acts > .cmd { flex: 1 1 340px; margin: 0; }
.acts > details[open] { flex-basis: 100%; order: 2; }
.field { display: grid; gap: var(--s1); font-size: var(--t-dense); font-weight: var(--w-mid); color: var(--text-2); }
.input, .field input, .field textarea, .field select { width: 100%; min-width: 0; min-height: 32px; padding: var(--s1) var(--s2); background: var(--surface); border: 1px solid var(--line-strong); border-radius: var(--r-item); font-size: var(--t-body); font-weight: var(--w-body); color: var(--text); }
.input::placeholder, .field input::placeholder, .field textarea::placeholder { color: var(--text-3); opacity: 1; }
.field textarea { min-height: 72px; resize: vertical; line-height: 1.5; }
.inline-field { flex: 1 1 200px; min-width: 160px; }
[aria-invalid="true"] { border-color: var(--alarm) !important; }
form output { display: block; font-size: var(--t-dense); }
form output:empty { display: none; }
form output.err { margin-top: var(--s2); padding: var(--s1) var(--s2); background: var(--alarm-wash); color: var(--text); border-left: 3px solid var(--alarm); }
form[aria-busy="true"] { opacity: 0.7; }
details.more { margin: var(--s2) 0 0; }
details.more > summary { display: inline-flex; align-items: center; min-height: 24px; cursor: pointer; font-size: var(--t-dense); color: var(--text-2); text-decoration: underline; list-style: none; }
details.more > summary::-webkit-details-marker { display: none; }

/* Commands to copy: monospace only here, for what goes to a terminal */
.cmd { display: flex; align-items: stretch; margin: var(--s2) 0 0; max-width: 100%; border: 1px solid var(--line); border-radius: var(--r-item); background: var(--surface-2); }
.cmd code { flex: 1; min-width: 0; padding: var(--s1) var(--s2); white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text); }
.cmd button { flex: none; min-height: 32px; min-width: 56px; padding: 0 var(--s2); border: 0; border-left: 1px solid var(--line); background: transparent; color: var(--text-2); font-size: var(--t-meta); font-weight: var(--w-mid); cursor: pointer; border-radius: 0 var(--r-item) var(--r-item) 0; }
.cmd button:hover { color: var(--text); }
html:not(.js) .cmd button { display: none; }

/* Bands of the front room */
.band { min-width: 0; }
.bandh { display: flex; align-items: center; gap: var(--s2); min-height: 32px; margin: 0 0 var(--s2); font-size: var(--t-dense); font-weight: var(--w-strong); color: var(--text-2); }
.bandh .aside { margin-left: auto; font-weight: var(--w-body); color: var(--text-3); font-size: var(--t-meta); }
.calmline { padding: var(--s3) var(--s4); background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-item); color: var(--text-2); }

/* Queue items: a full-width plate, the tier in words at its left edge */
.queue-list { display: grid; gap: var(--s2); }
.qi { position: relative; padding: var(--s2) var(--s4) var(--s3) calc(var(--s4) + 4px); border: 1px solid var(--line); border-radius: var(--r-item); background: var(--surface); }
.qi::before { content: ""; position: absolute; left: -1px; top: -1px; bottom: -1px; width: 5px; border-radius: var(--r-item) 0 0 var(--r-item); }
.qi[data-tier="now"] { background: var(--alarm-wash); border-color: var(--alarm); }
.qi[data-tier="now"]::before { background: var(--alarm); }
.qi[data-tier="turn"] { background: var(--attn-wash); }
.qi[data-tier="turn"]::before { background: var(--attn); }
.qhead { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s1) var(--s2); font-size: var(--t-meta); color: var(--text-2); }
.tier { display: inline-flex; align-items: center; gap: var(--s1); padding: 0 var(--s2); min-height: 20px; border-radius: 10px; font-weight: var(--w-strong); }
.qi[data-tier="now"] .tier { background: var(--alarm); color: var(--on-alarm); }
.qi[data-tier="turn"] .tier { background: var(--attn); color: var(--on-attn); }
.qhead .kind { font-weight: var(--w-strong); color: var(--text); }
.q.quote { font-size: var(--t-body); font-weight: var(--w-body); }
.q { margin: var(--s1) 0 0; font-size: var(--t-item); font-weight: var(--w-strong); overflow-wrap: anywhere; }
.q.quote { max-width: 64ch; }
.conseq, .why { margin: var(--s1) 0 0; font-size: var(--t-dense); color: var(--text-2); max-width: 64ch; }
.conseq b { color: var(--text); font-weight: var(--w-strong); }
.class-word { display: inline-flex; padding: 0 var(--s1); border: 1px solid currentColor; border-radius: var(--r-item); font-size: var(--t-meta); font-weight: var(--w-mid); }

/* Agent rows: a departure board, one row per agent at work */
.floor-list { display: grid; gap: var(--s2); container-type: inline-size; }
.agent { padding: var(--s3) var(--s4); background: var(--surface); border: 1px solid var(--line); border-left: 4px solid var(--live); border-radius: var(--r-item); }
.agent.flagged { border-left-color: var(--alarm); }
.agent.stopped { border-left-color: var(--line-strong); }
.arow { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto auto; grid-template-areas: "g title usage acts" ". facts lease lease"; gap: var(--s1) var(--s3); align-items: center; }
.arow > .g { grid-area: g; }
.arow .title { grid-area: title; min-width: 0; font-weight: var(--w-strong); text-decoration: none; overflow-wrap: anywhere; }
.arow .title:hover { text-decoration: underline; }
.arow .title .id { margin-right: var(--s2); }
.arow .facts { grid-area: facts; min-width: 0; font-size: var(--t-dense); color: var(--text-2); }
.arow .lease { grid-area: lease; justify-self: end; }
.arow .usage { grid-area: usage; justify-self: end; text-align: right; }
.arow .row-acts { grid-area: acts; }
@container (max-width: 519px) {
  .arow { grid-template-columns: 16px minmax(0, 1fr) auto; grid-template-areas: "g title acts" ". usage usage" ". facts facts" ". lease lease"; }
  .arow .usage, .arow .lease { justify-self: start; text-align: left; }
}
@container (min-width: 1240px) {
  .arow { grid-template-columns: 16px minmax(0, 1.6fr) minmax(0, 1.4fr) minmax(170px, auto) minmax(150px, auto) auto; grid-template-areas: "g title facts lease usage acts"; }
}
.lease { display: flex; align-items: center; gap: var(--s2); font-size: var(--t-meta); color: var(--text-2); }
.lease .track { flex: 1 1 80px; max-width: 160px; height: 6px; background: var(--surface-2); border: 1px solid var(--line-strong); }
.lease .fill { display: block; height: 100%; background: var(--live); }
.lease.warn { color: var(--alarm); font-weight: var(--w-mid); }
.lease.warn .fill { background: var(--alarm); }
.usage { display: inline-flex; align-items: center; gap: var(--s2); font-size: var(--t-meta); color: var(--text-3); white-space: nowrap; }
.usage b { font-size: var(--t-body); color: var(--text); font-weight: var(--w-strong); }
.usage .old { color: var(--text-3); font-size: var(--t-body); font-weight: var(--w-mid); }
.spark { width: 64px; height: 18px; flex: none; }
.spark polyline { fill: none; stroke: var(--live); stroke-width: 1.5; }
.flagmark { display: inline-flex; align-items: center; gap: var(--s1); color: var(--alarm); font-size: var(--t-meta); font-weight: var(--w-strong); }
.last { margin: var(--s2) 0 0 28px; padding-left: var(--s3); border-left: 2px solid var(--line); font-size: var(--t-dense); color: var(--text); max-width: 64ch; overflow-wrap: anywhere; }
.last .meta { margin-left: var(--s1); }
.row-acts { position: relative; display: flex; gap: var(--s2); justify-content: flex-end; }
.row-acts details > summary { list-style: none; }
.row-acts details > summary::-webkit-details-marker { display: none; }
.row-acts details[open] > summary { border-color: var(--text); }
/* In place: the panel opens under its own button, over the rows below. */
.row-acts details > :not(summary) { position: absolute; right: 0; top: calc(100% + 6px); z-index: 6; width: min(560px, calc(100vw - 48px)); margin: 0; }
.panel-in { margin: var(--s2) 0 0; padding: var(--s3); background: var(--surface); border: 1px solid var(--line-strong); border-radius: var(--r-item); box-shadow: var(--shadow); }
.panel-in .meta { margin-top: var(--s1); }
.confirm { margin: var(--s2) 0 0; padding: var(--s4); background: var(--surface); border: 1px solid var(--alarm); border-radius: var(--r-item); box-shadow: var(--shadow); max-width: 64ch; animation: open 160ms var(--ease); }
.confirm h4 { font-size: var(--t-item); font-weight: var(--w-strong); }
.confirm dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--s1) var(--s3); margin: var(--s2) 0 0; font-size: var(--t-dense); }
.confirm dt { color: var(--text-2); font-weight: var(--w-mid); }
.stopstate { margin: var(--s2) 0 0 28px; font-size: var(--t-dense); font-weight: var(--w-mid); }
@keyframes open { from { opacity: 0; transform: translateY(-4px); } }

/* Compact rows: up next, blocked, plan layers */
.rows { display: grid; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-item); }
.row { display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 0 var(--s2); padding: var(--s2) var(--s3); border-top: 1px solid var(--line); font-size: var(--t-dense); }
.row:first-child { border-top: 0; }
.row .g { margin-top: 3px; }
.row a { min-width: 0; text-decoration: none; overflow-wrap: anywhere; }
.row a:hover .t { text-decoration: underline; }
.row .t .id { margin-right: var(--s2); }
.row .meta { grid-column: 2; }
.row .meta .why { color: var(--text-2); }
.row .meta .owner { color: var(--attn-ink); font-weight: var(--w-strong); }
.grouph { margin: var(--s3) 0 var(--s2); font-size: var(--t-dense); font-weight: var(--w-strong); color: var(--text-2); }
.grouph:first-child { margin-top: 0; }

/* The digest and History: one sentence per event */
.feed { display: grid; }
.ev { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: var(--s2); padding: var(--s1) 0; border-top: 1px solid var(--line); font-size: var(--t-dense); }
.ev:first-child { border-top: 0; }
.ev time { color: var(--text-3); font-size: var(--t-meta); padding-top: 1px; }
.ev .txt { overflow-wrap: anywhere; }
.ev .txt a { font-weight: var(--w-strong); text-decoration: none; }
.ev .txt a:hover { text-decoration: underline; }
.ev.fault .txt::before, .ev.signal .txt::before { content: ""; display: inline-block; width: 8px; height: 8px; margin-right: var(--s1); vertical-align: 1px; }
.ev.fault .txt::before { background: var(--alarm); clip-path: polygon(50% 0, 100% 100%, 0 100%); }
.ev.signal .txt::before { background: var(--attn); border-radius: 50%; }
.ev.done .txt { font-weight: var(--w-mid); }
.ev.new { box-shadow: inset 3px 0 0 var(--live); padding-left: var(--s2); }
.groups { display: grid; gap: var(--s3); }
.group { padding: var(--s2) var(--s3); background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-item); }
.group h3 { display: flex; align-items: center; gap: var(--s2); font-size: var(--t-dense); font-weight: var(--w-strong); }
.group h3 .count { height: 20px; min-width: 20px; font-size: var(--t-meta); }
.digest-sum { margin: 0 0 var(--s2); font-size: var(--t-dense); color: var(--text-2); }
.digest-sum b { color: var(--text); }

/* Tabs under the floor at mid widths */
.tablist { display: none; gap: var(--s1); margin: 0 0 var(--s2); }
html.js .lower .tablist { display: flex; }
.tablist button { display: inline-flex; align-items: center; gap: var(--s2); min-height: 40px; padding: 0 var(--s3); border: 1px solid var(--line); border-radius: var(--r-item); background: var(--surface); color: var(--text-2); font-weight: var(--w-mid); cursor: pointer; }
.tablist button[aria-selected="true"] { color: var(--text); border-color: var(--text); box-shadow: inset 0 -3px 0 var(--text); }
html.js .lower [role="tabpanel"][hidden] { display: none; }

/* Gate receipts and the review verdict */
.verdict { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s1) var(--s3); font-size: var(--t-dense); font-weight: var(--w-mid); }
.verdict.ok { color: var(--text); }
.verdict.no { color: var(--alarm); }
.pips { display: flex; flex-wrap: wrap; gap: var(--s1) var(--s3); font-size: var(--t-meta); color: var(--text-2); }
.pip { display: inline-flex; align-items: center; gap: var(--s1); white-space: nowrap; }
.pip::before { content: ""; width: 12px; height: 12px; box-sizing: border-box; border: 1.5px dashed var(--text-2); border-radius: 50%; flex: none; }
.pip.pass::before, .pip.fail::before, .pip.waived::before { border-style: solid; border-radius: 2px; }
.pip.pass { color: var(--text); }
.pip.pass::before { content: "\\2713"; display: inline-flex; align-items: center; justify-content: center; background: var(--text); border-color: var(--text); color: var(--surface); font-size: 10px; line-height: 1; }
.pip.fail { color: var(--alarm); font-weight: var(--w-strong); }
.pip.fail::before { content: "\\00d7"; display: inline-flex; align-items: center; justify-content: center; background: var(--alarm); border-color: var(--alarm); color: var(--on-alarm); font-size: 11px; line-height: 1; }
.pip.waived { color: var(--attn-ink); font-weight: var(--w-strong); }
.pip.waived::before { background: var(--attn); border-color: var(--attn-ink); }
.receipts { display: grid; gap: var(--s2); }
.receipt { display: grid; grid-template-columns: minmax(96px, max-content) minmax(0, 1fr); gap: var(--s1) var(--s3); padding: var(--s2) var(--s3); background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-item); font-size: var(--t-dense); }
.receipt .what { color: var(--text-2); }
.receipt.waived { background: var(--attn-wash); border-color: var(--attn-ink); }
.receipt.fail { background: var(--alarm-wash); border-color: var(--alarm); }
.receipt .cmdline { grid-column: 2; font-family: var(--mono); font-size: var(--t-meta); color: var(--text-2); overflow-wrap: anywhere; }

/* Change wash: an item that changed in a live update, once */
.changed { animation: wash 1200ms ease-out; }
@keyframes wash { from { background-color: var(--live-wash); } }
.qi.arrived { animation: arrive 200ms var(--ease); }
.qi.arrived .tier { animation: pulse 600ms ease-out 1; }
@keyframes arrive { from { opacity: 0; transform: translateY(-6px); } }
@keyframes pulse { 40% { transform: scale(1.12); } }

/* Toast and notice */
.toast { position: fixed; z-index: 40; left: 50%; bottom: var(--s5); transform: translateX(-50%); padding: var(--s2) var(--s4); background: var(--text); color: var(--surface); border-radius: var(--r-item); box-shadow: var(--shadow); font-size: var(--t-dense); opacity: 0; pointer-events: none; transition: opacity 200ms var(--ease); max-width: min(64ch, calc(100vw - 32px)); }
.toast.on { opacity: 1; }
.notice { display: none; margin: 0 0 var(--s3); padding: var(--s2) var(--s3); background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--live); font-size: var(--t-dense); border-radius: var(--r-item); }
.notice.on { display: block; }
`;

const ROOMS = `
main { padding: 0 var(--s5) var(--s7); }
.room { display: none; }
html:not(.js) .room:target, html:not(.js) main:not(:has(.room:target)) #now { display: block; }
html.js[data-room="now"] #now, html.js[data-room="review"] #review, html.js[data-room="plan"] #plan, html.js[data-room="spend"] #spend, html.js[data-room="history"] #history { display: block; }
.roomh { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s1) var(--s4); margin: var(--s2) 0 var(--s4); }
.roomh h2 { font-size: var(--t-room); font-weight: var(--w-strong); }
.roomh p { color: var(--text-2); font-size: var(--t-dense); max-width: 64ch; }

/* Now: queue, floor, next and recent */
.now-grid { display: grid; gap: var(--s5); grid-template-columns: minmax(0, 1fr); grid-template-areas: "queue" "floor" "lower"; align-items: start; }
.now-grid .queue { grid-area: queue; }
.now-grid .floor { grid-area: floor; }
.now-grid .lower { grid-area: lower; }
.lower .panels { display: grid; gap: var(--s5); }
@media (min-width: 720px) {
  .now-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-areas: "queue floor" "queue lower"; }
}
/* A long queue at mid widths takes the full width in two columns, so all of
   it is in the first viewport; the floor follows. */
@media (min-width: 720px) and (max-width: 1599px) {
  .now-grid:has(.queue-list > .qi:nth-child(4)) { grid-template-areas: "queue queue" "floor lower"; }
  .now-grid:has(.queue-list > .qi:nth-child(4)) .queue-list { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: start; }
}
@media (min-width: 1600px) {
  .now-grid { grid-template-columns: minmax(0, 1.5fr) minmax(0, 1.25fr) minmax(0, 0.85fr); grid-template-areas: "queue floor lower"; }
  html.js .lower .tablist { display: none; }
  html.js .lower [role="tabpanel"][hidden] { display: block; }
}
@media (min-width: 2600px) {
  .now-grid { grid-template-columns: minmax(0, 2fr) minmax(0, 3fr) minmax(0, 4fr); }
  .lower .panels { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: start; }
}

/* Review */
.review-list { display: grid; gap: var(--s4); max-width: 1480px; }
.rv { padding: var(--s4); background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-room); }
.rv.no { border-left: 4px solid var(--alarm); }
.rv h3 { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s1) var(--s2); font-size: var(--t-item); font-weight: var(--w-strong); }
.rv h3 a { text-decoration: none; }
.rv h3 a:hover { text-decoration: underline; }
.rv .sub { margin: var(--s1) 0 0; font-size: var(--t-dense); color: var(--text-2); }
.rv .why { max-width: 60ch; }
.rv-grid { display: grid; gap: var(--s4); margin: var(--s3) 0 0; }
@media (min-width: 1100px) { .rv-grid { grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); } }
.finding { padding: var(--s2) var(--s3); background: var(--surface-2); border-left: 3px solid var(--line-strong); border-radius: 0 var(--r-item) var(--r-item) 0; max-width: 64ch; }
.rv.no .finding { background: var(--alarm-wash); border-left-color: var(--alarm); }
.finding .by { display: block; margin-top: var(--s1); font-size: var(--t-meta); color: var(--text-2); }
.sec-h { margin: var(--s3) 0 var(--s1); font-size: var(--t-dense); font-weight: var(--w-strong); color: var(--text-2); }
.accept { display: grid; gap: var(--s1); }
.accept li { position: relative; padding-left: var(--s4); font-size: var(--t-dense); max-width: 64ch; overflow-wrap: anywhere; }
.accept li::before { content: ""; position: absolute; left: 2px; top: 8px; width: 6px; height: 6px; background: var(--text-3); }
.waivers { display: grid; gap: var(--s2); max-width: 1480px; }
.waiver { padding: var(--s3) var(--s4); background: var(--attn-wash); border: 1px solid var(--attn-ink); border-radius: var(--r-item); font-size: var(--t-dense); }
.waiver b { font-weight: var(--w-strong); }

/* Plan */
.plan-tools { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s3); margin: 0 0 var(--s3); font-size: var(--t-dense); color: var(--text-2); }
.plan-tools label { display: inline-flex; align-items: center; gap: var(--s2); min-height: 32px; cursor: pointer; }
html:not(.js) .plan-tools label { display: none; }
.legend { display: flex; flex-wrap: wrap; gap: var(--s1) var(--s3); }
.legend li { display: inline-flex; align-items: center; gap: var(--s1); }
.plan-wrap { overflow: auto; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-room); }
svg.graph { display: block; }
.graph .edge { fill: none; stroke: var(--line-strong); stroke-width: 1.2; }
.graph .edge.done { stroke: var(--line); }
.graph .edge.hot { stroke: var(--live); stroke-width: 2; }
.graph .arrow { fill: var(--line-strong); }
.graph .node rect.box { fill: var(--surface); stroke: var(--text-2); stroke-width: 1.2; }
.graph .node text { fill: var(--text); font: var(--w-body) 13px var(--sans); }
.graph .node .nid { font-weight: var(--w-strong); }
.graph .node .nmeta { fill: var(--text-3); font-size: 12px; }
.graph .s-blocked rect.box { stroke: var(--line-strong); stroke-dasharray: 4 3; }
.graph .s-in_progress rect.box { stroke: var(--live); stroke-width: 2.4; fill: var(--live-wash); }
.graph .s-rework rect.box { stroke: var(--alarm); stroke-width: 2.4; fill: var(--alarm-wash); }
.graph .s-accepted rect.box, .graph .s-cancelled rect.box { fill: var(--surface-2); stroke: var(--line); stroke-width: 1; }
.graph .s-accepted text, .graph .s-cancelled text { fill: var(--text-2); }
.graph .s-cancelled .ntitle { text-decoration: line-through; }
.graph .flag { fill: var(--attn); stroke: var(--attn-ink); }
.graph a:focus-visible { outline: none; }
.graph a:focus-visible rect.box, .graph a:hover rect.box { stroke: var(--focus); stroke-width: 2.4; }
.graph.hide-done .s-accepted, .graph.hide-done .s-cancelled, .graph.hide-done .edge.done { opacity: 0.3; }
.layers { display: none; }
.layer + .layer { margin-top: var(--s4); }
@media (max-width: 719px) { .plan-wrap { display: none; } .layers { display: block; } }

/* Spend */
.strip { display: grid; gap: var(--s3); grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); margin: 0 0 var(--s5); max-width: 1600px; }
.stat { padding: var(--s3) var(--s4); background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-item); }
.stat .label { font-size: var(--t-dense); color: var(--text-2); font-weight: var(--w-mid); }
.stat .big { font-size: var(--t-room); font-weight: var(--w-strong); }
.stat .sub { margin: var(--s1) 0 0; font-size: var(--t-dense); color: var(--text-2); }
.stat .bar-len { width: 100%; height: 10px; margin-top: var(--s2); }
.tops { display: grid; gap: var(--s2); margin: 0 0 var(--s5); max-width: 1600px; }
.top { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2) var(--s4); padding: var(--s2) var(--s3); background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-item); font-size: var(--t-dense); }
.top a { text-decoration: none; font-weight: var(--w-strong); }
.top .bar-len { width: 160px; }
.tables { display: grid; gap: var(--s5); max-width: 1600px; }
@media (min-width: 1280px) { .tables { grid-template-columns: 1fr 1fr; } .tables .wide { grid-column: 1 / -1; } }
.tbl-wrap { overflow-x: auto; }
.tbl { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--line); font-size: var(--t-dense); }
.tbl caption { padding: 0 0 var(--s2); text-align: left; font-size: var(--t-dense); font-weight: var(--w-strong); color: var(--text-2); }
.tbl th, .tbl td { padding: var(--s2) var(--s3); text-align: left; border-top: 1px solid var(--line); vertical-align: middle; }
.tbl thead th { border-top: 0; background: var(--surface-2); color: var(--text-2); font-size: var(--t-meta); font-weight: var(--w-strong); white-space: nowrap; }
.tbl td.num, .tbl th.num { text-align: right; white-space: nowrap; }
.tbl .barcell { width: 30%; min-width: 96px; }
.share { height: 8px; background: var(--surface-2); }
.share span { display: block; height: 100%; background: var(--text-2); }

/* History */
.filters { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); margin: 0 0 var(--s4); padding: 0; border: 0; max-width: 1200px; }
.filters input[type="radio"] { position: absolute; opacity: 0; pointer-events: none; }
.filters input[type="radio"] + label { display: inline-flex; align-items: center; min-height: 32px; padding: 0 var(--s3); border: 1px solid var(--line); border-radius: 16px; background: var(--surface); font-size: var(--t-dense); cursor: pointer; }
.filters input[type="radio"] + label:hover { border-color: var(--line-strong); }
.filters input[type="radio"]:checked + label { background: var(--text); border-color: var(--text); color: var(--surface); font-weight: var(--w-mid); }
.filters input[type="radio"]:focus-visible + label { outline: 2px solid var(--focus); outline-offset: 2px; }
.filters .field { margin-left: auto; display: flex; align-items: center; gap: var(--s2); }
.filters .field input { width: 120px; }
html:not(.js) .filters .field { display: none; }
${['flow', 'gates', 'decisions', 'messages', 'owner', 'trouble', 'settings', 'plan'].map((k) => `#history:has(#hf-${k}:checked) .ev:not([data-kind="${k}"]) { display: none; }`).join('\n')}
#history:has(#hf-all:checked) .ev { display: grid; }
#history:has(#hf-main:checked) .ev[data-kind="plan"] { display: none; }
.day { margin: 0 0 var(--s4); max-width: 1200px; }
.day h3 { margin: 0 0 var(--s1); font-size: var(--t-dense); font-weight: var(--w-strong); color: var(--text-2); }
.day .feed { padding: var(--s1) var(--s3); background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-item); }
.history-note { margin: var(--s3) 0 0; color: var(--text-3); font-size: var(--t-dense); }

/* Task sheet: the one other elevated surface */
.sheet { display: none; position: fixed; inset: 0; z-index: 30; }
.sheet:target { display: block; }
html.js .sheet { display: none; }
html.js .sheet.open { display: block; }
.sheet .scrim { position: absolute; inset: 0; background: var(--scrim); }
.sheet .panel { position: absolute; top: 0; right: 0; bottom: 0; width: min(780px, 100vw); display: flex; flex-direction: column; background: var(--ground); box-shadow: var(--shadow); animation: slide 200ms var(--ease); }
@keyframes slide { from { transform: translateX(24px); opacity: 0.4; } }
.shead { padding: var(--s4) var(--s5) var(--s3); background: var(--surface); border-bottom: 1px solid var(--line); }
.shead .top { display: flex; align-items: center; gap: var(--s2); font-size: var(--t-dense); color: var(--text-2); }
.shead .close { margin-left: auto; display: inline-flex; align-items: center; justify-content: center; min-width: 32px; min-height: 32px; padding: 0 var(--s2); border: 1px solid var(--line); border-radius: var(--r-item); text-decoration: none; font-size: var(--t-dense); color: var(--text-2); }
.shead .close:hover { color: var(--text); border-color: var(--line-strong); }
.sheet h2:focus { outline: none; }
.sheet h2 { margin: var(--s1) 0 0; font-size: var(--t-room); font-weight: var(--w-strong); max-width: 64ch; overflow-wrap: anywhere; }
.sheet h2 .id { margin-right: var(--s2); }
.facts { display: flex; flex-wrap: wrap; gap: var(--s1) var(--s4); margin: var(--s2) 0 0; font-size: var(--t-dense); color: var(--text-2); }
.facts b { color: var(--text); font-weight: var(--w-strong); }
.sbody { flex: 1; overflow: auto; overflow-wrap: anywhere; padding: var(--s4) var(--s5) var(--s7); display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s5); align-content: start; }
.sec > h3 { margin: 0 0 var(--s2); font-size: var(--t-dense); font-weight: var(--w-strong); color: var(--text-2); }
.box { padding: var(--s3) var(--s4); background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-item); }
.box + .box { margin-top: var(--s2); }
.blockers li { padding: var(--s1) 0; font-size: var(--t-dense); }
.phase { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: var(--s1); margin: 0 0 var(--s2); font-size: var(--t-meta); color: var(--text-3); }
.phase li { padding-top: var(--s1); border-top: 4px solid var(--line); white-space: nowrap; }
.phase li.done { border-color: var(--text-2); color: var(--text-2); }
.phase li.now { border-color: var(--live); color: var(--text); font-weight: var(--w-strong); }
.ledger { display: grid; gap: var(--s2); }
.ledger > details { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-item); }
.ledger > details > summary { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); min-height: 40px; padding: var(--s1) var(--s3); cursor: pointer; font-size: var(--t-dense); }
.tag { display: inline-flex; align-items: center; padding: 0 var(--s1); border: 1px solid var(--line-strong); border-radius: var(--r-item); color: var(--text-2); font-size: var(--t-meta); }
.tag.live { color: var(--live); border-color: currentColor; }
.entry { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: var(--s1) var(--s3); padding: var(--s2) var(--s3); border-top: 1px solid var(--line); font-size: var(--t-dense); }
.entry .type { font-weight: var(--w-strong); }
.entry .type.fail { color: var(--alarm); }
.entry .by { color: var(--text-2); font-size: var(--t-meta); }
.entry .sum { grid-column: 2; white-space: pre-wrap; overflow-wrap: anywhere; max-width: 64ch; }
.entry details { grid-column: 2; }
.entry details > summary { display: inline-flex; align-items: center; min-height: 24px; font-size: var(--t-meta); color: var(--text-2); cursor: pointer; }
.entry .rcpt { margin: var(--s1) 0 0; padding: var(--s1) var(--s2); background: var(--surface-2); font: var(--t-meta)/1.5 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.entry .nocount { color: var(--text-3); }
.thread { display: grid; gap: var(--s2); }
.msg { padding: var(--s2) var(--s3); background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-item); font-size: var(--t-dense); }
.msg.owner { border-left: 3px solid var(--attn-ink); }
.msg.fault { border-left: 3px solid var(--alarm); }
.msg header { display: flex; flex-wrap: wrap; gap: var(--s2); color: var(--text-3); font-size: var(--t-meta); }
.msg header .who { color: var(--text-2); font-weight: var(--w-mid); }
.msg p { margin: var(--s1) 0 0; white-space: pre-wrap; overflow-wrap: anywhere; max-width: 64ch; }
.links li { display: flex; gap: var(--s2); align-items: baseline; padding: var(--s1) 0; font-size: var(--t-dense); }
.links a { text-decoration: none; }
.links a:hover .t { text-decoration: underline; }
.split2 { display: grid; gap: var(--s4); }
@media (min-width: 640px) { .split2 { grid-template-columns: 1fr 1fr; } }
.box form + form { margin-top: var(--s3); padding-top: var(--s3); border-top: 1px solid var(--line); }

/* Narrow screens */
@media (max-width: 719px) {
  .bar { padding: var(--s2) var(--s4); gap: var(--s1) var(--s3); }
  .brand .product { display: none; }
  .rooms { order: 3; width: 100%; margin: 0 calc(-1 * var(--s1)); }
  .spendline > span { white-space: normal; flex-wrap: wrap; }
  .bar-len { width: 64px; }
  .rooms a { padding: 0 var(--s2); }
  .lead { padding: var(--s3) var(--s4) var(--s2); }
  .sentence { font-size: var(--t-room); }
  main { padding: 0 var(--s4) var(--s7); }
  .sheet .panel { width: 100vw; }
  .shead, .sbody { padding-left: var(--s4); padding-right: var(--s4); }
  .last, .stopstate { margin-left: 0; }
  /* Six steps do not fit their words on a phone; the current one keeps its word. */
  .phase li:not(.now) span { display: none; }
  .phase li.now { overflow: visible; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
  .changed { box-shadow: inset 3px 0 0 var(--live); }
}
@media print {
  .rooms, .skip, .acts, form, .cmd button, .theme { display: none !important; }
  .room { display: block !important; break-before: page; }
}
`;

const CSS = TOKENS + BASE + SHELL + COMPONENTS + ROOMS;

module.exports = { CSS, TOKENS, BASE, COMPONENTS, LIGHT, DARK };
