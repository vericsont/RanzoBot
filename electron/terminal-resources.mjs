import { randomUUID } from "node:crypto";

export function createTerminalResources({ files, git, sessionAllowed, ownerAllowed, timeoutMs = 8000 } = {}) {
  const grants = new Map();
  const pending = new Map();
  const service = kind => kind === "git" ? git : files;
  const entry = (owner, id, kind) => {
    const grant = grants.get(id);
    if (!grant || grant.owner !== owner || (kind && grant.kind !== kind) || !ownerAllowed(owner)) {
      throw new Error("The terminal resource is unavailable");
    }
    return grant;
  };
  const close = (owner, id) => {
    const grant = grants.get(id);
    if (!grant || grant.owner !== owner) return;
    grants.delete(id);
    service(grant.kind).close(id);
  };
  const cancel = (owner, sessionId) => {
    for (const [requestId, request] of pending) {
      if (request.owner !== owner || (sessionId && request.sessionId !== sessionId)) continue;
      pending.delete(requestId);
      clearTimeout(request.timer);
      request.reject(new Error("The terminal session is unavailable"));
    }
  };
  return {
    async open({ owner, sessionId, action, absolutePath }) {
      if (!sessionAllowed(owner, sessionId) || !ownerAllowed(owner)) throw new Error("The terminal session is unavailable");
      if (!['view', 'git'].includes(action)) throw new Error("The terminal request is invalid");
      const backend = action === "git" ? git : files;
      const resource = await backend.open(absolutePath);
      if (!sessionAllowed(owner, sessionId) || !ownerAllowed(owner)) {
        backend.close(resource.id);
        throw new Error("The terminal session is unavailable");
      }
      grants.set(resource.id, { owner, kind: resource.kind });
      const requestId = randomUUID();
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error("The terminal page did not accept the request"));
          }, timeoutMs);
          timer.unref?.();
          pending.set(requestId, { owner, sessionId, timer, resolve, reject });
          try { owner.send("host-terminal:open", { requestId, sessionId, resource }); }
          catch (error) { pending.delete(requestId); clearTimeout(timer); reject(error); }
        });
      } catch (error) {
        close(owner, resource.id);
        throw error;
      }
    },
    acknowledge(owner, requestId, accepted) {
      const request = pending.get(requestId);
      if (!request || request.owner !== owner || typeof accepted !== "boolean") return;
      pending.delete(requestId);
      clearTimeout(request.timer);
      if (accepted && sessionAllowed(owner, request.sessionId) && ownerAllowed(owner)) request.resolve();
      else request.reject(new Error("The terminal page could not open the resource"));
    },
    async list(owner, id, relativePath) {
      entry(owner, id, "directory");
      return files.list(id, relativePath);
    },
    async openChild(owner, id, relativePath) {
      entry(owner, id, "directory");
      const child = await files.openChild(id, relativePath);
      if (!grants.has(id) || grants.get(id)?.owner !== owner || !ownerAllowed(owner)) {
        files.close(child.id);
        throw new Error("The terminal resource is unavailable");
      }
      grants.set(child.id, { owner, kind: child.kind });
      return child;
    },
    async read(owner, id) { entry(owner, id, "file"); return files.read(id); },
    async save(owner, id, revision, text) { entry(owner, id, "file"); return files.save(id, revision, text); },
    async history(owner, id, cursor) { entry(owner, id, "git"); return git.history(id, cursor); },
    async commit(owner, id, hash, parent) { entry(owner, id, "git"); return git.commit(id, hash, parent); },
    async diff(owner, id, hash, parent, path) { entry(owner, id, "git"); return git.diff(id, hash, parent, path); },
    close,
    closeSession(owner, sessionId) { cancel(owner, sessionId); },
    closeOwner(owner) {
      cancel(owner);
      for (const [id, grant] of grants) if (grant.owner === owner) close(owner, id);
    },
    closeAll() {
      for (const request of pending.values()) cancel(request.owner);
      for (const [id, grant] of grants) close(grant.owner, id);
    },
  };
}
