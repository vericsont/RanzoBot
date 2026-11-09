import fs from "node:fs";
import path from "node:path";

// Security: terminal transcripts can contain secrets; persist only in the owner-only local app profile, never a bot workspace.
export const TERMINAL_STATE_LIMITS = Object.freeze({ sessions: 16, transcriptBytes: 128 * 1024, stateBytes: 16 * 1024 * 1024, depth: 16 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const blank = () => ({ version: 1, sessions: [], layout: null, activeKey: null, zoomed: null });

function tail(value, maxBytes) {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of [...value].reverse()) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    result = character + result;
    bytes += size;
  }
  return result;
}

function validLayout(value, keys, seen, depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > TERMINAL_STATE_LIMITS.depth ||
      !UUID.test(value.id) || seen.has(value.id) || !Number.isFinite(value.weight) || value.weight <= 0 || value.weight > 100) return false;
  seen.add(value.id);
  if (value.kind === "pane") return keys.has(value.id) && Object.keys(value).every(key => ["id", "kind", "weight"].includes(key));
  if (value.kind !== "split" || !["row", "column"].includes(value.axis) || !Array.isArray(value.children) ||
      value.children.length < 2 || value.children.length > TERMINAL_STATE_LIMITS.sessions ||
      !Object.keys(value).every(key => ["id", "kind", "weight", "axis", "children"].includes(key))) return false;
  return value.children.every(child => validLayout(child, keys, seen, depth + 1));
}

export function parseTerminalState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 || !Array.isArray(value.sessions) || value.sessions.length > TERMINAL_STATE_LIMITS.sessions) return blank();
  const sessions = [];
  const keys = new Set();
  for (const entry of value.sessions) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !UUID.test(entry.key) || keys.has(entry.key) ||
        typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 80 || typeof entry.transcript !== "string" ||
        !Object.keys(entry).every(key => ["key", "name", "transcript"].includes(key))) return blank();
    keys.add(entry.key);
    sessions.push({ key: entry.key, name: entry.name, transcript: tail(entry.transcript, TERMINAL_STATE_LIMITS.transcriptBytes) });
  }
  let layout = value.layout;
  if (layout !== null && (!validLayout(layout, keys, new Set()) || new Set(flatten(layout)).size !== keys.size || flatten(layout).some(key => !keys.has(key)))) layout = null;
  const activeKey = keys.has(value.activeKey) ? value.activeKey : sessions[0]?.key ?? null;
  const zoomed = keys.has(value.zoomed) ? value.zoomed : null;
  return { version: 1, sessions, layout, activeKey, zoomed };
}

function flatten(tree) {
  return tree.kind === "pane" ? [tree.id] : tree.children.flatMap(flatten);
}

export function createTerminalStateStore({ file, files = fs } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error("Terminal state path must be absolute");
  return {
    load() {
      try {
        const data = files.readFileSync(file);
        if (data.length > TERMINAL_STATE_LIMITS.stateBytes) return blank();
        return parseTerminalState(JSON.parse(data.toString("utf8")));
      } catch { return blank(); }
    },
    save(input) {
      const state = parseTerminalState(input);
      const data = Buffer.from(JSON.stringify(state));
      if (data.length > TERMINAL_STATE_LIMITS.stateBytes) throw new Error("Terminal state is too large");
      files.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        files.writeFileSync(temporary, data, { mode: 0o600 });
        files.renameSync(temporary, file);
      } catch (error) {
        try { files.rmSync(temporary, { force: true }); } catch {}
        throw error;
      }
      return state;
    },
  };
}
