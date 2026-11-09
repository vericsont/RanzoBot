import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalResources } from "./terminal-resources.mjs";

function fixture() {
  let next = 0;
  const closed = [];
  const files = {
    open: async () => ({ id: `f${++next}`, kind: "directory", label: "fixture" }),
    list: async () => ({ entries: [] }),
    openChild: async () => ({ id: `f${++next}`, kind: "file", label: "child" }),
    read: async () => ({ text: "fixture", revision: "one", readOnly: false }),
    save: async () => ({ revision: "two" }),
    close: id => closed.push(id),
  };
  const git = { open: async () => ({ id: `g${++next}`, kind: "git", label: "repo" }), close: id => closed.push(id) };
  const messages = [];
  const owner = { send: (channel, data) => messages.push([channel, data]) };
  let session = true;
  let local = true;
  const manager = createTerminalResources({ files, git, sessionAllowed: (candidate, id) => candidate === owner && id === "shell" && session, ownerAllowed: candidate => candidate === owner && local, timeoutMs: 100 });
  return { manager, owner, messages, closed, setSession: value => { session = value; }, setLocal: value => { local = value; } };
}

test("routes an open to its owner, waits for acceptance, and confines child grants", async () => {
  const { manager, owner, messages, closed } = fixture();
  const open = manager.open({ owner, sessionId: "shell", action: "view", absolutePath: "/tmp" });
  await Promise.resolve();
  const event = messages[0][1];
  assert.equal(messages[0][0], "host-terminal:open");
  assert.equal(event.sessionId, "shell");
  manager.acknowledge({}, event.requestId, true);
  manager.acknowledge(owner, event.requestId, true);
  await open;
  const child = await manager.openChild(owner, event.resource.id, "child");
  assert.equal((await manager.read(owner, child.id)).text, "fixture");
  await assert.rejects(manager.read({}, child.id), /unavailable/);
  await assert.rejects(manager.read(owner, event.resource.id), /unavailable/);
  manager.closeOwner(owner);
  assert.deepEqual(closed.sort(), [child.id, event.resource.id].sort());
  await assert.rejects(manager.read(owner, child.id), /unavailable/);
});

test("revokes pending requests and grants on session closure or refused delivery", async () => {
  const { manager, owner, messages, closed, setSession } = fixture();
  const first = manager.open({ owner, sessionId: "shell", action: "view", absolutePath: "/tmp" });
  await Promise.resolve();
  setSession(false);
  manager.closeSession(owner, "shell");
  await assert.rejects(first, /unavailable/);
  assert.deepEqual(closed, [messages[0][1].resource.id]);
  await assert.rejects(manager.open({ owner, sessionId: "shell", action: "view", absolutePath: "/tmp" }), /unavailable/);
});

test("refuses resource access after owner stops being local", async () => {
  const { manager, owner, messages, setLocal } = fixture();
  const first = manager.open({ owner, sessionId: "shell", action: "view", absolutePath: "/tmp" });
  await Promise.resolve();
  manager.acknowledge(owner, messages[0][1].requestId, true);
  await first;
  setLocal(false);
  await assert.rejects(manager.list(owner, messages[0][1].resource.id, ""), /unavailable/);
  manager.closeOwner(owner);
});
