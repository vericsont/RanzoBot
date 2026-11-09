import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_PATH_BYTES = 4096;
const MAX_CLIENTS = 32;
const MAX_ACTIVE_REQUESTS = 16;
const MAX_SESSION_REQUESTS = 4;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

function response(socket, value) {
  if (socket.destroyed || socket.writableEnded || socket.rnzResponseSent) return;
  socket.rnzResponseSent = true;
  try { socket.end(`${JSON.stringify(value)}\n`); } catch { socket.destroy(); }
}

function errorMessage(error) {
  const message = error instanceof Error ? error.message : "The pane could not be opened";
  return [...message].map(character => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("").slice(0, 500) || "The pane could not be opened";
}

function hasControl(value) {
  return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function validRequest(value) {
  return value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === 4 &&
    Object.hasOwn(value, "version") && value.version === 1 &&
    Object.hasOwn(value, "token") && typeof value.token === "string" && TOKEN_PATTERN.test(value.token) &&
    Object.hasOwn(value, "action") && (value.action === "view" || value.action === "git") &&
    Object.hasOwn(value, "absolutePath") && typeof value.absolutePath === "string" &&
    path.isAbsolute(value.absolutePath) && !value.absolutePath.includes("\0") &&
    Buffer.byteLength(value.absolutePath) <= MAX_PATH_BYTES;
}

async function makeSocketDirectory() {
  for (const parent of [os.tmpdir(), "/tmp"]) {
    if (!parent) continue;
    const directory = await mkdtemp(path.join(parent, "rnz-"));
    const socketPath = path.join(directory, "s");
    if (Buffer.byteLength(socketPath) <= 90) {
      try {
        await chmod(directory, 0o700);
        return { directory, socketPath };
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
  throw new Error("A short private socket path is unavailable");
}

export function createRnzTransport({ onRequest }) {
  if (typeof onRequest !== "function") throw new TypeError("onRequest must be a function");

  const sessions = new Map();
  const tokens = new Map();
  const clients = new Set();
  let server;
  let directory;
  let socketPath;
  let activeRequests = 0;
  let started = false;
  let closed = false;

  const sendError = (socket, message) => response(socket, { ok: false, message });

  const handleRequest = (socket, request) => {
    if (!validRequest(request)) return sendError(socket, "Invalid rnz request");
    const session = tokens.get(request.token);
    if (!session || sessions.get(session.sessionId) !== session) return sendError(socket, "The terminal session is unavailable");
    if (activeRequests >= MAX_ACTIVE_REQUESTS || session.activeRequests >= MAX_SESSION_REQUESTS) {
      return sendError(socket, "Too many rnz requests are pending");
    }

    activeRequests++;
    session.activeRequests++;
    session.clients.add(socket);
    socket.rnzSession = session;
    const deadline = setTimeout(() => sendError(socket, "The pane request timed out"), REQUEST_TIMEOUT_MS);
    deadline.unref?.();
    Promise.resolve().then(() => onRequest({
      sessionId: session.sessionId,
      owner: session.owner,
      action: request.action,
      absolutePath: request.absolutePath,
    })).then(
      () => {
        if (sessions.get(session.sessionId) === session) response(socket, { ok: true });
        else sendError(socket, "The terminal session is unavailable");
      },
      error => sendError(socket, errorMessage(error)),
    ).finally(() => {
      clearTimeout(deadline);
      activeRequests--;
      session.activeRequests--;
    });
  };

  const accept = socket => {
    if (closed || clients.size >= MAX_CLIENTS) return socket.destroy();
    clients.add(socket);
    socket.setNoDelay(true);
    socket.on("error", () => {});
    let frameTimer;
    socket.once("close", () => {
      clients.delete(socket);
      clearTimeout(frameTimer);
      socket.rnzSession?.clients.delete(socket);
    });

    let input = Buffer.alloc(0);
    let received = false;
    frameTimer = setTimeout(() => sendError(socket, "The rnz request timed out"), REQUEST_TIMEOUT_MS);
    frameTimer.unref?.();
    socket.on("data", chunk => {
      if (received) return socket.destroy();
      input = Buffer.concat([input, chunk]);
      if (input.length > MAX_REQUEST_BYTES) {
        clearTimeout(frameTimer);
        return sendError(socket, "The rnz request is too large");
      }
      const newline = input.indexOf(10);
      if (newline === -1) return;
      received = true;
      clearTimeout(frameTimer);
      if (newline !== input.length - 1) return sendError(socket, "Invalid rnz request");
      let request;
      try { request = JSON.parse(input.subarray(0, newline).toString("utf8")); }
      catch { return sendError(socket, "Invalid rnz request"); }
      socket.removeAllListeners("data");
      socket.on("data", () => socket.destroy());
      handleRequest(socket, request);
    });
  };

  return {
    async start() {
      if (closed || started) throw new Error("The rnz transport cannot be started");
      if (process.platform === "win32") throw new Error("The rnz transport requires a POSIX system");
      started = true;
      try {
        ({ directory, socketPath } = await makeSocketDirectory());
        server = net.createServer(accept);
        await new Promise((resolve, reject) => {
          const onError = error => {
            server.off("listening", onListening);
            reject(error);
          };
          const onListening = () => {
            server.off("error", onError);
            resolve();
          };
          server.once("error", onError);
          server.once("listening", onListening);
          server.listen(socketPath);
        });
        await chmod(socketPath, 0o600);
      } catch (error) {
        closed = true;
        if (server?.listening) await new Promise(resolve => server.close(resolve));
        if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    },

    addSession(sessionId, owner) {
      if (!started || closed) throw new Error("The rnz transport is unavailable");
      if (typeof sessionId !== "string" || !sessionId || sessionId.length > 128 || hasControl(sessionId)) {
        throw new TypeError("sessionId is invalid");
      }
      if (owner == null) throw new TypeError("owner is required");
      if (sessions.has(sessionId)) throw new Error("The terminal session already exists");
      const token = randomBytes(32).toString("hex");
      const session = { sessionId, owner, token, activeRequests: 0, clients: new Set() };
      sessions.set(sessionId, session);
      tokens.set(token, session);
      return { RNZ_SOCKET: socketPath, RNZ_TOKEN: token };
    },

    revoke(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return;
      sessions.delete(sessionId);
      tokens.delete(session.token);
      for (const client of session.clients) client.destroy();
    },

    async close() {
      if (closed) return;
      closed = true;
      sessions.clear();
      tokens.clear();
      for (const client of clients) client.destroy();
      if (server?.listening) await new Promise(resolve => server.close(resolve));
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    },
  };
}
