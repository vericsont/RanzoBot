import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTerminalFiles } from "./terminal-files.mjs";

const MAX_TEXT_BYTES = 4 * 1024 * 1024;

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rnz-terminal-files-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function code(expected) {
  return error => error.code === expected;
}

test("opens one explicit file, preserves UTF-8 BOM, line endings and mode on save", async t => {
  const root = await fixture(t);
  const filePath = path.join(root, "draft with spaces.txt");
  const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("first\r\nsecond\r\n")]);
  await fs.writeFile(filePath, original, { mode: 0o640 });
  const files = createTerminalFiles();
  const opened = await files.open(filePath);
  assert.equal(opened.kind, "file");
  assert.equal(opened.label, "draft with spaces.txt");
  assert.ok(opened.id.length >= 32);
  assert.notEqual(opened.id, filePath);

  const first = await files.read(opened.id);
  assert.equal(first.text, "\ufefffirst\r\nsecond\r\n");
  assert.equal(first.readOnly, false);
  const saved = await files.save(opened.id, first.revision, `${first.text}last\r\n`);
  assert.equal((await fs.readFile(filePath)).toString("utf8"), "\ufefffirst\r\nsecond\r\nlast\r\n");
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o640);
  assert.notEqual(saved.revision, first.revision);
  await files.close(opened.id);
  await assert.rejects(files.read(opened.id), code("UNAVAILABLE"));
});

test("mixed line endings and hard-linked files remain read-only", async t => {
  const root = await fixture(t);
  const mixed = path.join(root, "mixed.txt");
  const linked = path.join(root, "linked.txt");
  await fs.writeFile(mixed, "first\r\nsecond\n");
  await fs.writeFile(linked, "linked\n");
  await fs.link(linked, path.join(root, "other-link.txt"));
  const files = createTerminalFiles();
  for (const file of [mixed, linked]) {
    const resource = await files.open(file);
    const data = await files.read(resource.id);
    assert.equal(data.readOnly, true);
    await assert.rejects(files.save(resource.id, data.revision, "change"), code("READ_ONLY"));
  }
  assert.equal(await fs.readFile(linked, "utf8"), "linked\n");
});

test("directory navigation is scoped, sorted and does not follow symlinks", async t => {
  const root = await fixture(t);
  const selected = path.join(root, "selected");
  const outside = path.join(root, "outside");
  await fs.mkdir(path.join(selected, "nested"), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(selected, "z.txt"), "z");
  await fs.writeFile(path.join(selected, "nested", "a.txt"), "a");
  await fs.writeFile(path.join(outside, "secret.txt"), "secret");
  await fs.symlink(outside, path.join(selected, "escape"));
  await fs.symlink(path.join(outside, "secret.txt"), path.join(selected, "secret-link"));

  const files = createTerminalFiles();
  const directory = await files.open(selected);
  assert.equal(directory.kind, "directory");
  const listing = await files.list(directory.id);
  assert.deepEqual(listing.entries, [
    { name: "escape", kind: "symlink" },
    { name: "nested", kind: "directory" },
    { name: "secret-link", kind: "symlink" },
    { name: "z.txt", kind: "file" },
  ]);
  assert.deepEqual((await files.list(directory.id, "nested")).entries, [{ name: "a.txt", kind: "file" }]);
  await assert.rejects(files.list(directory.id, "escape"), code("SYMLINK"));
  await assert.rejects(files.openChild(directory.id, "secret-link"), code("SYMLINK"));
  await assert.rejects(files.openChild(directory.id, "escape/secret.txt"), code("SYMLINK"));

  const childFile = await files.openChild(directory.id, "nested/a.txt");
  assert.equal(childFile.kind, "file");
  assert.equal((await files.read(childFile.id)).text, "a");
  const childDirectory = await files.openChild(directory.id, "nested");
  assert.equal(childDirectory.kind, "directory");
  assert.deepEqual((await files.list(childDirectory.id)).entries, [{ name: "a.txt", kind: "file" }]);
});

test("rejects traversal and keeps an explicit file grant narrow", async t => {
  const root = await fixture(t);
  const filePath = path.join(root, "file.txt");
  await fs.writeFile(filePath, "safe");
  const files = createTerminalFiles();
  const opened = await files.open(filePath);
  await assert.rejects(files.list(opened.id), code("UNAVAILABLE"));
  await assert.rejects(files.openChild(opened.id, "child"), code("UNAVAILABLE"));
  const directory = await files.open(root);
  for (const invalid of ["../outside", "nested/../file.txt", path.resolve(root, "file.txt"), "bad\0name"]) {
    await assert.rejects(files.list(directory.id, invalid), code("INVALID_PATH"));
  }
  await assert.rejects(files.open(path.join(root, "missing")), code("NOT_FOUND"));
  await fs.symlink(filePath, path.join(root, "file-link"));
  await assert.rejects(files.open(path.join(root, "file-link")), code("SYMLINK"));
});

