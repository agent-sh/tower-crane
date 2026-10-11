# T91 board controls

The screenshots show Controls at 1920x1080 in both color schemes, served by `tower-crane serve --agent owner` on a fixture project with three orchestrator escalations recorded from the CLI:

- D1, `project set --merge-admin true`, and D2, `ask --setting publish`: Approve or Decline answers them. An approval is the orchestrator's: its repeat of the same command makes the change once.
- D3, `spawn --role orchestrator --wait`, already approved: it waits for the orchestrator's repeat.

Images:

- [Light theme](controls-light.png)
- [Dark theme](controls-dark.png)

The repository's Chrome driver (`test/browser.js`) captured them. The Playwright MCP browser runs outside the agent sandbox's network and could not reach the sandboxed serve port.

`test/board-controls.test.js` drives the real CLI and serve process. Its Chrome test saves limits, approves and declines requests the owner made there, edits personal fallbacks, pauses the project, saves rung and task values beside unsaved input and reads them back through the selectors, sends a research rung's `web_mcp` as `--web-mcp`, answers an ordinary decision, and checks a 390px viewport. API tests cover each control family, shared audit events, approval retry, orchestrator and publish approvals used by the orchestrator's repeat, release of another agent's live claim, stale-page refusal, viewer refusal, gate waivers, and a supervised fixture's interrupt and delegation. No model runs in the fixture.

Run the touched tests with:

```sh
node --test test/board-controls.test.js test/control-modes.test.js
```

`TOWER_CRANE_BOARD_ARTIFACTS` saves the automated Chrome test's two 1920x1080 screenshots to a directory.
