import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTerminalStateStore, parseTerminalState, TERMINAL_STATE_LIMITS } from "./terminal-state.mjs";

const ids = Array.from({ length: 3 }, (_, index) => `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
const state = {
  version: 1,
  sessions: ids.map((key, index) => ({ key, name: `Terminal ${index + 1}`, transcript: `saved output ${index}` })),
  activeKey: ids[1],
  zoomed: ids[2],
  layout: {
    id: "20000000-0000-4000-8000-000000000001", kind: "split", axis: "row", weight: 1,
    children: [
      { id: ids[0], kind: "pane", weight: 2 },
      { id: "20000000-0000-4000-8000-000000000002", kind: "split", axis: "column", weight: 1, children: [
        { id: ids[1], kind: "pane", weight: 1 }, { id: ids[2], kind: "pane", weight: 1 },
      ] },
    ],
  },
};

test("saves private session scrollback, active pane, zoom and nested divider weights, then restores them", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "terminal-state-"));
  try {
    const file = path.join(directory, "terminal-state.json");
    const store = createTerminalStateStore({ file });
    assert.deepEqual(store.load().sessions, []);
    assert.deepEqual(store.save(state), state);
    assert.deepEqual(store.load(), state);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), state);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("bounds transcript bytes and state size while retaining whole Unicode characters", () => {
  const key = ids[0];
  const input = { version: 1, sessions: [{ key, name: "Terminal 1", transcript: "x".repeat(10) + "🙂".repeat(40_000) }], layout: { id: key, kind: "pane", weight: 1 }, activeKey: key };
  const parsed = parseTerminalState(input);
  assert.ok(Buffer.byteLength(parsed.sessions[0].transcript) <= TERMINAL_STATE_LIMITS.transcriptBytes);
  assert.equal([...parsed.sessions[0].transcript].at(-1), "🙂");
  const directory = mkdtempSync(path.join(os.tmpdir(), "terminal-state-large-"));
  try {
    const store = createTerminalStateStore({ file: path.join(directory, "state.json") });
    const tooMany = Array.from({ length: 16 }, (_, index) => ({ key: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, name: `Terminal ${index + 1}`, transcript: "\0".repeat(TERMINAL_STATE_LIMITS.transcriptBytes) }));
    const saved = store.save({ version: 1, sessions: tooMany, layout: null, activeKey: tooMany[0].key, zoomed: null });
    assert.equal(saved.sessions.length, 16);
    const oversized = createTerminalStateStore({ file: path.join(directory, "oversized.json"), files: { readFileSync: () => Buffer.alloc(TERMINAL_STATE_LIMITS.stateBytes + 1) } });
    assert.deepEqual(oversized.load().sessions, []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("rejects malformed trees, unknown panes, duplicate panes, unsafe weights and invalid session records", () => {
  assert.deepEqual(parseTerminalState(null).sessions, []);
  assert.deepEqual(parseTerminalState({ ...state, sessions: [{ ...state.sessions[0], transcript: 10 }] }).sessions, []);
  assert.equal(parseTerminalState({ ...state, layout: { id: ids[0], kind: "pane", weight: 1 } }).layout, null);
  assert.equal(parseTerminalState({ ...state, layout: { ...state.layout, weight: Infinity } }).layout, null);
  assert.equal(parseTerminalState({ ...state, layout: { ...state.layout, children: [state.layout.children[0], state.layout.children[0]] } }).layout, null);
  assert.equal(parseTerminalState({ ...state, layout: { ...state.layout, children: [...state.layout.children, { id: "30000000-0000-4000-8000-000000000001", kind: "pane", weight: 1 }] } }).layout, null);
  assert.deepEqual(parseTerminalState({ ...state, sessions: Array.from({ length: 17 }, (_, i) => ({ key: `10000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, name: "Terminal", transcript: "" })) }).sessions, []);
});
