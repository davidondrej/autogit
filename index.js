#!/usr/bin/env node
// Zero-dependency CLI, ESM, Node >=18.
// autogit — auto stage→commit→push for agentic engineers
//   autogit setup     wire agent hooks globally (once per machine)
//   autogit on/off    enable/disable auto-push in current repo
//   autogit ship      stage, scan, commit, push (what the hooks run)
//   autogit undo      take back the last autogit commit (local + remote)
//   autogit status    show hooks + repo state
//   autogit update    update autogit to the latest version from npm
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync, statSync, utimesSync, realpathSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const CONFIG_FILE = ".autogit.json";
// Version comes from package.json — single source of truth.
const VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
// Defaults mirror the MVP's current auto-push behavior.
const DEFAULTS = { mode: "auto", remote: "origin", branch: "current", secretsScan: true };
// Trailer added to every commit body — this is how `undo` knows a commit is ours.
const SHIP_TRAILER = "Shipped-by: autogit";

// ---------- helpers ----------
// Helpers wrap git/fs calls so commands above stay readable.

function git(...args) {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: ((r.stdout || "") + (r.stderr || "")).trim() };
}

function die(msg, code = 1) { console.error(`✗ autogit: ${msg}`); process.exit(code); }
// stderr, not stdout: Codex Stop hooks treat plain text on stdout as invalid JSON.
function ok(msg) { console.error(`✓ autogit: ${msg}`); }

function repoRootOrNull() {
  const r = git("rev-parse", "--show-toplevel");
  return r.ok ? r.out : null;
}

// ---------- secrets scanning ----------
// Keep patterns conservative to avoid surprising false positives.

const SECRET_PATTERNS = [
  { name: "AWS access key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "Private key block", re: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: "Generic API key assignment", re: /(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token)["']?\s*[:=]\s*["'][A-Za-z0-9_\-]{20,}["']/i },
  { name: "OpenAI key", re: /\bsk-[A-Za-z0-9_\-]{20,}/ },
  { name: "Anthropic key", re: /sk-ant-[A-Za-z0-9_\-]{20,}/ },
  { name: "GitHub token", re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: "Slack token", re: /xox[baprs]-[A-Za-z0-9\-]{10,}/ },
  { name: "Google API key", re: /AIza[0-9A-Za-z_\-]{35}/ },
  { name: "JWT", re: /eyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/ }
];

const SENSITIVE_FILES = [/^\.env(\..+)?$/, /\.pem$/, /\.key$/, /id_rsa/, /credentials\.json$/];
// Template/placeholder files (.env.example, config.key.template, …) are meant
// to be committed — skip them entirely: filename check AND content scan. A
// realistic-looking dummy value is indistinguishable from a real key, so
// scanning template contents only produces false positives that block every
// turn. Deliberate trade-off: a real key pasted into a template ships —
// naming a file *.example declares its contents committable.
const TEMPLATE_FILE = /\.(example|sample|template|dist)$/i;
// Obvious placeholder values (docs, templates, sample configs) aren't secrets.
// Tested against the matched token only — never the whole line — so a real key
// on a line that merely mentions "example" is still caught. A genuine key
// containing one of these words is possible but astronomically unlikely.
const PLACEHOLDER = /your|example|sample|placeholder|changeme|dummy|redacted|xxxx|1234567890/i;

// Prompts can carry pasted secrets — those must never become commit subjects.
// Checks the full text (not the truncated subject) so a key cut off at 72
// chars can't leak its prefix. Same conservative patterns as the diff scan.
function hasSecret(text) {
  return SECRET_PATTERNS.some(({ re }) => re.test(text));
}

function scanSecrets() {
  const findings = [];
  const staged = git("diff", "--cached", "--name-only").out.split("\n").filter(Boolean);

  for (const f of staged) {
    const base = path.basename(f);
    if (TEMPLATE_FILE.test(base)) continue;
    if (SENSITIVE_FILES.some(re => re.test(base))) {
      findings.push({ file: f, issue: "sensitive filename" });
    }
  }

  // only scan added lines; template files are skipped wholesale (see above)
  let currentFile = "", inTemplate = false;
  for (const line of git("diff", "--cached", "--unified=0").out.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
      inTemplate = TEMPLATE_FILE.test(path.basename(currentFile));
      continue;
    }
    if (inTemplate || !line.startsWith("+") || line.startsWith("+++")) continue;
    for (const { name, re } of SECRET_PATTERNS) {
      const m = line.match(re);
      if (m && !PLACEHOLDER.test(m[0])) findings.push({ file: currentFile, issue: name });
    }
  }
  return findings;
}

// ---------- setup: wire agent hooks globally ----------

// Shared JSON config merge: parse, apply mutations, write only if changed.
function updateJson(file, mutate) {
  let cfg = {};
  if (existsSync(file)) {
    try { cfg = JSON.parse(readFileSync(file, "utf8")); }
    catch { return `could not parse ${file} — skipped, fix it and rerun`; }
  }
  const before = JSON.stringify(cfg);
  mutate(cfg);
  if (JSON.stringify(cfg) === before) return "already wired";
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  return null; // changed — caller crafts the message
}

// Add an entry only if its command isn't anywhere in the config yet —
// makes setup safely re-runnable and lets upgrades add new hooks.
function ensure(cfg, needle, add) {
  if (!JSON.stringify(cfg).includes(needle)) add(cfg);
}

// Claude settings.json and Codex hooks.json share the same event entry shape.
function claudeStyleEntry(cfg, event, command) {
  cfg.hooks ??= {};
  cfg.hooks[event] ??= [];
  cfg.hooks[event].push({ hooks: [{ type: "command", command }] });
}

function setupClaude() {
  if (!existsSync(path.join(homedir(), ".claude"))) return "not installed — skipped";
  const file = path.join(homedir(), ".claude", "settings.json");
  // cd to the project dir: Claude hooks don't guarantee the working directory
  const ship = 'cd "${CLAUDE_PROJECT_DIR:-.}" && autogit ship';
  const busy = 'cd "${CLAUDE_PROJECT_DIR:-.}" && autogit busy';
  return updateJson(file, cfg => {
    ensure(cfg, "autogit ship", c => claudeStyleEntry(c, "Stop", ship));
    ensure(cfg, "autogit busy", c => {
      claudeStyleEntry(c, "UserPromptSubmit", busy);
      claudeStyleEntry(c, "PostToolUse", busy); // refreshes the marker during long turns
    });
  }) ?? `wired (${file})`;
}

