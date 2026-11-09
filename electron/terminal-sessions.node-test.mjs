import assert from "node:assert/strict";
import test from "node:test";

import {
  createTerminalSessions,
  registerTerminalIpc,
  releaseTerminalOwnerOnWindowClose,
  terminalPageAllowed,
  terminalSenderAllowed,
  terminalShell,
  TERMINAL_LIMITS,
} from "./terminal-sessions.mjs";

class FakePty {
  data = new Set();
  exits = new Set();
  writes = [];
  sizes = [];
  blocked = [];
  paused = false;
  pauseCount = 0;
  resumeCount = 0;
  killed = 0;
  onData(callback) { this.data.add(callback); return { dispose: () => this.data.delete(callback) }; }
  onExit(callback) { this.exits.add(callback); return { dispose: () => this.exits.delete(callback) }; }
  write(value) { this.writes.push(value); }
  resize(cols, rows) { this.sizes.push([cols, rows]); }
  pause() { this.paused = true; this.pauseCount += 1; }
  resume() {
    this.paused = false;
    this.resumeCount += 1;
    while (!this.paused && this.blocked.length) this.emitOutput(this.blocked.shift());
  }
  kill() { this.killed += 1; this.exit(1); }
  output(value) {
    if (this.paused) this.blocked.push(value);
    else this.emitOutput(value);
  }
  forceOutput(value) { this.emitOutput(value); }
  emitOutput(value) { for (const callback of this.data) callback(value); }
  exit(exitCode) { for (const callback of this.exits) callback({ exitCode }); }
}

function fixture(options = {}) {
  const spawned = [];
  const received = [];
  const dataEvents = [];
  let nextId = 1;
  let sessions;
  const { onData: customOnData, ackOutput = false, ...settings } = options;
  sessions = createTerminalSessions({
    loadPty: () => ({ spawn: (...args) => {
      const pty = new FakePty();
      spawned.push({ args, pty });
      return pty;
    } }),
    onData: (owner, id, data, sequence) => {
      dataEvents.push({ owner, id, data, sequence });
      if (ackOutput) sessions.ack(owner, id, sequence);
      else if (customOnData) customOnData(owner, id, data, sequence);
      else received.push([owner, id, data]);
    },
    onExit: (owner, id, code) => received.push([owner, id, code]),
    makeId: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    ...settings,
  });
  return { sessions, spawned, received, dataEvents };
}

const owner = () => ({ id: Math.random() });

