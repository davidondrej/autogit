// Tests for agent mode (the LLM commit gate). Run: npm test
// Focus: the gate must fail OPEN — no key, dead API, garbage replies must all
// ship with plain auto behavior, never hold work hostage. Holds must keep the
// changes intact in the working tree. E2E runs against a mock OpenRouter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseDecision, buildReviewRequest, agentSettings, MAX_DIFF_CHARS, DEFAULT_MODEL } from "./index.js";

const INDEX = fileURLToPath(new URL("./index.js", import.meta.url));
// Hermetic git: ignore the machine's global/system config.
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
delete ENV.OPENROUTER_API_KEY; // the machine's real key must never leak into tests
const sh = (cwd, ...args) => spawnSync("git", args, { cwd, env: ENV, encoding: "utf8" });

// ---------- unit: parseDecision ----------

test("parseDecision: plain, fenced, and prose-wrapped JSON all parse", () => {
  const want = { commit: true, reason: "solid change", message: "add agent gate" };
  const plain = JSON.stringify(want);
  for (const text of [
    plain,
    "```json\n" + plain + "\n```",
    "Here is my decision:\n" + plain
  ]) assert.deepEqual(parseDecision(text), want, text);
});

test("parseDecision: garbage and wrong shapes fail closed to null (→ ship)", () => {
  assert.equal(parseDecision("no json here"), null);
  assert.equal(parseDecision(""), null);
  assert.equal(parseDecision(null), null);
  assert.equal(parseDecision('{"commit": "yes"}'), null, "commit must be a boolean");
  assert.equal(parseDecision('{"broken": '), null);
});

test("parseDecision: missing fields default to empty, quotes get stripped", () => {
  assert.deepEqual(parseDecision('{"commit": false}'), { commit: false, reason: "", message: "" });
  assert.equal(parseDecision('{"commit": true, "message": "\\"fix thing\\""}').message, "fix thing");
});

// ---------- unit: buildReviewRequest ----------

test("buildReviewRequest: carries prompt, files, diff; caps huge diffs", () => {
  const r = buildReviewRequest({ prompt: "fix the bug", nameStatus: "M\tapp.js", diff: "+ x", recent: "older subject" });
  for (const part of ["fix the bug", "M\tapp.js", "+ x", "older subject"]) assert.match(r, new RegExp(part.replace(/[+\\]/g, "\\$&")));

  const big = buildReviewRequest({ prompt: null, nameStatus: "M\ta", diff: "x".repeat(MAX_DIFF_CHARS + 500), recent: "" });
  assert.match(big, /\(not captured\)/, "missing prompt is stated, not faked");
  assert.match(big, /diff truncated/, "oversized diffs must announce truncation");
  assert.ok(big.length < MAX_DIFF_CHARS + 1000, "the cap must actually cap");
  assert.doesNotMatch(big, /Recent commit subjects/, "empty history omits the section");
});

// ---------- unit: agentSettings precedence ----------

test("agentSettings: env key > global config; repo model > global > default", () => {
  const home = mkdtempSync(path.join(tmpdir(), "autogit-home-"));
  const saved = { HOME: process.env.AUTOGIT_HOME, KEY: process.env.OPENROUTER_API_KEY };
  try {
    process.env.AUTOGIT_HOME = home;
    delete process.env.OPENROUTER_API_KEY;

    assert.deepEqual(agentSettings(null), { key: null, model: DEFAULT_MODEL, baseUrl: "https://openrouter.ai/api/v1" },
      "no config anywhere → no key, built-in defaults");

    mkdirSync(path.join(home, ".autogit"), { recursive: true });
    writeFileSync(path.join(home, ".autogit", "config.json"),
      JSON.stringify({ openrouterApiKey: "sk-or-global", model: "global/model", baseUrl: "http://proxy/v1/" }));
    const g = agentSettings(null);
    assert.equal(g.key, "sk-or-global");
    assert.equal(g.model, "global/model");
    assert.equal(g.baseUrl, "http://proxy/v1", "trailing slash is trimmed");

    assert.equal(agentSettings({ model: "repo/model" }).model, "repo/model", "repo model wins");
    process.env.OPENROUTER_API_KEY = "sk-or-env";
    assert.equal(agentSettings(null).key, "sk-or-env", "env key wins");
  } finally {
    if (saved.HOME === undefined) delete process.env.AUTOGIT_HOME; else process.env.AUTOGIT_HOME = saved.HOME;
    if (saved.KEY === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = saved.KEY;
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------- E2E scaffolding ----------

// Mock OpenRouter: answers /chat/completions with a canned decision (or an
// error), records every request. Runs in-process, so the CLI is spawned async —
// spawnSync would block the event loop and deadlock the server.
function mockOpenRouter(respond) {
  return new Promise(resolve => {
    const hits = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", d => (body += d));
      req.on("end", () => {
        hits.push({ url: req.url, body });
        const { status = 200, json = {} } = respond(req.url, body);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(json));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      hits,
      close: () => new Promise(r => server.close(r))
    }));
  });
}

const decision = d => ({ json: { choices: [{ message: { content: "```json\n" + JSON.stringify(d) + "\n```" } }] } });

function run(args, opts) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [INDEX, ...args], { ...opts });
    let stdout = "", stderr = "";
    p.stdout.on("data", d => (stdout += d));
    p.stderr.on("data", d => (stderr += d));
    p.stdin.end(opts.input ?? "");
    p.on("close", status => resolve({ status, stdout, stderr }));
  });
}

