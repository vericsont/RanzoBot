import assert from "node:assert/strict";
import { execFile as callbackExecFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTerminalGit } from "./terminal-git.mjs";

const execFile = promisify(callbackExecFile);

async function git(cwd, ...args) {
  const { stdout } = await execFile("git", ["-c", "core.fsmonitor=false", "-C", cwd, ...args], {
    encoding: "buffer",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout.toString("utf8").replace(/\n$/, "");
}

async function fixture(t, options = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rnz-git-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await execFile("git", ["init", "-q", ...options, root]);
  await git(root, "config", "user.name", "Ranzo Tester");
  await git(root, "config", "user.email", "ranzo@example.invalid");
  await fs.mkdir(path.join(root, "nested"));
  return root;
}

async function commitAll(root, message) {
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", message);
  return git(root, "rev-parse", "HEAD");
}

async function refs(root) {
  return git(root, "for-each-ref", "--format=%(refname) %(objectname)");
}

test("opens repositories from subdirectories and worktrees; returns root history and unusual file diffs read-only", async t => {
  const root = await fixture(t, ["-b", "main"]);
  await fs.writeFile(path.join(root, "first file.txt"), "first line\n\nbody\n");
  await fs.writeFile(path.join(root, "line\nbreak.txt"), "odd name\n");
  await fs.writeFile(path.join(root, "-leading.txt"), "leading\n");
  await fs.writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2, 255]));
  const rootHash = await commitAll(root, "root commit\n\nBody line\n");
  await git(root, "tag", "-a", "v1", "-m", "version one");
  const nested = path.join(root, "nested");
  const worktree = path.join(path.dirname(root), `${path.basename(root)}-worktree`);
  await git(root, "worktree", "add", "-q", "-b", "worktree-branch", worktree, rootHash);
  t.after(() => fs.rm(worktree, { recursive: true, force: true }));

  const service = createTerminalGit();
  t.after(() => service.closeAll());
  const opened = await service.open(nested);
  assert.deepEqual({ kind: opened.kind, label: opened.label }, { kind: "git", label: path.basename(root) });
  const history = await service.history(opened.id);
  assert.equal(history.commits.length, 1);
  assert.equal(history.commits[0].hash, rootHash);
  assert.deepEqual(history.commits[0].parents, []);
  assert.ok(history.commits[0].refs.includes("main"));
  assert.ok(history.commits[0].refs.includes("tag: v1"));

  const commit = await service.commit(opened.id, rootHash);
  assert.equal(commit.subject, "root commit");
  assert.equal(commit.body, "Body line\n");
  assert.deepEqual(commit.parents, []);
  assert.deepEqual(commit.files.map(file => file.path).sort(), ["-leading.txt", "binary.bin", "first file.txt", "line\nbreak.txt"].sort());

  const textDiff = await service.diff(opened.id, rootHash, undefined, "first file.txt");
  assert.match(textDiff.text, /first line/);
  assert.equal(textDiff.truncated, false);
  const binaryDiff = await service.diff(opened.id, rootHash, undefined, "binary.bin");
  assert.match(binaryDiff.text, /Binary files .* differ/);
  await assert.rejects(service.diff(opened.id, rootHash, undefined, "../outside"), /invalid/);
  await assert.rejects(service.diff(opened.id, rootHash, undefined, "missing"), /not part/);
  await assert.rejects(service.commit(opened.id, "not-a-hash"), /hash is invalid/);
  await assert.rejects(service.commit(opened.id, rootHash, "0".repeat(40)), /not a parent/);

  const beforeStatus = await git(root, "status", "--porcelain=v1", "--untracked-files=all");
  const beforeRefs = await refs(root);
  const worktreeOpen = await service.open(worktree);
  assert.equal(worktreeOpen.label, path.basename(worktree));
  await service.history(worktreeOpen.id);
  assert.equal(await git(root, "status", "--porcelain=v1", "--untracked-files=all"), beforeStatus);
  assert.equal(await refs(root), beforeRefs);
});

test("selects merge parents and reports renames", async t => {
  const root = await fixture(t, ["-b", "main"]);
  await fs.writeFile(path.join(root, "base.txt"), "base\n");
  const base = await commitAll(root, "base");
  await git(root, "branch", "side");

  await fs.writeFile(path.join(root, "main.txt"), "main\n");
  await commitAll(root, "main change");
  const firstParent = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "side");
  await fs.writeFile(path.join(root, "side.txt"), "side\n");
  await commitAll(root, "side change");
  const secondParent = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "main");
  await git(root, "merge", "--no-ff", "--no-edit", "side");
  const merge = await git(root, "rev-parse", "HEAD");

  await fs.rename(path.join(root, "main.txt"), path.join(root, "renamed main.txt"));
  await commitAll(root, "rename");
  const rename = await git(root, "rev-parse", "HEAD");

  const service = createTerminalGit();
  t.after(() => service.closeAll());
  const { id } = await service.open(root);
  const mergeDetails = await service.commit(id, merge);
  assert.deepEqual(mergeDetails.parents, [firstParent, secondParent]);
  assert.deepEqual(mergeDetails.files.map(file => file.path), ["side.txt"]);
  const secondParentDetails = await service.commit(id, merge, secondParent);
  assert.deepEqual(secondParentDetails.files.map(file => file.path), ["main.txt"]);
  assert.match((await service.diff(id, merge, secondParent, "main.txt")).text, /main/);
  await assert.rejects(service.commit(id, merge, base), /not a parent/);

  const renameDetails = await service.commit(id, rename);
  const renamed = renameDetails.files.find(file => file.path === "renamed main.txt");
  assert.ok(renamed);
  assert.match(renamed.status, /^R/);
  assert.equal(renamed.oldPath, "main.txt");
  assert.match((await service.diff(id, rename, undefined, renamed.path)).text, /renamed main\.txt/);
  await fs.rm(path.join(root, "side.txt"));
  const deletion = await commitAll(root, "delete side file");
  const deletionDetails = await service.commit(id, deletion);
  assert.deepEqual(deletionDetails.files, [{ path: "side.txt", status: "D" }]);
  assert.match((await service.diff(id, deletion, undefined, "side.txt")).text, /-side/);
});

