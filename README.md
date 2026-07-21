# autogit

<!-- User-facing flow up top; contributor internals below. -->

Your AI coding agent writes the code. **autogit ships it.**

When your agent finishes a turn, autogit stages, commits, and pushes — automatically.

## Quick start

```bash
# 1. Install (once per machine)
npm install -g @davidondrej/autogit
autogit setup

# 2. Enable it per repo
cd your-project
autogit on
```

Done. Every agent turn now ends with: **stage → secrets scan → commit → push.**

> From source instead: `git clone https://github.com/davidondrej/autogit && cd autogit && npm link`

## Supported agents

| Agent | After `autogit setup` |
| --- | --- |
| **Claude Code** | works immediately |
| **Cursor** | works immediately — interactive local + worktree agents, including repos entered or created after the session starts (`agent -p` has no stop hook) |
| **Pi** | works immediately |
| **Codex** | one-time approval: restart open sessions, then run `/hooks` in `codex` and trust autogit (needs ≥ 0.124) — covers the CLI, the Codex desktop app, and the IDE extension |

> Hooks fire for interactive local agent sessions. Cursor `agent -p`, Cursor cloud agents (no local user hooks), Codex cloud tasks, and `codex exec` are not covered — upstream limitations. Codex re-asks for `/hooks` trust whenever autogit updates its hook entries.

## Commands

```
autogit setup     Wire up agent hooks (once per machine)
autogit on        Enable auto-push in this repo
autogit on --agent  Agent mode: an LLM reviews each turn before it ships
autogit off       Disable auto-push in this repo
autogit ship      Stage, scan, commit, push (what the hooks run)
autogit undo      Take back the last autogit commit, local + remote
autogit status    Show hooks + repo state
autogit update    Update autogit to the latest version from npm
autogit --version Print the installed version (-v)
```

**Commit messages**: `autogit ship -m "message"` uses your message. Without `-m`, the subject is the prompt you gave your agent that turn (so `git log` reads like your instructions), falling back to a list of changed files. If the prompt looks like it contains a secret (pasted API key, token, etc.), it's never used — the commit gets the file-list subject instead.

**Undo**: shipped something you regret? `autogit undo` rewinds the remote branch, removes the commit locally, and leaves the changes uncommitted in your working tree — ready to fix and re-ship. Run it again to peel off earlier autogit commits. It refuses to touch commits it didn't make, or remotes that have since moved on.

**Update**: `autogit update` fetches the latest release (`npm install -g` under the hood) and prints old → new version. Running from a source checkout (`npm link`)? It refuses and points you at `git pull` instead.

**Status**: `autogit status` reports the version, which agent hooks are wired, whether auto-push is on here, and a busy line. `busy: N agent(s) mid-turn — shipping deferred` means another agent is still active in this repo, so your change is staged-pending — **not** lost or failed; the last agent to finish ships everything. If something hasn't pushed yet, check here first: a deferred ship during concurrent agents is normal, not a bug.

## Agent mode

Plain autogit ships every turn, subject = your prompt. Agent mode puts an LLM between the turn and the push: one cheap call reviews the staged diff (plus your prompt and recent commit subjects) and decides — ship, or hold?

```bash
autogit on --agent    # asks for an OpenRouter API key once per machine
```

- **Holds** work-in-progress and meaningless churn (debug prints, scratch files, half-implemented features). Held changes stay in your working tree, get re-staged next turn, and are re-reviewed with the bigger diff — nothing is ever discarded.
- **Ships** everything else, with a descriptive commit subject written from the diff — not from your prompt. This fixes the messy-`git log` problem too.
- **Fails open.** No key, API down, 15 s timeout, unusable reply → ships exactly like plain auto mode, with a stderr note. A flaky API can never silently stop your pushes. `autogit status` warns when the key is missing.
- **Secrets stay guarded.** The secrets scan runs *before* the review call, so an unscanned diff never leaves your machine; a prompt that looks like it contains a secret isn't sent either.
- **`-m` bypasses the gate** — an explicit message is human intent, no LLM call spent.
- **Key never touches the repo** — it lives in `~/.autogit/config.json` (mode 0600). The `OPENROUTER_API_KEY` env var overrides it. Agents enable with `autogit on --agent --key <key>`.
- **Undo works unchanged** — agent-shipped commits carry the same trailer.

