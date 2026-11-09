import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { TextDecoder } from "node:util";

const MAX_PATH_BYTES = 16 * 1024;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 500;
const MAX_RESOURCES = 256;
const NOFOLLOW = fs.constants.O_NOFOLLOW;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function identity(stats) {
  return `${stats.dev}:${stats.ino}`;
}

function sameVersion(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mode === right.mode && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function ensurePathString(value, absolute = false) {
  if (typeof value !== "string" || !value || value.includes("\0") ||
      Buffer.from(value, "utf8").toString("utf8") !== value || Buffer.byteLength(value) > MAX_PATH_BYTES ||
      (absolute && !path.isAbsolute(value))) {
    fail("INVALID_PATH", "Path is invalid");
  }
}

function relativeParts(value) {
  if (value === "") return [];
  ensurePathString(value);
  if (path.isAbsolute(value)) fail("INVALID_PATH", "Path must be relative");
  const parts = value.split(path.sep);
  if (parts.some(part => part === ".." || part === "." || part === "")) {
    fail("INVALID_PATH", "Path contains an invalid component");
  }
  return parts;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function makeRevision(raw, stats) {
  const digest = createHash("sha256").update(raw).digest("hex");
  const facts = [identity(stats), stats.mode.toString(), stats.size.toString(), stats.mtimeNs.toString(), stats.ctimeNs.toString(), digest];
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex");
}

function decodeText(raw) {
  let text;
  try {
    text = decoder.decode(raw);
  } catch {
    fail("UNSUPPORTED_ENCODING", "File is not valid UTF-8");
  }
  if (text.includes("\0")) fail("BINARY", "Binary files cannot be opened as text");
  return text;
}

function mixedLineEndings(text) {
  let first = "";
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "\r" && text[index] !== "\n") continue;
    const ending = text[index] === "\r" && text[index + 1] === "\n" ? "\r\n" : text[index];
    if (ending.length === 2) index++;
    if (first && first !== ending) return true;
    first = ending;
  }
  return false;
}

function encodeText(text) {
  if (typeof text !== "string") fail("INVALID_TEXT", "Text must be a string");
  const raw = Buffer.from(text, "utf8");
  if (raw.toString("utf8") !== text) fail("INVALID_TEXT", "Text contains invalid Unicode");
  if (raw.length > MAX_TEXT_BYTES) fail("TOO_LARGE", "File exceeds the text size limit");
  if (raw.includes(0)) fail("BINARY", "Text cannot contain NUL bytes");
  return raw;
}

function validateAbsolute(absolutePath) {
  ensurePathString(absolutePath, true);
  return path.resolve(absolutePath);
}

