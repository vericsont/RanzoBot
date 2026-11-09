// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ terminals: [] as any[], order: [] as string[], writeCallbacks: [] as (() => void)[], holdWrites: false, savedState: { version: 1, sessions: [], layout: null, activeKey: null, zoomed: null } as any }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    input?: (data: string) => void;
    output: string[] = [];
    buffer: any;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      const output = this.output;
      this.buffer = { active: { get length() { return output.join("").split("\\n").length; }, getLine(index: number) { return { translateToString: () => (output.join("").split("\\n")[index] ?? "").replace(/\\r$/, "") }; } } };
      fixture.terminals.push(this);
    }
    loadAddon(addon: { terminal?: unknown }) { addon.terminal = this; }
    open(element: HTMLElement) {
      Object.defineProperty(element, "clientWidth", { configurable: true, value: 640 });
      Object.defineProperty(element, "clientHeight", { configurable: true, value: 400 });
    }
    onData(callback: (data: string) => void) { this.input = callback; return { dispose: vi.fn() }; }
    write(data: string, callback?: () => void) {
      this.output.push(data);
      if (!callback) return;
      if (fixture.holdWrites) fixture.writeCallbacks.push(callback);
      else queueMicrotask(callback);
    }
    clear() { this.output = []; }
    focus() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class { fit() { fixture.order.push("fit"); } },
}));

import { setLocale } from "@/lib/i18n";
import { TerminalPage } from "./TerminalPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let data: ((id: string, value: string) => Promise<void>) | undefined;
let exit: ((id: string, code: number) => void) | undefined;
let open: ((request: { requestId: string; sessionId: string; resource: { id: string; kind: "directory"; label: string } }) => boolean) | undefined;
let nextId = 0;
const bridge = {
  start: vi.fn(async ({ cols, rows }: { cols: number; rows: number }) => {
    fixture.order.push("start");
    expect(cols).toBeGreaterThan(0);
    expect(rows).toBeGreaterThan(0);
    nextId += 1;
    return { id: `terminal-${nextId}` };
  }),
  attach: vi.fn(async (_id: string) => { fixture.order.push("attach"); }),
  write: vi.fn(async () => {}),
  resize: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  restoreState: vi.fn(async () => fixture.savedState),
  saveState: vi.fn(async (state: any) => { fixture.savedState = state; return state; }),
  setDirty: vi.fn(),
  listDirectory: vi.fn(async () => ({ entries: [] })),
  closeResource: vi.fn(async () => {}),
  onOpen: vi.fn((callback: typeof open) => { open = callback; return () => { open = undefined; }; }),
  onData: vi.fn((callback: (id: string, value: string) => Promise<void>) => {
    fixture.order.push("onData"); data = callback; return () => { data = undefined; };
  }),
  onExit: vi.fn((callback: (id: string, code: number) => void) => {
    fixture.order.push("onExit"); exit = callback; return () => { exit = undefined; };
  }),
};

