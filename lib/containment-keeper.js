'use strict';

// The original caller may exit while independently dispatched work is still
// running. Keep its aggregate bound without holding that caller's output open.
require('./containment').guardRemaining(JSON.parse(process.argv[2])).catch(() => {
  process.exitCode = 1;
});
