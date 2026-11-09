import { describe, expect, it } from "vitest";
import { dropZone, gridLayout, leafIds, measureLayout, movePane, removePane, resizeDivider, splitPane } from "./terminal-layout";

const keys = Array.from({ length: 9 }, (_, index) => String(index + 1));

describe("terminal tiling", () => {
  it.each([[1, 1], [1, 2], [2, 1], [2, 2], [3, 3]])("lays out %i rows by %i columns", (rows, columns) => {
    const ids = keys.slice(0, rows * columns);
    const tree = gridLayout(ids, columns);
    const { panes, dividers } = measureLayout(tree, 1200, 900);
    expect(leafIds(tree)).toEqual(ids);
    expect(new Set([...panes.values()].map(rect => rect.top)).size).toBe(rows);
    expect(new Set([...panes.values()].map(rect => rect.left)).size).toBe(columns);
    expect(dividers).toHaveLength(ids.length - 1);
  });

  it("nests splits on either axis and collapses empty groups on close", () => {
    let tree = gridLayout(["1"], 1);
    tree = splitPane(tree, "1", "2", "right");
    tree = splitPane(tree, "1", "3", "bottom");
    const { panes } = measureLayout(tree, 1000, 800);
    expect(panes.get("2")!.height).toBe(800);
    expect(panes.get("1")!.left).toBe(panes.get("3")!.left);
    expect(panes.get("3")!.top).toBeGreaterThan(panes.get("1")!.top);
    tree = removePane(tree, "3");
    expect(measureLayout(tree, 1000, 800).panes.get("1")!.height).toBe(800);
    tree = removePane(removePane(tree, "2"), "1");
    expect(tree).toBeNull();
  });

  it.each(["left", "right", "top", "bottom"] as const)("moves panes to the %s without duplicates", edge => {
    const original = gridLayout(keys, 3);
    const moved = movePane(original, "9", "1", edge, false);
    expect(leafIds(moved).sort()).toEqual(keys);
    expect(leafIds(original)).toEqual(keys);
    const { panes } = measureLayout(moved, 1500, 1100);
    const a = panes.get("9")!;
    const b = panes.get("1")!;
    if (edge === "left") expect(a.left + a.width).toBeLessThanOrEqual(b.left);
    if (edge === "right") expect(a.left).toBeGreaterThanOrEqual(b.left + b.width);
    if (edge === "top") expect(a.top + a.height).toBeLessThanOrEqual(b.top);
    if (edge === "bottom") expect(a.top).toBeGreaterThanOrEqual(b.top + b.height);
  });

  it("swaps center drops and docks outer drops beside the target group", () => {
    const original = gridLayout(keys.slice(0, 4), 2);
    const swapped = movePane(original, "4", "1", "center", false);
    expect(leafIds(swapped)).toEqual(["4", "2", "3", "1"]);
    const outer = movePane(original, "4", "1", "top", true);
    const { panes } = measureLayout(outer, 1000, 800);
    expect(panes.get("4")!.width).toBe(1000);
    expect(panes.get("4")!.top).toBeLessThan(panes.get("1")!.top);
    expect(movePane(original, "1", "1", "center", false)).toBe(original);
    expect(movePane(original, "missing", "1", "left", false)).toBe(original);
    expect(movePane(original, "1", "missing", "left", false)).toBe(original);
  });

  it("preserves valid geometry through repeated cross-group moves and removals", () => {
    let tree = gridLayout(keys, 3);
    for (let index = 0; index < 60; index++) {
      tree = movePane(tree, keys[index % 9]!, keys[(index + 4) % 9]!, (["left", "top", "right", "bottom", "center"] as const)[index % 5]!, index % 2 === 0);
      const measured = measureLayout(tree, 1200, 900);
      expect(leafIds(tree).sort()).toEqual(keys);
      const rects = [...measured.panes.values()];
      for (const rect of rects) {
        expect(rect.width).toBeGreaterThanOrEqual(239.99);
        expect(rect.height).toBeGreaterThanOrEqual(139.99);
      }
      for (let a = 0; a < rects.length; a++) for (let b = a + 1; b < rects.length; b++) {
        const one = rects[a]!; const two = rects[b]!;
        const overlapX = Math.min(one.left + one.width, two.left + two.width) - Math.max(one.left, two.left);
        const overlapY = Math.min(one.top + one.height, two.top + two.height) - Math.max(one.top, two.top);
        expect(overlapX <= 0 || overlapY <= 0).toBe(true);
      }
    }
    for (const key of keys) tree = removePane(tree, key);
    expect(tree).toBeNull();
  });

  it.each([1, 2])("resizes axis %i, clamps to subtree minima, and leaves other panes alone", columns => {
    const tree = gridLayout(["1", "2", "3"], columns === 1 ? 1 : 3);
    const measured = measureLayout(tree, 1200, 900);
    const divider = measured.dividers[0]!;
    const next = resizeDivider(tree, divider, 40, measured.rects);
    const resized = measureLayout(next, 1200, 900);
    const dimension = columns === 1 ? "height" : "width";
    expect(resized.panes.get("1")![dimension]).toBeCloseTo(measured.panes.get("1")![dimension] + 40);
    expect(resized.panes.get("3")).toEqual(measured.panes.get("3"));
    const clamped = measureLayout(resizeDivider(tree, divider, 10000, measured.rects), 1200, 900);
    expect(clamped.panes.get("2")![dimension]).toBeCloseTo(columns === 1 ? 140 : 240);
  });

  it("uses Wave's center, triangular side, and outer-edge drop zones", () => {
    const rect = { left: 100, top: 100, width: 500, height: 500 };
    expect(dropZone(rect, 350, 350)).toEqual({ edge: "center", outer: false });
    expect(dropZone(rect, 250, 350)).toEqual({ edge: "left", outer: false });
    expect(dropZone(rect, 110, 350)).toEqual({ edge: "left", outer: true });
    expect(dropZone(rect, 350, 590)).toEqual({ edge: "bottom", outer: true });
    expect(dropZone(rect, 350, 250)).toEqual({ edge: "top", outer: false });
    expect(dropZone(rect, 450, 350)).toEqual({ edge: "right", outer: false });
    expect(dropZone(rect, 50, 350)).toBeNull();
  });
});