function setupCodex() {
  if (!existsSync(path.join(homedir(), ".codex"))) return "not installed — skipped";
  // Codex ≥0.124 lifecycle hooks; runs commands in the session cwd.
  // Separate file, so the user's config.toml (incl. legacy notify) stays untouched.
  const file = path.join(homedir(), ".codex", "hooks.json");
  return updateJson(file, cfg => {
    ensure(cfg, "autogit ship", c => claudeStyleEntry(c, "Stop", "autogit ship"));
    ensure(cfg, "autogit busy", c => {
      claudeStyleEntry(c, "UserPromptSubmit", "autogit busy");
      claudeStyleEntry(c, "PostToolUse", "autogit busy");
    });
  // Codex trust is hash-based: it silently skips hooks until the user trusts
  // them via /hooks, and re-flags them whenever this file's entries change.
  // Live edits also disable hooks in already-running sessions until restart.
  }) ?? `wired (${file}) — restart any open codex sessions, then run /hooks inside codex to trust autogit`;
}

function setupCursor() {
  if (!existsSync(path.join(homedir(), ".cursor"))) return "not installed — skipped";
  // Cursor stop hooks run from ~/.cursor and pass workspace_roots via stdin JSON.
  // Local + worktree agents fire it; cloud agents don't support stop hooks yet.
  const file = path.join(homedir(), ".cursor", "hooks.json");
  const entry = (cfg, event, command) => {
    cfg.hooks ??= {};
    cfg.hooks[event] ??= [];
    cfg.hooks[event].push({ command });
  };
  return updateJson(file, cfg => {
    cfg.version ??= 1;
    ensure(cfg, "autogit ship", c => entry(c, "stop", "autogit ship"));
    ensure(cfg, "autogit busy", c => {
      entry(c, "beforeSubmitPrompt", "autogit busy");
      entry(c, "postToolUse", "autogit busy");
    });
  }) ?? `wired (${file})`;
}

// Pi auto-discovers extensions in ~/.pi/agent/extensions/ — we drop one in.
// Plain ESM, no types: valid for Pi's jiti loader, easy to verify with node.
const PI_EXTENSION = `// autogit — auto stage→commit→push after every agent turn
// Generated by \`autogit setup\`. Delete this file to unwire Pi.
import { spawn } from "node:child_process";

export default function (pi) {
  const id = "pi-" + process.pid;
  const busy = (ctx) => {
    spawn("autogit", ["busy", "--id", id], { cwd: ctx.cwd, stdio: "ignore" }).on("error", () => {});
  };
  pi.on("agent_start", (_event, ctx) => busy(ctx));
  pi.on("tool_execution_end", (_event, ctx) => busy(ctx)); // refresh during long turns

  pi.on("agent_end", (_event, ctx) => {
    const p = spawn("autogit", ["ship", "--id", id], { cwd: ctx.cwd, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => {
      if (code !== 0) ctx.ui.notify("autogit: " + (err.trim() || "ship failed"), "error");
    });
    p.on("error", () => ctx.ui.notify("autogit: not found on PATH", "error"));
  });
}
`;

function setupPi() {
  const dir = path.join(homedir(), ".pi");
  if (!existsSync(dir)) return "not installed — skipped";
  const file = path.join(dir, "agent", "extensions", "autogit.ts");
  // content compare, so upgrades rewrite the extension
  if (existsSync(file) && readFileSync(file, "utf8") === PI_EXTENSION) return "already wired";
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, PI_EXTENSION);
  return `wired (extension at ${file})`;
}

function cmdSetup() {
  console.log(`Claude Code:  ${setupClaude()}`);
  console.log(`Codex:        ${setupCodex()}`);
  console.log(`Cursor:       ${setupCursor()}`);
  console.log(`Pi:           ${setupPi()}`);
  console.log(`\nNow opt in the repos you want auto-pushed:\n  cd <repo> && autogit on`);
}

// ---------- public-repo guard ----------
// `on` warns before enabling auto-push on a public GitHub repo: prompts become
// public commit subjects, and pushed mistakes are scraped within seconds.
// Best-effort and GitHub-only — offline or non-GitHub remotes enable silently.

function githubSlug(url) {
  // https://github.com/o/r(.git) · git@github.com:o/r(.git) · ssh://git@github.com/o/r
  const m = url.match(/[/@]github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

async function isPublicOnGitHub(slug) {
  try {
    const res = await fetch(`https://api.github.com/repos/${slug}`, {
      headers: { "User-Agent": "autogit" }, // GitHub rejects UA-less requests
      signal: AbortSignal.timeout(3000)
    });
    return res.status === 200; // anonymous 200 = public; 404 = private; else unknown
  } catch { return false; }
}

async function confirmPublic(slug) {
  console.error(`⚠ autogit: this repo is PUBLIC on GitHub (${slug}).`);
  console.error("  Auto-push makes your prompts public commit messages, visible to anyone.");
  // no terminal to ask on (an agent ran this) — refuse, with the override spelled out
  if (!process.stdin.isTTY) die("run `autogit on --public-ok` to enable anyway.");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  let a = "";
  try { a = (await rl.question("  Enable anyway? [y/N] ")).trim().toLowerCase(); }
  catch {} // Ctrl+C / Ctrl+D at the prompt counts as No
  finally { rl.close(); }
  if (a !== "y" && a !== "yes") die("aborted — auto-push stays off.");
}

// ---------- GitHub account pinning ----------
// gh supports multiple logged-in accounts, but its credential helper only ever
// serves the *active* one — pushes to the other account's repos 403. Fix at
// `on` time: when gh knows 2+ accounts, ask which one this repo pushes as and
// pin it repo-locally:
//   credential.username → routes osxkeychain / Git-Credential-Manager
//   credential.helper   → appended fallback serving that user's gh token
// Detection reads gh's hosts.yml directly — `gh auth status` hits the network
// (seconds); the file read is instant and works even if gh moved off PATH.

function ghHostsFile() {
  const base = process.env.GH_CONFIG_DIR
    || (process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, "gh")
                                    : path.join(homedir(), ".config", "gh"));
  return path.join(base, "hosts.yml");
}

// Tiny purpose-built parse of gh's own file: the github.com block, the keys
// under `users:`, and the active `user:` value. Tolerant of indent width.
function ghAccounts() {
  let text;
  try { text = readFileSync(ghHostsFile(), "utf8"); } catch { return []; }
  const names = []; let active = null;
  let inGithub = false, usersIndent = -1, childIndent = -1;
  for (const raw of text.split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) { inGithub = line === "github.com:"; usersIndent = childIndent = -1; continue; }
    if (!inGithub) continue;
    if (usersIndent !== -1 && indent <= usersIndent) { usersIndent = childIndent = -1; } // left the users block
    if (usersIndent === -1) {
      if (line === "users:") { usersIndent = indent; continue; }
      const m = line.match(/^user:\s*(\S+)/);
      if (m) active = m[1];
      continue;
    }
    if (childIndent === -1) childIndent = indent; // first child sets the level
    if (indent === childIndent) {
      const m = line.match(/^([\w-]+):/);
      if (m) names.push(m[1]);
    }
  }
  return names.map(name => ({ name, active: name === active }));
}

