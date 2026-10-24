# Provider credentials in the OS secret store (T528 phase 1)

Date: 2026-10-22. Versions: Claude Code 2.1.305, codex-cli 0.163.0, systemd 259, gnome-keyring 50.0, libsecret-tools 0.21.7. Tower Crane at origin/main 42bded10. T527's branch has no commits yet.

Method: harness behaviour was observed against a local fake endpoint. It speaks the Anthropic SSE API, the Bedrock InvokeModel event stream and a 404 stub for the OpenAI Responses API. Every credential was fake (`tc-research-fake-*`). No real model was called. The lab is in `/home/avifenesh/.cache/tct/t528/lab`: `fake-server.js`, `run.sh` (Claude), `crun.sh` (Codex), `helper*.sh`, `probe*.sh`, and per-run logs under `runs/`. The throwaway keyring entry and the throwaway kernel key were deleted afterwards. No real secret value was read or printed.

## Summary

- **Claude and Codex can both fetch a credential through a command they run themselves, outside the command sandbox.** The command can read the OS store. Sandboxed commands on Linux cannot reach the store: the D-Bus socket and the systemd-creds varlink socket are both under the hidden `/run`. All of this was verified end to end with a keyring-backed helper.
- **The gap is Claude on Bedrock with a bearer token.** Claude Code 2.1.305 has no helper for `AWS_BEARER_TOKEN_BEDROCK`. It reads it only from the environment. There are two env-free routes:
  - `awsCredentialExport` with STS credentials (SigV4).
  - A loopback broker that injects the bearer, with `CLAUDE_CODE_SKIP_BEDROCK_AUTH=1`.
- **Codex on Bedrock (sol, astra) has a drop-in.** `[model_providers.amazon-bedrock.auth] command` returns a bearer token from a command, and it works through the region router.
- **Codex keyring login cannot be shared with agent homes.** The keyring entry is keyed by a hash of `CODEX_HOME`, and each agent gets its own home.
- **Two Tower Crane gaps to fix with the design:**
  - `sandbox.session_bus: true` exposes the Secret Service to sandboxed commands.
  - The login failure detector does not recognise helper failures.

## Current state in Tower Crane

- **Claude rungs:** five rungs in `.tower-crane/project.json` (easy, hard, research, review, small) set `env_file: ~/.config/claude-code/bedrock.env`.
  - That file holds `AWS_BEARER_TOKEN_BEDROCK`, plus non-secret routing: `CLAUDE_CODE_USE_BEDROCK` and the `ANTHROPIC_DEFAULT_*_MODEL` pins.
  - `lib/spawn-settings.js` `agentEnv` reads it at spawn into the harness environment.
- **Codex:** `lib/agents.js` links `~/.codex/auth.json` and `~/.codex/.env` into each agent home. The `.env` holds only `AWS_BEARER_TOKEN_BEDROCK`, and Codex loads it into its own environment.
  - `sol.config.toml` and `astra.config.toml` both use `model_provider = "amazon-bedrock"`, with `model_providers.amazon-bedrock.base_url` set to the loopback `bedrock-region-router` (127.0.0.1:18765). That router forwards the client's Authorization header.
  - The default `config.toml` uses provider `openai` with a ChatGPT login in `auth.json` (`auth_mode chatgpt`).
- **Claude helpers:** for `apiKeyHelper`, `awsAuthRefresh` and `awsCredentialExport`, the agent home names `lib/auth-helper.js`. It reads and runs the user's command. `~/.claude/settings.json` sets none of the three today.
- **Codex helper fields:** `PROVIDER_FIELDS` in `lib/agents.js` deliberately drops `auth`, `aws.credential_export` and `aws.auth_refresh` from the user's Codex config. Tower Crane would have to generate them itself.

## 1. Claude Code 2.1.305

Sources:
- code.claude.com/docs/en/amazon-bedrock.md (Advanced credential configuration)
- code.claude.com/docs/en/settings-reference (apiKeyHelper, awsAuthRefresh, awsCredentialExport, sandbox.credentials)
- code.claude.com/docs/en/env-vars
- code.claude.com/docs/en/authentication.md (Credential management)
- code.claude.com/docs/en/sandboxing (What runs outside the sandbox)

### Where helpers run

The sandboxing page says helper commands "such as your status line command and apiKeyHelper run with your full access".

