'use strict';

const { str, run } = require('./commands-specs');

const COMMANDS = [
  { section: 'Views', name: 'bench tokens', usage: '[--prices FILE]', summary: 'tokens and priced cost per accepted task, by rung and by escalation path, from spend records', flags: { prices: str('FILE', 'model price table JSON, same shape as review.prices (default: the project review.prices)') }, description: "tokens per accepted task from spend entries: overall, by escalation path (the task's worker rungs in order, repeats collapsed) and by rung, as medians and means with fresh input, cache reads and output split. Missing category totals are null and excluded from that category median. USD uses recorded `cost_usd`, else `--prices` (the `review.prices` shape), else the project `review.prices`, matched first on the exact configured model id, then on the canonical model identity (the Claude provider prefix, 1M suffix and Bedrock version suffix dropped); a run on several models prices each model's own counts. Metered USD is the api-billed part (including Codex Bedrock providers resolved from profile/config), reported beside the list-price equivalent; unknown billing counts only toward list price; unpriced entries are listed by model. Tasks with unknown token entries, unfinalized live usage or spawned sessions missing usage are excluded from all medians and means; recorded live tokens still count in the overall spend total. JSON names missing sessions in `missing_spawns`", run: run('./bench-tokens', 'benchTokens') },
];

module.exports = COMMANDS;
