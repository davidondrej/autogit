# autogit

Auto **stage → commit → push** for agentic engineers. Works with any coding agent — Claude Code, Codex, Pi Agent, Hermes, or anything that can run a shell command.

Your agent writes the code *and* the commit message. autogit ships it — with the safety level you choose.

## Install

```bash
npm install -g autogit-cli
```

## Setup (per repo)

```bash
autogit init
```

Creates `.autogit.json`:

```json
{
  "mode": "human",
  "remote": "origin",
  "branch": "current",
  "secretsScan": true,
  "review": {
    "provider": "openrouter",
    "model": "anthropic/claude-sonnet-4.5",
    "apiKeyEnv": "OPENROUTER_API_KEY"
  }
}
```

## Modes

- **`auto`** — ship immediately. For throwaway projects and max velocity.
- **`agent`** — a separate LLM (via OpenRouter) reviews the diff and approves/rejects before push.
- **`human`** — terminal `y/n` prompt showing the diff. For your most sensitive repos.

## Hook up your agent

Add one line to `CLAUDE.md` / `AGENTS.md` / your agent's instructions:

```
After completing each task, run: autogit ship -m "<concise commit message>"
```

That's it. The agent decides *what* to say; autogit decides *whether* it ships.

## Safety

- Secrets scan on every staged diff (AWS, OpenAI, Anthropic, GitHub, Slack, Google keys, private key blocks, `.env` files, JWTs). Blocks the push; override with `--force-secrets`.
- `human` mode refuses to run in non-interactive shells, so an agent can't approve on your behalf.
- Rejections fully unstage — your working tree is untouched.

## Commands

```
autogit init                  Set up .autogit.json
autogit ship -m "message"     Stage, scan, gate, commit, push
autogit status                Show config
```

MIT
