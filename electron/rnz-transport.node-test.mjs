import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRnzTransport } from "./rnz-transport.mjs";

const electronDirectory = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(electronDirectory, "rnz-cli.mjs");
const wrapperPath = path.join(electronDirectory, "rnz");

function run(command, args, { cwd, env = {}, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function fixture(t, onRequest) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rnz-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const transport = createRnzTransport({ onRequest });
  await transport.start();
  t.after(() => transport.close());
  const owner = { name: "fixture-owner" };
  const credentials = transport.addSession("fixture-session", owner);
  return { root, transport, owner, credentials };
}

function cli(args, credentials, cwd) {
  return run(process.execPath, [cliPath, ...args], { cwd, env: credentials });
}

test("rnz resolves paths from the command cwd and returns only after pane acceptance", async t => {
  const requests = [];
  const { root, owner, credentials } = await fixture(t, async request => {
    await new Promise(resolve => setTimeout(resolve, 80));
    requests.push(request);
  });
  const cwd = path.join(root, "after-cd");
  await mkdir(cwd);
  const started = Date.now();
  const result = await cli(["view", "--", "-snow ☃ file"], credentials, cwd);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.ok(Date.now() - started >= 60);
  assert.deepEqual(requests, [{
    sessionId: "fixture-session",
    owner,
    action: "view",
    absolutePath: path.join(cwd, "-snow ☃ file"),
  }]);

  const wrapperResult = await run(wrapperPath, ["git"], {
    cwd,
    env: { ...credentials, RNZ_NODE: process.execPath, RNZ_CLI: cliPath },
  });
  assert.equal(wrapperResult.code, 0, wrapperResult.stderr);
  assert.equal(wrapperResult.stdout, "");
  assert.equal(requests[1].action, "git");
  assert.equal(requests[1].absolutePath, cwd);
});

test("rnz rejects invalid arguments without contacting the transport", async t => {
  const calls = [];
  const { root, credentials } = await fixture(t, request => calls.push(request));
  for (const args of [[], ["open"], ["view", "first", "second"], ["git", "-bad"]]) {
    const result = await cli(args, credentials, root);
    assert.equal(result.code, 2, args.join(" "));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^rnz: Usage:/);
  }
  assert.deepEqual(calls, []);
});

test("wrong and revoked capabilities cannot request a pane", async t => {
  const calls = [];
  const { root, credentials, transport } = await fixture(t, request => calls.push(request));
  const wrong = { ...credentials, RNZ_TOKEN: "a".repeat(64) };
  const rejected = await cli(["view"], wrong, root);
  assert.equal(rejected.code, 1);
  assert.equal(rejected.stdout, "");
  assert.match(rejected.stderr, /session is unavailable/);
  assert.doesNotMatch(rejected.stderr, new RegExp(wrong.RNZ_TOKEN));

  transport.revoke("fixture-session");
  const stale = await cli(["git"], credentials, root);
  assert.equal(stale.code, 1);
  assert.equal(stale.stdout, "");
  assert.match(stale.stderr, /session is unavailable/);
  assert.deepEqual(calls, []);
});

test("endpoint and private directory permissions are restrictive and close removes them", async t => {
  const { transport, credentials } = await fixture(t, () => {});
  const socketPath = credentials.RNZ_SOCKET;
  const directory = path.dirname(socketPath);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
  await transport.close();
  await assert.rejects(stat(socketPath), { code: "ENOENT" });
  await assert.rejects(stat(directory), { code: "ENOENT" });
});

test("concurrent CLI requests are independently acknowledged", async t => {
  const requests = [];
  const { root, credentials, owner } = await fixture(t, async request => {
    await new Promise(resolve => setTimeout(resolve, 40));
    requests.push(request);
  });
  const results = await Promise.all(Array.from({ length: 4 }, (_, index) => cli(["view", `file-${index}`], credentials, root)));
  assert.deepEqual(results.map(result => result.code), [0, 0, 0, 0]);
  assert.equal(requests.length, 4);
  assert.ok(requests.every(request => request.owner === owner));
});

test("transport reports pane rejection and wrapper never falls back to global Node", async t => {
  const { root, transport, credentials } = await fixture(t, () => { throw new Error("Pane was rejected"); });
  const rejected = await cli(["view"], credentials, root);
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /Pane was rejected/);

  const missingRuntime = await run(wrapperPath, ["view"], { cwd: root, env: { RNZ_NODE: "", RNZ_CLI: cliPath } });
  assert.equal(missingRuntime.code, 127);
  assert.match(missingRuntime.stderr, /launcher is unavailable/);
  await transport.close();
});
