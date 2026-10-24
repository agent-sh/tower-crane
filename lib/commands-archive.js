'use strict';

const { many, str, run } = require('./commands-specs');

const COMMANDS = [
  { section: 'Plan', name: 'task archive', pos: ['ID'], usage: 'ID [--path P]... [--into T | --grant T]', summary: "list the archive accept or cancel kept of a task's scratch, or copy files from it into another task's scratch", flags: { path: many('P', 'a file or directory in the archive; repeatable; default all'), into: str('T', "copy into T's scratch and record archive evidence on T"), grant: str('T', "operational (orchestrator or owner): let T's worker copy from this archive") }, description: "list the archive of task ID's scratch that `accept` and cancellation wrote to `archive/ID/` in the state directory: each file's path, original size, stored size and SHA-256, which files were cited, truncated, redacted or binary, the files left out and the truncation notice. `--path P` limits it to a file or a directory and refuses a path the archive does not hold. `--into T` copies the files into T's scratch root as `archive-ID-<path>` (the path URL-encoded), checking each against its manifest SHA-256, and records `archive` evidence on T naming the source and each file; T must be open. The orchestrator and the owner copy into any task; T's worker copies only while it holds T's claim and only from an archive granted to T with `--grant T`, which only the orchestrator or the owner sets. Archives older than `archive.retention_days` (default 30) are removed when one is written or read", run: run('./archive', 'command') },
];

module.exports = COMMANDS;
