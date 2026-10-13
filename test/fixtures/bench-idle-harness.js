'use strict';

const fs = require('node:fs');
const [, , ready, finish] = process.argv;
fs.writeFileSync(ready, '');
setInterval(() => {
  if (fs.existsSync(finish)) process.exit(0);
}, 100);