Model: defaults to `z-ai/glm-5.2` (fast, ~free at diff-review volumes). Pin per repo with `--model <id>` (stored in `.autogit.json`), or set a machine default (`model` in `~/.autogit/config.json`). A `baseUrl` there points the calls at any OpenAI-compatible endpoint. Back to plain auto-push: `autogit on --auto`.

## Safety

- **Opt-in per repo** — repos without `autogit on` are never touched.
- **Public-repo check** — `autogit on` warns when the repo is public on GitHub (your prompts become public commit messages). Humans confirm with y/N; agents must re-run with `autogit on --public-ok`.
- **Multi-account aware** — if `gh` has several GitHub accounts logged in, `autogit on` asks which one pushes this repo and pins it (repo-local git config). Agents pass `--account <name>`.
- **One-command undo** — `autogit undo` takes back the last auto-push, remote included.
- **Secrets scan** — blocks pushes containing API keys, private key blocks, `.env` files, or JWTs, and unstages everything. Template files (`.env.example`, `*.sample`, `*.template`, `*.dist`) are fully exempt — filename and contents — they're meant to be committed, and a template's values are placeholders by definition. Obvious placeholder values (`your-key-here`, `AKIA…EXAMPLE`, `xxxx…`) are exempt everywhere else too. Override real blocks with `--force-secrets`. Commit messages are covered too: a prompt containing a secret never becomes the subject (not overridable).
- **No noise** — nothing changed means nothing shipped. Aborted or errored Cursor turns never ship.
- **Remote-moved aware** — if something else pushed first (another machine, the GitHub web editor), `ship` rebases your commit onto the new remote tip and retries. Real conflicts stop safely: commit kept locally, fix spelled out.
- **Parallel-agent aware** — if another agent is still mid-task in the same repo, autogit waits its turn: the last agent to finish ships everything. (For fully separate commits per agent, use worktrees — autogit handles each independently.)

## Internals

For contributors, human or AI. The implementation is a reference of product intent, not fixed architecture.

### Design

