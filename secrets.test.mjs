// E2E tests for ship's secrets scan. Run: npm test
// Focus: template files (.env.example) and placeholder values must never
// block shipping — the false positive that spammed every agent turn — while
// real secrets and real .env files still block.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const INDEX = fileURLToPath(new URL("./index.js", import.meta.url));
// Hermetic git: ignore the machine's global/system config.
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const sh = (cwd, ...args) => spawnSync("git", args, { cwd, env: ENV, encoding: "utf8" });

// Throwaway opted-in repo with a bare origin. Writes `files`, runs
// `autogit ship`, and reports what happened.
function ship(files, args = []) {
  const base = mkdtempSync(path.join(tmpdir(), "autogit-e2e-"));
  try {
    sh(base, "init", "-q", "--bare", "origin.git");
    const work = path.join(base, "work");
    sh(base, "init", "-q", "-b", "main", work);
    sh(work, "config", "user.email", "t@t.t");
    sh(work, "config", "user.name", "t");
    sh(work, "config", "commit.gpgsign", "false");
    sh(work, "remote", "add", "origin", path.join(base, "origin.git"));
    writeFileSync(path.join(work, ".autogit.json"), '{"mode":"auto"}\n');
    sh(work, "add", "-A");
    sh(work, "commit", "-qm", "init");
    sh(work, "push", "-q", "origin", "HEAD:main");
    for (const [name, content] of Object.entries(files)) {
      const p = path.join(work, name);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
    const r = spawnSync(process.execPath, [INDEX, "ship", ...args],
      { cwd: work, env: ENV, encoding: "utf8", input: "" });
    const pushed = Number(sh(path.join(base, "origin.git"), "rev-list", "--count", "main").stdout.trim());
    const staged = sh(work, "diff", "--cached", "--name-only").stdout.trim();
    return { code: r.status, err: r.stderr, pushed, staged };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test(".env.example ships — template files are not secrets (the every-turn block bug)", () => {
  const r = ship({ "scorer/.env.example": "OPENAI_API_KEY=your-key-here\n" });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.pushed, 2, "the commit should reach origin");
  assert.match(r.err, /shipped/);
});

test("realistic-looking dummy values in template files ship — templates are exempt, contents included", () => {
  // key built at runtime so this source file never contains a scannable token
  const fakeKey = "sk-" + "AbCdEfGhIjKlMnOpQrStUvWx";
  const r = ship({ ".env.example": `OPENAI_API_KEY=${fakeKey}\n` });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.pushed, 2, "the commit should reach origin");
});

test("a real .env still blocks, and unstages everything", () => {
  const r = ship({ ".env": "OPENAI_API_KEY=real\n", "app.js": "ok\n" });
  assert.equal(r.code, 1);
  assert.match(r.err, /\.env: sensitive filename/);
  assert.equal(r.pushed, 1, "nothing may reach origin");
  assert.equal(r.staged, "", "the block must leave nothing staged");
});

test("placeholder values ship — docs and samples are not leaks", () => {
  const r = ship({ "doc.md": 'aws = "AKIAIOSFODNN7EXAMPLE"\nOPENAI_API_KEY=sk-your-key-goes-here-xxxxxxxxxx\n' });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.pushed, 2);
});

test("a real-looking key still blocks", () => {
  const r = ship({ "leak.js": 'const k = "sk-proj4bCd3fGh1jKlMn0pQrStUvWxYz012345";\n' });
  assert.equal(r.code, 1);
  assert.match(r.err, /leak\.js: OpenAI key/);
  assert.equal(r.pushed, 1);
});

test("--force-secrets overrides a block", () => {
  const r = ship({ ".env": "OPENAI_API_KEY=real\n" }, ["--force-secrets"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.pushed, 2);
});