// Throwaway agent-mode repo with a bare origin + isolated AUTOGIT_HOME.
function scaffold({ key = "sk-or-test", baseUrl } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), "autogit-agent-"));
  sh(base, "init", "-q", "--bare", "origin.git");
  const work = path.join(base, "work");
  sh(base, "init", "-q", "-b", "main", work);
  sh(work, "config", "user.email", "t@t.t");
  sh(work, "config", "user.name", "t");
  sh(work, "config", "commit.gpgsign", "false");
  sh(work, "remote", "add", "origin", path.join(base, "origin.git"));
  writeFileSync(path.join(work, ".autogit.json"), '{"mode":"agent"}\n');
  sh(work, "add", "-A");
  sh(work, "commit", "-qm", "init");
  sh(work, "push", "-q", "origin", "HEAD:main");
  const home = path.join(base, "home");
  mkdirSync(path.join(home, ".autogit"), { recursive: true });
  const global = {};
  if (key) global.openrouterApiKey = key;
  if (baseUrl) global.baseUrl = baseUrl;
  writeFileSync(path.join(home, ".autogit", "config.json"), JSON.stringify(global));
  return {
    base, work,
    env: { ...ENV, AUTOGIT_HOME: home },
    origin: path.join(base, "origin.git"),
    pushed: () => Number(sh(path.join(base, "origin.git"), "rev-list", "--count", "main").stdout.trim()),
    subject: () => sh(path.join(base, "origin.git"), "log", "-1", "--format=%s", "main").stdout.trim(),
    body: () => sh(path.join(base, "origin.git"), "log", "-1", "--format=%B", "main").stdout,
    staged: () => sh(work, "diff", "--cached", "--name-only").stdout.trim(),
    cleanup: () => rmSync(base, { recursive: true, force: true })
  };
}

// ---------- E2E: ship through the gate ----------

