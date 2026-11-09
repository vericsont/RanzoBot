import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const SESSION_ID = /^[0-9a-f-]{36}$/i;
export const TERMINAL_LIMITS = Object.freeze({
  sessions: 16,
  cols: [2, 500],
  rows: [1, 200],
  inputBytes: 16 * 1024,
  pendingOutputBytes: 512 * 1024,
  deferredOutputBytes: 128 * 1024,
  inFlightOutputBytes: 256 * 1024,
  outputHighWaterBytes: 384 * 1024,
  outputLowWaterBytes: 128 * 1024,
  outputChunkBytes: 64 * 1024,
});
const ATTACH_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 500;

export function loadTerminalPty({ packaged = false, resourcesPath = process.resourcesPath } = {}) {
  const entry = packaged
    ? path.join(resourcesPath, "terminal-runtime", "node_modules", "@lydell", "node-pty")
    : "@lydell/node-pty";
  return require(entry);
}

export function terminalShell(platform = process.platform, env = process.env) {
  if (platform === "win32") return { file: env.ComSpec || env.COMSPEC || "cmd.exe", args: [] };
  const file = typeof env.SHELL === "string" && path.isAbsolute(env.SHELL) ? env.SHELL : "/bin/sh";
  return { file, args: ["-l"] };
}

function origin(value) {
  try {
    const parsed = new URL(value);
    return parsed.origin === "null" ? null : parsed.origin;
  } catch {
    return null;
  }
}

export function terminalPageAllowed(event, { owner, localOrigin, localWorkspace }) {
  const contents = owner?.webContents;
  if (
    localWorkspace !== true || !contents || contents.isDestroyed?.() || owner.isDestroyed?.() ||
    event?.sender !== contents || !event.senderFrame || event.senderFrame !== contents.mainFrame
  ) return false;
  try {
    const allowedOrigin = origin(localOrigin);
    return Boolean(allowedOrigin) && origin(event.senderFrame.url) === allowedOrigin && origin(contents.getURL()) === allowedOrigin;
  } catch {
    return false;
  }
}

export function terminalSenderAllowed(event, options) {
  return terminalPageAllowed(event, options) && typeof options.token === "string" &&
    options.token.length > 0 && options.token === options.expectedToken;
}

export function releaseTerminalOwnerOnWindowClose(window, documentTokens, getSessions) {
  const owner = window.webContents;
  window.once("closed", () => {
    documentTokens.delete(owner);
    getSessions()?.closeOwner(owner);
  });
}

function dimensions(input) {
  if (!input || Object.prototype.toString.call(input) !== "[object Object]" || Object.keys(input).some(key => key !== "cols" && key !== "rows")) {
    throw new Error("Terminal dimensions are invalid");
  }
  const { cols, rows } = input;
  if (!Number.isInteger(cols) || cols < TERMINAL_LIMITS.cols[0] || cols > TERMINAL_LIMITS.cols[1] ||
      !Number.isInteger(rows) || rows < TERMINAL_LIMITS.rows[0] || rows > TERMINAL_LIMITS.rows[1]) {
    throw new Error("Terminal dimensions are invalid");
  }
  return { cols, rows };
}

function childEnvironment(platform, env) {
  const allowed = platform === "win32"
    ? ["PATH", "PATHEXT", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "USERNAME", "COMSPEC"]
    : ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"];
  return Object.fromEntries(allowed.filter(key => typeof env[key] === "string").map(key => [key, env[key]]).concat([["TERM", "xterm-256color"]]));
}

function takeBytes(value, limit) {
  if (Buffer.byteLength(value) <= limit) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > limit) break;
    result += character;
    bytes += size;
  }
  return result;
}

function dispose(subscription) {
  try { subscription?.dispose?.(); } catch {}
}