Observed: the helper ran in the host mount, PID and network namespaces. It could read a directory that the sandbox `denyRead` hid. Sandboxed Bash in the same session ran in its own namespaces and could not read it. This held for apiKeyHelper (run A4) and awsCredentialExport (run B1).

### apiKeyHelper (Anthropic API and gateways only)

- **Output:** the key on stdout. Claude sent it as both `x-api-key` and `Authorization: Bearer` (A4).
- **When it runs:**
  - Lazily, at the first request.
  - Again once the cache lifetime has passed: 5 minutes by default, or `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`.
  - On a 401 or 403.
  - When a cached JWT has expired.
- **Observed with TTL 2000 ms (A5):** the request that found the cache stale still carried the old key. The helper ran at that moment, and the next request carried the new key. Nothing runs while the session is idle.
- **Failure (A6, A8):** stderr gets `apiKeyHelper failed: exited 3: <helper stderr>`. Against a 401 endpoint, Claude ran the helper three times, printed `Your apiKeyHelper script is failing · ... Run /status to see the script's error output`, and exited 1.
- **401 with a working helper (A7):** Claude reran the helper before every retry, with backoff of about 1, 1, 2, 4, 9, 16 and 35 s. It was still retrying at 90 s.
- **Not a Bedrock credential (B5):** with `CLAUDE_CODE_USE_BEDROCK=1` and only apiKeyHelper, the helper ran once and no request was sent in 40 s. Claude waits on the AWS credential chain. The docs' precedence list puts cloud provider credentials first.
- **Slow helper:** a notice appears after 10 s.
- **Trust:** a helper from project settings waits for workspace trust. Tower Crane passes `--setting-sources user`, so this does not apply.

### awsCredentialExport (Bedrock and Mantle)

- **Output:** JSON in the STS shape `{"Credentials":{AccessKeyId,SecretAccessKey,SessionToken,Expiration}}` or the flat `aws configure export-credentials` shape. `Expiration` is optional.
- **Scope:** the docs say Claude "scopes the credentials to its own Bedrock client, so the shell commands Claude runs still see your ambient credentials". Observed (B1): requests were SigV4-signed with the exported key and session token, and sandboxed Bash had no `AWS_ACCESS_KEY_ID`, secret or session variable.
- **First run:** once, before the first request. The same credentials also signed the startup `GET /inference-profiles` and a Haiku probe call.
- **Refresh, documented:** cached until 5 minutes before `Expiration`, or one hour without one.
- **Refresh, observed (B2, B4, B12):** Claude did not rerun the command on `Expiration`. It kept signing with credentials 17 s past expiry. It reran the command before each retry after a 403 (B3: 7 runs in 35 s). So rotation costs one rejected request when AWS refuses the expired token.
- **Failure messages (binary strings):** `awsCredentialExport did not return a valid value`, `did not return valid AWS STS output structure`, and `Error getting AWS credentials from awsCredentialExport`.

### awsAuthRefresh

It runs only after an STS `GetCallerIdentity` check fails. It is meant to rewrite `~/.aws`, shows its output to the user, and takes no interactive input. A cross-process lock applies (`CLAUDE_CODE_DISABLE_AUTH_REFRESH_LOCK`). It does not help a keyring design. It was not exercised, because it calls real STS.

### Bedrock bearer token

- `AWS_BEARER_TOKEN_BEDROCK` is read from the environment only, and it wins over the credential chain (amazon-bedrock docs).
- There is no helper or setting for it. The binary strings show no bearer helper key.
- Observed (B6): the env token reaches sandboxed Bash.
- `sandbox.credentials.envVars: [{name: "AWS_BEARER_TOKEN_BEDROCK", mode: "deny"}]` removes it from Bash while Claude keeps using it (B8). This is relevant to T527 and avoids `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`'s side effects.

### Can Bedrock use short-lived STS credentials instead of the bearer?

Yes. awsCredentialExport accepts session credentials and Claude signs SigV4 with them (B1, and E1 end to end with a keyring-backed helper). It needs an IAM principal to mint them, for example an access key or role held in the store and exchanged through STS. A Bedrock API key cannot be turned into SigV4 credentials.

### CLAUDE_CODE_SKIP_BEDROCK_AUTH=1

Claude sends no auth header (B9). `ANTHROPIC_BEDROCK_BASE_URL` keeps a path prefix for both `/model/...` and the control-plane `/inference-profiles` call (B10). A loopback broker that injects the bearer can therefore serve Claude with no credential in its environment.

### What sandboxed Bash can reach (Linux)

