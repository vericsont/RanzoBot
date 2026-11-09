import { afterEach, describe, expect, it, vi } from "vitest";
import { canLeaveTerminalDrafts, registerTerminalDraftGuard } from "./terminal-draft-guard";

describe("terminal draft guard", () => {
  let unregister: (() => void) | undefined;

  afterEach(() => {
    unregister?.();
    unregister = undefined;
  });

  it("allows leaving when no guard is registered", () => {
    expect(canLeaveTerminalDrafts()).toBe(true);
  });

  it("invokes the registered guard synchronously", () => {
    const callback = vi.fn(() => false);
    unregister = registerTerminalDraftGuard(callback);

    expect(canLeaveTerminalDrafts()).toBe(false);
    expect(callback).toHaveBeenCalledOnce();
  });

  it("does not let an old cleanup remove a newer registration", () => {
    const first = registerTerminalDraftGuard(() => false);
    const secondCallback = vi.fn(() => true);
    unregister = registerTerminalDraftGuard(secondCallback);

    first();
    expect(canLeaveTerminalDrafts()).toBe(true);
    expect(secondCallback).toHaveBeenCalledOnce();
  });

  it("blocks leaving if the guard throws", () => {
    unregister = registerTerminalDraftGuard(() => { throw new Error("confirmation failed"); });
    expect(canLeaveTerminalDrafts()).toBe(false);
  });
});
