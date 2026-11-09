import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const HISTORY_PAGE_SIZE = 100;
const HISTORY_MAX_OFFSET = 1_000_000;
const HISTORY_OUTPUT_LIMIT = 2 * 1024 * 1024;
const REF_OUTPUT_LIMIT = 4 * 1024 * 1024;
const COMMIT_OUTPUT_LIMIT = 4 * 1024 * 1024;
const DIFF_OUTPUT_LIMIT = 2 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 10_000;
const STDERR_LIMIT = 8 * 1024;
const HASH_FORMAT = { sha1: 40, sha256: 64 };
const LOG_FORMAT = "tformat:%H%x00%P%x00%an%x00%aI%x00%s";
const GIT_OPTIONS = [
  "--no-pager", "--no-optional-locks", "--literal-pathspecs",
  "-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-C",
];

function error(message) {
  return new Error(message);
}

function takeBytes(chunks, value, limit, current) {
  const remaining = limit - current;
  if (remaining <= 0) return current;
  const chunk = value.subarray(0, remaining);
  chunks.push(chunk);
  return current + chunk.length;
}

function gitEnvironment() {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))),
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    PAGER: "cat",
  };
}

function gitError(result) {
  const detail = result.stderr.toString("utf8").trim().slice(0, STDERR_LIMIT);
  const failure = error(detail || "Git command failed");
  failure.exitCode = result.code;
  return failure;
}

function runGit(cwd, args, {
  entry,
  outputLimit = HISTORY_OUTPUT_LIMIT,
  timeoutMs = COMMAND_TIMEOUT_MS,
  allowFailure = false,
  allowTruncation = false,
} = {}, activeProcesses) {
  if (entry && activeProcesses.resources.get(entry.id) !== entry) return Promise.reject(error("Git resource is closed"));
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...GIT_OPTIONS, cwd, ...args], {
      cwd,
      env: gitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    activeProcesses.all.add(child);
    entry?.children.add(child);
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let spawnError = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", chunk => {
      const before = stdoutBytes;
      stdoutBytes = takeBytes(stdout, chunk, outputLimit, stdoutBytes);
      if (before + chunk.length > outputLimit) {
        truncated = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", chunk => {
      stderrBytes = takeBytes(stderr, chunk, STDERR_LIMIT, stderrBytes);
    });
    child.on("error", cause => { spawnError = cause; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      activeProcesses.all.delete(child);
      entry?.children.delete(child);
      const result = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        code,
        signal,
        truncated,
      };
      if (entry && activeProcesses.resources.get(entry.id) !== entry) return reject(error("Git resource is closed"));
      if (timedOut) return reject(error("Git command timed out"));
      if (spawnError) return reject(error(`Git is unavailable: ${spawnError.message}`));
      if (truncated && !allowTruncation) return reject(error("Git output exceeds the limit"));
      if (code !== 0 && !allowFailure && !truncated) return reject(gitError(result));
      resolve(result);
    });
  });
}

function decodeLine(output) {
  return Buffer.from(output).toString("utf8").replace(/\n$/, "");
}

function parseLog(output) {
  const fields = output.toString("utf8").split("\0");
  const commits = [];
  for (let index = 0; index + 4 < fields.length; index += 5) {
    const [hash, parents, author, date, subject] = fields.slice(index, index + 5);
    if (!hash) continue;
    commits.push({ hash, parents: parents ? parents.split(" ") : [], author, date, subject });
  }
  return commits;
}

function parseRefs(output) {
  const refs = new Map();
  for (const line of output.toString("utf8").split("\n")) {
    if (!line) continue;
    const [name, object, peeled] = line.split("\0");
    const hash = peeled || object;
    if (!hash) continue;
    const label = name.startsWith("refs/heads/") ? name.slice(11)
      : name.startsWith("refs/remotes/") ? name.slice(13)
        : name.startsWith("refs/tags/") ? `tag: ${name.slice(10)}`
          : name.startsWith("refs/") ? name.slice(5) : name;
    const labels = refs.get(hash) ?? [];
    labels.push(label);
    refs.set(hash, labels);
  }
  return refs;
}