- Single zero-dependency Node.js CLI: `index.js`, ESM, Node ≥18.
- Commands: `setup`, `on`, `off`, `ship`, `undo`, `busy`, `status`, `update`, plus `-v`/`--version` (read from `package.json`, also shown by `status`).
- `autogit update` (added 2026-07-04, after users couldn't find how to update): runs `npm install -g @davidondrej/autogit@latest`, then reports old → new by asking the fresh binary for its version (the running process is still old code). Source checkouts refuse with a `git pull` hint — detected by `.git` next to `index.js` (npm strips it on publish) — so npm can't bury an `npm link` symlink under the registry tarball.
- Modes (DECIDED 2026-06-10: auto only; agent added 2026-07-12): **auto** — ship immediately, no gate. **agent** — an LLM reviews each turn before it ships (see below). **human** (terminal y/n) remains on the roadmap.
- Agent mode (DECIDED 2026-07-12): a separate OpenRouter call — this supersedes the 2026-06-09 decision that the currently-running agent should review. Reason: no agent (Claude/Codex/Cursor/Pi) exposes a review channel from a stop hook — the turn is already over, and exit-2 tricks are exactly what the fail-safes forbid. One API call works uniformly for all four; sending the turn's prompt with the diff recovers most task context.
  - Gate runs after every local gate (opt-in, busy-defer, secrets, branch) so a blocked turn never burns an LLM call; `-m` skips it (human intent).
  - Fail open on everything (no key, timeout 15 s, HTTP error, unparseable reply): ship with plain auto behavior + stderr note. Rationale: autogit is a backup as much as a publisher — a flaky API must never silently stop pushes. Hold = `git reset`, changes stay in the working tree, re-reviewed next turn.
  - Key in `~/.autogit/config.json` (0600; `AUTOGIT_HOME` relocates it for tests/dotfiles), never repo-local — `.autogit.json` is often committed. `OPENROUTER_API_KEY` env wins. Model precedence: repo `model` > global `model` > built-in default. Global `baseUrl` supports any OpenAI-compatible endpoint.
  - No `response_format` in the API call (per-model support varies) — strict-JSON instructions plus defensive parsing (fence/prose stripping, boolean `commit` required); anything unusable fails open. Diff capped at 50 KB with an explicit truncation note. LLM subjects go through the same 72-char flattening as prompts.
  - `on --agent` probes the key (GET `/key`) while a human is present: definitive 401/403 dies without enabling; network trouble passes — offline must never block setup.
- npm name (DECIDED 2026-06-10): **`@davidondrej/autogit`** — unscoped `autogit`/`autogit-cli` taken; `auto-git` rejected by npm's name-similarity rule. The installed binary stays `autogit`. Scoped packages need `npm publish --access=public`.
- Per-repo opt-in is the safety model: `autogit on` writes `.autogit.json`; without it, `ship` is a silent no-op (exit 0). Only enable it where aggressive auto-push is OK.
- Public-repo guard in `on` (added 2026-06-12): parses the `origin` URL for a `github.com` slug, probes `https://api.github.com/repos/<slug>` anonymously (3 s timeout, explicit User-Agent — GitHub rejects UA-less requests). HTTP 200 = public → TTY asks y/N (Ctrl+C/D = No), non-TTY (an agent) dies pointing at `--public-ok`. 404/offline/non-GitHub remotes enable silently — best-effort guard, never a gate. `--public-ok` skips the probe entirely. Runs only at `on`; the ship path is untouched.
- Multi-account pin in `on` (added 2026-06-12): gh's credential helper only ever serves its *active* account (cli/cli#11938), so auto-pushes to a second account's repos 403. Detection reads gh's `hosts.yml` directly (instant — `gh auth status` hits the network for seconds). 2+ accounts on an HTTPS github.com remote → TTY asks which account (number, name, or Enter = active), non-TTY dies pointing at `--account <name>`. The pin is repo-local git config: `credential.username` (osxkeychain/GCM route by it) plus an appended last-resort `credential.helper` that serves `gh auth token --user <name>`. SSH remotes skip the question (keys route those). Re-pin anytime with `autogit on --account <name>` (works while already on); `status` shows the pin; `off` leaves it in place — it fixes manual pushes too.
- `autogit setup` wires lifecycle hooks globally: Claude Code `Stop` (`~/.claude/settings.json`), Codex `Stop` (`~/.codex/hooks.json`, ≥0.124, one-time `/hooks` trust), Cursor `stop` (`~/.cursor/hooks.json`, lowercase events + `version: 1`), and a Pi extension (`~/.pi/agent/extensions/autogit.ts`, fires on `agent_end`). Cursor also imports Claude hooks, so generated Claude commands no-op when `CURSOR_VERSION` is present; only Cursor's native copies perform Git work.
- Codex legacy `notify` is NOT used (single-slot, often taken by other tools; an upstream deprecation was attempted and reverted in 0.129). Codex hook commands run in the session `cwd`, unsandboxed, via `$SHELL -lc` — so `git push` has network and the user's PATH.
- Codex surfaces (verified 2026-06-10): the desktop app and IDE extension run the same CLI core and execute the same `~/.codex/hooks.json`; cloud tasks never fire local hooks, and `codex exec` hook dispatch is broken upstream (openai/codex#26452). Trust is hash-based — any change to the wired commands silently un-trusts them until the user re-runs `/hooks`; editing hooks.json mid-session disables hooks until Codex restarts (#21160). Esc-interrupted turns fire no `Stop`; that turn's changes ship with the next one (busy-marker TTL self-heals).
- `ship` reads an optional JSON payload from stdin (all hook systems pipe one). Cursor repo resolution is strict and ordered: the opted-in repo saved from `postToolUse.cwd`, then the current turn's transcript `working_directory`, then `workspace_roots` as the multi-root fallback. This covers nested repos and repos created after a session starts without recursively scanning folders. Cursor `status` must be `completed`; aborted/errored turns never push. Claude/Codex payloads fall through to cwd behavior.

### How `ship` works

`git add -A` → secrets scan on added lines (AWS/OpenAI/Anthropic/GitHub/Slack/Google keys, private key blocks, `.env` filenames, JWTs; `--force-secrets` overrides) → agent gate (agent mode only: ship-or-hold + subject) → commit → push to `origin`/current branch.

Scan false-positive guards (added 2026-07-03, after every-turn blocks in the field; widened 2026-07-04): filenames ending `.example`/`.sample`/`.template`/`.dist` skip the scan entirely — filename check and content scan. (Contents were scanned at first, but a realistic-looking dummy value is indistinguishable from a real key, so templates kept blocking. Naming a file `*.example` declares its contents committable — deliberate trade-off: a real key pasted into a template ships.) Elsewhere, a matched token containing an obvious placeholder word (`your`, `example`, `changeme`, `xxxx`, …) is ignored — the placeholder test runs against the matched token only, never the whole line, so a real key on a line mentioning "example" still blocks. Note a blocked file stays in the working tree: `git add -A` re-stages it next turn, so a real stray `.env` re-blocks every turn until removed or gitignored (the error message says so).

Non-fast-forward rejection (remote moved — a push from elsewhere) self-heals: fetch, `git rebase FETCH_HEAD`, push again once. The tree is always clean at that point (everything was just committed) so the rebase is safe, and the `Shipped-by` trailer survives it, so `undo` keeps working. A rebase conflict aborts cleanly: commit kept locally, manual fix printed (`git pull --rebase && git push`). Any other push failure still dies with the commit kept locally.

Commit subject precedence: `-m` flag > agent-mode message (LLM-written, from the diff) > the turn's user prompt > the agent's final message (Codex `last_assistant_message`) > file-list fallback (`autogit: update X, Y (+N more)`). Prompt-derived subjects are first checked against `SECRET_PATTERNS` (full text, pre-truncation — the diff scan never sees the message): a match drops to the file-list fallback, with a stderr note. `--force-secrets` deliberately does not override this. The prompt comes from the session's busy-marker content (see below), a `prompt`-like field in the stop payload, or the last real user message in the Cursor/Claude/Codex `transcript_path` JSONL (formats are officially unstable, so parsing is defensive; tool results and `<`-prefixed noise like `<user_instructions>` are skipped). Subjects are flattened to one line, capped at 72 chars. Every commit gets a `Shipped-by: autogit` trailer — that's how `undo` identifies autogit commits.

### How `undo` works

Escape hatch for bad auto-pushes; one commit per run, repeatable. Refuses unless the last commit has the `Shipped-by: autogit` trailer (or legacy `autogit:` subject prefix). Order matters: it rewinds the remote first (`push --force-with-lease` of the parent, only if the remote tip still equals the shipped commit), then `git reset <parent>` (mixed) locally so the changes land back in the working tree uncommitted. Remote tip == parent means the push never landed → local-only undo. Remote moved past the commit → die, undo manually. Works even after `autogit off` (falls back to default remote `origin`).

### Parallel agents (busy markers)

- Problem: `git add -A` would scoop up a second agent's half-finished work when the first agent's turn ends.
- Solution: while an agent is mid-turn it holds a marker file in `<git-dir>/autogit-busy/<session-id>`. `ship` clears its own marker, then defers (exit 0, stderr note) if any *live other* agent's marker survives. The last agent to finish ships everything. No polling, no daemon.
- Liveness is the core check (not just freshness). Each marker stores its owning agent's process id, so `ship` can tell a working agent from a **ghost**. `sweepBusy` scans every marker (no early return) and deletes any that can't be a live other agent: owned by a dead process (crashed/closed agent), owned by *this* agent's own pid (a leftover from a churned session id — compaction/`clear`/resume), or past the TTL backstop. This is why a deferred ship no longer freezes: an orphan marker is reaped on the next ship instead of blocking for the full TTL.
  - The agent pid is resolved by walking up from the hook's parent past the throwaway shell wrapper (`cd … && autogit …`) to the first non-shell ancestor — the long-lived agent. Pi spawns `autogit` directly, so its parent already is the agent.
- Markers are written/refreshed by `autogit busy`, wired to: Claude `UserPromptSubmit` + `PostToolUse`, Codex `UserPromptSubmit` + `PostToolUse`, Cursor `beforeSubmitPrompt` + `postToolUse`, Pi `agent_start` + `tool_execution_end`. Tool hooks refresh the marker so long turns stay fresh. Cursor also records the current generation's exact opted-in repo under `~/.autogit/cursor-sessions/` (0600); `stop` consumes and deletes it.
- Marker payload is JSON `{ pid, prompt }`. Prompt-submit hooks carry the user's prompt, so `busy` writes it into the marker; tool hooks carry none, so they only bump mtime (preserving the content). `ship` reads its own marker before clearing it and uses the prompt as the commit subject. Pi's hooks don't expose the prompt — Pi ships with the file-list fallback. Legacy plain-text markers (pre-pid) are still read as `{ pid: null, prompt }` and fall back to TTL-only gating.
- TTL (`BUSY_TTL_MS`, 10 min) is now a backstop, not the primary signal: it reaps legacy pid-less markers and guards against a recycled pid that happens to look alive. Liveness reaps real ghosts immediately.
- Markers live under the *resolved* git dir (`git rev-parse --git-dir`), so each worktree has its own set — parallel worktree agents never block each other.
- `autogit busy` must stay silent on stdout (some hooks parse stdout). Session ids come from hook payloads (`session_id`/`conversation_id`/`thread_id`/`turn_id`) or `--id` (Pi). No id → no marker (an unattributable marker can never be cleared by its owner and would block shipping until stale).
- Limit: simultaneous agents in ONE directory still end up in one blended commit (shipped by the last finisher). True isolation = worktrees.

### Fail-safes

- Hooks must never disturb the agent: `ship` exits 0 on every no-op path, and never exits 2 (Claude would block its Stop hook; Codex would treat stderr as instructions and *continue the turn*). All output goes to stderr — Codex parses Stop-hook stdout as JSON and injects UserPromptSubmit stdout into model context.
- Secrets scan blocks the push and fully unstages (`git reset`).
- `autogit undo` reverses a bad ship — remote rewind + local uncommit, never touches non-autogit commits.
- Nothing staged → no commit, no push, no noise.

## Roadmap

Owner-gated — don't build these without a go-ahead.

- ~~**agent mode**~~ — shipped 2026-07-12 (see Agent mode above; supersedes the 2026-06-09 running-agent idea).
- **human mode** — terminal y/n prompt on the diff, for production repos. (Existed in the pre-MVP prototype, cut for focus.)
- More agents in `setup` (Pi added 2026-06-10; Hermes next: `post_llm_call` shell hook in `~/.hermes/config.yaml` + reading `cwd` from stdin JSON in `ship` + user consent flow).
- Branch strategy: currently current-branch push only; auto-branch + PR flow considered.

MIT
