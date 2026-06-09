# AGENTS.md

## What this is

**autogit** automates the stage → commit → push loop for engineers working with AI coding agents (Claude Code, Codex, etc.). After an agent finishes a task, changes ship to git automatically, with a configurable safety level.

## Safety modes

- **auto** — ship immediately, no gate
- **agent** — a separate LLM reviews the staged diff and approves/rejects before push
- **human** — interactive terminal y/n prompt showing the diff (for sensitive repos)

## Current implementation

A zero-dependency Node.js CLI (`index.js`, ESM, Node ≥18) with three commands:

- `autogit init` — writes a per-repo `.autogit.json` config (mode, remote, branch, secretsScan toggle, OpenRouter review settings)
- `autogit ship -m "message"` — the main pipeline: `git add -A` → regex secrets scan on added lines (AWS/OpenAI/Anthropic/GitHub/Slack/Google keys, private key blocks, `.env` filenames, JWTs; blockable, `--force-secrets` overrides) → mode gate → commit → push
- `autogit status` — show config and repo state

## Key design choices (provisional, open to revision)

- **Agent-invoked CLI**, not a daemon/cron/watcher/git-hook. One instruction line in CLAUDE.md/AGENTS.md tells the agent to run `autogit ship` after each task. Chosen because shell execution is the one interface every agent shares.
- **The agent writes the commit message** — the tool just ships it, no LLM call for message generation.
- **Per-repo JSON config** — safety level is a property of the repo, not the user.
- **Agent-review mode** calls OpenRouter chat completions with the diff (truncated to 60k chars) and parses an `APPROVE:`/`REJECT:` verdict line.
- **npm distribution** — target audience already has Node. (Go/Rust single binary was considered.)

## Fail-safe behaviors

- Default mode is **human**.
- Every rejection fully unstages via `git reset`.
- Human mode refuses to run without a TTY, so an agent can't pipe "y" to approve itself.
- Distinct exit codes: 0 ok, 1 error, 2 rejected, 3 no-TTY — agents can read outcomes programmatically.

## Open questions (confirm with owner before changing)

- **Trigger**: stay agent-invoked, or become a file-watcher/quiescence daemon? Owner does not want to be locked into "agent finishes task" as the only trigger.
- **Agent review**: could the currently-running agent review instead of a separate OpenRouter call?
- **Branch strategy**: currently pushes to current or configured branch — no auto-branching/PR flow yet.
- **Package name**: `autogit-cli` is a placeholder; npm availability unchecked.

## Ground rules for agents

Treat the prototype as a reference implementation of the product intent, not a fixed architecture. Confirm any major structural change with the owner before implementing.

Make all of your responses clear & very concise.
