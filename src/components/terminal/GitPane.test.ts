// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitPane, gitGraphRows, type GitBridge } from "./GitPane";

type Commit = Awaited<ReturnType<GitBridge["gitCommit"]>>;
type HistoryPage = Awaited<ReturnType<GitBridge["gitHistory"]>>;

const firstCommit: Commit = {
  hash: "abc123456789", parents: [], author: "Ada", date: "2025-01-02", subject: "Add first file", body: "Plain commit body",
  files: [{ path: "hello.txt", status: "A" }, { path: "next.txt", status: "M" }],
};
const mergeCommit: Commit = {
  hash: "merge123456", parents: ["parent-a", "parent-b"], author: "Lin", date: "2025-02-03", subject: "Merge work", body: "",
  files: [{ path: "merge.txt", status: "M" }],
};
const history: HistoryPage = {
  commits: [
    { hash: firstCommit.hash, parents: [], author: "Ada", date: "2025-01-02", subject: firstCommit.subject, refs: ["HEAD -> main", "tag: v1"] },
    { hash: mergeCommit.hash, parents: mergeCommit.parents, author: "Lin", date: "2025-02-03", subject: mergeCommit.subject, refs: ["feature"] },
  ],
  nextCursor: null,
};

let host: HTMLDivElement;
let root: Root;
let bridge: GitBridge;
const render = async (resourceId = "repo-1") => {
  await act(async () => root.render(createElement(GitPane, { resourceId, bridge })));
  await settle();
};
const settle = async () => {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
};
const clickCommit = async (subject: string) => {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.includes(subject));
  if (!button) throw new Error(`Missing commit button: ${subject}`);
  await act(async () => button.click());
  await settle();
};
const select = async (label: string, value: string) => {
  const element = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  if (!element) throw new Error(`Missing select: ${label}`);
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  bridge = {
    gitHistory: vi.fn(async () => history),
    gitCommit: vi.fn(async (_id: string, hash: string) => hash === mergeCommit.hash ? mergeCommit : firstCommit),
    gitDiff: vi.fn(async (_id: string, _hash: string, _parent: string | undefined, path: string) => ({ text: `diff for ${path}\n+line`, truncated: false })),
  };
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("GitPane", () => {
  it("draws merge parent lanes and reconnects shared history", () => {
    const commit = (hash: string, parents: string[]) => ({ hash, parents, author: "", date: "", subject: "", refs: [] });
    const rows = gitGraphRows([commit("merge", ["left", "right"]), commit("left", ["base"]), commit("right", ["base"]), commit("base", [])]);
    expect(rows[0]!.parents).toHaveLength(2);
    expect(rows[1]!.incoming).toBe(2);
    expect(rows[2]!.parents).toHaveLength(1);
    expect(rows[3]!.width).toBeGreaterThan(0);
  });

  it("loads refs, selects commits and renders changed files and text diffs", async () => {
    await render();
    expect(bridge.gitHistory).toHaveBeenCalledWith("repo-1", undefined);
    expect(host.textContent).toContain("HEAD -> main");
    expect(host.textContent).toContain("tag: v1");
    await clickCommit("Add first file");
    expect(bridge.gitCommit).toHaveBeenCalledWith("repo-1", firstCommit.hash);
    expect(host.textContent).toContain("Plain commit body");
    expect(host.textContent).toContain("diff for hello.txt");
    expect(host.querySelector('select[aria-label="Changed file"]')).not.toBeNull();
    await select("Changed file", "1");
    expect(bridge.gitDiff).toHaveBeenLastCalledWith("repo-1", firstCommit.hash, undefined, "next.txt");
    expect(host.textContent).toContain("diff for next.txt");
  });

  it("compares merge commits against a chosen parent and handles root commits", async () => {
    await render();
    await clickCommit("Merge work");
    expect(bridge.gitDiff).toHaveBeenLastCalledWith("repo-1", mergeCommit.hash, "parent-a", "merge.txt");
    await select("Compare with parent", "parent-b");
    expect(bridge.gitCommit).toHaveBeenLastCalledWith("repo-1", mergeCommit.hash, "parent-b");
    expect(bridge.gitDiff).toHaveBeenLastCalledWith("repo-1", mergeCommit.hash, "parent-b", "merge.txt");
    await clickCommit("Add first file");
    expect(bridge.gitDiff).toHaveBeenLastCalledWith("repo-1", firstCommit.hash, undefined, "hello.txt");
  });

  it("loads more history and refreshes without changing the selected commit", async () => {
    bridge.gitHistory = vi.fn()
      .mockResolvedValueOnce({ commits: [history.commits[0]!], nextCursor: "page-2" })
      .mockResolvedValueOnce({ commits: [history.commits[1]!], nextCursor: null })
      .mockResolvedValueOnce({ commits: [history.commits[0]!], nextCursor: "page-2" });
    await render();
    await clickCommit("Add first file");
    const more = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("Load more"))!;
    await act(async () => more.click());
    await settle();
    expect(bridge.gitHistory).toHaveBeenLastCalledWith("repo-1", "page-2");
    expect(host.textContent).toContain("Merge work");
    const refresh = host.querySelector<HTMLButtonElement>('button[aria-label="Refresh history"]')!;
    await act(async () => refresh.click());
    await settle();
    const selected = [...host.querySelectorAll<HTMLButtonElement>('button[aria-pressed="true"]')];
    expect(selected).toHaveLength(1);
    expect(selected[0]?.textContent).toContain("Add first file");
    expect(bridge.gitHistory).toHaveBeenLastCalledWith("repo-1", undefined);
  });

  it("ignores an older history response after refresh", async () => {
    const oldPage = deferred<HistoryPage>();
    const freshPage = deferred<HistoryPage>();
    bridge.gitHistory = vi.fn().mockReturnValueOnce(oldPage.promise).mockReturnValueOnce(freshPage.promise);
    await render();
    const refresh = host.querySelector<HTMLButtonElement>('button[aria-label="Refresh history"]')!;
    await act(async () => refresh.click());
    await act(async () => freshPage.resolve({ commits: [{ ...history.commits[0]!, hash: "fresh", subject: "Fresh history" }], nextCursor: null }));
    await settle();
    await act(async () => oldPage.resolve(history));
    await settle();
    expect(host.textContent).toContain("Fresh history");
    expect(host.textContent).not.toContain("Merge work");
  });

  it("reports empty history and bridge errors", async () => {
    bridge.gitHistory = vi.fn().mockResolvedValue({ commits: [], nextCursor: null });
    await render();
    expect(host.textContent).toContain("No commits found.");
    await act(async () => root.render(createElement(GitPane, { resourceId: "broken", bridge: { ...bridge, gitHistory: vi.fn().mockRejectedValue(new Error("unavailable")) } })));
    await settle();
    expect(host.textContent).toContain("Could not load history: unavailable");
  });

  it("keeps only the newest commit response and selected-file diff", async () => {
    const oldCommit = deferred<Commit>();
    const latestCommit = deferred<Commit>();
    bridge.gitCommit = vi.fn((_id, hash) => hash === firstCommit.hash ? oldCommit.promise : latestCommit.promise);
    await render();
    await clickCommit("Add first file");
    const mergeButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.includes("Merge work"))!;
    await act(async () => mergeButton.click());
    await act(async () => latestCommit.resolve(mergeCommit));
    await settle();
    await act(async () => oldCommit.resolve(firstCommit));
    await settle();
    expect(host.textContent).toContain("Merge work");
    expect(host.textContent).not.toContain("Plain commit body");

    const oldDiff = deferred<{ text: string; truncated: boolean }>();
    bridge.gitCommit = vi.fn(async () => firstCommit);
    bridge.gitDiff = vi.fn((_id, _hash, _parent, path) => path === "hello.txt" ? oldDiff.promise : Promise.resolve({ text: "new file diff", truncated: false }));
    await clickCommit("Add first file");
    await select("Changed file", "1");
    await settle();
    await act(async () => oldDiff.resolve({ text: "stale diff", truncated: false }));
    await settle();
    expect(host.textContent).toContain("new file diff");
    expect(host.textContent).not.toContain("stale diff");
  });

  it("identifies binary changes and visibly bounds truncated or oversized text", async () => {
    const withBinary: Commit = { ...firstCommit, files: [
      { path: "image.bin", status: "Binary" },
      { path: "large.txt", status: "M" },
      { path: "clipped.txt", status: "M" },
    ] };
    bridge.gitCommit = vi.fn(async () => withBinary);
    bridge.gitDiff = vi.fn(async (_id, _hash, _parent, path) => path === "large.txt"
      ? { text: "x".repeat(110_000), truncated: false }
      : path === "clipped.txt" ? { text: "partial diff", truncated: true }
        : { text: "Binary files old and new differ", truncated: false });
    await render();
    await clickCommit("Add first file");
    expect(host.textContent).toContain("Binary file change; no text diff is available.");
    await select("Changed file", "1");
    expect(host.textContent).toContain("Diff output truncated");
    expect(host.querySelector("pre")?.textContent).toHaveLength(100_000);
    await select("Changed file", "2");
    expect(host.textContent).toContain("partial diff");
    expect(host.textContent).toContain("Diff output truncated");
  });
});