- Bash runs in separate mount, PID and network namespaces (A4).
- `/proc` shows only the sandbox's own processes (9 PIDs), so the harness's `/proc/<pid>/environ` is out of reach.
- `/run` is denied, so the session bus socket is missing.
- 127.0.0.1 is unreachable: curl failed with rc 7 (B11).

## 2. Codex CLI 0.163.0

Sources:
- Source at tag rust-v0.163.0: `codex-rs/model-provider/src/amazon_bedrock/auth.rs`, `credential_export.rs`, `codex-rs/model-provider-info/src/lib.rs`, `codex-rs/login/src/auth/{storage.rs,external_bearer.rs,bedrock_api_key.rs}`, `codex-rs/keyring-store/Cargo.toml`.
- Config reference at learn.chatgpt.com/docs/config-file/config-reference.
- The installed binary: `@openai/codex-linux-x64/.../codex`. `~/.local/bin/codex` is a wrapper script.

### Bedrock auth sources, in order (auth.rs `auth_source`)

1. `model_providers.amazon-bedrock.auth`: a command that returns a bearer token.
2. `aws.credential_export`: a command that returns SigV4 credentials.
3. `aws.profile`: an AWS profile, so `credential_process` also works.
4. A Codex-managed Bedrock API key, saved by the TUI login into `auth.json` or the keyring.
5. Codex-managed access keys.
6. `AWS_BEARER_TOKEN_BEDROCK` from the environment. This is what Tower Crane uses today, through `.env`.
7. `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` from the environment.
8. The AWS SDK default chain.

`validate_bedrock_override` allows only `base_url`, `auth`, `http_headers`, `aws.profile`, `aws.region`, `aws.credential_export` and `aws.auth_refresh` on the built-in provider.

### auth.command (bearer)

- Runs directly, with no shell. stdin is null. The token is read from stdout.
- stderr is appended to the error message, so a helper must never write the secret there.
- Timeout: `timeout_ms`, default 5000.
- Refresh: lazily at the first request after `refresh_interval_ms` (default 300000); 0 means refresh only after an auth retry.
- Observed (C2): `Bearer` with the command's output, refreshed on the configured interval at the next request.
- Observed end to end with secret-tool (C4): it works through a loopback base URL, as with the region router.
- Failure (C5): `Failed to resolve external auth: provider auth command `...` exited with status ...: <stderr>`. Codex then kept sending requests with no auth header.

### aws.credential_export (SigV4)

- Command: an absolute path or bare name, with no shell. stdin is null and stderr is discarded. Output is capped at 64 KiB. Timeout defaults to 30 s.
- Output uses the same two JSON shapes as Claude.
- Cache: until `Expiration` minus 5 minutes, or one hour without one.
- Observed (C1): SigV4 with service `bedrock-mantle`.
- Not tested: SigV4 through the region router. The router forwards the client's `host` header unchanged, and the signature covers the host, so I did not test or rely on it.

### Login storage (`codex login`, `cli_auth_credentials_store = file | keyring | auto | ephemeral`)

- The keyring backend is the `keyring` crate:
  - Linux: `linux-native-async-persistent` plus `secret-service`.
  - macOS: `apple-native`.
  - Windows: `windows-native`.
- `auto` falls back to `auth.json` when the keyring fails.
- The entry is service `Codex Auth`, account `cli|` plus the first 16 hex digits of sha256 of the canonical `CODEX_HOME` (storage.rs `compute_store_key`).
  - An isolated agent home therefore never sees a keyring login made under `~/.codex`.
  - Tower Crane could only make it work by copying the secret under each agent's key.
  - I did not write a `Codex Auth` keyring entry to test this, because its name cannot carry the `tc-research-fake-` prefix. The finding comes from the source.
- The 0.163.0 `codex login` CLI has only `--with-api-key`, `--with-access-token` and `--device-auth`. The Bedrock API key login lives in the TUI.

### Can Codex get a credential without it entering its environment?

Yes, through `auth.command`, `aws.credential_export` or `aws.profile` with `credential_process`. The value stays in Codex's memory. The command inherits Codex's environment, so it can find the session bus.

### What sandboxed commands can reach (Linux)