function pinAccount(name, knownToGh) {
  if (!/^[\w-]+$/.test(name)) die(`"${name}" doesn't look like a GitHub username.`);
  git("config", "credential.username", name); // keychain/GCM route by this
  if (knownToGh) {
    // last-resort helper: if no earlier helper serves this username, hand git
    // that user's gh token. Appended repo-locally; re-pinning replaces it.
    git("config", "--unset-all", "credential.helper", "gh auth token");
    git("config", "--add", "credential.helper",
      `!f() { [ "$1" = get ] && t=$(gh auth token --user ${name} 2>/dev/null) && [ -n "$t" ] && echo "password=$t"; :; }; f`);
  }
  ok(`this repo now pushes as ${name}.`);
}

async function chooseAccount(args) {
  const i = args.indexOf("--account");
  const flag = i !== -1 ? args[i + 1] : null;
  const accounts = ghAccounts();
  if (flag) {
    const known = accounts.some(a => a.name === flag);
    if (accounts.length && !known)
      die(`gh doesn't know "${flag}" — logged in: ${accounts.map(a => a.name).join(", ")}.`);
    pinAccount(flag, known);
    return;
  }
  if (accounts.length < 2) return; // zero/one account — nothing to disambiguate
  console.error("autogit: multiple GitHub accounts are logged in:");
  accounts.forEach((a, n) => console.error(`    ${n + 1}. ${a.name}${a.active ? " (active)" : ""}`));
  if (!process.stdin.isTTY) die("pick one for this repo: autogit on --account <name>");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  let ans = null;
  try { ans = (await rl.question(`  Which account pushes this repo? [1-${accounts.length}, Enter = active] `)).trim(); }
  catch {} // Ctrl+C / Ctrl+D
  finally { rl.close(); }
  if (ans === null) die("aborted — auto-push stays off.");
  const picked = accounts[Number(ans) - 1]
    || accounts.find(a => a.name === ans)
    || (ans === "" ? accounts.find(a => a.active) : null);
  if (!picked) die(`no account "${ans}" — aborted, auto-push stays off.`);
  pinAccount(picked.name, true);
}

// ---------- on / off ----------

