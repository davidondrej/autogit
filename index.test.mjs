// Zero-dependency tests for the busy-marker / defer logic. Run: npm test
// Focus: a ghost marker (dead process, or our own churned session id) must never
// block shipping — the bug these tests exist to prevent regressing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sweepBusy, sweepBusyMarkers, busyDir, isAlive, agentPid, readMarker, writeMarker, BUSY_TTL_MS } from "./index.js";

// A pid astronomically unlikely to exist — stands in for a crashed/closed agent.
const DEAD_PID = 2147480000;

// Run `fn` inside a throwaway git repo with cwd set to it (busyDir reads cwd).
function inRepo(fn) {
  const cwd = process.cwd();
  const repo = mkdtempSync(path.join(tmpdir(), "autogit-test-"));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  try {
    process.chdir(repo);
    const dir = busyDir(repo);
    mkdirSync(dir, { recursive: true });
    fn(dir);
  } finally {
    process.chdir(cwd);
    rmSync(repo, { recursive: true, force: true });
  }
}

const marker = (dir, name) => path.join(dir, name);
function age(file, ms) { const t = new Date(Date.now() - ms); utimesSync(file, t, t); }

test("dead-pid marker is reaped and never blocks shipping", () => {
  inRepo(dir => {
    const f = marker(dir, "crashed-session");
    writeMarker(f, DEAD_PID, "half-finished work");
    assert.equal(sweepBusy(dir, process.pid), false, "a dead agent must not count as busy");
    assert.equal(existsSync(f), false, "the orphan marker should be deleted");
  });
});

test("our own churned-session marker (same pid) is reaped, not treated as another agent", () => {
  inRepo(dir => {
    // compaction/clear: same live process, but a stale marker under the old id
    const f = marker(dir, "old-session-id");
    writeMarker(f, process.pid, "previous turn");
    assert.equal(sweepBusy(dir, process.pid), false, "our own ghost must not block us");
    assert.equal(existsSync(f), false, "the self-orphan should be deleted");
  });
});

test("a live, different agent's marker correctly defers", () => {
  inRepo(dir => {
    const f = marker(dir, "other-agent");
    writeMarker(f, process.pid, "real concurrent work"); // alive, and != myPid below
    assert.equal(sweepBusy(dir, DEAD_PID), true, "a live other agent must cause a defer");
    assert.equal(existsSync(f), true, "a live agent's marker must be preserved");
  });
});

test("stale marker is reaped regardless of pid liveness", () => {
  inRepo(dir => {
    const f = marker(dir, "ancient");
    writeMarker(f, process.pid, "x"); // pid is alive...
    age(f, BUSY_TTL_MS + 60_000);     // ...but past the TTL backstop
    assert.equal(sweepBusy(dir, DEAD_PID), false, "past-TTL markers are stale even if pid is alive");
    assert.equal(existsSync(f), false);
  });
});

test("legacy plain-text markers still work (TTL-gated, no pid)", () => {
  inRepo(dir => {
    const f = marker(dir, "legacy");
    writeFileSync(f, "a bare prompt, pre-pid format");
    assert.equal(sweepBusy(dir, DEAD_PID), true, "a fresh legacy marker still defers");
    assert.equal(existsSync(f), true, "a fresh legacy marker is preserved");
    age(f, BUSY_TTL_MS + 60_000);
    assert.equal(sweepBusy(dir, DEAD_PID), false, "a stale legacy marker is reaped");
  });
});

test("multiple markers are all swept in one pass (no early return)", () => {
  inRepo(dir => {
    // myPid = process.pid below. process.ppid is a different, live process — it
    // stands in for a genuinely concurrent other agent.
    writeMarker(marker(dir, "dead"), DEAD_PID, "a");
    writeMarker(marker(dir, "mine"), process.pid, "b");       // our own churned-session orphan
    const liveOther = marker(dir, "live-other");
    writeMarker(liveOther, process.ppid, "c");                // alive, != myPid
    const staleF = marker(dir, "stale");
    writeMarker(staleF, process.ppid, "d"); age(staleF, BUSY_TTL_MS + 60_000); // alive but past TTL
    assert.equal(sweepBusy(dir, process.pid), true, "the one live other agent survives");
    assert.equal(existsSync(marker(dir, "dead")), false, "dead reaped");
    assert.equal(existsSync(marker(dir, "mine")), false, "self-orphan reaped");
    assert.equal(existsSync(staleF), false, "stale reaped");
    assert.equal(existsSync(liveOther), true, "live other preserved");
  });
});

test("status-style sweep cleans ghosts while preserving live markers", () => {
  inRepo(dir => {
    writeMarker(marker(dir, "dead"), DEAD_PID, "a");
    const liveOther = marker(dir, "live-other");
    writeMarker(liveOther, process.pid, "b");
    const staleF = marker(dir, "stale");
    writeMarker(staleF, process.pid, "c"); age(staleF, BUSY_TTL_MS + 60_000);
    assert.equal(sweepBusyMarkers(dir, null, { reapMine: false }), 1, "only the live marker counts");
    assert.equal(existsSync(marker(dir, "dead")), false, "dead reaped");
    assert.equal(existsSync(staleF), false, "stale reaped");
    assert.equal(existsSync(liveOther), true, "live marker preserved");
  });
});

test("readMarker / writeMarker round-trip, plus legacy parse", () => {
  inRepo(dir => {
    const f = marker(dir, "rt");
    writeMarker(f, 1234, "hello world");
    assert.deepEqual(readMarker(f), { pid: 1234, prompt: "hello world" });
    writeMarker(f, null, ""); // tool-hook write: pid known, no prompt
    assert.deepEqual(readMarker(f), { pid: null, prompt: null });
    writeFileSync(f, "legacy text");
    assert.deepEqual(readMarker(f), { pid: null, prompt: "legacy text" });
  });
});

test("isAlive: this process is alive, an absurd pid is not", () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(DEAD_PID), false);
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(null), false);
});

test("agentPid resolves to a live ancestor process", () => {
  const pid = agentPid();
  assert.ok(Number.isInteger(pid) && pid > 1, "should be a real pid");
  assert.equal(isAlive(pid), true, "the resolved agent must actually be running");
});