Probed with a Tower Crane-like profile: `:minimal` read, the home not named, network enabled.
- Separate mount and PID namespaces.
- **The host network namespace is shared.** So 127.0.0.1 services are reachable (the region router answered 405) and so are abstract sockets.
- The X11 abstract socket accepted the connection but refused setup without the cookie, which sits under the hidden `/run/user/1000`.
- The D-Bus path socket is hidden, so `secret-tool` failed with "Could not connect".
- `systemd-creds --user decrypt` failed: "Failed to connect to io.systemd.Credentials".
- Neither sandbox could find a key in the kernel user keyring (`keyctl search @u` failed).

## 3. OS secret stores

| Store | Headless, boot, SSH | Rotation | Platforms |
|---|---|---|---|
| Secret Service (gnome-keyring, `secret-tool`) | Login keyring unlocks at graphical login. Before that, or SSH-only, a lookup needs a GUI prompt and fails. | `secret-tool store` with the same attributes replaces the value | Linux desktop |
| systemd-creds `--user` | Works from boot with no unlock. Encryption is bound to TPM2 plus the host key. | Re-encrypt the file | Linux, systemd 256 or later |
| macOS Keychain | Locked in some SSH sessions | `add-generic-password -U` | macOS |
| Windows Credential Manager | Network logons have no credential set | `CredWrite` | Windows |

### Linux Secret Service

- This host runs gnome-keyring-daemon 50.0. The `login` collection is unlocked now. Linger is on.
- Observed with a throwaway entry:
  - A lookup takes 16 ms.
  - It works from a systemd user service (`systemd-run --user --pipe`).
  - It works with only `XDG_RUNTIME_DIR` set, because libsecret falls back to `$XDG_RUNTIME_DIR/bus`.
  - It fails with neither bus variable: "Cannot autolaunch D-Bus without X11 $DISPLAY".
- The spec (specifications.freedesktop.org/secret-service-spec, chapters 8 to 10) says locked items cannot be read, unlocking returns a prompt the service shows, and the spec "does not mandate any form of access control".
  - Any process with the bus socket can read unlocked items.
  - Locked or headless means a prompt that cannot show. With linger, user services start at boot while the login keyring is still locked.
  - I did not lock the owner's keyring to test this.

### systemd-creds

- `--user` (since systemd 256) encrypts a credential that "may only be decrypted from the specified user's context" (man systemd-creds). `--with-key=auto` uses TPM2 plus the host key.
- Observed: `systemd-creds --user encrypt` and `decrypt` work from a plain shell.
- Decryption goes through the root varlink socket `/run/systemd/io.systemd.Credentials`, which both sandboxes hide.
- It needs no unlock and works headless.
- Credentials can only be attached to services. Tower Crane's `systemd-run --user --scope` cannot take them, so a helper decrypting on demand is the fit.

### macOS Keychain (`security find-generic-password -s SERVICE -a ACCOUNT -w`)

- Claude's docs say the Keychain can reject access when locked in an SSH session.
- Both sandboxes allow mach-lookup of the keychain service `com.apple.SecurityServer`:
  - Codex: `seatbelt_network_policy.sbpl` at rust-v0.163.0.
  - Claude: sandbox-runtime `macos-sandbox-utils.ts`, which also allows `com.apple.securityd.xpc`.
- Whether a sandboxed `security` call can read an item then depends on whether `~/Library/Keychains` is readable. Tower Crane hides the home. It also depends on the item's ACL, which names binaries, and a sandboxed command can run the same binary.
- **Not verified. It needs a test on the Mac.**
- Separately, Claude Code on macOS keys its own login in the Keychain to `CLAUDE_CONFIG_DIR` (authentication docs), so isolated agent homes do not see the owner's login there.

### Windows Credential Manager

- `CredRead` reads "the user's credential set ... associated with the logon session of the current token". Network logon sessions have none (learn.microsoft.com CredReadW).
- `cmdkey` cannot print secrets, so a helper needs `CredRead` (PowerShell with Add-Type).
- Claude runs commands unsandboxed on native Windows (sandboxing docs). Codex's elevated Windows sandbox runs commands as separate sandbox users.
- **Not verified here.**

## 4. Recommended design

### Principles

- One Tower Crane credential helper reads the OS store.
- Each harness runs it through its own command hook, outside the command sandbox.
- No secret goes in an env file, argv, project.json, events or logs.
- Spawn checks that the credential is present before launch.

### Store and helper

- **Named credentials:** owner config (`~/.config/tower-crane/config.json`) maps names to stores, for example `"credentials": {"bedrock-bearer": {"store": "auto"}}`.
- **Store order for `auto`:**
  - Linux: Secret Service (`service=tower-crane`, `name=<NAME>`), then systemd-creds `--user` (`~/.config/tower-crane/credentials/<NAME>.cred`).
  - macOS: Keychain, service `tower-crane`.
  - Windows: Credential Manager, target `tower-crane:<NAME>`.