async function cmdOn(args) {
  const root = repoRootOrNull();
  if (!root) die("not inside a git repository.");
  const p = path.join(root, CONFIG_FILE);
  if (existsSync(p)) {
    // already on — flags still work without toggling: --account re-pins,
    // --agent / --auto switch the mode in place
    if (args.includes("--account")) await chooseAccount(args);
    if (args.includes("--agent")) await enableAgentMode(p, args);
    else if (args.includes("--auto")) { updateRepoConfig(p, { mode: "auto" }); ok("agent mode OFF — back to plain auto-push."); }
    else if (!args.includes("--account")) ok("already on.");
    return;
  }
  const remote = git("remote", "get-url", "origin");
  const url = remote.ok ? remote.out : "";
  const slug = githubSlug(url);
  if (slug && !args.includes("--public-ok") && await isPublicOnGitHub(slug)) await confirmPublic(slug);
  // account pin only applies to HTTPS github remotes — SSH routes by key
  if (slug && /^https?:\/\//.test(url)) await chooseAccount(args);
  if (args.includes("--agent")) { await enableAgentMode(p, args); return; }
  writeFileSync(p, JSON.stringify({ mode: "auto" }, null, 2) + "\n");
  ok(`auto-push ON — every agent turn in this repo now ships to git.`);
}

function cmdOff() {
  const root = repoRootOrNull();
  if (!root) die("not inside a git repository.");
  const p = path.join(root, CONFIG_FILE);
  if (!existsSync(p)) { ok("already off."); return; }
  unlinkSync(p);
  ok("auto-push OFF.");
}

// ---------- busy markers ----------
// While an agent is mid-turn it holds a marker file; ship defers if any other
// agent's marker is fresh. The last agent to finish ships everything.

// PID liveness is the primary "is this agent still working?" signal. This TTL is
// only a backstop: it reaps legacy (pre-pid) markers and guards against a
// recycled pid that happens to look alive on a marker we never cleaned.
const BUSY_TTL_MS = 10 * 60 * 1000;

function busyDir(root) {
  // resolve the real git dir — in worktrees, <root>/.git is a file, and each
  // worktree gets its own dir, which isolates busy markers per checkout
  const gd = git("rev-parse", "--git-dir").out; // relative to cwd, or absolute in worktrees
  return path.join(path.resolve(process.cwd(), gd), "autogit-busy");
}

// The agent is the long-lived process that spawned this hook. Hooks run via a
// throwaway shell wrapper (`cd … && autogit …`) that exits the instant the hook
// returns, so our own ppid is that dead shell — useless for liveness. Walk up
// past shells to the real agent. Verified tree: node → zsh → claude. Pi spawns
// autogit directly, so its parent is already the agent (a non-shell).
const SHELL_RE = /(^|\/|-)(sh|bash|zsh|dash|fish|env)$/;
function agentPid() {
  let pid = process.ppid;
  for (let i = 0; i < 6 && pid > 1; i++) {
    const r = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" });
    const m = (r.stdout || "").trim().match(/^\s*(\d+)\s+(.*)$/);
    if (!m) break;
    if (!SHELL_RE.test(m[2].trim())) return pid; // first non-shell ancestor = the agent
    pid = parseInt(m[1], 10);
  }
  return process.ppid;
}

// `process.kill(pid, 0)` probes existence without signalling: ESRCH = gone,
// EPERM = exists but owned by another user (still alive).
function isAlive(pid) {
  if (!pid || pid <= 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

// Marker payload = the owning agent's pid + this turn's prompt, as JSON. The pid
// lets ship tell a live agent from an orphan — a dead process, or our own
// churned session id (compaction / clear / resume leaves the old marker behind).
// Legacy markers are bare prompt text; they read back as { pid: null }.
function writeMarker(file, pid, prompt) {
  writeFileSync(file, JSON.stringify({ pid: pid || null, prompt: prompt || "" }));
}
function readMarker(file) {
  try {
    const t = readFileSync(file, "utf8").trim();
    if (t.startsWith("{")) { const o = JSON.parse(t); return { pid: o.pid || null, prompt: (o.prompt || "").trim() || null }; }
    return { pid: null, prompt: t || null };
  } catch { return null; }
}

function sessionId(payload, args) {
  const i = args.indexOf("--id");
  if (i !== -1 && args[i + 1]) return args[i + 1];
  const raw = payload?.session_id || payload?.conversation_id
    || payload?.thread_id || payload?.["thread-id"]
    || payload?.turn_id || payload?.["turn-id"];
  return raw ? String(raw) : null;
}

function markerPath(root, id) {
  return path.join(busyDir(root), id.replace(/[^A-Za-z0-9._-]/g, "_"));
}

// `autogit busy` — called by agent start/tool hooks; touches this session's marker.
// Must stay silent: some hooks treat stdout as context or JSON.
// Marker content = the turn's user prompt (prompt-submit hooks carry it) —
// ship reads it back as the commit subject. Tool hooks carry no prompt, so
// they only refresh mtime and leave the stored prompt alone.
function cmdBusy(args) {
  const payload = readStdinPayload();
  const id = sessionId(payload, args);
  if (!id) return; // no session id → no marker: nobody could ever clear it
  const prompt = promptText(payload);
  const pid = agentPid(); // stamped into the marker so ship can check liveness
  const roots = payload?.workspace_roots?.length ? payload.workspace_roots : [process.cwd()];
  for (const dir of roots) {
    try {
      process.chdir(dir);
      const root = repoRootOrNull();
      if (!root || !existsSync(path.join(root, CONFIG_FILE))) continue; // only opted-in repos
      const marker = markerPath(root, id);
      mkdirSync(path.dirname(marker), { recursive: true });
      if (prompt || !existsSync(marker)) writeMarker(marker, pid, prompt);
      else { const now = new Date(); utimesSync(marker, now, now); } // mtime is the freshness signal
    } catch {}
  }
}

// Read & clear this session's own marker; returns the stored prompt (if any).
function takeOwnMarker(root, id) {
  if (!id) return null;
  try {
    const p = markerPath(root, id);
    const m = readMarker(p);
    unlinkSync(p);
    return m?.prompt || null;
  } catch { return null; }
}

// Sweep every marker (no early return) and delete the ones that can't represent
// a live *other* agent:
//   • mine    — owned by THIS agent's pid: a leftover from our own churned
//               session id (compaction / clear / resume). Same process = it's us.
//   • dead    — owned by a process that no longer exists (crashed / closed agent).
//   • stale   — past the TTL backstop (covers legacy pid-less markers & pid reuse).
// Returns true only if a marker from a live, *different* agent survives — the one
// case where deferring is correct.
function sweepBusyMarkers(root, myPid, { reapMine = true } = {}) {
  const dir = busyDir(root);
  if (!existsSync(dir)) return 0;
  let live = 0;
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    try {
      const stale = Date.now() - statSync(p).mtimeMs > BUSY_TTL_MS;
      const m = readMarker(p);
      const pid = m?.pid || null;
      const mine = reapMine && pid && myPid && pid === myPid;
      const dead = pid != null && !isAlive(pid);
      if (stale || mine || dead) { unlinkSync(p); continue; }
      live++;
    } catch {}
  }
  return live;
}

function sweepBusy(root, myPid) {
  return sweepBusyMarkers(root, myPid) > 0;
}

// ---------- agent mode (LLM commit gate) ----------
// mode "agent": before committing, one LLM call reviews the turn's staged diff
// and decides ship-vs-hold, plus writes a descriptive commit subject.
// DECIDED 2026-07-12: a separate OpenRouter call, superseding the 2026-06-09
// running-agent idea — no agent exposes a review channel from a stop hook (the
// turn is already over), and one API call works uniformly for all four agents.
// The turn's prompt is sent along with the diff, recovering most task context.
// Fail open everywhere: no key, timeout, HTTP error, unparseable reply → ship
// with plain auto behavior. autogit is a backup as much as a publisher — a
// flaky API must never silently stop pushes. Held changes stay in the working
// tree; next turn's `git add -A` re-stages them and the agent re-decides.

const OPENROUTER_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "z-ai/glm-5.2"; // cheap + fast; override with --model or global config
const AGENT_TIMEOUT_MS = 15_000; // hooks have their own ~60s timeouts — stay well under
const MAX_DIFF_CHARS = 50_000;   // huge turns send a truncated diff, not a blown context

// The key lives machine-global, never in the repo — .autogit.json is often
// committed. AUTOGIT_HOME is honored so tests (and dotfile setups) can relocate it.
function globalConfigFile() {
  return path.join(process.env.AUTOGIT_HOME || homedir(), ".autogit", "config.json");
}

function readGlobalConfig() {
  try { return JSON.parse(readFileSync(globalConfigFile(), "utf8")); } catch { return {}; }
}

// The config holds a secret — 0600 on create, and chmod for pre-existing files.
function writeGlobalConfig(cfg) {
  const file = globalConfigFile();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {}
}

// Key: env var wins (CI, one-offs), then the global config. Model precedence:
// repo .autogit.json > global config > built-in default. baseUrl is global-only —
// any OpenAI-compatible endpoint works (LiteLLM, a proxy, …).
function agentSettings(repoCfg) {
  const g = readGlobalConfig();
  return {
    key: process.env.OPENROUTER_API_KEY || g.openrouterApiKey || null,
    model: repoCfg?.model || g.model || DEFAULT_MODEL,
    baseUrl: (g.baseUrl || OPENROUTER_URL).replace(/\/+$/, "")
  };
}

// Ship-vs-hold policy. Bias to ship: held work exists only on this machine.
const AGENT_SYSTEM_PROMPT = `You are the commit gate for autogit, a tool that auto-commits and auto-pushes after every AI coding-agent turn. Review one turn's staged changes and decide: ship them now, or hold them for a later turn.

HOLD only when shipping now would clearly hurt:
- work in progress — half-implemented features, broken or unfinished code that later turns will complete
- meaningless churn — debug prints, scratch/temp files, commented-out experiments, accidental edits that add nothing on their own

SHIP everything else, including small but complete changes (a typo fix, a doc tweak). When unsure, ship: autogit is also a backup — held work exists only on this machine, and held changes are re-reviewed next turn anyway.

Reply with ONLY this JSON (no markdown, no commentary):
{"commit": true or false, "reason": "short user-facing reason for your decision", "message": "commit subject"}

The message must describe what actually changed and why, from the diff — imperative mood, specific, max 72 characters. Never restate the user's prompt or say "update files". Always fill in message, even when holding.`;

function capDiff(diff) {
  if (diff.length <= MAX_DIFF_CHARS) return diff;
  return diff.slice(0, MAX_DIFF_CHARS)
    + `\n[diff truncated — showing ${MAX_DIFF_CHARS} of ${diff.length} chars]`;
}

function buildReviewRequest({ prompt, nameStatus, diff, recent }) {
  return [
    `User's prompt for this turn:\n${prompt || "(not captured)"}`,
    recent ? `Recent commit subjects (style reference):\n${recent}` : null,
    `Staged files:\n${nameStatus}`,
    `Staged diff:\n${capDiff(diff)}`
  ].filter(Boolean).join("\n\n");
}

// Models wrap JSON in fences or prose no matter what you ask — dig out the
// object and validate the one field that matters. Unparseable → null → fail open.
function parseDecision(text) {
  const m = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (typeof o.commit !== "boolean") return null;
    return {
      commit: o.commit,
      reason: typeof o.reason === "string" ? o.reason.trim() : "",
      message: typeof o.message === "string" ? o.message.trim().replace(/^["'`]+|["'`]+$/g, "") : ""
    };
  } catch { return null; }
}

// One chat-completions call. No response_format: support varies per model, and
// defensive parsing covers every model. Throws with a short reason on any
// failure — the caller turns that into a fail-open note.
async function agentDecide(settings, review) {
  let res;
  try {
    res = await fetch(`${settings.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.key}`,
        "Content-Type": "application/json",
        // OpenRouter attribution headers (optional, ignored elsewhere)
        "HTTP-Referer": "https://github.com/davidondrej/autogit",
        "X-Title": "autogit"
      },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          { role: "system", content: AGENT_SYSTEM_PROMPT },
          { role: "user", content: review }
        ]
      }),
      signal: AbortSignal.timeout(AGENT_TIMEOUT_MS)
    });
  } catch (e) {
    throw new Error(e.name === "TimeoutError" ? `no reply in ${AGENT_TIMEOUT_MS / 1000}s` : "network error");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let content;
  try { content = (await res.json())?.choices?.[0]?.message?.content; } catch {}
  const decision = parseDecision(content);
  if (!decision) throw new Error("unusable reply");
  return decision;
}

