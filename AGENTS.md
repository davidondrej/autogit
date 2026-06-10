# AGENTS.md

## What this is

**autogit** — auto **stage → commit → push** for agentic engineers: people who use AI coding agents (Claude Code, Codex, etc.) for everything and don't write code by hand. After every agent turn, the work ships to GitHub automatically.

## MVP scope (current — DECIDED 2026-06-10)

One mode, two switches:

- **auto mode only.** Ship immediately, no review gate. Review modes come later (see Roadmap).
- **Install once, globally**: `autogit setup` wires the user's agents' lifecycle hooks — Claude Code `Stop` hook (`~/.claude/settings.json`), Codex `Stop` hook (`~/.codex/hooks.json`, Codex ≥0.124, needs one-time `/hooks` trust), Cursor `stop` hook (`~/.cursor/hooks.json`), and a Pi extension (`~/.pi/agent/extensions/autogit.ts`, fires on `agent_end`) — so `autogit ship` runs after every agent turn, in every project.
- **Opt-in per repo**: `autogit on` writes `.autogit.json`. In repos without it, `ship` is a silent no-op (exit 0). The per-repo switch is the safety model for the MVP: only enable it where aggressive auto-push is OK.

## How `ship` works

`git add -A` → secrets scan on added lines (AWS/OpenAI/Anthropic/GitHub/Slack/Google keys, private key blocks, `.env` filenames, JWTs; `--force-secrets` overrides) → commit → push to `origin`/current branch.

Commit message (ADDED 2026-06-10): subject precedence is `-m` flag > the turn's user prompt > file-list fallback (`autogit: update X, Y (+N more)`). The prompt comes from the session's busy-marker content (see below), or a `prompt`-like field in the stop payload, or — Claude only — the last real user message in the `transcript_path` JSONL (skipping tool results and `<`-prefixed slash-command noise). Subjects are flattened to one line, capped at 72 chars. Every commit gets a `Shipped-by: autogit` trailer — that's how `undo` identifies autogit commits.

## How `undo` works (ADDED 2026-06-10)

Escape hatch for bad auto-pushes; one commit per run, repeatable. Refuses unless the last commit has the `Shipped-by: autogit` trailer (or legacy `autogit:` subject prefix). Order matters: it rewinds the remote first (`push --force-with-lease` of the parent, only if the remote tip still equals the shipped commit), then `git reset <parent>` (mixed) locally so the changes land back in the working tree uncommitted. Remote tip == parent means the push never landed → local-only undo. Remote moved past the commit → die, undo manually. Works even after `autogit off` (falls back to default remote `origin`).

## Architecture

- Single zero-dependency Node.js CLI: `index.js`, ESM, Node ≥18, npm-distributed.
- Commands: `setup`, `on`, `off`, `ship`, `undo`, `status`.
- All three JSON configs (Claude `settings.json`, Codex `hooks.json`, Cursor `hooks.json`) merge through one `wireHook()` helper; Claude/Codex share the same `Stop` entry shape, Cursor uses lowercase `stop` + `version: 1`.
- Codex legacy `notify` is NOT used (single-slot, often taken by other tools, deprecated since hooks landed in 0.124). Codex hook commands run in the session `cwd`.
- `ship` reads an optional JSON payload from stdin (all hook systems pipe one): Cursor's carries `workspace_roots` (its hooks run from `~/.cursor`, not the project — multi-root workspaces ship every opted-in root) and `status` (`ship` only proceeds on `completed`, so aborted/errored turns never push). Claude/Codex payloads lack these fields and fall through to cwd behavior.
- Cursor cloud agents don't fire `stop` hooks yet — local + worktree agents only.

## Parallel agents (busy markers — ADDED 2026-06-10)

- Problem: `git add -A` would scoop up a second agent's half-finished work when the first agent's turn ends.
- Solution: while an agent is mid-turn it holds a marker file in `<git-dir>/autogit-busy/<session-id>`. `ship` clears its own marker, then defers (exit 0, stderr note) if any other fresh marker exists. The last agent to finish ships everything. No polling, no daemon.
- Markers are written/refreshed by `autogit busy`, wired to: Claude `UserPromptSubmit` + `PostToolUse`, Codex `UserPromptSubmit` + `PostToolUse`, Cursor `beforeSubmitPrompt` + `postToolUse`, Pi `agent_start` + `tool_execution_end`. Tool hooks refresh the marker so long turns stay fresh.
- Marker content doubles as prompt storage (ADDED 2026-06-10): prompt-submit hooks carry the user's prompt, so `busy` writes it into the marker; tool hooks carry none, so they only bump mtime (preserving the content). `ship` reads its own marker before clearing it and uses the prompt as the commit subject. Pi's hooks don't expose the prompt — Pi ships with the file-list fallback.
- Stale markers (> 15 min, `BUSY_TTL_MS`) mean a crashed agent — they're deleted on sight, so shipping self-heals.
- Markers live under the *resolved* git dir (`git rev-parse --git-dir`), so each worktree has its own set — parallel worktree agents never block each other.
- `autogit busy` must stay silent on stdout (some hooks parse stdout). Session ids come from hook payloads (`session_id`/`conversation_id`/`thread_id`/`turn_id`) or `--id` (Pi). No id → no marker (an unattributable marker can never be cleared by its owner and would block shipping until stale).
- Limit: simultaneous agents in ONE directory still end up in one blended commit (shipped by the last finisher). True isolation = worktrees.

## Fail-safes

- Per-repo opt-in; silent everywhere else.
- `autogit undo` reverses a bad ship — remote rewind + local uncommit, never touches non-autogit commits.
- Hooks must never disturb the agent: `ship` exits 0 on every no-op path, and never exits 2 (which would block Claude Code's Stop hook).
- Secrets scan blocks the push and fully unstages (`git reset`).
- Nothing staged → no commit, no push, no noise.

## Roadmap (do not build without owner)

- **agent mode** — an LLM reviews the diff before push. Owner decision 2026-06-09: the *currently-running* agent should review (it has task context), not a separate OpenRouter call. Mechanics TBD.
- **human mode** — terminal y/n prompt on the diff, for production repos. (Existed in the pre-MVP prototype, cut for focus.)
- More agents (Hermes, …) in `setup`. (Pi added 2026-06-10. Hermes needs `post_llm_call` shell hook in `~/.hermes/config.yaml` + reading `cwd` from stdin JSON in `ship` + user consent flow.)
- Branch strategy: currently current-branch push only; auto-branch + PR flow considered.
- ~~Package name~~ — DECIDED 2026-06-10: npm name is **`@davidondrej/autogit`** (unscoped `autogit`/`autogit-cli` taken; `auto-git` rejected by npm's name-similarity rule). The installed binary stays `autogit`. Scoped packages need `npm publish --access=public`.

## Ground rules

- Keep it minimal: small files, zero dependencies, simplest thing that works.
- Treat the implementation as a reference of product intent, not fixed architecture.
- Confirm any major structural change with the owner before implementing.
