# autogit

<!-- Short-form README kept focused on the MVP flow. -->

Your AI coding agent writes the code. **autogit ships it.**

Every time your agent finishes a turn, autogit stages, commits, and pushes — automatically. Built for agentic engineers who don't write code by hand.

Works with **Claude Code**, **Codex**, and **Pi**.

## Install (once per machine)

```bash
npm install -g auto-git
autogit setup
```

`autogit setup` hooks into your agents — Claude Code's `Stop` hook, Codex's `Stop` hook, and a Pi extension — so autogit runs after every agent turn, in every project.

> **Codex one-time step:** Codex requires you to trust new hooks. After setup, open `codex` and run `/hooks` to approve autogit. (Needs Codex ≥ 0.124.)

> Not on npm yet? From source: `git clone https://github.com/davidondrej/autogit && cd autogit && npm link`

## Turn it on (per repo)

```bash
autogit on
```

That's it. From now on: agent finishes → stage → secrets scan → commit → push.

Repos where you didn't run `autogit on` are never touched — autogit stays completely silent there.

## Commands

```
autogit setup     Wire up agent hooks (once per machine)
autogit on        Enable auto-push in this repo
autogit off       Disable auto-push in this repo
autogit ship      Stage, scan, commit, push (what the hook runs)
autogit status    Show hooks + repo state
```

`autogit ship -m "message"` uses your message; without `-m` it auto-generates one from the changed files.

## Safety

- **Opt-in per repo.** Auto-push only happens where you explicitly turned it on.
- **Secrets scan** on every diff: AWS, OpenAI, Anthropic, GitHub, Slack, Google keys, private key blocks, `.env` files, JWTs. Findings block the push and unstage everything. Override with `--force-secrets`.
- **Nothing to commit → no-op.** Question-only agent turns don't create noise.

## Roadmap

- **agent mode** — an LLM reviews the diff before push, for more serious repos.
- **human mode** — terminal y/n prompt on the diff, for production repos.
- More agents.

MIT
