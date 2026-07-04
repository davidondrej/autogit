// E2E tests for `autogit update`. Run: npm test
// The real `npm install -g` must never run here — the happy path is tested
// against a fake npm/autogit on PATH, in a temp copy with no .git (that's
// what an npm-installed autogit looks like).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const INDEX = fileURLToPath(new URL("./index.js", import.meta.url));

test("update refuses inside a source checkout — npm must not bury the npm-link symlink", () => {
  // this repo is exactly that case: .git sits next to index.js
  const r = spawnSync(process.execPath, [INDEX, "update"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /source checkout/);
  assert.match(r.stderr, /git pull/);
});

test("update runs npm install -g and reports old → new version", () => {
  const base = mkdtempSync(path.join(tmpdir(), "autogit-update-"));
  try {
    // npm-install-like copy: index.js + package.json, no .git
    copyFileSync(INDEX, path.join(base, "index.js"));
    copyFileSync(path.join(path.dirname(INDEX), "package.json"), path.join(base, "package.json"));
    // fake npm records its args; fake autogit answers the post-install version probe
    const bin = path.join(base, "bin");
    mkdirSync(bin);
    const argsLog = path.join(base, "npm-args.txt");
    writeFileSync(path.join(bin, "npm"), `#!/bin/sh\necho "$@" > "${argsLog}"\nexit 0\n`);
    writeFileSync(path.join(bin, "autogit"), '#!/bin/sh\necho "9.9.9"\n');
    chmodSync(path.join(bin, "npm"), 0o755);
    chmodSync(path.join(bin, "autogit"), 0o755);
    const r = spawnSync(process.execPath, [path.join(base, "index.js"), "update"],
      { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(argsLog, "utf8").trim(), "install -g @davidondrej/autogit@latest");
    assert.match(r.stderr, /updated .+ → 9\.9\.9/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