test("rejects binary, invalid UTF-8 and oversized files", async t => {
  const root = await fixture(t);
  const binaryPath = path.join(root, "binary.dat");
  const invalidPath = path.join(root, "invalid.dat");
  const largePath = path.join(root, "large.txt");
  await fs.writeFile(binaryPath, Buffer.from([0x61, 0x00, 0x62]));
  await fs.writeFile(invalidPath, Buffer.from([0xc3, 0x28]));
  await fs.writeFile(largePath, Buffer.alloc(MAX_TEXT_BYTES + 1, 0x61));
  const files = createTerminalFiles();
  for (const [filePath, expected] of [[binaryPath, "BINARY"], [invalidPath, "UNSUPPORTED_ENCODING"], [largePath, "TOO_LARGE"]]) {
    const opened = await files.open(filePath);
    await assert.rejects(files.read(opened.id), code(expected));
  }
  const normalPath = path.join(root, "normal.txt");
  await fs.writeFile(normalPath, "unchanged");
  const normal = await files.open(normalPath);
  const revision = (await files.read(normal.id)).revision;
  await assert.rejects(files.save(normal.id, revision, "x".repeat(MAX_TEXT_BYTES + 1)), code("TOO_LARGE"));
  assert.equal(await fs.readFile(normalPath, "utf8"), "unchanged");
});

test("detects content changes, replacement and deletion as conflicts", async t => {
  const root = await fixture(t);
  const files = createTerminalFiles();
  const changedPath = path.join(root, "changed.txt");
  await fs.writeFile(changedPath, "before");
  const changed = await files.open(changedPath);
  const changedRevision = (await files.read(changed.id)).revision;
  await fs.writeFile(changedPath, "external");
  await assert.rejects(files.save(changed.id, changedRevision, "draft"), code("CONFLICT"));
  assert.equal(await fs.readFile(changedPath, "utf8"), "external");

  const replacedPath = path.join(root, "replaced.txt");
  await fs.writeFile(replacedPath, "same bytes");
  const replaced = await files.open(replacedPath);
  const replacedRevision = (await files.read(replaced.id)).revision;
  await fs.unlink(replacedPath);
  await fs.writeFile(replacedPath, "same bytes");
  await assert.rejects(files.save(replaced.id, replacedRevision, "draft"), code("CONFLICT"));
  assert.equal(await fs.readFile(replacedPath, "utf8"), "same bytes");

  const deletedPath = path.join(root, "deleted.txt");
  await fs.writeFile(deletedPath, "before");
  const deleted = await files.open(deletedPath);
  const deletedRevision = (await files.read(deleted.id)).revision;
  await fs.unlink(deletedPath);
  await assert.rejects(files.save(deleted.id, deletedRevision, "draft"), code("CONFLICT"));
});

test("serializes saves using revisions and retains file contents after a write failure", async t => {
  const root = await fixture(t);
  const filePath = path.join(root, "file.txt");
  await fs.writeFile(filePath, "before");
  const files = createTerminalFiles();
  const opened = await files.open(filePath);
  const initial = await files.read(opened.id);
  const results = await Promise.allSettled([
    files.save(opened.id, initial.revision, "first"),
    files.save(opened.id, initial.revision, "second"),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected" && result.reason.code === "CONFLICT").length, 1);

  const current = await files.read(opened.id);
  const originalRename = fs.rename;
  fs.rename = async () => { throw Object.assign(new Error("simulated write failure"), { code: "EIO" }); };
  try {
    await assert.rejects(files.save(opened.id, current.revision, "draft"), error => error.code === "EIO");
  } finally {
    fs.rename = originalRename;
  }
  assert.equal((await files.read(opened.id)).text, current.text);
  assert.deepEqual((await fs.readdir(root)).sort(), ["file.txt"]);
});

test("permission failures and resource cleanup leave no temporary files", async t => {
  const root = await fixture(t);
  const filePath = path.join(root, "read-only.txt");
  await fs.writeFile(filePath, "keep", { mode: 0o644 });
  const files = createTerminalFiles();
  const opened = await files.open(filePath);
  const snapshot = await files.read(opened.id);
  await fs.chmod(root, 0o555);
  try {
    assert.equal((await files.read(opened.id)).readOnly, true);
    await assert.rejects(files.save(opened.id, snapshot.revision, "draft"), code("READ_ONLY"));
  } finally {
    await fs.chmod(root, 0o755);
  }
  assert.equal(await fs.readFile(filePath, "utf8"), "keep");
  assert.deepEqual(await fs.readdir(root), ["read-only.txt"]);
  await files.closeAll();
  await assert.rejects(files.read(opened.id), code("UNAVAILABLE"));
});

test("lists special files as other and refuses to open them", { skip: process.platform === "win32" }, async t => {
  const root = await fixture(t);
  const socketPath = path.join(root, "socket");
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const files = createTerminalFiles();
  const directory = await files.open(root);
  assert.deepEqual((await files.list(directory.id)).entries, [{ name: "socket", kind: "other" }]);
  await assert.rejects(files.open(socketPath), code("NOT_FILE"));
  await assert.rejects(files.openChild(directory.id, "socket"), code("NOT_FILE"));
});

test("refuses directories whose result would exceed the bound", async t => {
  const root = await fixture(t);
  for (let index = 0; index < 501; index += 1) await fs.writeFile(path.join(root, `file-${index}.txt`), "");
  const files = createTerminalFiles();
  const opened = await files.open(root);
  await assert.rejects(files.list(opened.id), code("TOO_MANY_ENTRIES"));
});