// The gate ship consults. Returns { hold: reason } (don't commit),
// { subject } (commit with the LLM's message), or { subject: null }
// (review unavailable — fail open to the normal subject chain).
async function agentGate(prompt, repoCfg) {
  const settings = agentSettings(repoCfg);
  if (!settings.key) {
    console.error("autogit: agent mode has no OpenRouter key (run: autogit on --agent) — shipping without review.");
    return { subject: null };
  }
  try {
    const log = git("log", "-5", "--format=%s");
    const review = buildReviewRequest({
      prompt,
      nameStatus: git("diff", "--cached", "--name-status").out,
      diff: git("diff", "--cached").out,
      recent: log.ok ? log.out : ""
    });
    const d = await agentDecide(settings, review);
    if (!d.commit) return { hold: d.reason || "not ready to ship" };
    return { subject: d.message ? subjectFrom(d.message) : null };
  } catch (e) {
    console.error(`autogit: agent review unavailable (${e.message}) — shipping without it.`);
    return { subject: null };
  }
}

// -- agent-mode setup (the `on --agent` path) --

// Best-effort key probe, same spirit as the public-repo check: a definitive
// 401/403 fails while the human is present to fix it; network trouble passes —
// being offline must never block setup.
async function keyLooksValid(key, baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/key`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000)
    });
    return res.status !== 401 && res.status !== 403;
  } catch { return true; }
}

async function saveKey(key, baseUrl) {
  if (!(await keyLooksValid(key, baseUrl)))
    die("OpenRouter rejected that key — check it at https://openrouter.ai/keys and rerun.");
  writeGlobalConfig({ ...readGlobalConfig(), openrouterApiKey: key });
  ok(`OpenRouter key saved to ${globalConfigFile()}.`);
}

// Get a key into place: --key flag > already set (env or global config) >
// TTY prompt. Dies without touching the repo config if none is available.
async function ensureAgentKey(args) {
  const i = args.indexOf("--key");
  const flagKey = i !== -1 ? (args[i + 1] || "").trim() : null;
  if (i !== -1 && !flagKey) die("--key needs a value: autogit on --agent --key <key>");
  const { key: existing, baseUrl } = agentSettings(null);
  if (flagKey) { await saveKey(flagKey, baseUrl); return; }
  if (existing) return;
  if (!process.stdin.isTTY)
    die("agent mode needs an OpenRouter API key — rerun with: autogit on --agent --key <key>");
  console.error("autogit: agent mode sends each turn's diff to OpenRouter for review.");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  let key = "";
  try { key = (await rl.question("  OpenRouter API key (from https://openrouter.ai/keys): ")).trim(); }
  catch {} // Ctrl+C / Ctrl+D
  finally { rl.close(); }
  if (!key) die("no key entered — agent mode not enabled.");
  await saveKey(key, baseUrl);
}

// Merge fields into .autogit.json, preserving anything else in it.
function updateRepoConfig(p, fields) {
  let cfg = {};
  if (existsSync(p)) { try { cfg = JSON.parse(readFileSync(p, "utf8")); } catch {} }
  Object.assign(cfg, fields);
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
}

// Key first (may die), repo config second — a failed key setup must leave the
// repo exactly as it was.
async function enableAgentMode(p, args) {
  await ensureAgentKey(args);
  const i = args.indexOf("--model");
  const model = i !== -1 ? (args[i + 1] || "").trim() : null;
  if (i !== -1 && !model) die(`--model needs a value, e.g. --model ${DEFAULT_MODEL}`);
  updateRepoConfig(p, model ? { mode: "agent", model } : { mode: "agent" });
  const effective = model || agentSettings(null).model;
  ok(`agent mode ON — ${effective} reviews every turn before it ships.`);
}

// ---------- ship ----------

function autoMessage(stagedFiles) {
  const names = stagedFiles.map(f => path.basename(f));
  const head = names.slice(0, 3).join(", ");
  const rest = names.length > 3 ? ` (+${names.length - 3} more)` : "";
  return `autogit: update ${head}${rest}`;
}

// Pull the user's prompt out of a hook payload. Prompt-submit payloads vary
// per agent — check the common spellings, both string and { text } shapes.
function promptText(payload) {
  for (const v of [payload?.prompt, payload?.text, payload?.user_prompt, payload?.message]) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v?.text === "string" && v.text.trim()) return v.text.trim();
  }
  return null;
}

// Stop payloads carry no prompt, but point at the session transcript.
// Claude transcripts and Codex rollouts are both JSONL — walk backwards for
// the last real user message. Line shapes (officially unstable; parse defensively):
//   Claude: {"type":"user","message":{"content":"..."|[{"type":"text","text":"..."}]}}
//   Codex:  {"type":"event_msg","payload":{"type":"user_message","message":"..."}}
function lastPromptFromTranscript(file) {
  try {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      let e; try { e = JSON.parse(lines[i]); } catch { continue; }
      let text;
      if (e.type === "user" && !e.isMeta) { // Claude
        const c = e.message?.content;
        text = typeof c === "string" ? c
          : Array.isArray(c) ? c.filter(p => p.type === "text").map(p => p.text).join(" ") : "";
      } else if (e.type === "event_msg" && e.payload?.type === "user_message") { // Codex
        text = typeof e.payload.message === "string" ? e.payload.message : "";
      } else continue;
      // skip tool results, slash-command noise, <user_instructions>/<environment_context> blobs
      if (!text.trim() || text.trim().startsWith("<")) continue;
      return text.trim();
    }
  } catch {}
  return null;
}

// One-line commit subject, capped at the conventional 72 chars.
function subjectFrom(prompt) {
  const s = prompt.replace(/\s+/g, " ").trim();
  return s.length > 72 ? s.slice(0, 69).trimEnd() + "..." : s;
}

// Hooks (Cursor, Claude, Codex) pass a JSON payload on stdin.
function readStdinPayload() {
  if (process.stdin.isTTY) return null;
  try {
    const raw = readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function cmdShip(args) {
  const payload = readStdinPayload();
  // Cursor reports turn status — never ship aborted or errored turns
  if (payload?.status && payload.status !== "completed") process.exit(0);
  // Cursor hooks run from ~/.cursor; the real project dirs come in the payload
  const roots = payload?.workspace_roots?.length ? payload.workspace_roots : [process.cwd()];
  const id = sessionId(payload, args);
  for (const dir of roots) await shipRepo(dir, args, id, payload);
}

async function shipRepo(dir, args, id, payload) {
  try { process.chdir(dir); } catch { return; }

  // silent no-op unless this is a repo that opted in — hooks fire everywhere
  const root = repoRootOrNull();
  if (!root) return;
  const cfgPath = path.join(root, CONFIG_FILE);
  if (!existsSync(cfgPath)) return;
  process.chdir(root);

  // clear our own marker first — it may hold this turn's prompt
  const storedPrompt = takeOwnMarker(root, id);

  // another agent mid-turn? defer — the last one to finish ships everything.
  // sweepBusy also reaps our own orphaned markers (churned session id) and any
  // left by dead agents, so a ghost can no longer block shipping for the full TTL.
  if (sweepBusy(root, agentPid())) {
    console.error("autogit: deferred — another agent is still working in this repo.");
    return;
  }

  let config;
  try { config = { ...DEFAULTS, ...JSON.parse(readFileSync(cfgPath, "utf8")) }; }
  catch { die(`${CONFIG_FILE} is not valid JSON.`); }
  if (config.mode !== "auto" && config.mode !== "agent") {
    console.error(`autogit: mode "${config.mode}" not supported yet — skipping.`);
    return;
  }

  const mIdx = args.indexOf("-m");
  const message = mIdx !== -1 ? args[mIdx + 1] : null;

  git("add", "-A");
  const staged = git("diff", "--cached", "--name-only").out.split("\n").filter(Boolean);
  if (!staged.length) return; // nothing changed — stay quiet

  if (config.secretsScan && !args.includes("--force-secrets")) {
    const findings = scanSecrets();
    if (findings.length) {
      git("reset");
      console.error("✗ autogit: blocked — possible secrets in the diff:");
      for (const f of findings) console.error(`    ${f.file}: ${f.issue}`);
      die("remove the secrets, .gitignore the files, or rerun with --force-secrets.");
    }
  }

  const branch = config.branch === "current" ? git("rev-parse", "--abbrev-ref", "HEAD").out : config.branch;
  if (branch === "HEAD") { git("reset"); die("detached HEAD — won't auto-push."); }

  // subject: explicit -m > agent-mode message > this turn's prompt (busy
  // marker, payload, or transcript) > the agent's final message (Codex Stop
  // payload) > file list. Trailer marks the commit as ours.
  let prompt = storedPrompt || promptText(payload)
    || (payload?.transcript_path ? lastPromptFromTranscript(payload.transcript_path) : null)
    || (typeof payload?.last_assistant_message === "string" && payload.last_assistant_message.trim()
        ? payload.last_assistant_message : null);
  // a prompt with a pasted secret never becomes the subject — file list instead
  // (deliberate: --force-secrets does NOT override this). Nulling it here also
  // keeps it out of the agent-mode review call below.
  if (prompt && hasSecret(prompt)) {
    console.error("autogit: prompt looks like it contains a secret — using file-list commit subject.");
    prompt = null;
  }

  // agent mode: one LLM call decides ship-vs-hold and writes the subject.
  // Runs after every local gate (opt-in, defer, secrets, branch) so a blocked
  // turn never burns a call. An explicit -m is human intent — skip the gate.
  let agentSubject = null;
  if (config.mode === "agent" && !message) {
    const gate = await agentGate(prompt, config);
    if (gate.hold) {
      git("reset");
      console.error(`autogit: agent held this turn — ${gate.hold} (kept locally; re-reviewed next turn)`);
      return;
    }
    agentSubject = gate.subject; // null when the review failed open
  }

  const subject = message || agentSubject || (prompt ? subjectFrom(prompt) : autoMessage(staged));
  const commit = git("commit", "-m", subject, "-m", SHIP_TRAILER);
  if (!commit.ok) die(`commit failed:\n${commit.out}`);

  let push = git("push", config.remote, `HEAD:${branch}`);
  if (!push.ok && /rejected|non-fast-forward|fetch first/i.test(push.out)) {
    // remote moved (a push from elsewhere) — rebase our commit onto it and
    // retry once. The tree is clean here (everything was just committed),
    // so rebase is safe. A conflict aborts cleanly: commit kept locally.
    if (git("fetch", config.remote, branch).ok) {
      const rebase = git("rebase", "FETCH_HEAD");
      if (!rebase.ok) {
        git("rebase", "--abort");
        die(`remote ${config.remote}/${branch} has new commits that conflict with yours — commit kept locally.\nresolve manually: git pull --rebase && git push`);
      }
      console.error(`autogit: remote moved — rebased onto ${config.remote}/${branch}, retrying push.`);
      push = git("push", config.remote, `HEAD:${branch}`);
    }
  }
  if (!push.ok) die(`push failed (commit kept locally):\n${push.out}`);
  ok(`shipped ${staged.length} file(s) → ${config.remote}/${branch}`);
}

// ---------- undo ----------
// Escape hatch: take back the last autogit commit. Rewinds the remote first
// (only if it still points at the shipped commit), then undoes the local
// commit, leaving the changes uncommitted in the working tree.
// Run it again to peel off earlier autogit commits one at a time.

function cmdUndo() {
  const root = repoRootOrNull();
  if (!root) die("not inside a git repository.");
  process.chdir(root);

  const head = git("rev-parse", "HEAD");
  if (!head.ok) die("no commits in this repo.");
  const subject = git("log", "-1", "--format=%s").out;
  const body = git("log", "-1", "--format=%B").out;
  // legacy "autogit:" prefix covers commits made before the trailer existed
  if (!body.includes(SHIP_TRAILER) && !subject.startsWith("autogit:"))
    die(`last commit ("${subject}") wasn't made by autogit — won't touch it.`);

  const parent = git("rev-parse", "HEAD~1");
  if (!parent.ok) die("the autogit commit is the repo's only commit — undo it manually.");

  const branch = git("rev-parse", "--abbrev-ref", "HEAD").out;
  if (branch === "HEAD") die("detached HEAD — undo manually.");

  // config may be gone (autogit off) — undo still works, with defaults
  let config = DEFAULTS;
  const cfgPath = path.join(root, CONFIG_FILE);
  if (existsSync(cfgPath)) {
    try { config = { ...DEFAULTS, ...JSON.parse(readFileSync(cfgPath, "utf8")) }; } catch {}
  }

  // rewind the remote first, while local HEAD still matches what was pushed
  const fetch = git("fetch", config.remote, branch);
  if (fetch.ok) {
    const remoteTip = git("rev-parse", "FETCH_HEAD").out;
    if (remoteTip === head.out) {
      const push = git("push", `--force-with-lease=${branch}:${head.out}`,
        config.remote, `${parent.out}:refs/heads/${branch}`);
      if (!push.ok) die(`couldn't rewind ${config.remote}/${branch}:\n${push.out}`);
      ok(`rewound ${config.remote}/${branch} to ${parent.out.slice(0, 7)}`);
    } else if (remoteTip !== parent.out) {
      die(`${config.remote}/${branch} no longer matches the shipped commit — undo manually.`);
    } // remoteTip === parent → the commit was never pushed; local undo only
  } else if (/couldn't find remote ref/i.test(fetch.out)) {
    // branch never reached the remote — local undo only
  } else {
    die(`could not reach ${config.remote} — fix the connection and rerun:\n${fetch.out}`);
  }

  git("reset", parent.out); // mixed reset: the changes come back, uncommitted
  ok(`undid "${subject}" — changes are back (uncommitted) in your working tree.`);
}

