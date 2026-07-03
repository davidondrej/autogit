---
name: npm-publish
description: Help David publish @davidondrej/autogit to npm as fast as possible. Use when David wants to publish/release to npm, hits a publish error (E404, EOTP, auth), or needs to re-auth npm. Contains David-specific context and known failures. Update this skill after each of David's messages during a publish session.
---

# Publish @davidondrej/autogit to npm

## David-specific context (never violate)

- David is ALWAYS already in the right folder. NEVER tell him to `cd`.
- Agents NEVER run `npm publish` themselves (2FA; AGENTS.md rule). Give David the exact command in a code block.
- Scoped package → `--access=public` is required.
- npm 2FA is on: publish itself pauses at "Authenticate your account at <url> / Press ENTER to open in the browser..." — press ENTER, confirm with the Apple passkey (fingerprint) in Brave, publish continues. (No terminal OTP anymore.)
- Give ONE command at a time. Very concise. No explanations unless something failed.

## What to send David (use this exact format)

When a release is ready, send him this — each command in its own code block, one super-concise instruction line above each. Nothing more.

> Publish (when it pauses: ENTER → passkey in Brave):
>
> ```bash
> npm publish --access=public
> ```
>
> Then verify it's live:
>
> ```bash
> npm view @davidondrej/autogit version
> ```

Only if publish fails with E404 (stale auth), send:

> Re-auth (ENTER → passkey in Brave), then publish again:
>
> ```bash
> npm login
> ```

## Known failures → fixes

- **E404 on PUT** (`could not be found or you do not have permission`) — stale/invalid auth token. The package exists; npm hides permission errors as 404. Fix: re-auth (below), then publish again.
- **EOTP** — missing/expired one-time password (legacy; 2FA is browser-passkey now). Rerun publish and complete the browser auth.

## Re-auth

```bash
npm login
```

Flow: prints a login URL, then waits at "Press ENTER to open in the browser..." — press ENTER. It opens a tab in Brave; David auths with his Apple passkey (fingerprint) — takes seconds. Terminal prints "Logged in on https://registry.npmjs.org/." when done. Then publish again.
Check who's logged in: `npm whoami`.

## The full happy path (verified 2026-07-03, publishing 0.7.2)

1. `npm publish --access=public`
2. Publish pauses → press ENTER → Brave opens → Apple passkey (fingerprint) → publish finishes (`+ @davidondrej/autogit@x.y.z`)
3. Verify: `npm view @davidondrej/autogit version`

Total time when auth is fresh: ~30 seconds. Two passkey touches max (login + publish).

## Log of past incidents

- 2026-07-03: publishing 0.7.2 hit E404 on PUT — auth token was stale. `npm login` fixed it (browser + passkey), then publish worked but paused for its own browser passkey confirmation. E404 = re-auth, nothing else.