export function createTerminalFiles() {
  const resources = new Map();

  function add(resource) {
    if (resources.size >= MAX_RESOURCES) fail("LIMIT", "Too many open local resources");
    resource.id = randomBytes(32).toString("base64url");
    resources.set(resource.id, resource);
    return { id: resource.id, kind: resource.kind, label: resource.label };
  }

  function get(id, kind) {
    const resource = typeof id === "string" ? resources.get(id) : undefined;
    if (!resource || (kind && resource.kind !== kind)) fail("UNAVAILABLE", "Resource is unavailable");
    return resource;
  }

  async function verifyDirectoryRoot(resource) {
    let stats;
    try {
      stats = await fsp.lstat(resource.root, { bigint: true });
      if (stats.isSymbolicLink() || !stats.isDirectory() || identity(stats) !== resource.identity) {
        fail("CONFLICT", "Directory changed or was replaced");
      }
      if (await fsp.realpath(resource.root) !== resource.root) fail("CONFLICT", "Directory changed or was replaced");
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) fail("CONFLICT", "Directory is no longer available");
      if (error.code) throw error;
      fail("CONFLICT", "Directory is no longer available");
    }
    return stats;
  }

  async function resolveDirectory(resource, relativePath = "") {
    await verifyDirectoryRoot(resource);
    let current = resource.root;
    for (const part of relativeParts(relativePath)) {
      const next = path.join(current, part);
      let stats;
      try {
        stats = await fsp.lstat(next, { bigint: true });
      } catch (error) {
        if (error.code === "ENOENT") fail("NOT_FOUND", "Directory does not exist");
        throw error;
      }
      if (stats.isSymbolicLink()) fail("SYMLINK", "Symbolic links are not followed");
      if (!stats.isDirectory()) fail("NOT_DIRECTORY", "Path is not a directory");
      current = await fsp.realpath(next);
      const currentStats = await fsp.lstat(next, { bigint: true });
      if (currentStats.isSymbolicLink() || identity(currentStats) !== identity(stats)) fail("CONFLICT", "Directory changed while it was being resolved");
      if (!inside(resource.root, current)) fail("OUTSIDE_ROOT", "Path escapes the selected directory");
    }
    return current;
  }

  async function verifyFileParent(resource) {
    const parent = path.dirname(resource.filePath);
    let stats;
    try {
      stats = await fsp.lstat(parent, { bigint: true });
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) fail("CONFLICT", "File location changed");
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory() || identity(stats) !== resource.parentIdentity ||
        await fsp.realpath(parent) !== parent) {
      fail("CONFLICT", "File location changed");
    }
    return stats;
  }

  async function fileSnapshot(resource) {
    await verifyFileParent(resource);
    let pathStats;
    try {
      pathStats = await fsp.lstat(resource.filePath, { bigint: true });
    } catch (error) {
      if (error.code === "ENOENT") fail("CONFLICT", "File was deleted");
      throw error;
    }
    if (pathStats.isSymbolicLink()) fail("SYMLINK", "Symbolic links are not followed");
    if (!pathStats.isFile()) fail("NOT_FILE", "Path is not a regular file");
    if (identity(pathStats) !== resource.identity) fail("CONFLICT", "File was replaced");
    if (pathStats.size > BigInt(MAX_TEXT_BYTES)) fail("TOO_LARGE", "File exceeds the text size limit");

    let handle;
    try {
      try {
        handle = await fsp.open(resource.filePath, fs.constants.O_RDONLY | NOFOLLOW);
      } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes(error.code)) fail("CONFLICT", "File was deleted");
        if (error.code === "ELOOP") fail("SYMLINK", "Symbolic links are not followed");
        throw error;
      }
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || identity(before) !== resource.identity) fail("CONFLICT", "File was replaced");
      if (before.size > BigInt(MAX_TEXT_BYTES)) fail("TOO_LARGE", "File exceeds the text size limit");
      const raw = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < raw.length) {
        const { bytesRead } = await handle.read(raw, length, raw.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      let currentPath;
      try {
        currentPath = await fsp.lstat(resource.filePath, { bigint: true });
      } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes(error.code)) fail("CONFLICT", "File was deleted while it was being read");
        throw error;
      }
      await verifyFileParent(resource);
      if (!sameVersion(before, after) || length !== Number(before.size) || identity(currentPath) !== resource.identity || currentPath.isSymbolicLink()) {
        fail("CONFLICT", "File changed while it was being read");
      }
      const contents = raw.subarray(0, length);
      const text = decodeText(contents);
      return { text, revision: makeRevision(contents, after), stats: after, raw: contents };
    } finally {
      await handle?.close();
    }
  }

  async function readOnly(resource, stats) {
    if (typeof process.geteuid !== "function" || stats.uid !== BigInt(process.geteuid()) || stats.nlink !== 1n || (stats.mode & 0o222n) === 0n) return true;
    try {
      await fsp.access(path.dirname(resource.filePath), fs.constants.W_OK);
      return false;
    } catch {
      return true;
    }
  }

  async function createFileGrant(filePath, expectedStats) {
    const parent = path.dirname(filePath);
    const parentStats = await fsp.lstat(parent, { bigint: true });
    if (parentStats.isSymbolicLink() || !parentStats.isDirectory() || await fsp.realpath(parent) !== parent) {
      fail("CONFLICT", "File location changed");
    }
    const current = await fsp.lstat(filePath, { bigint: true });
    if (current.isSymbolicLink() || !current.isFile() || identity(current) !== identity(expectedStats)) {
      fail("CONFLICT", "File changed while it was being opened");
    }
    return add({
      kind: "file",
      label: path.basename(filePath) || filePath,
      filePath,
      identity: identity(current),
      parentIdentity: identity(parentStats),
    });
  }

  async function open(absolutePath) {
    if (NOFOLLOW === undefined) fail("UNSUPPORTED_PLATFORM", "Safe local file access is unavailable on this platform");
    const target = validateAbsolute(absolutePath);
    let suppliedStats;
    try {
      suppliedStats = await fsp.lstat(target, { bigint: true });
    } catch (error) {
      if (error.code === "ENOENT") fail("NOT_FOUND", "Path does not exist");
      throw error;
    }
    if (suppliedStats.isSymbolicLink()) fail("SYMLINK", "Symbolic links are not followed");
    const resolved = await fsp.realpath(target);
    const stats = await fsp.lstat(resolved, { bigint: true });
    const suppliedAfter = await fsp.lstat(target, { bigint: true });
    if (suppliedAfter.isSymbolicLink()) fail("SYMLINK", "Symbolic links are not followed");
    if (identity(suppliedAfter) !== identity(suppliedStats) || identity(stats) !== identity(suppliedAfter)) {
      fail("CONFLICT", "Path changed while it was being opened");
    }
    if (stats.isSymbolicLink()) fail("SYMLINK", "Symbolic links are not followed");
    if (stats.isDirectory()) {
      return add({ kind: "directory", root: resolved, identity: identity(stats), label: path.basename(resolved) || resolved });
    }
    if (!stats.isFile()) fail("NOT_FILE", "Only regular files and directories can be opened");
    return createFileGrant(resolved, stats);
  }

  async function list(id, relativePath = "") {
    const resource = get(id, "directory");
    const directoryPath = await resolveDirectory(resource, relativePath);
    const directoryStats = await fsp.lstat(directoryPath, { bigint: true });
    let directory;
    try {
      directory = await fsp.opendir(directoryPath, { encoding: "buffer" });
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) fail("CONFLICT", "Directory changed while it was being listed");
      throw error;
    }
    const entries = [];
    try {
      for await (const dirent of directory) {
        let name;
        try {
          name = Buffer.isBuffer(dirent.name) ? decoder.decode(dirent.name) : dirent.name;
        } catch {
          fail("UNSUPPORTED_NAME", "Directory contains a filename that is not valid UTF-8");
        }
        if (Buffer.from(name, "utf8").toString("utf8") !== name) fail("UNSUPPORTED_NAME", "Directory contains a filename that is not valid UTF-8");
        const kind = dirent.isSymbolicLink() ? "symlink" : dirent.isDirectory() ? "directory" : dirent.isFile() ? "file" : "other";
        entries.push({ name, kind });
        if (entries.length > MAX_DIRECTORY_ENTRIES) fail("TOO_MANY_ENTRIES", "Directory exceeds the entry limit");
      }
    } finally {
      await directory.close().catch(() => {});
    }
    const after = await fsp.lstat(directoryPath, { bigint: true });
    await verifyDirectoryRoot(resource);
    if (identity(after) !== identity(directoryStats) || after.isSymbolicLink()) fail("CONFLICT", "Directory changed while it was being listed");
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    return { entries };
  }

  async function openChild(id, relativePath) {
    const resource = get(id, "directory");
    const parts = relativeParts(relativePath);
    if (!parts.length) fail("INVALID_PATH", "A child path is required");
    const name = parts.pop();
    const parentRelative = parts.join(path.sep);
    const parent = await resolveDirectory(resource, parentRelative);
    const childPath = path.join(parent, name);
    let stats;
    try {
      stats = await fsp.lstat(childPath, { bigint: true });
    } catch (error) {
      if (error.code === "ENOENT") fail("NOT_FOUND", "Child does not exist");
      throw error;
    }
    if (stats.isSymbolicLink()) fail("SYMLINK", "Symbolic links are not followed");
    const resolved = await fsp.realpath(childPath);
    if (!inside(resource.root, resolved)) fail("OUTSIDE_ROOT", "Path escapes the selected directory");
    if (stats.isDirectory()) {
      const current = await fsp.lstat(resolved, { bigint: true });
      if (!current.isDirectory() || identity(current) !== identity(stats)) fail("CONFLICT", "Directory changed while it was being opened");
      return add({ kind: "directory", root: resolved, identity: identity(current), label: path.basename(resolved) });
    }
    if (!stats.isFile()) fail("NOT_FILE", "Only regular files and directories can be opened");
    return createFileGrant(resolved, stats);
  }

  async function read(id) {
    const resource = get(id, "file");
    const snapshot = await fileSnapshot(resource);
    const mixed = mixedLineEndings(snapshot.text);
    return { text: snapshot.text, revision: snapshot.revision, readOnly: mixed || await readOnly(resource, snapshot.stats), ...(mixed ? { readOnlyReason: "Mixed line endings cannot be saved safely" } : {}) };
  }

  async function saveNow(resource, expectedRevision, text) {
    if (resources.get(resource.id) !== resource) fail("UNAVAILABLE", "Resource is unavailable");
    const raw = encodeText(text);
    const current = await fileSnapshot(resource);
    if (current.revision !== expectedRevision) fail("CONFLICT", "File changed since it was read");
    if (mixedLineEndings(current.text) || await readOnly(resource, current.stats)) fail("READ_ONLY", "File cannot be safely saved");

    const temporaryPath = path.join(path.dirname(resource.filePath), `.rnz-${randomBytes(16).toString("hex")}.tmp`);
    let handle;
    let renamed = false;
    try {
      await verifyFileParent(resource);
      handle = await fsp.open(temporaryPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
      await handle.writeFile(raw);
      await handle.chown(Number(current.stats.uid), Number(current.stats.gid));
      await handle.chmod(Number(current.stats.mode & 0o7777n));
      await handle.sync();
      const latest = await fileSnapshot(resource);
      if (latest.revision !== expectedRevision) fail("CONFLICT", "File changed while it was being saved");
      if (resources.get(resource.id) !== resource) fail("UNAVAILABLE", "Resource is unavailable");
      await verifyFileParent(resource);
      // Path-based rename is atomic, but Node exposes no compare-and-swap against an external writer.
      await fsp.rename(temporaryPath, resource.filePath);
      renamed = true;
      const written = await handle.stat({ bigint: true });
      resource.identity = identity(written);
      const saved = await fileSnapshot(resource);
      return { revision: saved.revision };
    } finally {
      await handle?.close();
      if (!renamed) await fsp.unlink(temporaryPath).catch(() => {});
    }
  }

  async function save(id, expectedRevision, text) {
    const resource = get(id, "file");
    if (typeof expectedRevision !== "string" || expectedRevision.length !== 64) fail("INVALID_REVISION", "Revision is invalid");
    const previous = resource.saveQueue ?? Promise.resolve();
    let unlock;
    resource.saveQueue = new Promise(resolve => { unlock = resolve; });
    await previous;
    try {
      return await saveNow(resource, expectedRevision, text);
    } finally {
      unlock();
    }
  }

  async function close(id) {
    if (typeof id === "string") resources.delete(id);
  }

  async function closeAll() {
    resources.clear();
  }

  return { open, list, openChild, read, save, close, closeAll };
}
