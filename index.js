#!/usr/bin/env node
// Zero-dependency CLI, ESM, Node >=18.
// autogit — auto stage→commit→push for agentic engineers
//   autogit setup     wire agent hooks globally (once per machine)
//   autogit on/off    enable/disable auto-push in current repo
//   autogit ship      stage, scan, commit, push (what the hooks run)
//   autogit undo      take back the last autogit commit (local + remote)
//   autogit status    show hooks + repo state
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync, statSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const CONFIG_FILE = ".autogit.json";
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
  { name: "OpenAI key", re: /sk-[A-Za-z0-9_\-]{20,}/ },
  { name: "Anthropic key", re: /sk-ant-[A-Za-z0-9_\-]{20,}/ },
  { name: "GitHub token", re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: "Slack token", re: /xox[baprs]-[A-Za-z0-9\-]{10,}/ },
  { name: "Google API key", re: /AIza[0-9A-Za-z_\-]{35}/ },
  { name: "JWT", re: /eyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/ }
];

const SENSITIVE_FILES = [/^\.env(\..+)?$/, /\.pem$/, /\.key$/, /id_rsa/, /credentials\.json$/];

function scanSecrets() {
  const findings = [];
  const staged = git("diff", "--cached", "--name-only").out.split("\n").filter(Boolean);

  for (const f of staged) {
    if (SENSITIVE_FILES.some(re => re.test(path.basename(f)))) {
      findings.push({ file: f, issue: "sensitive filename" });
    }
  }

  // only scan added lines
  let currentFile = "";
  for (const line of git("diff", "--cached", "--unified=0").out.split("\n")) {
    if (line.startsWith("+++ b/")) { currentFile = line.slice(6); continue; }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(line)) findings.push({ file: currentFile, issue: name });
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
  }) ?? `wired (${file}) — open codex and run /hooks once to trust it`;
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

// ---------- on / off ----------