// ---------- update ----------
// Self-update: `npm install -g` isn't discoverable from inside the tool, so
// users on old versions stayed stuck (seen in the field). One command fixes it.

function cmdUpdate() {
  // Source checkouts (git clone + npm link) must not be npm-installed over —
  // the registry tarball would bury the live repo behind the symlink. npm
  // strips .git on publish, so its presence next to index.js means "source".
  const here = path.dirname(fileURLToPath(import.meta.url));
  if (existsSync(path.join(here, ".git")))
    die(`running from a source checkout (${here}) — update with git pull.`);
  console.error(`autogit: ${VERSION} installed — updating from npm…`);
  // npm's output stays visible, but on stderr like everything autogit prints
  const r = spawnSync("npm", ["install", "-g", "@davidondrej/autogit@latest"], { stdio: ["ignore", 2, 2] });
  if (r.error) die("npm not found on PATH — install Node.js/npm and rerun.");
  if (r.status !== 0) die("update failed — see npm's output above.");
  // this process is still the old code — ask the fresh install for its version
  const now = (spawnSync("autogit", ["--version"], { encoding: "utf8" }).stdout || "").trim();
  if (now === VERSION) ok(`already up to date (${VERSION}).`);
  else if (now) ok(`updated ${VERSION} → ${now}.`);
  else ok("updated — check with: autogit --version");
}