- **New `lib/credential-helper.js`:**
  - `value NAME` prints the value on stdout and nothing else.
  - `aws-export NAME` prints STS JSON.
  - `check NAME` reports present or absent through its exit status only.
  - Errors name the store and the fix, never the value.
- **CLI:** `tower-crane credentials set NAME` reads stdin and never argv. `credentials import --env-file PATH --var VAR --name NAME` handles migration. Also `credentials check` and `credentials rm`.
- **Rungs:** a rung names `credentials: {provider: NAME}` instead of `env_file`. Changing the name is owner-required, as `env_file` is. Rotating the value is not.

### Per harness and provider

| Harness, provider | Mechanism | Verified |
|---|---|---|
| Claude, Anthropic API key | Agent settings `apiKeyHelper` = helper `value NAME` | A4 to A8 |
| Claude, Bedrock, IAM principal available | `awsCredentialExport` = helper `aws-export NAME`, returning STS session credentials. Region stays in env (non-secret). | B1, E1 |
| Claude, Bedrock, bearer only (preferred) | Per-spawn loopback broker, like `github-broker.js`. Claude gets `ANTHROPIC_BEDROCK_BASE_URL=http://127.0.0.1:P/<nonce>` and `CLAUDE_CODE_SKIP_BEDROCK_AUTH=1`. The broker adds `Authorization: Bearer` from the store and forwards `/model/*` to bedrock-runtime and `/inference-profiles` to the bedrock control plane, with streamed bodies and Content-Type unchanged. | B9, B10, B11 |
| Claude, Bedrock, bearer only (opt-in fallback) | Spawn reads the store and sets `AWS_BEARER_TOKEN_BEDROCK` in the claude process only, plus `sandbox.credentials.envVars` deny. There is no file. The token stays in the harness's environ and in hooks' and MCP servers' environments. | B8 |
| Codex, Bedrock (sol, astra) | Generated `model_providers.amazon-bedrock.auth = {command = <node>, args = [<helper>, "value", NAME]}` in the agent `config.toml` and in every profile file. Stop linking `.env`. Keep T526's shell policy. | C2, C4, C5 |
| Codex, Bedrock, IAM principal available | `aws.credential_export` with the same helper, when not going through the region router | C1 |
| Codex, OpenAI ChatGPT login | Keep the `auth.json` symlink. It is a file under the hidden home, not env. The keyring store cannot follow isolated homes. | source |
| Codex, OpenAI API key | A custom provider with `auth.command`. `env_key` stays env-based. | docs |

### Notes on the loopback broker

- Codex commands share the host network, so they can reach any 127.0.0.1 port.
- The broker therefore binds per spawn, requires the path nonce, and stops when the spawn ends.
- The nonce sits in the Claude agent's own home. Other agents' homes are hidden by `homes/`.
- Claude's own Bash cannot reach loopback (B11).

### Changes that come with it

- **Session bus:** refuse `sandbox.session_bus: true` with a Secret Service credential, or switch that project to systemd-creds. Correction, in review: switching does not help. Over the bus a command can start a user unit with `systemd-run --user`, which runs outside the sandbox as the owner and reaches systemd-creds and the helper too. The implementation refuses any credential on a route with the grant. The grant puts the bus socket, and so the store, in reach of sandboxed commands. docs/state.md already names "a running secret service" as the risk.
- **Preflight:** spawn runs `helper check NAME` before launch and refuses with "unlock the login keyring" or "run tower-crane credentials set NAME". Without it:
  - Claude retries with backoff for minutes on a 401 (A7).
  - Codex sends unauthenticated requests (C5).
- **Failure detection:** `authFailure` in `lib/spawn-monitor.js` should match `apiKeyHelper failed`, `Your apiKeyHelper script is failing`, `awsCredentialExport did not return`, `Error getting AWS credentials from awsCredentialExport`, `Failed to resolve external auth: provider auth command`, and `AWS credential export command`. A dead credential is then a harness outage, not a task attempt.
- **Readiness checks:** `ClaudeProvider.problems` and `ladder show` treat a credential name as ready credentials.

### Migration from env_file

