// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilePane, type FileBridge, type FileResource } from "./FilePane";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rootResource: FileResource = { id: "root-grant", kind: "directory", label: "project" };
let host: HTMLDivElement;
let root: Root;
let dirtyChange = vi.fn<(dirty: boolean) => void>();
let bridge: FileBridge;
let originalConfirm: PropertyDescriptor | undefined;

const render = async (resource = rootResource) => {
  await act(async () => root.render(createElement(FilePane, { resource, bridge, onDirtyChange: dirtyChange })));
};
const settle = async () => {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
};
const click = async (selector: string) => {
  const button = host.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`Missing button: ${selector}`);
  await act(async () => button.click());
};
const edit = async (text: string) => {
  const content = host.querySelector<HTMLElement>(".cm-content");
  if (!content) throw new Error("Missing CodeMirror content");
  await act(async () => {
    content.textContent = text;
    content.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  dirtyChange = vi.fn<(dirty: boolean) => void>();
  originalConfirm = Object.getOwnPropertyDescriptor(window, "confirm");
  bridge = {
    listDirectory: vi.fn(async () => ({ entries: [] })),
    openChild: vi.fn(async (): Promise<FileResource> => ({ id: "file-grant", kind: "file", label: "hello.txt" })),
    readText: vi.fn(async () => ({ text: "hello\n", revision: "rev-1", readOnly: false })),
    saveText: vi.fn(async () => ({ revision: "rev-2" })),
    closeResource: vi.fn(async () => {}),
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  await settle();
  host.remove();
  if (originalConfirm) Object.defineProperty(window, "confirm", originalConfirm);
  else Reflect.deleteProperty(window, "confirm");
  vi.restoreAllMocks();
});

describe("FilePane", () => {
  it("lists directories first, navigates within the grant, opens a file, and returns while closing only its child grant", async () => {
    vi.mocked(bridge.listDirectory).mockImplementation(async (_id, path) => ({
      entries: path === ""
        ? [{ name: "z.txt", kind: "file" }, { name: "nested", kind: "directory" }, { name: "link", kind: "symlink" }]
        : [{ name: "hello.txt", kind: "file" }],
    }));
    await render();
    await settle();

    const labels = [...host.querySelectorAll<HTMLButtonElement>("ul button")].map((button) => button.textContent);
    expect(labels).toEqual(["nested/", "linksymbolic link not followed", "z.txt"]);
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="link, symbolic link not followed"]')?.disabled).toBe(true);
    await click('button[aria-label="nested, directory"]');
    await settle();
    expect(bridge.listDirectory).toHaveBeenLastCalledWith("root-grant", "nested");
    expect(host.textContent).toContain("nested");

    await click('button[aria-label="hello.txt"]');
    await settle();
    expect(bridge.openChild).toHaveBeenCalledWith("root-grant", "nested/hello.txt");
    expect(host.querySelector(".cm-content")?.textContent).toContain("hello");
    await click("header button");
    await settle();
    expect(bridge.closeResource).toHaveBeenCalledWith("file-grant");
    expect(bridge.listDirectory).toHaveBeenLastCalledWith("root-grant", "nested");
    expect(bridge.closeResource).not.toHaveBeenCalledWith("root-grant");
  });

  it("saves edits explicitly and intercepts Ctrl-S", async () => {
    vi.mocked(bridge.listDirectory).mockResolvedValue({ entries: [{ name: "hello.txt", kind: "file" }] });
    await render();
    await settle();
    await click('button[aria-label="hello.txt"]');
    await settle();
    await edit("saved draft");
    await click("header button:last-child");
    expect(bridge.saveText).toHaveBeenCalledWith("file-grant", "rev-1", "saved draft");
    await settle();
    await edit("shortcut draft");
    const content = host.querySelector<HTMLElement>(".cm-content")!;
    await act(async () => content.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true })));
    expect(bridge.saveText).toHaveBeenLastCalledWith("file-grant", "rev-2", "shortcut draft");
  });

  it("requires confirmation before Back and keeps the dirty state when discard is cancelled", async () => {
    vi.mocked(bridge.listDirectory).mockResolvedValue({ entries: [{ name: "hello.txt", kind: "file" }] });
    await render();
    await settle();
    await click('button[aria-label="hello.txt"]');
    await settle();
    await edit("draft");
    expect(dirtyChange).toHaveBeenLastCalledWith(true);
    const confirm = vi.fn(() => false);
    Object.defineProperty(window, "confirm", { configurable: true, value: confirm });
    await click("header button");
    expect(confirm).toHaveBeenCalledWith("Discard unsaved changes?");
    expect(host.querySelector(".cm-content")?.textContent).toContain("draft");
    expect(bridge.closeResource).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await click("header button");
    await settle();
    expect(host.querySelector(".cm-content")).toBeNull();
    expect(bridge.closeResource).toHaveBeenCalledWith("file-grant");
  });

  it("preserves edits made during a save and remains dirty after the saved snapshot completes", async () => {
    vi.mocked(bridge.listDirectory).mockResolvedValue({ entries: [{ name: "hello.txt", kind: "file" }] });
    let finishSave!: (result: { revision: string }) => void;
    vi.mocked(bridge.saveText).mockReturnValue(new Promise((resolve) => { finishSave = resolve; }));
    await render();
    await settle();
    await click('button[aria-label="hello.txt"]');
    await settle();
    await edit("first draft");
    await click("header button:last-child");
    expect(bridge.saveText).toHaveBeenCalledWith("file-grant", "rev-1", "first draft");
    await edit("newer draft");
    await act(async () => finishSave({ revision: "rev-2" }));
    expect(host.querySelector(".cm-content")?.textContent).toContain("newer draft");
    expect(host.textContent).toContain("Unsaved changes");
    expect(dirtyChange).toHaveBeenLastCalledWith(true);
  });

  it("keeps the latest draft after a save conflict and closes its child grant on unmount", async () => {
    vi.mocked(bridge.listDirectory).mockResolvedValue({ entries: [{ name: "hello.txt", kind: "file" }] });
    let rejectSave!: (error: Error) => void;
    vi.mocked(bridge.saveText).mockReturnValue(new Promise((_resolve, reject) => { rejectSave = reject; }));
    await render();
    await settle();
    await click('button[aria-label="hello.txt"]');
    await settle();
    await edit("submitted draft");
    await click("header button:last-child");
    await edit("latest pending draft");
    await act(async () => rejectSave(new Error("revision conflict")));
    expect(host.textContent).toContain("Conflict: revision conflict");
    expect(host.querySelector(".cm-content")?.textContent).toContain("latest pending draft");
    await act(async () => root.unmount());
    await settle();
    expect(bridge.closeResource).toHaveBeenCalledWith("file-grant");
    root = createRoot(host);
  });

  it("shows loading and a text-read error without losing the Back path", async () => {
    let finishListing!: (result: { entries: Array<{ name: string; kind: "file" }> }) => void;
    vi.mocked(bridge.listDirectory).mockReturnValue(new Promise((resolve) => { finishListing = resolve; }));
    vi.mocked(bridge.readText).mockRejectedValue(new Error("unsupported text"));
    await render();
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Loading…");
    await act(async () => finishListing({ entries: [{ name: "hello.txt", kind: "file" }] }));
    await click('button[aria-label="hello.txt"]');
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("unsupported text");
    expect(host.querySelector("header button")?.textContent).toBe("Back");
    await click("header button");
    await settle();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(bridge.closeResource).toHaveBeenCalledWith("file-grant");
  });

  it("renders read-only files without enabling edits or saves and reports bridge errors", async () => {
    const file: FileResource = { id: "read-grant", kind: "file", label: "locked.txt" };
    vi.mocked(bridge.readText).mockResolvedValue({ text: "read only", revision: "r1", readOnly: true });
    await render(file);
    await settle();
    expect(host.textContent).toContain("Read-only");
    expect(host.querySelector<HTMLElement>(".cm-content")?.getAttribute("contenteditable")).toBe("false");
    expect(host.querySelector<HTMLButtonElement>("button")?.textContent).toBe("Save");
    expect(host.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    expect(bridge.closeResource).not.toHaveBeenCalled();

    root.unmount();
    root = createRoot(host);
    bridge = { ...bridge, listDirectory: vi.fn(async () => { throw new Error("permission denied"); }) };
    await render();
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("permission denied");
  });
});