const render = async () => {
  await act(async () => root.render(createElement(StrictMode, null, createElement(TerminalPage))));
};
const settle = async () => {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
};
const createButton = () => host.querySelector<HTMLButtonElement>('button[aria-label="New terminal"]')
  ?? [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Create terminal"))!;

beforeEach(() => {
  setLocale("en");
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(900);
  fixture.terminals.length = 0;
  fixture.order.length = 0;
  fixture.writeCallbacks.length = 0;
  fixture.holdWrites = false;
  fixture.savedState = { version: 1, sessions: [], layout: null, activeKey: null, zoomed: null };
  nextId = 0;
  data = undefined;
  exit = undefined;
  open = undefined;
  bridge.start.mockClear();
  bridge.attach.mockClear();
  bridge.write.mockClear();
  bridge.resize.mockClear();
  bridge.close.mockClear();
  bridge.restoreState.mockClear();
  bridge.saveState.mockClear();
  bridge.onData.mockClear();
  bridge.onExit.mockClear();
  bridge.onOpen.mockClear();
  bridge.closeResource.mockClear();
  window.ogb = { platform: "linux", remoteClient: { active: false }, hostTerminal: bridge } as unknown as typeof window.ogb;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  await settle();
  host.remove();
  delete window.ogb;
  vi.restoreAllMocks();
});

describe("TerminalPage", () => {
  it("restores saved shells, nested layout, active pane and scrollback, then persists output and the layout", async () => {
    const [first, second] = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002"];
    const group = "20000000-0000-4000-8000-000000000001";
    fixture.savedState = {
      version: 1,
      sessions: [{ key: first, name: "Terminal 1", transcript: "previous shell output" }, { key: second, name: "Terminal 2", transcript: "second shell output" }],
      activeKey: second, zoomed: null,
      layout: { id: group, kind: "split", axis: "row", weight: 1, children: [
        { id: first, kind: "pane", weight: 2 }, { id: second, kind: "pane", weight: 1 },
      ] },
    };
    await render();
    await settle();
    expect(host.querySelectorAll("[data-terminal-pane]")).toHaveLength(2);
    expect(host.querySelectorAll('[role="group"]')).toHaveLength(0);
    expect(bridge.start).toHaveBeenCalledTimes(2);
    expect(fixture.terminals[0]!.output.join("")).toContain("previous shell output");
    expect(fixture.terminals[1]!.output.join("")).toContain("second shell output");
    expect(host.querySelector<HTMLElement>('[data-terminal-pane="10000000-0000-4000-8000-000000000001"]')!.style.width).toBe("796px");
    await act(async () => { await data?.("terminal-1", "fresh output\\r\\n"); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(bridge.saveState).toHaveBeenCalled();
    expect(fixture.savedState.activeKey).toBe(second);
    expect(fixture.savedState.layout).toEqual(expect.objectContaining({ id: group, axis: "row" }));
    expect(fixture.savedState.sessions[0].transcript).toContain("fresh output");
  });

  it("shows no host terminal surface or bridge calls on a remote page", async () => {
    window.ogb = { platform: "linux", remoteClient: { active: true }, hostTerminal: bridge } as unknown as typeof window.ogb;
    await render();
    expect(host.textContent).toContain("Local terminal unavailable");
    expect(host.querySelector('[data-terminal-tiles]')).toBeNull();
    expect(bridge.onData).not.toHaveBeenCalled();
    expect(bridge.start).not.toHaveBeenCalled();
  });

  it("subscribes before starting, attaches the session, and sends only terminal input/output through the bridge", async () => {
    await render();
    expect(host.querySelector("h1")?.title).toContain("This computer");
    expect(host.querySelector("h1")?.title).toContain("never sent to bots");
    await act(async () => createButton().click());
    await settle();
    expect(fixture.order.indexOf("onData")).toBeLessThan(fixture.order.indexOf("start"));
    expect(fixture.order.indexOf("onExit")).toBeLessThan(fixture.order.indexOf("start"));
    expect(fixture.order.indexOf("attach")).toBeGreaterThan(fixture.order.indexOf("start"));
    expect(bridge.start).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-terminal-pane]')?.getAttribute("aria-label")).toBe("Terminal 1");
    expect(host.querySelector('button[aria-label="Move Terminal 1"]')?.textContent).toBe("");

    const terminal = fixture.terminals.at(-1)!;
    await act(async () => terminal.input!("ls\r"));
    expect(bridge.write).toHaveBeenCalledWith("terminal-1", "ls\r");
    await act(async () => { await data?.("terminal-1", "done\r\n"); });
    expect(terminal.output).toContain("done\r\n");
    expect(bridge.resize).toHaveBeenCalledWith("terminal-1", 80, 24);
  });

  it("opens resources beside the source shell and persists only shell panes", async () => {
    await render();
    await act(async () => createButton().click());
    await settle();
    const request = { requestId: "request", sessionId: "terminal-1", resource: { id: "directory-id", kind: "directory" as const, label: "fixture" } };
    let accepted = false;
    await act(async () => { accepted = open!(request); });
    await settle();
    expect(accepted).toBe(true);
    expect(host.querySelectorAll("[data-terminal-pane]")).toHaveLength(2);
    expect(host.textContent).toContain("This directory is empty.");
    expect(bridge.start).toHaveBeenCalledTimes(1);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(fixture.savedState.sessions).toHaveLength(1);
    expect(fixture.savedState.layout).toEqual(expect.objectContaining({ kind: "pane", id: fixture.savedState.sessions[0].key }));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Close fixture"]')!.click());
    expect(bridge.closeResource).toHaveBeenCalledWith("directory-id");
    expect(host.querySelectorAll("[data-terminal-pane]")).toHaveLength(1);
    expect(open!({ ...request, sessionId: "not-a-session" })).toBe(false);
  });

  it("renders buffered attach output and preserves an exit delivered before attach resolves", async () => {
    bridge.attach.mockImplementationOnce(async (id) => {
      if (data) await data(id, "shell ready\r\n");
      exit?.(id, 7);
      await Promise.resolve();
    });
    await render();
    await act(async () => createButton().click());
    await settle();
    expect(fixture.terminals.at(-1)!.output).toContain("shell ready\r\n");
    expect(host.textContent).toContain("Exited with code 7");
    expect(bridge.resize).not.toHaveBeenCalled();
  });

  it("resolves onData only after xterm finishes writing, and safely settles a disposed terminal", async () => {
    fixture.holdWrites = true;
    await render();
    await act(async () => createButton().click());
    await settle();
    let settled = false;
    const pending = data!("terminal-1", "buffered").then(() => { settled = true; });
    await Promise.resolve();
    expect(fixture.terminals.at(-1)!.output).toContain("buffered");
    expect(settled).toBe(false);
    const pendingWrite = fixture.writeCallbacks.shift()!;
    await act(async () => pendingWrite());
    await pending;
    expect(settled).toBe(true);

    const lateData = data!;
    await act(async () => root.unmount());
    await expect(lateData("terminal-1", "late")).resolves.toBeUndefined();
    root = createRoot(host);
    fixture.holdWrites = false;
  });

  it("tiles up to sixteen sessions and closes the selected session", async () => {
    await render();
    for (let index = 0; index < 16; index += 1) {
      await act(async () => createButton().click());
      await settle();
    }
    expect(host.querySelectorAll('[data-terminal-pane]')).toHaveLength(16);
    expect(host.querySelectorAll('[role="separator"]')).toHaveLength(15);
    expect(createButton().disabled).toBe(true);
    const selectedPane = host.querySelector<HTMLButtonElement>('button[aria-label="Move Terminal 2"]')!;
    await act(async () => selectedPane.click());
    expect(selectedPane.parentElement!.className).toContain("bg-raised/60");
    const close = host.querySelector<HTMLButtonElement>('button[aria-label="Close Terminal 2"]')!;
    await act(async () => close.click());
    await settle();
    expect(host.querySelectorAll('[data-terminal-pane]')).toHaveLength(15);
    expect(bridge.close).toHaveBeenCalledWith("terminal-2");
    expect(createButton().disabled).toBe(false);
  });

  it("moves across columns without restarting shells and resizes with the keyboard", async () => {
    await render();
    await act(async () => createButton().click());
    await settle();
    await act(async () => createButton().click());
    await settle();
    const paneNames = () => [...host.querySelectorAll('[data-terminal-pane]')].map(pane => pane.getAttribute("aria-label"));
    const originalSurfaces = [...host.querySelectorAll('[data-terminal-surface]')];
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Move Terminal 2"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(paneNames()).toEqual(["Terminal 2", "Terminal 1"]);
    expect([...host.querySelectorAll('[data-terminal-surface]')]).toEqual(originalSurfaces.reverse());
    expect(bridge.start).toHaveBeenCalledTimes(2);
    expect(bridge.close).not.toHaveBeenCalled();
    const separator = host.querySelector<HTMLElement>('[role="separator"]')!;
    expect(separator.getAttribute("aria-orientation")).toBe("vertical");
    const firstPane = host.querySelector<HTMLElement>('[data-terminal-pane]')!;
    const beforeWidth = parseFloat(firstPane.style.width);
    await act(async () => separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(parseFloat(firstPane.style.width)).toBeCloseTo(beforeWidth + 24);
    await act(async () => fixture.terminals.at(-1)!.input!("echo still running\r"));
    expect(bridge.write).toHaveBeenCalledWith("terminal-2", "echo still running\r");
  });

  it("creates 3×3, maximizes to 1×1, restores, and never closes panes when arranging", async () => {
    await render();
    await act(async () => createButton().click());
    await settle();
    const arrange = async (value: string) => {
      const select = host.querySelector<HTMLSelectElement>('select[aria-label="Arrange panes"]')!;
      await act(async () => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
      await settle();
    };
    await arrange("3x3");
    const panes = [...host.querySelectorAll<HTMLElement>("[data-terminal-pane]")];
    const surfaces = [...host.querySelectorAll("[data-terminal-surface]")];
    const terminals = [...fixture.terminals];
    expect(panes).toHaveLength(9);
    expect(new Set(panes.map(pane => pane.style.left)).size).toBe(3);
    expect(new Set(panes.map(pane => pane.style.top)).size).toBe(3);
    expect(bridge.start).toHaveBeenCalledTimes(9);
    expect(host.querySelector<HTMLOptionElement>('option[value="2x2"]')!.disabled).toBe(true);
    await arrange("zoom");
    expect(panes.filter(pane => !pane.hidden)).toHaveLength(1);
    await act(async () => data?.("terminal-1", "output while hidden"));
    expect(terminals[0]!.output).toContain("output while hidden");
    await arrange("zoom");
    expect(panes.every(pane => !pane.hidden)).toBe(true);
    expect([...host.querySelectorAll("[data-terminal-surface]")]).toEqual(surfaces);
    expect(fixture.terminals).toEqual(terminals);
    expect(bridge.close).not.toHaveBeenCalled();
    await arrange("9x1");
    expect(new Set(panes.map(pane => pane.style.left)).size).toBe(1);
    await arrange("1x9");
    expect(new Set(panes.map(pane => pane.style.top)).size).toBe(1);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(fixture.savedState.zoomed).toBeNull();
    expect(bridge.start).toHaveBeenCalledTimes(9);
  });

  it("splits one pane below and preserves its neighboring full-height column", async () => {
    await render();
    await act(async () => createButton().click());
    await settle();
    await act(async () => createButton().click());
    await settle();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Split Terminal 1 below"]')!.click());
    await settle();
    const pane = (name: string) => host.querySelector<HTMLElement>(`[data-terminal-pane][aria-label="${name}"]`)!;
    expect(pane("Terminal 1").style.left).toBe(pane("Terminal 3").style.left);
    expect(parseFloat(pane("Terminal 3").style.top)).toBeGreaterThan(0);
    expect(parseFloat(pane("Terminal 2").style.height)).toBe(900);
    expect(bridge.start).toHaveBeenCalledTimes(3);
  });

  it("reports start errors and lets the person dismiss them", async () => {
    bridge.start.mockRejectedValueOnce(new Error("could not start shell"));
    await render();
    await act(async () => createButton().click());
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("could not start shell");
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Dismiss")?.click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("closes sessions, settles pending output, and unsubscribes when leaving the page", async () => {
    fixture.holdWrites = true;
    await render();
    await act(async () => createButton().click());
    await settle();
    await act(async () => createButton().click());
    await settle();
    const deliver = data!;
    const pendingOutput = deliver("terminal-2", "pending output");
    expect(fixture.writeCallbacks).toHaveLength(1);
    await act(async () => root.unmount());
    await settle();
    await expect(pendingOutput).resolves.toBeUndefined();
    await expect(deliver("terminal-1", "late output")).resolves.toBeUndefined();
    expect(bridge.close).toHaveBeenCalledWith("terminal-1");
    expect(bridge.close).toHaveBeenCalledWith("terminal-2");
    expect(data).toBeUndefined();
    expect(exit).toBeUndefined();
    root = createRoot(host);
    fixture.holdWrites = false;
  });
});
