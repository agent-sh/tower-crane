'use strict';

// Never ends on its own: the shard deadline test stops it.
require('node:test')('shard hang', () => new Promise(() => setInterval(() => {}, 60000))); // wait-allow: held open until the shard deadline under test
