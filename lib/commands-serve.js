'use strict';

const { int, run } = require('./commands-specs');

const COMMANDS = [
  { section: 'Views', name: 'serve', usage: '[--port P]', summary: 'serve the sketch and a Settings view for the ladder and task tiers on 127.0.0.1; pages reload when the state changes', flags: { port: int('P', 'port (default 4747; 0 picks a free one)') }, description: "serve the live board and a Settings view on 127.0.0.1 (default port 4747; 0 picks a free one) and update open pages over server-sent events when the state changes. Pages are rendered from the state on each request. As the owner it also prints a one-time link to open in the browser that will write (`--json` prints `{ url, state, open }`; `open` is `url` for other identities). Exits 1 if the port is in use", run: run('./serve', 'serve') },
];

module.exports = COMMANDS;
