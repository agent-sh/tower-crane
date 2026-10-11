# T91 board controls

The screenshots show Controls at 1920x1080 in both color schemes, served by `tower-crane serve --agent owner` on the automated Chrome test's fixture: the owner's pending `merge.admin` change (D2) under Pending approvals, a task blocked on owner work, then every project, agent and task form and the authority table.

Images:

- [Light theme, first screen](controls-light.png) and [whole page](controls-light-full.png)
- [Dark theme, first screen](controls-dark.png) and [whole page](controls-dark-full.png)

The repository's Chrome driver (`test/browser.js`) captured them. The Playwright MCP browser kit runs outside the agent sandbox's network: navigating it to a sandboxed `tower-crane serve` port returns `ERR_CONNECTION_REFUSED` (checked again on 2026-10-11), so the CDP driver stands in for it.

`test/board-controls.test.js` drives the real CLI and serve process. Its Chrome test saves limits, approves and declines requests the owner made there, edits personal fallbacks, pauses the project, saves rung and task values beside unsaved input and reads them back through the selectors, sends a research rung's `web_mcp` as `--web-mcp`, answers an ordinary decision, and checks a 390px viewport. API tests cover each control family, shared audit events, approval retry, orchestrator and publish approvals used by the orchestrator's repeat and never by a later board save, the note naming flags an orchestrator's repeat does not carry, release of another agent's live claim, stale-page refusal, viewer refusal, gate waivers, and a supervised fixture's interrupt and delegation. No model runs in the fixture.

Run the touched tests with:

```sh
node --test test/board-controls.test.js test/control-modes.test.js
```

`TOWER_CRANE_BOARD_ARTIFACTS` saves the automated Chrome test's 1920x1080 screenshots, first screen and whole page, to a directory.