function cmdOn() {
  const root = repoRootOrNull();
  if (!root) die("not inside a git repository.");
  const p = path.join(root, CONFIG_FILE);
  if (existsSync(p)) { ok("already on."); return; }
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

const BUSY_TTL_MS = 15 * 60 * 1000; // markers older than this are stale (crashed agent)

function busyDir(root) {
  // resolve the real git dir — in worktrees, <root>/.git is a file, and each
  // worktree gets its own dir, which isolates busy markers per checkout
  const gd = git("rev-parse", "--git-dir").out; // relative to cwd, or absolute in worktrees
  return path.join(path.resolve(process.cwd(), gd), "autogit-busy");
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
  const roots = payload?.workspace_roots?.length ? payload.workspace_roots : [process.cwd()];
  for (const dir of roots) {
    try {
      process.chdir(dir);
      const root = repoRootOrNull();
      if (!root || !existsSync(path.join(root, CONFIG_FILE))) continue; // only opted-in repos
      const marker = markerPath(root, id);
      mkdirSync(path.dirname(marker), { recursive: true });
      if (prompt || !existsSync(marker)) writeFileSync(marker, prompt || "");
      else { const now = new Date(); utimesSync(marker, now, now); } // mtime is the freshness signal
    } catch {}
  }
}

// Read & clear this session's own marker; returns the stored prompt (if any).
function takeOwnMarker(root, id) {
  if (!id) return null;
  try {
    const p = markerPath(root, id);
    const prompt = readFileSync(p, "utf8").trim();
    unlinkSync(p);
    return prompt || null;
  } catch { return null; }
}

// Returns true if another agent is mid-turn in this repo. Cleans stale markers.
function othersBusy(root) {
  const dir = busyDir(root);
  if (!existsSync(dir)) return false;
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    try {
      if (Date.now() - statSync(p).mtimeMs > BUSY_TTL_MS) { unlinkSync(p); continue; }
      return true;
    } catch {}
  }
  return false;
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

// Claude's Stop payload has no prompt, but points at the session transcript
// (JSONL). Walk it backwards for the last real user message.
function lastPromptFromTranscript(file) {
  try {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      let e; try { e = JSON.parse(lines[i]); } catch { continue; }
      if (e.type !== "user" || e.isMeta) continue;
      const c = e.message?.content;
      const text = typeof c === "string" ? c
        : Array.isArray(c) ? c.filter(p => p.type === "text").map(p => p.text).join(" ") : "";
      if (!text.trim() || text.startsWith("<")) continue; // tool results / slash-command noise
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

function cmdShip(args) {
  const payload = readStdinPayload();
  // Cursor reports turn status — never ship aborted or errored turns
  if (payload?.status && payload.status !== "completed") process.exit(0);
  // Cursor hooks run from ~/.cursor; the real project dirs come in the payload
  const roots = payload?.workspace_roots?.length ? payload.workspace_roots : [process.cwd()];
  const id = sessionId(payload, args);
  for (const dir of roots) shipRepo(dir, args, id, payload);
}

function shipRepo(dir, args, id, payload) {
  try { process.chdir(dir); } catch { return; }

  // silent no-op unless this is a repo that opted in — hooks fire everywhere
  const root = repoRootOrNull();
  if (!root) return;
  const cfgPath = path.join(root, CONFIG_FILE);
  if (!existsSync(cfgPath)) return;
  process.chdir(root);

  // clear our own marker first — it may hold this turn's prompt
  const storedPrompt = takeOwnMarker(root, id);

  // another agent mid-turn? defer — the last one to finish ships everything
  if (othersBusy(root)) {
    console.error("autogit: deferred — another agent is still working in this repo.");
    return;
  }

  let config;
  try { config = { ...DEFAULTS, ...JSON.parse(readFileSync(cfgPath, "utf8")) }; }
  catch { die(`${CONFIG_FILE} is not valid JSON.`); }
  if (config.mode !== "auto") {
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
      die("fix these, or rerun with --force-secrets.");
    }
  }

  const branch = config.branch === "current" ? git("rev-parse", "--abbrev-ref", "HEAD").out : config.branch;
  if (branch === "HEAD") { git("reset"); die("detached HEAD — won't auto-push."); }

  // subject: explicit -m > this turn's prompt (busy marker, payload, or
  // Claude transcript) > file-list fallback. Trailer marks the commit as ours.
  const prompt = storedPrompt || promptText(payload)
    || (payload?.transcript_path ? lastPromptFromTranscript(payload.transcript_path) : null);
  const subject = message || (prompt ? subjectFrom(prompt) : autoMessage(staged));
  const commit = git("commit", "-m", subject, "-m", SHIP_TRAILER);
  if (!commit.ok) die(`commit failed:\n${commit.out}`);

  const push = git("push", config.remote, `HEAD:${branch}`);
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

// ---------- status ----------

function cmdStatus() {
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
  const on = existsSync(path.join(root, CONFIG_FILE));
  console.log(`repo:   ${root}`);
  console.log(`        auto-push ${on ? "ON" : "OFF — run: autogit on"}`);

  const dir = busyDir(root);
  const fresh = existsSync(dir)
    ? readdirSync(dir).filter(f => Date.now() - statSync(path.join(dir, f)).mtimeMs <= BUSY_TTL_MS)
    : [];
  if (fresh.length) console.log(`        busy: ${fresh.length} agent(s) mid-turn — shipping deferred`);
}

// ---------- main ----------

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "setup": cmdSetup(); break;
  case "on": cmdOn(); break;
  case "off": cmdOff(); break;
  case "ship": cmdShip(args); break;
  case "undo": cmdUndo(); break;
  case "busy": cmdBusy(args); break;
  case "status": cmdStatus(); break;
  default:
    console.log(`autogit — auto stage→commit→push for agentic engineers

  autogit setup     Wire up agent hooks: Claude Code + Codex + Cursor + Pi (once per machine)
  autogit on        Enable auto-push in this repo
  autogit off       Disable auto-push in this repo
  autogit ship      Stage, scan, commit, push (hooks run this after every turn)
  autogit undo      Take back the last autogit commit, local + remote (repeatable)
  autogit busy      Mark this repo busy (agent start/tool hooks run this)
  autogit status    Show hooks + repo state

ship flags:
  -m "message"      Commit message (defaults to the turn's prompt, else the file list)
  --force-secrets   Override a secrets-scan block

Parallel agents in one repo: ship defers while another agent is mid-turn;
the last one to finish ships everything. Use worktrees for full isolation.`);
}