test("paginates against an unchanged ref snapshot and rejects stale cursors", async t => {
  const root = await fixture(t, ["-b", "main"]);
  await fs.writeFile(path.join(root, "tracked"), "content\n");
  await commitAll(root, "base");
  const tree = await git(root, "write-tree");
  let parent = await git(root, "rev-parse", "HEAD");
  for (let index = 0; index < 101; index++) {
    parent = await git(root, "commit-tree", tree, "-p", parent, "-m", `page ${index}`);
  }
  await git(root, "update-ref", "refs/heads/main", parent);

  const service = createTerminalGit();
  t.after(() => service.closeAll());
  const { id } = await service.open(root);
  const first = await service.history(id);
  assert.equal(first.commits.length, 100);
  assert.equal(typeof first.nextCursor, "string");
  const second = await service.history(id, first.nextCursor);
  assert.equal(second.commits.length, 2);
  assert.equal(second.nextCursor, null);
  await git(root, "update-ref", "refs/heads/extra", parent);
  await assert.rejects(service.history(id, first.nextCursor), /references changed/);
  await assert.rejects(service.history(id, "bad"), /cursor is invalid/);
});

test("caps diff output, neutralizes Git helpers, closes opaque handles, and supports SHA-256", async t => {
  const root = await fixture(t, ["-b", "main"]);
  const marker = path.join(root, "helper-ran");
  const helper = path.join(root, "helper.sh");
  await fs.writeFile(helper, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  await fs.writeFile(path.join(root, ".gitattributes"), "*.txt diff=hostile\n");
  await fs.writeFile(path.join(root, "large.txt"), "a\n");
  const base = await commitAll(root, "base");
  await fs.writeFile(path.join(root, "large.txt"), `${"x".repeat(2 * 1024 * 1024)}\n`);
  const large = await commitAll(root, "large change");
  await git(root, "config", "diff.external", helper);
  await git(root, "config", "diff.hostile.textconv", helper);
  await git(root, "config", "core.fsmonitor", helper);
  const statusBefore = await git(root, "status", "--porcelain=v1", "--untracked-files=all");
  const refsBefore = await refs(root);

  const service = createTerminalGit();
  t.after(() => service.closeAll());
  const { id } = await service.open(root);
  const diff = await service.diff(id, large, base, "large.txt");
  assert.equal(diff.truncated, true);
  assert.ok(Buffer.byteLength(diff.text) <= 2 * 1024 * 1024);
  assert.equal(await fs.access(marker).then(() => true, () => false), false);
  assert.equal(await git(root, "status", "--porcelain=v1", "--untracked-files=all"), statusBefore);
  assert.equal(await refs(root), refsBefore);

  service.close(id);
  await assert.rejects(service.history(id), /closed or unknown/);
  const { id: shaId } = await (async () => {
    const shaRoot = await fixture(t, ["--object-format=sha256", "-b", "main"]);
    await fs.writeFile(path.join(shaRoot, "file"), "sha256\n");
    await commitAll(shaRoot, "sha256");
    return service.open(shaRoot);
  })();
  assert.equal((await service.history(shaId)).commits[0].hash.length, 64);
  service.closeAll();
  await assert.rejects(service.commit(shaId, "0".repeat(64)), /closed or unknown/);
});

test("includes detached HEAD commits in history", async t => {
  const root = await fixture(t, ["-b", "main"]);
  await fs.writeFile(path.join(root, "tracked"), "base\n");
  const base = await commitAll(root, "base");
  await git(root, "checkout", "--detach", base);
  await fs.writeFile(path.join(root, "detached"), "head only\n");
  const detached = await commitAll(root, "detached HEAD");

  const service = createTerminalGit();
  t.after(() => service.closeAll());
  const { id } = await service.open(root);
  const history = await service.history(id);
  assert.equal(history.commits[0].hash, detached);
  assert.deepEqual(history.commits[0].refs, []);
  assert.ok(history.commits.some(commit => commit.hash === base));
});

test("rejects nonrepositories and supports empty repositories", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rnz-empty-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const service = createTerminalGit();
  t.after(() => service.closeAll());
  await assert.rejects(service.open(directory));
  await execFile("git", ["init", "-q", directory]);
  const { id } = await service.open(directory);
  assert.deepEqual(await service.history(id), { commits: [], nextCursor: null });
});
