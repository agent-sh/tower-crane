'use strict';

// A writer whose clock is CLOCK_BEHIND_MS behind this host's, as on another
// host or after NTP or a VM resume stepped the clock back.
const Real = Date;
const behind = Number(process.env.CLOCK_BEHIND_MS || 5000);
global.Date = class extends Real {
  constructor(...args) {
    if (args.length) super(...args);
    else super(Real.now() - behind);
  }

  static now() {
    return Real.now() - behind;
  }
};
