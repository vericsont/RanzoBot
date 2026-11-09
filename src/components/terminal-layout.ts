// Tiling and drop-zone behavior adapted from Wave Terminal, Copyright 2025 Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// Modified for RanzoBot: immutable terminal-only layout and pixel-constrained geometry.

type Axis = "row" | "column";
export type Edge = "left" | "right" | "top" | "bottom";
export type DropZone = { edge: Edge | "center"; outer: boolean };
export type Tile = { id: string; weight: number } & (
  | { kind: "pane" }
  | { kind: "split"; axis: Axis; children: Tile[] }
);
export type Rect = { left: number; top: number; width: number; height: number };
export type Divider = { id: string; parent: string; index: number; axis: Axis; rect: Rect };
const GAP = 6;
const pane = (id: string): Tile => ({ id, kind: "pane", weight: 1 });
const group = (axis: Axis, children: Tile[]): Tile => children.length === 1 ? children[0]! : { id: crypto.randomUUID(), kind: "split", axis, children, weight: 1 };

export function leafIds(tree: Tile | null): string[] {
  return !tree ? [] : tree.kind === "pane" ? [tree.id] : tree.children.flatMap(leafIds);
}

export function gridLayout(keys: string[], columns: number): Tile | null {
  if (!keys.length) return null;
  const rows: Tile[] = [];
  columns = Math.max(1, Math.floor(columns));
  for (let index = 0; index < keys.length; index += columns) rows.push(group("row", keys.slice(index, index + columns).map(pane)));
  return group("column", rows);
}

function find(tree: Tile | null, id: string): Tile | undefined {
  if (!tree || tree.id === id) return tree ?? undefined;
  return tree.kind === "split" ? tree.children.map(child => find(child, id)).find(Boolean) : undefined;
}

function parentOf(tree: Tile | null, id: string): Extract<Tile, { kind: "split" }> | undefined {
  if (tree?.kind !== "split") return undefined;
  return tree.children.some(child => child.id === id) ? tree : tree.children.map(child => parentOf(child, id)).find(Boolean);
}

function normalize(tree: Tile): Tile | null {
  if (tree.kind === "pane") return tree;
  const children = tree.children.flatMap(child => {
    if (child.kind !== "split" || child.axis !== tree.axis) return [child];
    const total = child.children.reduce((sum, item) => sum + item.weight, 0);
    return child.children.map(item => ({ ...item, weight: child.weight * item.weight / total }));
  });
  if (!children.length) return null;
  if (children.length === 1) return { ...children[0]!, weight: tree.weight };
  return { ...tree, children };
}

function remove(tree: Tile | null, matches: (tile: Tile) => boolean): Tile | null {
  if (!tree || matches(tree)) return null;
  if (tree.kind === "pane") return tree;
  return normalize({ ...tree, children: tree.children.flatMap(child => { const next = remove(child, matches); return next ? [next] : []; }) });
}

export function removePane(tree: Tile | null, key: string): Tile | null {
  return remove(tree, tile => tile.id === key);
}

function insert(tree: Tile, target: string, incoming: Tile, edge: Edge): Tile {
  const axis = edge === "left" || edge === "right" ? "row" : "column";
  const before = edge === "left" || edge === "top";
  if (tree.kind === "split" && tree.axis === axis) {
    const index = tree.children.findIndex(child => child.id === target);
    if (index >= 0) {
      const children = [...tree.children];
      children.splice(index + (before ? 0 : 1), 0, { ...incoming, weight: children[index]!.weight });
      return { ...tree, children };
    }
  }
  if (tree.id === target) {
    const children = [{ ...tree, weight: 1 }, { ...incoming, weight: 1 }];
    return { ...group(axis, before ? children.reverse() : children), weight: tree.weight };
  }
  return tree.kind === "pane" ? tree : { ...tree, children: tree.children.map(child => insert(child, target, incoming, edge)) };
}

export function splitPane(tree: Tile | null, target: string, key: string, edge: Edge): Tile {
  return tree ? insert(tree, target, pane(key), edge) : pane(key);
}

export function movePane(tree: Tile | null, key: string, target: string, edge: DropZone["edge"], outer: boolean): Tile | null {
  if (!tree || key === target) return tree;
  const source = find(tree, key);
  if (!source || source.kind !== "pane" || !find(tree, target)) return tree;
  if (edge === "center") {
    const swap = (tile: Tile): Tile => tile.kind === "pane"
      ? { ...tile, id: tile.id === key ? target : tile.id === target ? key : tile.id }
      : { ...tile, children: tile.children.map(swap) };
    return swap(tree);
  }
  const parent = parentOf(tree, target);
  const axis = edge === "left" || edge === "right" ? "row" : "column";
  if (outer && parent && parent.axis !== axis) target = parent.id;
  return remove(insert(tree, target, pane(key), edge), tile => tile === source);
}

