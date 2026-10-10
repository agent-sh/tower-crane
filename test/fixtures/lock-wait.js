'use strict';

// Timeout tests use the real CLI with a shorter acquisition budget.
const S = require('../../lib/state');
const mutate = S.mutate;
S.mutate = (ctx, cmd, fn, waitMs) => mutate(ctx, cmd, fn, waitMs ?? 1000);
