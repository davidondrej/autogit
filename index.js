#!/usr/bin/env node
// autogit — auto stage→commit→push for agentic engineers
// Usage:
//   autogit init                      set up config in current repo
//   autogit ship -m "message"         stage, scan, gate, commit, push
//   autogit status                    show current config
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

const CONFIG_FILE = ".autogit.json";

const DEFAULT_CONFIG = {
  mode: "human", // "auto" | "agent" | "human"
  remote: "origin",
  branch: "current", // "current" or a fixed branch name
  secretsScan: true,
  review: {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4.5",
    apiKeyEnv: "OPENROUTER_API_KEY"
  }
};

// ---------- helpers ----------

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts }).trim();
}

function shSafe(cmd) {
  try { return { ok: true, out: sh(cmd) }; }
  catch (e) { return { ok: false, out: (e.stdout || "") + (e.stderr || e.message) }; }
}

function repoRoot() {
  const r = shSafe("git rev-parse --show-toplevel");
  if (!r.ok) die("Not inside a git repository.");
  return r.out;
}

function loadConfig(root) {
  const p = path.join(root, CONFIG_FILE);
  if (!existsSync(p)) die(`No ${CONFIG_FILE} found. Run: autogit init`);
  return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(p, "utf8")) };
}

function die(msg, code = 1) {
  console.error(`✗ autogit: ${msg}`);
  process.exit(code);
}

function ok(msg) { console.log(`✓ ${msg}`); }

async function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(question, a => { rl.close(); res(a.trim().toLowerCase()); }));
}

// ---------- secrets scanning ----------

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
  const staged = shSafe("git diff --cached --name-only").out.split("\n").filter(Boolean);

  for (const f of staged) {
    const base = path.basename(f);
    if (SENSITIVE_FILES.some(re => re.test(base))) {
      findings.push({ file: f, issue: "sensitive filename" });
    }
  }

  // only scan added lines
  const diff = shSafe("git diff --cached --unified=0").out;
  let currentFile = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) { currentFile = line.slice(6); continue; }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(line)) findings.push({ file: currentFile, issue: name });
    }
  }
  return findings;
}

// ---------- agent review (OpenRouter) ----------

async function agentReview(config, diff, message) {
  const key = process.env[config.review.apiKeyEnv];
  if (!key) die(`Agent review mode requires ${config.review.apiKeyEnv} env var.`);

  const truncated = diff.length > 60000 ? diff.slice(0, 60000) + "\n...[diff truncated]" : diff;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: config.review.model,
      messages: [{
        role: "user",
        content: `You are a strict code reviewer gating an automatic git push.\nCommit message: "${message}"\n\nReview this staged diff. Reject if you see: secrets/credentials, obviously broken code, destructive changes (mass deletions that look unintentional), or changes unrelated to the commit message.\n\nRespond with EXACTLY one line:\nAPPROVE: <short reason>\nor\nREJECT: <short reason>\n\nDiff:\n${truncated}`
      }],
      max_tokens: 200
    })
  });

  if (!res.ok) die(`OpenRouter API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const verdict = (data.choices?.[0]?.message?.content || "").trim();
  console.log(`  reviewer (${config.review.model}): ${verdict}`);
  return verdict.toUpperCase().startsWith("APPROVE");
}

// ---------- commands ----------

async function cmdInit() {
  const root = repoRoot();
  const p = path.join(root, CONFIG_FILE);
  if (existsSync(p)) die(`${CONFIG_FILE} already exists.`);

  writeFileSync(p, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  ok(`Created ${CONFIG_FILE} (mode: human)`);
  console.log(`
Next steps:
  1. Edit ${CONFIG_FILE} — set mode to "auto", "agent", or "human"
  2. Add this to your CLAUDE.md / AGENTS.md:

     After completing each task, run:
       autogit ship -m "<concise commit message describing the change>"

  3. For "agent" mode, set ${DEFAULT_CONFIG.review.apiKeyEnv}.`);
}

async function cmdShip(args) {
  const root = repoRoot();
  process.chdir(root);
  const config = loadConfig(root);

  const mIdx = args.indexOf("-m");
  const message = mIdx !== -1 ? args[mIdx + 1] : null;
  if (!message) die('Missing commit message. Usage: autogit ship -m "message"');
  const forceSecrets = args.includes("--force-secrets");

  // 1. stage
  sh("git add -A");
  const staged = shSafe("git diff --cached --name-only").out;
  if (!staged) { ok("Nothing to commit."); return; }
  ok(`Staged ${staged.split("\n").length} file(s)`);

  // 2. secrets scan
  if (config.secretsScan && !forceSecrets) {
    const findings = scanSecrets();
    if (findings.length) {
      sh("git reset");
      console.error("✗ Blocked — possible secrets detected:");
      for (const f of findings) console.error(`    ${f.file}: ${f.issue}`);
      die("Fix these, or rerun with --force-secrets to override.");
    }
    ok("Secrets scan passed");
  }

  // 3. mode gate
  const diff = shSafe("git diff --cached").out;
  if (config.mode === "human") {
    if (!process.stdin.isTTY) {
      sh("git reset");
      die("Human review mode requires an interactive terminal. Run autogit ship yourself, or switch mode.", 3);
    }
    console.log("\n" + shSafe("git diff --cached --stat").out + "\n");
    const a = await prompt(`Commit & push "${message}"? [y/N/d=show diff] `);
    if (a === "d") {
      console.log(diff);
      const b = await prompt(`Commit & push? [y/N] `);
      if (b !== "y") { sh("git reset"); die("Rejected by human.", 2); }
    } else if (a !== "y") {
      sh("git reset");
      die("Rejected by human.", 2);
    }
  } else if (config.mode === "agent") {
    const approved = await agentReview(config, diff, message);
    if (!approved) { sh("git reset"); die("Rejected by reviewing agent.", 2); }
  } // mode "auto": no gate

  // 4. commit
  sh(`git commit -m ${JSON.stringify(message)}`);
  ok(`Committed: ${message}`);

  // 5. push
  const branch = config.branch === "current"
    ? sh("git rev-parse --abbrev-ref HEAD")
    : config.branch;
  const push = shSafe(`git push ${config.remote} HEAD:${branch}`);
  if (!push.ok) die(`Push failed:\n${push.out}`);
  ok(`Pushed to ${config.remote}/${branch}`);
}

function cmdStatus() {
  const root = repoRoot();
  const config = loadConfig(root);
  console.log(JSON.stringify(config, null, 2));
}

// ---------- main ----------

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "init": await cmdInit(); break;
  case "ship": await cmdShip(args); break;
  case "status": cmdStatus(); break;
  default:
    console.log(`autogit — auto stage→commit→push for agentic engineers

Commands:
  autogit init                  Set up .autogit.json in this repo
  autogit ship -m "message"     Stage, scan, gate, commit, push
  autogit status                Show config

Modes (set in .autogit.json):
  auto    ship immediately
  agent   LLM reviews diff via OpenRouter before push
  human   terminal y/n prompt on diff

Flags:
  --force-secrets               Override secrets scan block`);
}