function validateCursor(cursor) {
  if (cursor === undefined || cursor === null) return { offset: 0, signature: null };
  if (typeof cursor !== "string" || cursor.length > 100 || !/^v1:[0-9]+:[a-f0-9]{64}$/.test(cursor)) {
    throw error("History cursor is invalid");
  }
  const [, rawOffset, signature] = cursor.split(":");
  const offset = Number(rawOffset);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > HISTORY_MAX_OFFSET) throw error("History cursor is invalid");
  return { offset, signature };
}

function validatePath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0 || filePath.includes("\0") || filePath.startsWith("/")) {
    throw error("Git file path is invalid");
  }
  const components = filePath.split("/");
  if (components.some(component => !component || component === "." || component === "..")) {
    throw error("Git file path is invalid");
  }
}

function parseFiles(output) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    throw error("Git paths must be valid UTF-8");
  }
  const fields = text.split("\0");
  const files = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = fields[index++];
      const filePath = fields[index++];
      if (oldPath === undefined || filePath === undefined) throw error("Git returned an invalid file list");
      files.push({ path: filePath, status, oldPath });
    } else {
      const filePath = fields[index++];
      if (filePath === undefined) throw error("Git returned an invalid file list");
      files.push({ path: filePath, status });
    }
  }
  return files;
}

