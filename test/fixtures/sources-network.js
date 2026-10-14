'use strict';

// CLI fixtures inject the transport through the gate context. Production has
// no setting or environment variable that permits private source addresses.
const gate = require('../../lib/gates/sources');
const { writeAtomic } = require('../atomic-file');
const run = gate.run;
const realFetch = global.fetch;
const pin = process.env.HOOK_SOURCES_PIN === '1';
const dualStack = process.env.HOOK_SOURCES_DUAL_STACK === '1';
const publicAnswers = [
  ...(dualStack ? [{ address: '2606:4700:4700::1111', family: 6 }] : []),
  { address: '93.184.216.34', family: 4 },
];
let lookups = 0;
const fixtureFetch = (url, options) => {
  const at = new URL(url);
  at.protocol = 'http:';
  at.host = new URL(process.env.HOOK_SOURCES_ORIGIN).host;
  return realFetch(at, { ...options, redirect: 'manual' });
};
// Keep before-change proof runs offline even when the old gate ignores injection.
global.fetch = fixtureFetch;
if (pin) {
  const http = require('node:http');
  const original = http.request;
  http.request = (url, options, callback) => {
    const assert = require('node:assert/strict');
    assert.equal(url.hostname, 'source.example');
    assert.equal(options.agent, false);
    assert.equal(lookups, 1, 'connecting must not resolve the hostname again');
    let address;
    options.lookup(url.hostname, { all: false }, (error, value, family) => {
      assert.equal(error, null);
      assert.equal(family, publicAnswers[0].family);
      address = value;
    });
    assert.equal(address, publicAnswers[0].address);
    options.lookup(url.hostname, { all: true }, (error, values) => {
      assert.equal(error, null);
      assert.deepEqual(values, publicAnswers);
    });
    if (dualStack) {
      const at = new URL(url);
      at.port = new URL(process.env.HOOK_SOURCES_ORIGIN).port;
      const lookup = (hostname, lookupOptions, done) => options.lookup(hostname, lookupOptions, (error, values) => {
        assert.equal(lookupOptions.all, true);
        assert.deepEqual(values, publicAnswers);
        writeAtomic(process.env.HOOK_SOURCES_TRACE, JSON.stringify({ lookups, addresses: values }));
        // Both connection attempts stay local; the fixture listens only on IPv4.
        done(error, values.map(value => ({ ...value, address: value.family === 6 ? '::1' : '127.0.0.1' })));
      });
      return original(at, { ...options, lookup, autoSelectFamily: true }, callback);
    }
    writeAtomic(process.env.HOOK_SOURCES_TRACE, JSON.stringify({ lookups, address, host: url.host }));
    const at = new URL(url);
    at.host = new URL(process.env.HOOK_SOURCES_ORIGIN).host;
    return original(at, { ...options, lookup: undefined, headers: { ...options.headers, Host: url.host } }, callback);
  };
}
gate.run = ctx => run({
  ...ctx,
  resolveHost: async hostname => {
    lookups++;
    if (pin && lookups > 1) return [{ address: '127.0.0.1', family: 4 }];
    if (hostname === 'private.example') return [{ address: '10.0.0.1', family: 4 }];
    if (hostname === 'mixed.example') return [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];
    if (hostname === 'source.example') return publicAnswers;
    throw new Error('unexpected fixture DNS lookup');
  },
  ...(!pin ? { fetchPage: async (url, options) => {
    require('node:assert/strict').equal(options.addresses[0].address, '93.184.216.34');
    return fixtureFetch(url, options);
  } } : {}),
});
