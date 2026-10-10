'use strict';

// The write token in the browser. Serve puts it in the page only for the one
// request that carries the one-time key it printed, so the page keeps it in
// localStorage, which is scoped to this host and port, for reloads and other
// tabs. The key leaves the address bar so it is not bookmarked or shared;
// that runs before anything reads location.href, such as the reload position.
const TOKEN = `
(function () {
  var name = 'tower-crane:token';
  var meta = document.querySelector('meta[name="tower-crane-token"]');
  if (!meta) return '';
  var token = meta.content;
  try {
    if (token) localStorage.setItem(name, token);
    else token = localStorage.getItem(name) || '';
  } catch (e) { /* storage may be off: the token lasts as long as the page */ }
  if (location.search) history.replaceState(null, '', location.pathname + location.hash);
  return token;
})()`;

module.exports = { TOKEN };