// ---------- status ----------

function cmdStatus() {
  console.log(`autogit ${VERSION}`);
  const claudeFile = path.join(homedir(), ".claude", "settings.json");
  const claudeWired = existsSync(claudeFile) && readFileSync(claudeFile, "utf8").includes("autogit ship");
  const codexFile = path.join(homedir(), ".codex", "hooks.json");
  const codexWired = existsSync(codexFile) && readFileSync(codexFile, "utf8").includes("autogit ship");
  const cursorFile = path.join(homedir(), ".cursor", "hooks.json");
  const cursorWired = existsSync(cursorFile) && readFileSync(cursorFile, "utf8").includes("autogit ship");
  const piWired = existsSync(path.join(homedir(), ".pi", "agent", "extensions", "autogit.ts"));
  console.log(`hooks:  Claude Code ${claudeWired ? "wired" : "NOT wired"} · Codex ${codexWired ? "wired" : "NOT wired"} · Cursor ${cursorWired ? "wired" : "NOT wired"} · Pi ${piWired ? "wired" : "NOT wired"}`);

  const root = repoRootOrNull();
  if (!root) { console.log("repo:   not inside a git repository"); return; }
  const cfgFile = path.join(root, CONFIG_FILE);
  const on = existsSync(cfgFile);
  let repoCfg = null;
  if (on) { try { repoCfg = JSON.parse(readFileSync(cfgFile, "utf8")); } catch {} }
  const agentOn = repoCfg?.mode === "agent";
  const acct = git("config", "credential.username");
  console.log(`repo:   ${root}`);
  console.log(`        auto-push ${on ? "ON" : "OFF — run: autogit on"}`
    + (agentOn ? ` · agent mode (${agentSettings(repoCfg).model})` : "")
    + (acct.ok && acct.out ? ` · pushes as ${acct.out}` : ""));
  // a missing key means every turn silently falls back to plain auto-push —
  // status is where that misconfig becomes visible
  if (agentOn && !agentSettings(repoCfg).key)
    console.log("        agent key: MISSING — reviews are skipped. Fix: autogit on --agent --key <key>");

  // Reuse the same sweep as ship so status cleans stale/dead ghosts too. Do not
  // reap same-pid markers here: status may be called mid-turn by that agent.
  const live = sweepBusyMarkers(root, null, { reapMine: false });
  if (live) console.log(`        busy: ${live} agent(s) mid-turn — shipping deferred`);
}