test("starts a fixed host shell with a filtered environment and no renderer command or cwd", () => {
  const fixtureData = fixture({
    platform: "linux",
    env: { SHELL: "/bin/zsh", PATH: "/usr/bin", HOME: "/home/person", DISPLAY: ":99", XAUTHORITY: "/tmp/xauth", WAYLAND_DISPLAY: "wayland-0", XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", XDG_CONFIG_HOME: "/home/person/config", SECRET: "not-forwarded" },
    home: "/home/person",
  });
  const result = fixtureData.sessions.start(owner(), { cols: 80, rows: 24 });
  const [file, args, options] = fixtureData.spawned[0].args;
  assert.deepEqual({ file, args }, { file: "/bin/zsh", args: ["-l"] });
  assert.deepEqual({ cols: options.cols, rows: options.rows, cwd: options.cwd, name: options.name }, {
    cols: 80, rows: 24, cwd: "/home/person", name: "xterm-256color",
  });
  assert.deepEqual(options.env, { PATH: "/usr/bin", HOME: "/home/person", SHELL: "/bin/zsh", DISPLAY: ":99", WAYLAND_DISPLAY: "wayland-0", XAUTHORITY: "/tmp/xauth", XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", XDG_CONFIG_HOME: "/home/person/config", TERM: "xterm-256color" });
  assert.equal("SECRET" in options.env, false);
  assert.equal(typeof result.id, "string");
  assert.deepEqual(terminalShell("win32", { COMSPEC: "C:\\Windows\\System32\\cmd.exe" }), {
    file: "C:\\Windows\\System32\\cmd.exe", args: [],
  });
});

test("binds a session environment and revokes it when the session closes", () => {
  const removed = [];
  const who = owner();
  const { sessions, spawned } = fixture({
    sessionEnvironment: (id, current) => { assert.equal(current, who); return { RNZ_TOKEN: id }; },
    onRemove: (current, id) => removed.push([current, id]),
  });
  const { id } = sessions.start(who, { cols: 80, rows: 24 });
  assert.equal(spawned[0].args[2].env.RNZ_TOKEN, id);
  assert.equal(sessions.owns(who, id), true);
  assert.equal(sessions.owns(owner(), id), false);
  sessions.close(who, id);
  assert.deepEqual(removed, [[who, id]]);
  assert.equal(sessions.owns(who, id), false);
});

test("validates dimensions and caps active and unattached sessions", () => {
  const { sessions } = fixture();
  const who = owner();
  for (const input of [null, { cols: 1, rows: 24 }, { cols: 501, rows: 24 }, { cols: 80, rows: 0 }, { cols: 80, rows: 201 }, { cols: 80, rows: 24, cwd: "/tmp" }]) {
    assert.throws(() => sessions.start(who, input), /dimensions/);
  }
  const ids = Array.from({ length: TERMINAL_LIMITS.sessions }, () => sessions.start(who, { cols: 80, rows: 24 }).id);
  assert.throws(() => sessions.start(who, { cols: 80, rows: 24 }), /Too many/);
  ids.forEach(id => sessions.close(who, id));
  assert.equal(sessions.size(), 0);
});

test("buffers output and exit until attach, then flushes output before exit", () => {
  const { sessions, spawned, received, dataEvents } = fixture();
  const who = owner();
  const id = sessions.start(who, { cols: 80, rows: 24 }).id;
  const pty = spawned[0].pty;
  pty.output("prompt> ");
  pty.exit(7);
  assert.deepEqual(received, []);
  sessions.attach(who, id);
  assert.deepEqual(received, [[who, id, "prompt> "]]);
  sessions.ack(who, id, dataEvents[0].sequence);
  assert.deepEqual(received, [[who, id, "prompt> "], [who, id, 7]]);
  assert.equal(sessions.size(), 0);
});

test("binds every operation to its owner and validates input and resize limits", () => {
  const { sessions, spawned } = fixture();
  const who = owner();
  const other = owner();
  const id = sessions.start(who, { cols: 90, rows: 30 }).id;
  const pty = spawned[0].pty;
  for (const action of [
    () => sessions.attach(other, id),
    () => sessions.close(other, id),
  ]) assert.throws(action, /unavailable/);
  sessions.attach(who, id);
  assert.throws(() => sessions.write(other, id, "whoami"), /unavailable/);
  assert.throws(() => sessions.resize(other, id, 90, 30), /unavailable/);
  assert.throws(() => sessions.write(who, id, "x".repeat(TERMINAL_LIMITS.inputBytes + 1)), /input/);
  assert.throws(() => sessions.write(who, id, new Uint8Array()), /input/);
  assert.throws(() => sessions.resize(who, id, 501, 30), /dimensions/);
  sessions.write(who, id, "echo ok\r");
  sessions.resize(who, id, 120, 45);
  assert.deepEqual(pty.writes, ["echo ok\r"]);
  assert.deepEqual(pty.sizes, [[120, 45]]);
});

test("retains pre-attach overflow and delivers every byte before exit", () => {
  const { sessions, spawned, received, dataEvents } = fixture();
  const who = owner();
  const id = sessions.start(who, { cols: 80, rows: 24 }).id;
  const pty = spawned[0].pty;
  const output = "a".repeat(TERMINAL_LIMITS.pendingOutputBytes + TERMINAL_LIMITS.outputChunkBytes + 1);
  pty.output(output);
  assert.equal(pty.killed, 1);
  sessions.attach(who, id);
  for (let index = 0; index < dataEvents.length; index += 1) {
    sessions.ack(who, id, dataEvents[index].sequence);
  }
  assert.equal(dataEvents.reduce((total, event) => total + Buffer.byteLength(event.data), 0), Buffer.byteLength(output));
  assert.ok(dataEvents.every(event => Buffer.byteLength(event.data) <= TERMINAL_LIMITS.outputChunkBytes));
  assert.deepEqual(received.at(-1), [who, id, 1]);
  assert.equal(sessions.size(), 0);
});

test("sustained output above one MiB per second does not kill a consuming terminal", () => {
  const { sessions, spawned, dataEvents } = fixture({ ackOutput: true, onData: () => {} });
  const who = owner();
  const id = sessions.start(who, { cols: 80, rows: 24 }).id;
  sessions.attach(who, id);
  const pty = spawned[0].pty;
  const chunk = "x".repeat(TERMINAL_LIMITS.outputChunkBytes);
  const started = Date.now();
  for (let total = 0; total < 17 * 1024 * 1024; total += chunk.length) pty.output(chunk);
  assert.ok(Date.now() - started < 16_000);
  assert.equal(dataEvents.reduce((total, event) => total + Buffer.byteLength(event.data), 0), 17 * 1024 * 1024);
  assert.equal(pty.killed, 0);
  assert.equal(pty.pauseCount, 0);
  assert.equal(sessions.size(), 1);
  sessions.close(who, id);
});

test("sustained high output pauses, resumes on ACK, and delivers exit after all data", () => {
  const { sessions, spawned, received, dataEvents } = fixture();
  const who = owner();
  const id = sessions.start(who, { cols: 80, rows: 24 }).id;
  sessions.attach(who, id);
  const pty = spawned[0].pty;
  const chunk = "x".repeat(TERMINAL_LIMITS.outputChunkBytes);
  for (let index = 0; index < 6; index += 1) pty.output(chunk);
  assert.equal(pty.paused, true);
  assert.equal(dataEvents.length, 4);
  assert.equal(pty.killed, 0);
  pty.output("tail");
  pty.exit(9);
  assert.equal(received.some(([, , value]) => value === 9), false);
  for (let index = 0; index < dataEvents.length; index += 1) sessions.ack(who, id, dataEvents[index].sequence);
  assert.equal(pty.killed, 0);
  assert.equal(pty.resumeCount, 1);
  assert.equal(dataEvents.reduce((total, event) => total + Buffer.byteLength(event.data), 0), 6 * chunk.length + 4);
  assert.deepEqual(received.at(-1), [who, id, 9]);
  assert.equal(sessions.size(), 0);
});

test("repeated output after pause hits the deferred cap and drains retained bytes before failure", () => {
  const { sessions, spawned, received, dataEvents } = fixture();
  const who = owner();
  const id = sessions.start(who, { cols: 80, rows: 24 }).id;
  sessions.attach(who, id);
  const pty = spawned[0].pty;
  const chunk = "x".repeat(TERMINAL_LIMITS.outputChunkBytes);
  for (let index = 0; index < 6; index += 1) pty.output(chunk);
  assert.equal(pty.paused, true);
  for (let index = 0; index < 10; index += 1) pty.forceOutput(chunk);
  assert.equal(pty.killed, 1);
  const maximumBuffered = TERMINAL_LIMITS.inFlightOutputBytes + TERMINAL_LIMITS.pendingOutputBytes + TERMINAL_LIMITS.deferredOutputBytes;
  for (let index = 0; index < dataEvents.length; index += 1) sessions.ack(who, id, dataEvents[index].sequence);
  const delivered = dataEvents.reduce((total, event) => total + Buffer.byteLength(event.data), 0);
  assert.ok(delivered <= maximumBuffered);
  assert.deepEqual(received.at(-1), [who, id, 1]);
  assert.equal(sessions.size(), 0);
});

test("a huge PTY event is not retained past the bounded deferred spill", () => {
  const { sessions, spawned, received, dataEvents } = fixture();
  const who = owner();
  const id = sessions.start(who, { cols: 80, rows: 24 }).id;
  const output = "x".repeat(5 * 1024 * 1024);
  spawned[0].pty.output(output);
  assert.equal(spawned[0].pty.killed, 1);
  sessions.attach(who, id);
  for (let index = 0; index < dataEvents.length; index += 1) sessions.ack(who, id, dataEvents[index].sequence);
  assert.equal(dataEvents.reduce((total, event) => total + Buffer.byteLength(event.data), 0),
    TERMINAL_LIMITS.pendingOutputBytes + TERMINAL_LIMITS.outputChunkBytes);
  assert.deepEqual(received.at(-1), [who, id, 1]);
});

test("slow ACKs pause PTY output without exceeding the buffer and owner cleanup kills it", async () => {
  const { sessions, spawned, dataEvents } = fixture();
  const who = owner();
  const id = sessions.start(who, { cols: 80, rows: 24 }).id;
  sessions.attach(who, id);
  const pty = spawned[0].pty;
  const chunk = "x".repeat(TERMINAL_LIMITS.outputChunkBytes);
  for (let index = 0; index < 6; index += 1) pty.output(chunk);
  pty.output("blocked behind the PTY pause");
  assert.equal(pty.paused, true);
  assert.equal(pty.blocked.length, 1);
  assert.equal(pty.killed, 0);
  assert.equal(dataEvents.length, 4);
  sessions.closeOwner(who);
  assert.equal(sessions.size(), 0);
  assert.equal(pty.data.size, 0);
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(pty.killed, 1);
});

test("close, owner cleanup, and app cleanup detach events and terminate each PTY", async () => {
  const { sessions, spawned } = fixture();
  const firstOwner = owner();
  const secondOwner = owner();
  const first = sessions.start(firstOwner, { cols: 80, rows: 24 }).id;
  sessions.start(firstOwner, { cols: 80, rows: 24 });
  const third = sessions.start(secondOwner, { cols: 80, rows: 24 }).id;
  sessions.close(firstOwner, first);
  assert.equal(spawned[0].pty.writes[0], "\x04");
  sessions.closeOwner(firstOwner);
  assert.equal(sessions.size(), 1);
  sessions.closeAll();
  assert.equal(sessions.size(), 0);
  assert.equal(spawned[2].pty.killed, 1);
  assert.ok(spawned.every(({ pty }) => pty.data.size === 0 && pty.exits.size === 0));
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.ok(spawned.every(({ pty }) => pty.killed === 1));
  assert.equal(third.length, 36);
});

test("fails without exposing native loader or shell errors", () => {
  const sessions = createTerminalSessions({ loadPty: () => { throw new Error("private path"); } });
  assert.throws(
    () => sessions.start(owner(), { cols: 80, rows: 24 }),
    error => error.message === "The interactive terminal could not be started" && !error.message.includes("private path"),
  );
});

function senderFixture(url = "http://127.0.0.1:8799/") {
  const frame = { url };
  const contents = { mainFrame: frame, getURL: () => url, isDestroyed: () => false };
  const win = { webContents: contents, isDestroyed: () => false };
  return { win, event: { sender: contents, senderFrame: frame } };
}

test("allows only the exact local main frame with a current document token", () => {
  const local = senderFixture();
  const options = { owner: local.win, localOrigin: "http://127.0.0.1:8799", localWorkspace: true };
  assert.equal(terminalPageAllowed(local.event, options), true);
  assert.equal(terminalSenderAllowed(local.event, { ...options, token: "current", expectedToken: "current" }), true);
  assert.equal(terminalSenderAllowed(local.event, { ...options, token: "stale", expectedToken: "current" }), false);

  const subframe = { ...local.event, senderFrame: { url: "http://127.0.0.1:8799/iframe" } };
  assert.equal(terminalPageAllowed(subframe, options), false);
  const unrelated = senderFixture();
  assert.equal(terminalPageAllowed(unrelated.event, options), false);
  assert.equal(terminalPageAllowed(local.event, { ...options, localOrigin: "http://127.0.0.1:8800" }), false);
  assert.equal(terminalPageAllowed(local.event, { ...options, localWorkspace: false }), false);
  const remote = senderFixture("https://workspace.example/");
  assert.equal(terminalPageAllowed(remote.event, { ...options, owner: remote.win }), false);
});

test("window close cleanup retains WebContents before Electron destroys the BrowserWindow", () => {
  const contents = {};
  let destroyed = false;
  let closed;
  const win = {
    get webContents() {
      if (destroyed) throw new TypeError("Object has been destroyed");
      return contents;
    },
    once: (event, callback) => { assert.equal(event, "closed"); closed = callback; },
  };
  const tokens = new WeakMap([[contents, "token"]]);
  let owner;
  releaseTerminalOwnerOnWindowClose(win, tokens, () => ({ closeOwner: value => { owner = value; } }));
  destroyed = true;
  closed();
  assert.equal(tokens.has(contents), false);
  assert.equal(owner, contents);
});

test("IPC rejects an unauthorized frame before reaching the session manager", async () => {
  const handlers = new Map();
  const messages = new Map();
  const ownerToken = owner();
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    on: (channel, handler) => messages.set(channel, handler),
  };
  const calls = [];
  const savedState = { version: 1, sessions: [] };
  const manager = Object.fromEntries(["start", "attach", "write", "resize", "close", "ack"].map(method => [method, (...args) => calls.push([method, ...args])]));
  registerTerminalIpc({
    ipcMain,
    sessions: manager,
    terminalState: { load: () => savedState, save: value => { savedState.value = value; return value; } },
    authorize: (event, token) => {
      if (event.allowed !== true || token !== "current") throw new Error("denied");
      return ownerToken;
    },
  });
  assert.throws(() => handlers.get("host-terminal:start")({ allowed: false }, "current", { cols: 80, rows: 24 }), /denied/);
  assert.throws(() => handlers.get("host-terminal:restore-state")({ allowed: false }, "current"), /denied/);
  assert.throws(() => handlers.get("host-terminal:save-state")({ allowed: false }, "current", {}), /denied/);
  assert.deepEqual(calls, []);
  const event = { allowed: true };
  await handlers.get("host-terminal:start")(event, "current", { cols: 80, rows: 24 });
  await handlers.get("host-terminal:attach")(event, "current", "id");
  await handlers.get("host-terminal:write")(event, "current", "id", "hello");
  await handlers.get("host-terminal:resize")(event, "current", "id", 80, 24);
  await handlers.get("host-terminal:close")(event, "current", "id");
  assert.equal(await handlers.get("host-terminal:restore-state")(event, "current"), savedState);
  const nextState = { version: 1, sessions: [{ key: "saved" }] };
  assert.equal(await handlers.get("host-terminal:save-state")(event, "current", nextState), nextState);
  assert.equal(savedState.value, nextState);
  messages.get("host-terminal:ack")(event, "current", "id", 1);
  assert.deepEqual(calls.map(([method]) => method), ["start", "attach", "write", "resize", "close", "ack"]);
  assert.ok(calls.every(([, ownerArg]) => ownerArg === ownerToken));
});