test("agent says ship → commit lands with the LLM's subject and the undo trailer", async () => {
  const mock = await mockOpenRouter(() => decision({ commit: true, reason: "complete feature", message: "add login validation to the signup form" }));
  const repo = scaffold({ baseUrl: mock.url });
  try {
    writeFileSync(path.join(repo.work, "app.js"), "ok\n");
    const r = await run(["ship"], { cwd: repo.work, env: repo.env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(repo.pushed(), 2, "the commit should reach origin");
    assert.equal(repo.subject(), "add login validation to the signup form");
    assert.match(repo.body(), /Shipped-by: autogit/, "undo must still recognize the commit");
    assert.equal(mock.hits.length, 1, "exactly one review call");
    assert.match(mock.hits[0].body, /Staged diff/, "the diff is in the review request");
    assert.match(mock.hits[0].body, /app\.js/, "the changed file is in the review request");
  } finally { await mock.close(); repo.cleanup(); }
});

test("agent says hold → nothing pushed, changes stay intact in the working tree", async () => {
  const mock = await mockOpenRouter(() => decision({ commit: false, reason: "half-finished scaffolding", message: "wip" }));
  const repo = scaffold({ baseUrl: mock.url });
  try {
    writeFileSync(path.join(repo.work, "wip.js"), "function later() {\n");
    const r = await run(["ship"], { cwd: repo.work, env: repo.env });
    assert.equal(r.status, 0, "a hold is not an error — hooks must stay quiet");
    assert.match(r.stderr, /held this turn — half-finished scaffolding/);
    assert.equal(repo.pushed(), 1, "nothing may reach origin");
    assert.equal(repo.staged(), "", "a hold must leave nothing staged");
    assert.ok(existsSync(path.join(repo.work, "wip.js")), "held work must survive in the working tree");
  } finally { await mock.close(); repo.cleanup(); }
});

test("API unreachable → fails open and ships with the normal fallback subject", async () => {
  const mock = await mockOpenRouter(() => ({ status: 500 }));
  await mock.close(); // now the port refuses connections
  const repo = scaffold({ baseUrl: mock.url });
  try {
    writeFileSync(path.join(repo.work, "app.js"), "ok\n");
    const r = await run(["ship"], { cwd: repo.work, env: repo.env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /agent review unavailable/);
    assert.equal(repo.pushed(), 2, "fail open: the work still ships");
    assert.match(repo.subject(), /autogit: update app\.js/, "falls back to the file-list subject");
  } finally { repo.cleanup(); }
});

test("HTTP error and garbage replies also fail open", async () => {
  let mode = "http-error";
  const mock = await mockOpenRouter(() =>
    mode === "http-error" ? { status: 401, json: { error: "bad key" } }
      : { json: { choices: [{ message: { content: "I refuse to answer in JSON" } }] } });
  for (mode of ["http-error", "garbage"]) {
    const repo = scaffold({ baseUrl: mock.url });
    try {
      writeFileSync(path.join(repo.work, "app.js"), mode + "\n");
      const r = await run(["ship"], { cwd: repo.work, env: repo.env });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /agent review unavailable \((HTTP 401|unusable reply)\)/);
      assert.equal(repo.pushed(), 2, `fail open on ${mode}`);
    } finally { repo.cleanup(); }
  }
  await mock.close();
});

test("agent mode without a key → notes it and ships like plain auto mode", async () => {
  const repo = scaffold({ key: null });
  try {
    writeFileSync(path.join(repo.work, "app.js"), "ok\n");
    const r = await run(["ship"], { cwd: repo.work, env: repo.env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /no OpenRouter key/);
    assert.equal(repo.pushed(), 2);
  } finally { repo.cleanup(); }
});

test("explicit -m bypasses the gate entirely — no LLM call, human message wins", async () => {
  const mock = await mockOpenRouter(() => decision({ commit: false, reason: "would hold", message: "x" }));
  const repo = scaffold({ baseUrl: mock.url });
  try {
    writeFileSync(path.join(repo.work, "app.js"), "ok\n");
    const r = await run(["ship", "-m", "release: cut 1.0"], { cwd: repo.work, env: repo.env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(repo.pushed(), 2);
    assert.equal(repo.subject(), "release: cut 1.0");
    assert.equal(mock.hits.length, 0, "-m must not spend an LLM call");
  } finally { await mock.close(); repo.cleanup(); }
});

// ---------- E2E: `on --agent` setup ----------

test("on --agent --key: probes the key, saves it 0600, flips the repo to agent mode", async () => {
  const mock = await mockOpenRouter(url => url.endsWith("/key") ? { json: { data: {} } } : { status: 404 });
  const repo = scaffold({ key: null, baseUrl: mock.url });
  try {
    const r = await run(["on", "--agent", "--key", "sk-or-fresh", "--model", "some/model"], { cwd: repo.work, env: repo.env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /agent mode ON/);
    const cfg = JSON.parse(readFileSync(path.join(repo.work, ".autogit.json"), "utf8"));
    assert.equal(cfg.mode, "agent");
    assert.equal(cfg.model, "some/model");
    const globalFile = path.join(repo.env.AUTOGIT_HOME, ".autogit", "config.json");
    const global = JSON.parse(readFileSync(globalFile, "utf8"));
    assert.equal(global.openrouterApiKey, "sk-or-fresh");
    assert.equal(global.baseUrl, mock.url, "existing global fields survive the merge");
    assert.equal(statSync(globalFile).mode & 0o777, 0o600, "the key file must not be world-readable");
    assert.equal(mock.hits.length, 1, "the key was probed once");

    // and --auto flips back without touching the model or the key
    const back = await run(["on", "--auto"], { cwd: repo.work, env: repo.env });
    assert.equal(back.status, 0, back.stderr);
    assert.equal(JSON.parse(readFileSync(path.join(repo.work, ".autogit.json"), "utf8")).mode, "auto");
  } finally { await mock.close(); repo.cleanup(); }
});

test("on --agent --key: a rejected key (401) dies and leaves the repo config untouched", async () => {
  const mock = await mockOpenRouter(() => ({ status: 401 }));
  const repo = scaffold({ key: null, baseUrl: mock.url });
  try {
    rmSync(path.join(repo.work, ".autogit.json")); // start from OFF
    const r = await run(["on", "--agent", "--key", "sk-or-bad"], { cwd: repo.work, env: repo.env });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /rejected that key/);
    assert.ok(!existsSync(path.join(repo.work, ".autogit.json")), "a failed key setup must not enable the repo");
  } finally { await mock.close(); repo.cleanup(); }
});

test("on --agent with no key and no TTY dies with the --key hint", async () => {
  const repo = scaffold({ key: null });
  try {
    rmSync(path.join(repo.work, ".autogit.json"));
    const r = await run(["on", "--agent"], { cwd: repo.work, env: repo.env });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--key <key>/);
    assert.ok(!existsSync(path.join(repo.work, ".autogit.json")));
  } finally { repo.cleanup(); }
});
