---
name: npm-publish
description: Help David publish @davidondrej/autogit to npm as fast as possible. Use when David wants to publish/release to npm, hits a publish error (E404, EOTP, auth), or needs to re-auth npm. Contains David-specific context and known failures. Update this skill after each of David's messages during a publish session.
---

# Publish @davidondrej/autogit to npm

## David-specific context (never violate)

- David is ALWAYS already in the right folder. NEVER tell him to `cd`.
- Agents NEVER run `npm publish` themselves (2FA; AGENTS.md rule). Give David the exact command in a code block.
- Scoped package → `--access=public` is required.
- npm 2FA is on: publish asks for an authenticator OTP in the terminal.
- Give ONE command at a time. Very concise. No explanations unless something failed.

## Fast path

```bash
npm publish --access=public
```

Verify after:

```bash
npm view @davidondrej/autogit version
```

## Known failures → fixes

- **E404 on PUT** (`could not be found or you do not have permission`) — stale/invalid auth token. The package exists; npm hides permission errors as 404. Fix: re-auth (below), then publish again.
- **EOTP** — missing/expired one-time password. Rerun publish, enter a fresh authenticator code.

## Re-auth

```bash
npm login
```

Flow: prints a login URL, then waits at "Press ENTER to open in the browser..." — press ENTER, finish the login in the browser (user `davidondrej`), and wait for the terminal to print "Logged in". Then publish again.
Check who's logged in: `npm whoami`.

## Log of past incidents

- 2026-07-03: publishing 0.7.2 hit E404 on PUT — auth token was stale. Re-auth via `npm login` was the fix path.