1. Ship the store, helper, CLI and rung field. `env_file` keeps working during the transition.
2. The owner runs `tower-crane credentials import --env-file ~/.config/claude-code/bedrock.env --var AWS_BEARER_TOKEN_BEDROCK --name bedrock-bearer`. The value never passes through an agent.
3. Rungs drop `env_file` and name `bedrock-bearer`. The non-secret lines move to rung `env` or to `ClaudeProvider.environment`: `CLAUDE_CODE_USE_BEDROCK` and the `ANTHROPIC_DEFAULT_*_MODEL` pins.
4. Codex homes stop linking `.env` and get the generated `auth` command.
5. Remove the secret lines from the env files only after the other readers move. They are outside Tower Crane:
   - `~/.local/bin`: `bedrock-region-router` (reads `~/.codex/.env`), `claude-max`, `claude-glm`, `claude-ctrl`, `revuto-final`, `codex-account-switch`.
   - systemd user units: `revuto`, `atrium-*` and `sxc-refresh-colbert` drop-ins, `sxc-refresh`, and `tacit-*`.
6. Remove the `env_file` code path once no rung uses it. Keep env only behind the explicit fallback.

### Rotation

- **Store:** replace the entry (`secret-tool store`, re-encrypt with systemd-creds, `security add-generic-password -U`).
- **Running harnesses pick it up:**
  - Claude apiKeyHelper: within the TTL, plus one request.
  - Claude awsCredentialExport: on the next credential error (observed), or 5 minutes before expiry (documented).
  - Codex `auth.command`: within `refresh_interval_ms` or after an auth retry.
  - Codex `credential_export`: 5 minutes before expiry.
  - The broker: reads on each request or caches briefly.
- **No respawn is needed**, unlike env.

### Failure modes

| Case | Behaviour | Handling |
|---|---|---|
| Keyring locked at spawn | Helper fails or would prompt | Preflight refuses with an unlock instruction. Headless hosts use systemd-creds. |
| Keyring locks mid-run (logout or reboot) | Next refresh fails | Harness errors are classified as a login outage. Tasks are not burned. |
| No session bus (cron, SSH without login) | `Cannot autolaunch D-Bus` | Pass `XDG_RUNTIME_DIR` (enough for libsecret), or use systemd-creds |
| CI without a keyring | No store | The self-hosted runner server uses systemd-creds. Otherwise the owner opts in per machine to the env fallback (`credentials.<name>.store: "env"`), and `ladder show` flags it. |
| Helper slow | Claude shows a notice after 10 s. Codex times out at 5 s (`auth`) or 30 s (`credential_export`). | Helper does one store read (16 ms measured) |

### Opt-in fallback

`store: "env"` (spawn injects the value into the harness process only, with T527's `sandbox.credentials` deny) or `store: "file"` (a 0600 file under the owner config dir) is set per machine in the owner's personal config. It is never the default, and `ladder show` names it on every use.

## Other findings

- **Codex sandbox and loopback.** Codex sandboxed commands share the host network namespace (`network.enabled = true`), so every 127.0.0.1 service on the host is in reach. LiteLLM on :4000 requires its master key. The region router forwards the caller's own auth.
- **sandbox.credentials vs. the scrub.** `sandbox.credentials.envVars` deny is a narrower fix for T527 than `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` (verified in B8).
- **Docs vs. observed.** The docs for awsCredentialExport's expiry refresh do not match 2.1.305 `-p` behaviour (B12). Return credentials of at least 15 minutes and expect one rejected request at rotation.

## Open questions for the owner

1. Is there an IAM principal (an access key or role) for the Bedrock account, so both harnesses can use one-hour STS credentials? Or is the long-term Bedrock API key all there is?
2. For Claude on Bedrock with only a bearer token: build the loopback broker (no env anywhere), or accept env injection into the claude process only as the interim?
3. Linux store order: Secret Service first, systemd-creds first, or systemd-creds only? And which machines run Tower Crane headless (dev server, runner server)?
4. Which machines, if any, may opt into the env or file fallback, and are agents in CI in scope?
5. Is keeping the Codex ChatGPT `auth.json` link (a file under the hidden home) acceptable?
6. Migrate the other env-file readers (region router, `claude-*` wrappers, revuto, atrium, tacit, sxc units) in T528, or in a separate task?
7. May I test on the Mac: Keychain reachability from both sandboxes, and Claude's login keyed to `CLAUDE_CONFIG_DIR`?
8. With `sandbox.session_bus: true`: refuse Secret Service credentials, or force systemd-creds for that project?