export function createTerminalSessions({
  loadPty = () => loadTerminalPty(),
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  onData = () => {},
  onExit = () => {},
  sessionEnvironment = () => ({}),
  onRemove = () => {},
  makeId = randomUUID,
} = {}) {
  const sessions = new Map();

  const remove = entry => {
    if (sessions.get(entry.id) !== entry) return false;
    sessions.delete(entry.id);
    try { onRemove(entry.owner, entry.id); } catch {}
    clearTimeout(entry.attachTimer);
    clearTimeout(entry.killTimer);
    dispose(entry.dataSubscription);
    dispose(entry.exitSubscription);
    entry.pending.length = 0;
    entry.pendingBytes = 0;
    entry.deferred.length = 0;
    entry.deferredBytes = 0;
    entry.outstanding.clear();
    entry.inFlightBytes = 0;
    return true;
  };

  const get = id => typeof id === "string" && SESSION_ID.test(id) ? sessions.get(id) : undefined;

  const bufferedBytes = entry => entry.inFlightBytes + entry.pendingBytes + entry.deferredBytes;

  const finishIfDrained = entry => {
    if (sessions.get(entry.id) !== entry || !entry.attached || entry.exitCode === null || entry.pending.length || entry.deferred.length || entry.outstanding.size) return;
    try { onExit(entry.owner, entry.id, entry.exitCode); } catch {}
    remove(entry);
  };

  const stopForOverflow = entry => {
    if (entry.overflowed) return;
    entry.overflowed = true;
    entry.exitCode = 1;
    entry.paused = true;
    entry.killTimer = setTimeout(() => emitExit(entry, 1), CLOSE_TIMEOUT_MS);
    entry.killTimer.unref?.();
    try { entry.pty.pause(); } catch {}
    try { entry.pty.kill(); } catch { flush(entry); }
  };

  const updateFlow = entry => {
    if (sessions.get(entry.id) !== entry) return;
    const buffered = bufferedBytes(entry);
    if (!entry.paused && buffered >= TERMINAL_LIMITS.outputHighWaterBytes) {
      entry.paused = true;
      try { entry.pty.pause(); } catch { stopForOverflow(entry); }
    } else if (!entry.deferred.length && entry.paused && buffered <= TERMINAL_LIMITS.outputLowWaterBytes) {
      entry.paused = false;
      try { entry.pty.resume(); } catch { stopForOverflow(entry); }
    }
  };

  const transmit = (entry, data) => {
    const bytes = Buffer.byteLength(data);
    if (sessions.get(entry.id) !== entry || !entry.attached || entry.inFlightBytes + bytes > TERMINAL_LIMITS.inFlightOutputBytes) return false;
    const sequence = entry.nextSequence++;
    entry.outstanding.set(sequence, bytes);
    entry.inFlightBytes += bytes;
    try {
      onData(entry.owner, entry.id, data, sequence);
      updateFlow(entry);
      return true;
    } catch {
      closeEntry(entry);
      return false;
    }
  };

  const flush = entry => {
    while (sessions.get(entry.id) === entry) {
      if (entry.pending.length) {
        const data = entry.pending[0];
        if (entry.inFlightBytes + Buffer.byteLength(data) > TERMINAL_LIMITS.inFlightOutputBytes) break;
        entry.pending.shift();
        entry.pendingBytes -= Buffer.byteLength(data);
        if (!transmit(entry, data)) {
          if (sessions.get(entry.id) === entry) queue(entry, data);
          break;
        }
        continue;
      }
      if (!entry.deferred.length || entry.pendingBytes >= TERMINAL_LIMITS.pendingOutputBytes) break;
      const source = entry.deferred[0];
      const chunk = takeBytes(source, Math.min(
        TERMINAL_LIMITS.outputChunkBytes,
        TERMINAL_LIMITS.pendingOutputBytes - entry.pendingBytes,
      ));
      if (!chunk) break;
      const remainder = source.slice(chunk.length);
      if (remainder) entry.deferred[0] = remainder;
      else entry.deferred.shift();
      entry.deferredBytes -= Buffer.byteLength(chunk);
      queue(entry, chunk);
    }
    updateFlow(entry);
    finishIfDrained(entry);
  };

  const emitExit = (entry, code) => {
    if (sessions.get(entry.id) !== entry) return;
    entry.exitCode = Number.isInteger(code) ? code : -1;
    if (entry.overflowed) entry.exitCode = 1;
    if (!entry.attached) return;
    flush(entry);
  };

  const queue = (entry, data) => {
    if (sessions.get(entry.id) !== entry) return false;
    const bytes = Buffer.byteLength(data);
    if (entry.pendingBytes + bytes > TERMINAL_LIMITS.pendingOutputBytes) return false;
    entry.pending.push(data);
    entry.pendingBytes += bytes;
    updateFlow(entry);
    return true;
  };

  const defer = (entry, data) => {
    if (!data) return true;
    const bytes = Buffer.byteLength(data);
    if (entry.deferredBytes + bytes > TERMINAL_LIMITS.deferredOutputBytes) {
      stopForOverflow(entry);
      return false;
    }
    entry.deferred.push(data);
    entry.deferredBytes += bytes;
    entry.paused = true;
    try { entry.pty.pause(); } catch { stopForOverflow(entry); }
    return true;
  };

  const receive = (entry, data) => {
    if (sessions.get(entry.id) !== entry || typeof data !== "string") return;
    if (entry.deferred.length) {
      defer(entry, data);
      return;
    }
    let remaining = data;
    while (remaining && sessions.get(entry.id) === entry) {
      const chunk = takeBytes(remaining, TERMINAL_LIMITS.outputChunkBytes);
      remaining = remaining.slice(chunk.length);
      if (entry.pending.length || !entry.attached || !transmit(entry, chunk)) {
        if (sessions.get(entry.id) !== entry) return;
        if (!queue(entry, chunk)) {
          defer(entry, chunk);
          defer(entry, remaining);
          stopForOverflow(entry);
          return;
        }
      }
    }
  };

  const closeEntry = (entry, immediate = false) => {
    if (!remove(entry)) return false;
    try { entry.pty.write("\x04"); } catch {}
    if (immediate) {
      try { entry.pty.kill(); } catch {}
    } else {
      entry.killTimer = setTimeout(() => {
        try { entry.pty.kill(); } catch {}
      }, CLOSE_TIMEOUT_MS);
      entry.killTimer.unref?.();
    }
    return true;
  };

  return {
    start(owner, input) {
      if (!owner) throw new Error("The terminal owner is unavailable");
      if (sessions.size >= TERMINAL_LIMITS.sessions) throw new Error("Too many terminal sessions are open");
      const { cols, rows } = dimensions(input);
      const id = makeId();
      let pty;
      try {
        const shell = terminalShell(platform, env);
        pty = loadPty().spawn(shell.file, shell.args, {
          name: "xterm-256color",
          cols,
          rows,
          cwd: home,
          env: { ...childEnvironment(platform, env), ...sessionEnvironment(id, owner) },
        });
      } catch {
        try { onRemove(owner, id); } catch {}
        throw new Error("The interactive terminal could not be started");
      }
      if (!pty || typeof pty.write !== "function" || typeof pty.resize !== "function" ||
          typeof pty.kill !== "function" || typeof pty.pause !== "function" || typeof pty.resume !== "function" ||
          typeof pty.onData !== "function" || typeof pty.onExit !== "function") {
        try { pty?.kill?.(); } catch {}
        try { onRemove(owner, id); } catch {}
        throw new Error("The interactive terminal is unavailable");
      }
      const entry = {
        id, owner, pty, attached: false, pending: [], pendingBytes: 0,
        outstanding: new Map(), inFlightBytes: 0, nextSequence: 1,
        deferred: [], deferredBytes: 0, paused: false, overflowed: false,
        exitCode: null, attachTimer: null, killTimer: null,
      };
      sessions.set(id, entry);
      entry.dataSubscription = pty.onData(data => receive(entry, data));
      entry.exitSubscription = pty.onExit(({ exitCode } = {}) => emitExit(entry, exitCode));
      entry.attachTimer = setTimeout(() => closeEntry(entry), ATTACH_TIMEOUT_MS);
      entry.attachTimer.unref?.();
      return { id };
    },

    attach(owner, id) {
      const entry = get(id);
      if (!entry || entry.owner !== owner || entry.attached) throw new Error("The terminal session is unavailable");
      entry.attached = true;
      clearTimeout(entry.attachTimer);
      flush(entry);
      if (sessions.get(id) === entry && entry.exitCode !== null) emitExit(entry, entry.exitCode);
    },

    ack(owner, id, sequence) {
      const entry = get(id);
      if (!entry || entry.owner !== owner || !Number.isSafeInteger(sequence)) return;
      const bytes = entry.outstanding.get(sequence);
      if (bytes === undefined) return;
      entry.outstanding.delete(sequence);
      entry.inFlightBytes -= bytes;
      flush(entry);
    },

    write(owner, id, data) {
      const entry = get(id);
      if (!entry || entry.owner !== owner || !entry.attached || entry.exitCode !== null || entry.overflowed) throw new Error("The terminal session is unavailable");
      if (typeof data !== "string" || Buffer.byteLength(data) > TERMINAL_LIMITS.inputBytes) throw new Error("Terminal input is invalid");
      try { entry.pty.write(data); } catch { throw new Error("Terminal input could not be written"); }
    },

    resize(owner, id, cols, rows) {
      const entry = get(id);
      if (!entry || entry.owner !== owner || !entry.attached || entry.exitCode !== null || entry.overflowed) throw new Error("The terminal session is unavailable");
      const size = dimensions({ cols, rows });
      try { entry.pty.resize(size.cols, size.rows); } catch { throw new Error("The terminal could not be resized"); }
    },

    close(owner, id) {
      const entry = get(id);
      if (!entry) return;
      if (entry.owner !== owner) throw new Error("The terminal session is unavailable");
      closeEntry(entry);
    },

    closeOwner(owner) {
      for (const entry of sessions.values()) if (entry.owner === owner) closeEntry(entry);
    },

    closeAll() {
      for (const entry of sessions.values()) closeEntry(entry, true);
    },

    owns(owner, id) { return get(id)?.owner === owner; },
    size() { return sessions.size; },
  };
}