// ---------- main ----------

// Only run the CLI when executed directly (not when imported by tests). realpath
// resolves the npm-link symlink so `autogit` still matches this real file.
let isMain = false;
try { isMain = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
catch { isMain = false; }

if (isMain) {
const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "setup": cmdSetup(); break;
  case "on": await cmdOn(args); break;
  case "off": cmdOff(); break;
  case "ship": await cmdShip(args); break;
  case "undo": cmdUndo(); break;
  case "busy": cmdBusy(args); break;
  case "status": cmdStatus(); break;
  case "update": cmdUpdate(); break;
  case "-v": case "--version": console.log(VERSION); break;
  default:
    console.log(`autogit — auto stage→commit→push for agentic engineers

  autogit setup     Wire up agent hooks: Claude Code + Codex + Cursor + Pi (once per machine)
  autogit on        Enable auto-push in this repo
  autogit off       Disable auto-push in this repo
  autogit ship      Stage, scan, commit, push (hooks run this after every turn)
  autogit undo      Take back the last autogit commit, local + remote (repeatable)
  autogit busy      Mark this repo busy (agent start/tool hooks run this)
  autogit status    Show hooks + repo state
  autogit update    Update autogit to the latest version from npm
  autogit --version Print the installed version (-v)

on flags:
  --public-ok       Enable without the public-GitHub-repo confirmation
  --account <user>  Pin which GitHub account pushes this repo (multi-account gh setups)
  --agent           Agent mode: an LLM (via your OpenRouter key) reviews each turn's
                    diff — holds junk/WIP, writes descriptive commit messages
  --key <key>       Save the OpenRouter API key (stored in ~/.autogit/config.json)
  --model <id>      Model for this repo's reviews (default: ${DEFAULT_MODEL})
  --auto            Back to plain auto-push (agent mode off, auto-push stays on)

ship flags:
  -m "message"      Commit message (defaults to the turn's prompt, else the file list)
  --force-secrets   Override a secrets-scan block

Parallel agents in one repo: ship defers while another agent is mid-turn;
the last one to finish ships everything. Use worktrees for full isolation.`);
}
}

// Exported for tests (importing this file is a no-op thanks to the isMain guard).
export { agentPid, isAlive, writeMarker, readMarker, takeOwnMarker, sweepBusy, sweepBusyMarkers, busyDir, markerPath, BUSY_TTL_MS };
export { parseDecision, buildReviewRequest, agentDecide, agentSettings, MAX_DIFF_CHARS, DEFAULT_MODEL };