function minimum(tile: Tile): { width: number; height: number } {
  if (tile.kind === "pane") return { width: 240, height: 140 };
  const children = tile.children.map(minimum);
  return {
    width: tile.axis === "row" ? children.reduce((sum, child) => sum + child.width, GAP * (children.length - 1)) : Math.max(...children.map(child => child.width)),
    height: tile.axis === "column" ? children.reduce((sum, child) => sum + child.height, GAP * (children.length - 1)) : Math.max(...children.map(child => child.height)),
  };
}

function lengths(children: Tile[], total: number, dimension: "width" | "height"): number[] {
  const result = children.map(() => 0);
  const pending = new Set(children.map((_, index) => index));
  while (pending.size) {
    const weight = [...pending].reduce((sum, index) => sum + children[index]!.weight, 0);
    const constrained = [...pending].filter(index => total * children[index]!.weight / weight < minimum(children[index]!)[dimension]);
    if (!constrained.length) {
      for (const index of pending) result[index] = total * children[index]!.weight / weight;
      break;
    }
    for (const index of constrained) {
      result[index] = minimum(children[index]!)[dimension];
      total -= result[index]!;
      pending.delete(index);
    }
  }
  return result;
}

export function measureLayout(tree: Tile | null, width: number, height: number) {
  const panes = new Map<string, Rect>();
  const rects = new Map<string, Rect>();
  const dividers: Divider[] = [];
  const min = tree ? minimum(tree) : { width: 0, height: 0 };
  width = Math.max(width, min.width);
  height = Math.max(height, min.height);
  const visit = (tile: Tile, rect: Rect) => {
    rects.set(tile.id, rect);
    if (tile.kind === "pane") { panes.set(tile.id, rect); return; }
    const row = tile.axis === "row";
    const sizes = lengths(tile.children, (row ? rect.width : rect.height) - GAP * (tile.children.length - 1), row ? "width" : "height");
    let offset = 0;
    tile.children.forEach((child, index) => {
      visit(child, { left: rect.left + (row ? offset : 0), top: rect.top + (row ? 0 : offset), width: row ? sizes[index]! : rect.width, height: row ? rect.height : sizes[index]! });
      offset += sizes[index]!;
      if (index < tile.children.length - 1) {
        dividers.push({ id: `${tile.id}:${index}`, parent: tile.id, index, axis: tile.axis, rect: { left: rect.left + (row ? offset : 0), top: rect.top + (row ? 0 : offset), width: row ? GAP : rect.width, height: row ? rect.height : GAP } });
        offset += GAP;
      }
    });
  };
  if (tree) visit(tree, { left: 0, top: 0, width, height });
  return { width, height, panes, rects, dividers };
}

export function resizeDivider(tree: Tile | null, divider: Divider, delta: number, rects: Map<string, Rect>): Tile | null {
  if (!tree || tree.kind === "pane") return tree;
  if (tree.id !== divider.parent) return { ...tree, children: tree.children.map(child => resizeDivider(child, divider, delta, rects)!) };
  const dimension = tree.axis === "row" ? "width" : "height";
  const weights = tree.children.map(child => rects.get(child.id)![dimension]);
  const first = divider.index;
  const second = first + 1;
  delta = Math.max(minimum(tree.children[first]!)[dimension] - weights[first]!, Math.min(weights[second]! - minimum(tree.children[second]!)[dimension], delta));
  weights[first]! += delta;
  weights[second]! -= delta;
  return { ...tree, children: tree.children.map((child, index) => ({ ...child, weight: weights[index]! })) };
}

export function dropZone(rect: Rect, x: number, y: number): DropZone | null {
  x = (x - rect.left) / rect.width;
  y = (y - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  if (x > 0.4 && x < 0.6 && y > 0.4 && y < 0.6) return { edge: "center", outer: false };
  if (x === y || x + y === 1) return null;
  const edge = y < x ? (x + y < 1 ? "top" : "right") : (x + y < 1 ? "left" : "bottom");
  return { edge, outer: x < 0.2 || x > 0.8 || y < 0.2 || y > 0.8 };
}
