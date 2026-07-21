// E2E coverage for Cursor hooks. Run: node --test
// Cursor's workspace root can be a parent of the opted-in repo, especially when
// the repo is created after the CLI session starts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const INDEX = fileURLToPath(new URL("./index.js", import.meta.url));
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const sh = (cwd, ...args) => spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });

function run(args, { cwd, env, input = "" }) {
  return spawnSync(process.execPath, [INDEX, ...args], {
    cwd,
    env: { ...GIT_ENV, ...env },
    input,
    encoding: "utf8"
  });
}

function scaffold() {
  const base = mkdtempSync(path.join(tmpdir(), "autogit-cursor-"));
  const workspace = path.join(base, "workspace");
  const repo = path.join(workspace, "project");
  const origin = path.join(base, "origin.git");
  mkdirSync(repo, { recursive: true });
  sh(base, "init", "-q", "--bare", origin);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "cursor-test@example.invalid");
  sh(repo, "config", "user.name", "Cursor Test");
  sh(repo, "config", "commit.gpgsign", "false");
  sh(repo, "remote", "add", "origin", origin);
  writeFileSync(path.join(repo, ".autogit.json"), '{"mode":"auto"}\n');
  writeFileSync(path.join(repo, "file.txt"), "before\n");
  sh(repo, "add", "-f", ".autogit.json", "file.txt");
  sh(repo, "commit", "-qm", "baseline");
  sh(repo, "push", "-q", "-u", "origin", "main");
  const home = path.join(base, "home");
  mkdirSync(home);
  return {
    base,
    workspace,
    repo,
    origin,
    env: { AUTOGIT_HOME: home },
    pushed: () => Number(sh(origin, "rev-list", "--count", "main").stdout.trim()),
    subject: () => sh(origin, "log", "-1", "--format=%s", "main").stdout.trim(),
    body: () => sh(origin, "log", "-1", "--format=%B", "main").stdout,
    cleanup: () => rmSync(base, { recursive: true, force: true })
  };
}

function cursorPayload(workspace, overrides = {}) {
  return JSON.stringify({
    conversation_id: "cursor-session",
    generation_id: "cursor-turn-1",
    cursor_version: "2026.07.17-test",
    workspace_roots: [workspace],
    ...overrides
  });
}

function transcript(file, prompt, workingDirectory = null) {
  const lines = [
    { role: "user", message: { content: [{ type: "text", text: prompt }] } },
    ...(workingDirectory ? [{
      role: "assistant",
      message: { content: [{ type: "tool_use", input: { working_directory: workingDirectory } }] }
    }] : []),
    { type: "turn_ended", status: "success" }
  ];
  writeFileSync(file, lines.map(line => JSON.stringify(line)).join("\n") + "\n");
}

test("Cursor ships the repo tracked from postToolUse.cwd when workspace_roots is a parent", () => {
  const s = scaffold();
  try {
    const transcriptFile = path.join(s.base, "transcript.jsonl");
    transcript(transcriptFile, "finish the nested Cursor change");
    writeFileSync(path.join(s.repo, "file.txt"), "after\n");

    const busy = run(["busy"], {
      cwd: s.workspace,
      env: s.env,
      input: cursorPayload(s.workspace, { hook_event_name: "postToolUse", cwd: s.repo })
    });
    assert.equal(busy.status, 0, busy.stderr);

    const stop = run(["ship"], {
      cwd: s.workspace,
      env: s.env,
      input: cursorPayload(s.workspace, {
        hook_event_name: "stop",
        status: "completed",
        transcript_path: transcriptFile
      })
    });
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(s.pushed(), 2, "the nested repo should reach origin");
    assert.equal(s.subject(), "finish the nested Cursor change");
    assert.match(s.body(), /Shipped-by: autogit/);
    assert.equal(sh(s.repo, "status", "--porcelain").stdout, "");
  } finally { s.cleanup(); }
});

test("Cursor falls back to the current turn's transcript working_directory", () => {
  const s = scaffold();
  try {
    const transcriptFile = path.join(s.base, "transcript.jsonl");
    transcript(transcriptFile, "ship from the Cursor transcript", s.repo);
    writeFileSync(path.join(s.repo, "file.txt"), "after transcript fallback\n");

    const stop = run(["ship"], {
      cwd: s.workspace,
      env: s.env,
      input: cursorPayload(s.workspace, {
        hook_event_name: "stop",
        status: "completed",
        transcript_path: transcriptFile
      })
    });
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(s.pushed(), 2);
    assert.equal(s.subject(), "ship from the Cursor transcript");
    assert.match(s.body(), /Shipped-by: autogit/);
  } finally { s.cleanup(); }
});

test("setup makes Claude autogit hooks no-op inside Cursor without disabling Claude", () => {
  const base = mkdtempSync(path.join(tmpdir(), "autogit-cursor-setup-"));
  try {
    const claudeDir = path.join(base, ".claude");
    const cursorDir = path.join(base, ".cursor");
    mkdirSync(claudeDir);
    mkdirSync(cursorDir);
    const claudeFile = path.join(claudeDir, "settings.json");
    writeFileSync(claudeFile, JSON.stringify({ hooks: {
      Stop: [{ hooks: [{ type: "command", command: 'cd "${CLAUDE_PROJECT_DIR:-.}" && autogit ship' }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: 'cd "${CLAUDE_PROJECT_DIR:-.}" && autogit busy' }] }],
      PostToolUse: [{ hooks: [{ type: "command", command: 'cd "${CLAUDE_PROJECT_DIR:-.}" && autogit busy' }] }]
    } }, null, 2));

    const env = { HOME: base, AUTOGIT_HOME: base };
    const first = run(["setup"], { cwd: base, env });
    assert.equal(first.status, 0, first.stderr);
    const once = readFileSync(claudeFile, "utf8");
    assert.doesNotMatch(once, /"command": "cd \\"\$\{CLAUDE_PROJECT_DIR/);
    assert.match(once, /CURSOR_VERSION/);

    const second = run(["setup"], { cwd: base, env });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(claudeFile, "utf8"), once, "setup must stay idempotent");

    const cfg = JSON.parse(once);
    const command = cfg.hooks.Stop[0].hooks[0].command;
    const bin = path.join(base, "bin");
    const calls = path.join(base, "calls");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "autogit"), `#!/bin/sh\necho "$@" >> "${calls}"\n`);
    chmodSync(path.join(bin, "autogit"), 0o755);
    const shellEnv = { ...GIT_ENV, PATH: `${bin}:${process.env.PATH}`, CLAUDE_PROJECT_DIR: base };

    const cursorRun = spawnSync("/bin/sh", ["-c", command], {
      cwd: base,
      env: { ...shellEnv, CURSOR_VERSION: "test" },
      encoding: "utf8"
    });
    assert.equal(cursorRun.status, 0, cursorRun.stderr);
    assert.equal(existsSync(calls), false, "Cursor must not run the Claude copy");

    const claudeRun = spawnSync("/bin/sh", ["-c", command], { cwd: base, env: shellEnv, encoding: "utf8" });
    assert.equal(claudeRun.status, 0, claudeRun.stderr);
    assert.equal(readFileSync(calls, "utf8").trim(), "ship", "Claude must still run autogit");
  } finally { rmSync(base, { recursive: true, force: true }); }
});
