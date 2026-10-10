'use strict';

// Moves the clock to TOWER_CRANE_TEST_NOW for every `new Date()` and Date.now() in the process. Event times and interval checks then agree, which clock.js cannot do: it moves only Date.now().
if (process.env.TOWER_CRANE_TEST_NOW) {
  const RealDate = Date;
  const offset = Number(process.env.TOWER_CRANE_TEST_NOW) - RealDate.now();
  class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(RealDate.now() + offset);
    }

    static now() {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = ShiftedDate;
}