export function createTerminalGit() {
  const resources = new Map();
  const activeProcesses = { all: new Set(), resources };
  let epoch = 0;

  const get = id => {
    const entry = typeof id === "string" ? resources.get(id) : null;
    if (!entry) throw error("Git resource is closed or unknown");
    return entry;
  };

  const run = (entry, args, options) => runGit(entry.cwd, args, { ...options, entry }, activeProcesses);

  const objectHash = (entry, hash) => {
    if (typeof hash !== "string" || hash.length !== HASH_FORMAT[entry.objectFormat] || !/^[0-9a-f]+$/.test(hash)) {
      throw error("Git commit hash is invalid");
    }
    return hash;
  };

  const snapshot = async entry => {
    const refsResult = await run(entry, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(*objectname)"], { outputLimit: REF_OUTPUT_LIMIT });
    const headResult = await run(entry, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowFailure: true });
    let head = null;
    if (headResult.code === 0) {
      head = decodeLine(headResult.stdout);
      objectHash(entry, head);
    } else if (headResult.code !== 1 && headResult.code !== 128) {
      throw gitError(headResult);
    }
    const signature = createHash("sha256").update(refsResult.stdout).update("\0").update(head ?? "").digest("hex");
    return { signature, head, refs: parseRefs(refsResult.stdout) };
  };

  const commitInfo = async (entry, requestedHash, requestedParent) => {
    const hash = objectHash(entry, requestedHash);
    const typeResult = await run(entry, ["cat-file", "-t", hash]);
    if (decodeLine(typeResult.stdout) !== "commit") throw error("Git object is not a commit");
    const metadataResult = await run(entry, ["show", "-s", `--format=${LOG_FORMAT}`, "-z", hash], { outputLimit: 128 * 1024 });
    const fields = metadataResult.stdout.toString("utf8").split("\0");
    if (fields.length < 5 || fields[0] !== hash) throw error("Git returned invalid commit metadata");
    const [, rawParents, author, date, subject] = fields;
    const parents = rawParents ? rawParents.split(" ") : [];
    const parentId = requestedParent === undefined ? parents[0] ?? null : objectHash(entry, requestedParent);
    if (parentId !== null && !parents.includes(parentId)) throw error("Selected parent is not a parent of this commit");

    const raw = (await run(entry, ["cat-file", "commit", hash], { outputLimit: COMMIT_OUTPUT_LIMIT })).stdout;
    const headerEnd = raw.indexOf(Buffer.from("\n\n"));
    if (headerEnd < 0) throw error("Git returned an invalid commit object");
    const message = raw.subarray(headerEnd + 2).toString("utf8");
    const firstLineEnd = message.indexOf("\n");
    const body = firstLineEnd < 0 ? "" : message.slice(firstLineEnd + 1).replace(/^\n/, "");
    const filesArgs = ["diff-tree", "--no-commit-id", "--name-status", "-r", "-z", "-M", "--no-ext-diff", "--no-textconv"];
    if (parentId === null) filesArgs.push("--root", hash);
    else filesArgs.push(parentId, hash);
    filesArgs.push("--");
    const files = parseFiles((await run(entry, filesArgs, { outputLimit: COMMIT_OUTPUT_LIMIT })).stdout);
    return { hash, parents, author, date, subject, body, files };
  };

  return {
    async open(requestedPath) {
      if (typeof requestedPath !== "string" || !requestedPath) throw error("Git path is invalid");
      const openingEpoch = epoch;
      let cwd;
      try {
        cwd = await fs.realpath(requestedPath);
        if (!(await fs.stat(cwd)).isDirectory()) throw error("Git path must be a directory");
      } catch (cause) {
        if (cause instanceof Error && cause.message === "Git path must be a directory") throw cause;
        throw error("Git path is unavailable");
      }
      if (openingEpoch !== epoch) throw error("Git resource was closed while opening");
      const rootResult = await runGit(cwd, ["rev-parse", "--show-toplevel"], { outputLimit: 64 * 1024 }, activeProcesses);
      const root = decodeLine(rootResult.stdout);
      if (!root) throw error("Path is not inside a Git repository");
      const repoRoot = path.resolve(root);
      const formatResult = await runGit(repoRoot, ["rev-parse", "--show-object-format"], { outputLimit: 64 * 1024 }, activeProcesses);
      const objectFormat = decodeLine(formatResult.stdout);
      if (!HASH_FORMAT[objectFormat]) throw error("Git object format is unsupported");
      if (openingEpoch !== epoch) throw error("Git resource was closed while opening");
      const id = randomUUID();
      resources.set(id, {
        id,
        cwd: repoRoot,
        objectFormat,
        label: path.basename(repoRoot) || repoRoot,
        children: new Set(),
      });
      return { id, kind: "git", label: resources.get(id).label };
    },

    async history(id, cursor) {
      const entry = get(id);
      const { offset, signature: expectedSignature } = validateCursor(cursor);
      const before = await snapshot(entry);
      if (expectedSignature && expectedSignature !== before.signature) throw error("Repository references changed; refresh history");
      const args = ["log", "--topo-order", "--date-order", "--max-count", String(HISTORY_PAGE_SIZE + 1), "--skip", String(offset), `--format=${LOG_FORMAT}`, "-z", "--all"];
      if (before.head) args.push(before.head);
      const result = await run(entry, args, { outputLimit: HISTORY_OUTPUT_LIMIT });
      const after = await snapshot(entry);
      if (before.signature !== after.signature) throw error("Repository references changed; refresh history");
      const allCommits = parseLog(result.stdout);
      const commits = allCommits.slice(0, HISTORY_PAGE_SIZE).map(commit => ({
        ...commit,
        refs: before.refs.get(commit.hash) ?? [],
      }));
      const hasNextPage = allCommits.length > HISTORY_PAGE_SIZE;
      return {
        commits,
        nextCursor: hasNextPage ? `v1:${offset + HISTORY_PAGE_SIZE}:${before.signature}` : null,
      };
    },

    async commit(id, hash, parentId) {
      return commitInfo(get(id), hash, parentId);
    },

    async diff(id, hash, parentId, filePath) {
      const entry = get(id);
      validatePath(filePath);
      const commit = await commitInfo(entry, hash, parentId);
      const file = commit.files.find(item => item.path === filePath);
      if (!file) throw error("File is not part of this commit");
      const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
      const args = ["diff-tree", "-p", "-r", "-M", "--no-ext-diff", "--no-textconv", "--no-color"];
      if (commit.parents.length === 0) args.push("--root", commit.hash);
      else args.push(parentId ?? commit.parents[0], commit.hash);
      args.push("--", ...paths);
      const result = await run(entry, args, { outputLimit: DIFF_OUTPUT_LIMIT, allowTruncation: true });
      return { text: result.stdout.toString("utf8"), truncated: result.truncated };
    },

    close(id) {
      const entry = resources.get(id);
      if (!entry) return;
      resources.delete(id);
      for (const child of entry.children) child.kill("SIGKILL");
    },

    closeAll() {
      epoch++;
      resources.clear();
      for (const child of activeProcesses.all) child.kill("SIGKILL");
    },
  };
}