export function registerTerminalIpc({ ipcMain, sessions, authorize, terminalState, resources, prepareSession, setDirty }) {
  const handle = (channel, action) => ipcMain.handle(`host-terminal:${channel}`, (event, token, ...args) => {
    const owner = authorize(event, token);
    const manager = typeof sessions === "function" ? sessions() : sessions;
    return action(manager, owner, ...args);
  });
  handle("start", async (manager, owner, input) => {
    if (prepareSession) await prepareSession();
    return manager.start(owner, input);
  });
  handle("attach", (manager, owner, id) => manager.attach(owner, id));
  handle("write", (manager, owner, id, data) => manager.write(owner, id, data));
  handle("resize", (manager, owner, id, cols, rows) => manager.resize(owner, id, cols, rows));
  handle("close", (manager, owner, id) => manager.close(owner, id));
  if (terminalState) {
    handle("restore-state", (_manager, _owner) => (typeof terminalState === "function" ? terminalState() : terminalState).load());
    handle("save-state", (_manager, _owner, value) => (typeof terminalState === "function" ? terminalState() : terminalState).save(value));
  }
  if (resources) {
    const getResources = () => typeof resources === "function" ? resources() : resources;
    handle("open-ack", (_manager, owner, requestId, accepted) => getResources().acknowledge(owner, requestId, accepted));
    handle("resource-list", (_manager, owner, id, relativePath) => getResources().list(owner, id, relativePath));
    handle("resource-child", (_manager, owner, id, relativePath) => getResources().openChild(owner, id, relativePath));
    handle("resource-read", (_manager, owner, id) => getResources().read(owner, id));
    handle("resource-save", (_manager, owner, id, revision, text) => getResources().save(owner, id, revision, text));
    handle("resource-history", (_manager, owner, id, cursor) => getResources().history(owner, id, cursor));
    handle("resource-commit", (_manager, owner, id, hash, parent) => getResources().commit(owner, id, hash, parent));
    handle("resource-diff", (_manager, owner, id, hash, parent, file) => getResources().diff(owner, id, hash, parent, file));
    handle("resource-close", (_manager, owner, id) => getResources().close(owner, id));
  }
  if (setDirty) ipcMain.on("host-terminal:dirty", (event, token, dirty) => {
    try {
      const owner = authorize(event, token);
      if (typeof dirty === "boolean") setDirty(owner, dirty);
    } catch {}
  });
  ipcMain.on("host-terminal:ack", (event, token, id, sequence) => {
    try {
      const owner = authorize(event, token);
      const manager = typeof sessions === "function" ? sessions() : sessions;
      manager.ack(owner, id, sequence);
    } catch {}
  });
}
