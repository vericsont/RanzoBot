import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Columns2, Eraser, GripVertical, Maximize2, Minimize2, Plus, Rows2, SquareTerminal, X } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useColorScheme } from "@/lib/color-scheme";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { registerTerminalDraftGuard } from "@/lib/terminal-draft-guard";
import { FilePane, type FileBridge, type FileResource } from "./terminal/FilePane";
import { GitPane, type GitBridge } from "./terminal/GitPane";

import { dropZone, gridLayout, leafIds, measureLayout, movePane, removePane, resizeDivider, splitPane, type Divider, type DropZone, type Edge, type Rect, type Tile } from "./terminal-layout";

const MAX_SESSIONS = 16;
const GRID_PRESETS = [[1, 2], [2, 1], [2, 2], [2, 3], [3, 2], [3, 3], [4, 4]] as const;
const paneButton = "flex size-7 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

export type HostTerminalBridge = {
  start(input: { cols: number; rows: number }): Promise<{ id: string }>;
  attach(id: string): Promise<void>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  close(id: string): Promise<void>;
  restoreState(): Promise<unknown>;
  saveState(state: unknown): Promise<unknown>;
  setDirty?(dirty: boolean): void;
  onData(callback: (id: string, data: string) => Promise<void>): () => void;
  onExit(callback: (id: string, code: number) => void): () => void;
  onOpen?(callback: (request: { requestId: string; sessionId: string; resource: FileResource | { id: string; kind: "git"; label: string } }) => boolean): () => void;
} & FileBridge & GitBridge;

type Runtime = {
  key: string;
  terminal: Terminal;
  fit: FitAddon;
  id?: string;
  attached: boolean;
  attaching: boolean;
  started: boolean;
  closing: boolean;
  disposed: boolean;
  outputWaiters: Set<() => void>;
  exitCode?: number;
  lastSize: string;
  writeQueue: Promise<void>;
  resizeQueue: Promise<void>;
};

type Session = {
  key: string;
  name: string;
  transcript?: string;
  id?: string;
  status: "starting" | "ready" | "exited" | "error" | "closing";
  exitCode?: number;
};

type ResourcePane = { key: string; resource: FileResource | { id: string; kind: "git"; label: string } };
type Dimensions = { cols: number; rows: number };

function terminalBridge(): HostTerminalBridge | null {
  if (typeof window === "undefined" || !window.ogb || window.ogb.remoteClient?.active) return null;
  return (window.ogb as typeof window.ogb & { hostTerminal?: HostTerminalBridge }).hostTerminal ?? null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function savedTranscript(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let index = Math.max(0, buffer.length - 5000); index < buffer.length; index++) lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  return lines.join("\\r\\n").slice(-128 * 1024);
}

function terminalTheme(colorScheme: "light" | "dark") {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const dark = colorScheme === "dark";
  return {
    background: token("--color-app", dark ? "#121212" : "#f5f1eb"),
    foreground: token("--color-ink", dark ? "#f5f5f5" : "#24292f"),
    cursor: token("--color-accent", "#1084fe"),
    cursorAccent: token("--color-app", dark ? "#121212" : "#f5f1eb"),
    selectionBackground: dark ? "#477db566" : "#477db544",
    black: dark ? "#202020" : "#24292f",
    red: dark ? "#ff7b72" : "#cf222e",
    green: dark ? "#3fb950" : "#1a7f37",
    yellow: dark ? "#d29922" : "#9a6700",
    blue: dark ? "#58a6ff" : "#0969da",
    magenta: dark ? "#bc8cff" : "#8250df",
    cyan: dark ? "#39c5cf" : "#1b7c83",
    white: dark ? "#d1d7e0" : "#6e7781",
    brightBlack: dark ? "#6e7781" : "#57606a",
    brightRed: dark ? "#ffa198" : "#a40e26",
    brightGreen: dark ? "#56d364" : "#116329",
    brightYellow: dark ? "#e3b341" : "#7d4e00",
    brightBlue: dark ? "#79c0ff" : "#0550ae",
    brightMagenta: dark ? "#d2a8ff" : "#6639ba",
    brightCyan: dark ? "#56d4dd" : "#0a6268",
    brightWhite: dark ? "#f0f6fc" : "#24292f",
  };
}

function TerminalSurface({
  sessionKey,
  visible,
  colorScheme,
  onReady,
  onInput,
  onResize,
}: {
  sessionKey: string;
  visible: boolean;
  colorScheme: "light" | "dark";
  onReady: (key: string, runtime: Runtime) => void;
  onInput: (key: string, runtime: Runtime, data: string) => void;
  onResize: (key: string, runtime: Runtime, dimensions: Dimensions) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const generation = useRef(0);
  const visibleRef = useRef(visible);
  const callbacks = useRef({ onReady, onInput, onResize });
  visibleRef.current = visible;
  callbacks.current = { onReady, onInput, onResize };

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const currentGeneration = ++generation.current;
    let runtime = runtimeRef.current;
    if (!runtime) {
      const terminal = new Terminal({
        cursorBlink: true,
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "ui-monospace, monospace",
        fontSize: 13,
        scrollback: 5000,
        screenReaderMode: true,
        theme: terminalTheme(colorScheme),
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(element);
      runtime = {
        key: sessionKey,
        terminal,
        fit,
        attached: false,
        attaching: false,
        started: false,
        closing: false,
        disposed: false,
        outputWaiters: new Set(),
        lastSize: "",
        writeQueue: Promise.resolve(),
        resizeQueue: Promise.resolve(),
      };
      runtimeRef.current = runtime;
    }
    const { terminal, fit } = runtime;
    const input = terminal.onData((data) => callbacks.current.onInput(sessionKey, runtime, data));
    const fitToHost = () => {
      if (!visibleRef.current || !element.clientWidth || !element.clientHeight) return;
      try {
        fit.fit();
        callbacks.current.onResize(sessionKey, runtime, { cols: terminal.cols, rows: terminal.rows });
      } catch {
        return;
      }
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fitToHost);
    observer?.observe(element);
    fitToHost();
    let mounted = true;
    queueMicrotask(() => {
      if (mounted && !runtime.started) {
        runtime.started = true;
        callbacks.current.onReady(sessionKey, runtime);
      }
    });

    return () => {
      mounted = false;
      observer?.disconnect();
      input.dispose();
      queueMicrotask(() => {
        if (generation.current !== currentGeneration) return;
        runtime.disposed = true;
        for (const finish of runtime.outputWaiters) finish();
        runtime.outputWaiters.clear();
        terminal.dispose();
        runtimeRef.current = null;
      });
    };
  }, [sessionKey]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.terminal.options.theme = terminalTheme(colorScheme);
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      const element = host.current;
      if (!element?.clientWidth || !element.clientHeight) return;
      try {
        runtime.fit.fit();
        callbacks.current.onResize(sessionKey, runtime, { cols: runtime.terminal.cols, rows: runtime.terminal.rows });
      } catch {
        return;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [colorScheme, sessionKey, visible]);

  return <div ref={host} className="terminal-surface h-full min-h-0 w-full overflow-hidden" data-terminal-surface={sessionKey} />;
}

export function TerminalPage({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  const bridge = terminalBridge();
  const colorScheme = useColorScheme();
  const [sessions, setSessions] = useState<Session[]>([]);
  const sessionsRef = useRef<Session[]>([]);
  const [resources, setResources] = useState<ResourcePane[]>([]);
  const resourcesRef = useRef<ResourcePane[]>([]);
  const dirtyPanes = useRef(new Set<string>());
  const dirtyCallback = useRef(onDirtyChange);
  dirtyCallback.current = onDirtyChange;
  const [activeKey, setActiveKey] = useState("");
  const activeKeyRef = useRef("");
  const [layout, setLayout] = useState<Tile | null>(null);
  const layoutRef = useRef<Tile | null>(null);
  const [zoomed, setZoomed] = useState<string | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const paneDrag = useRef<{ key: string; x: number; y: number; moved: boolean } | null>(null);
  const ignoreDragClick = useRef(false);
  const [dropTarget, setDropTarget] = useState<({ source: string; key: string } & DropZone) | null>(null);
  const dropTargetRef = useRef<typeof dropTarget>(null);
  const resizeDrag = useRef<{ x: number; y: number; tree: Tile | null; divider: Divider; rects: Map<string, Rect> } | null>(null);
  const [error, setError] = useState("");
  const [listenersReady, setListenersReady] = useState(false);
  const [stateRestored, setStateRestored] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoomedRef = useRef<string | null>(null);
  const sessionNumber = useRef(0);
  const lifecycle = useRef(0);
  const liveKeys = useRef(new Set<string>());
  const runtimes = useRef(new Map<string, Runtime>());
  const runtimesById = useRef(new Map<string, Runtime>());

  const scheduleSaveRef = useRef<() => void>(() => {});
  const saveStateRef = useRef<() => Promise<void>>(async () => {});
  const stateRestoredRef = useRef(false);
  stateRestoredRef.current = stateRestored;
  const commitLayout = useCallback((next: Tile | null) => {
    layoutRef.current = next;
    setLayout(next);
    scheduleSaveRef.current();
  }, []);

  const paneCount = sessions.length + resources.length;
  const empty = paneCount === 0;
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setViewportSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [empty]);

  const commitSessions = useCallback((next: Session[]) => {
    sessionsRef.current = next;
    setSessions(next);
    scheduleSaveRef.current();
  }, []);

  const commitResources = useCallback((next: ResourcePane[]) => {
    resourcesRef.current = next;
    setResources(next);
  }, []);

  const updateSession = useCallback((key: string, patch: Partial<Session>) => {
    commitSessions(sessionsRef.current.map((session) => session.key === key ? { ...session, ...patch } : session));
  }, [commitSessions]);

  const selectSession = useCallback((key: string) => {
    activeKeyRef.current = key;
    setActiveKey(key);
  }, []);

  const setFailure = useCallback((error: unknown) => {
    setError(errorMessage(error));
  }, []);

  const saveState = useCallback(async () => {
    if (!bridge || !stateRestored) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    try {
      let savedLayout = layoutRef.current;
      for (const pane of resourcesRef.current) savedLayout = removePane(savedLayout, pane.key);
      const savedKeys = new Set(sessionsRef.current.map(session => session.key));
      await bridge.saveState({
        version: 1,
        sessions: sessionsRef.current.map(({ key, name, transcript }) => ({
          key, name, transcript: runtimes.current.has(key) ? savedTranscript(runtimes.current.get(key)!.terminal) : transcript ?? "",
        })),
        layout: savedLayout,
        activeKey: savedKeys.has(activeKeyRef.current) ? activeKeyRef.current : sessionsRef.current[0]?.key ?? null,
        zoomed: zoomedRef.current && savedKeys.has(zoomedRef.current) ? zoomedRef.current : null,
      });
    } catch (cause) { setFailure(cause); }
  }, [bridge, setFailure, stateRestored]);
  const scheduleSave = useCallback(() => {
    if (!bridge || !stateRestoredRef.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void saveStateRef.current(); }, 250);
  }, [bridge]);
  scheduleSaveRef.current = scheduleSave;
  saveStateRef.current = saveState;

  useEffect(() => {
    if (!bridge) return;
    const token = ++lifecycle.current;
    const offData = bridge.onData(async (id, data) => {
      if (lifecycle.current !== token) return;
      const runtime = runtimesById.current.get(id);
      if (!runtime?.attached || runtime.closing || runtime.disposed) return;
      await new Promise<void>((resolve) => {
        let pending = true;
        const finish = () => {
          if (!pending) return;
          pending = false;
          runtime.outputWaiters.delete(finish);
          resolve();
        };
        runtime.outputWaiters.add(finish);
        try {
          runtime.terminal.write(data, finish);
        } catch {
          finish();
        }
      });
      scheduleSaveRef.current();
    });
    const offExit = bridge.onExit((id, code) => {
      if (lifecycle.current !== token) return;
      const runtime = runtimesById.current.get(id);
      if (!runtime || runtime.closing) return;
      runtime.attached = false;
      runtime.attaching = false;
      runtime.exitCode = code;
      updateSession(runtime.key, { status: "exited", exitCode: code });
      scheduleSaveRef.current();
    });
    const offOpen = bridge.onOpen?.(({ sessionId, resource }) => {
      const source = runtimesById.current.get(sessionId);
      if (lifecycle.current !== token || !source?.attached || source.closing || !liveKeys.current.has(source.key) ||
          !stateRestoredRef.current || sessionsRef.current.length + resourcesRef.current.length >= MAX_SESSIONS) return false;
      const key = crypto.randomUUID();
      commitResources([...resourcesRef.current, { key, resource }]);
      commitLayout(splitPane(layoutRef.current, source.key, key, "right"));
      selectSession(key);
      zoomedRef.current = null;
      setZoomed(null);
      return true;
    });
    setListenersReady(true);
    let mounted = true;
    void bridge.restoreState().then(saved => {
      if (!mounted || lifecycle.current !== token) return;
      const restored = saved as { sessions?: Session[]; layout?: Tile | null; activeKey?: string | null; zoomed?: string | null };
      const restoredSessions = Array.isArray(restored?.sessions)
        ? restored.sessions.slice(0, MAX_SESSIONS).filter(session => session && typeof session.key === "string" && typeof session.name === "string" && typeof session.transcript === "string").map(session => ({ ...session, status: "starting" as const }))
        : [];
      sessionsRef.current = restoredSessions;
      setSessions(restoredSessions);
      restoredSessions.forEach(session => liveKeys.current.add(session.key));
      const keys = new Set(restoredSessions.map(session => session.key));
      const candidate = restored?.layout;
      const candidateKeys = candidate ? leafIds(candidate) : [];
      const restoredLayout = candidate && candidateKeys.length === keys.size && candidateKeys.every(key => keys.has(key))
        ? candidate
        : gridLayout(restoredSessions.map(session => session.key), Math.ceil(Math.sqrt(restoredSessions.length)));
      layoutRef.current = restoredLayout;
      setLayout(restoredLayout);
      const active = restoredSessions.find(session => session.key === restored?.activeKey)?.key ?? restoredSessions[0]?.key ?? "";
      activeKeyRef.current = active;
      setActiveKey(active);
      const zoom = restoredSessions.some(session => session.key === restored?.zoomed) ? restored!.zoomed! : null;
      zoomedRef.current = zoom;
      setZoomed(zoom);
      sessionNumber.current = restoredSessions.reduce((max, session) => Math.max(max, Number(session.name.match(/(\d+)$/)?.[1] ?? 0)), 0);
      setStateRestored(true);
    }).catch(cause => {
      if (!mounted || lifecycle.current !== token) return;
      setFailure(cause);
      setStateRestored(true);
    });

    return () => {
      mounted = false;
      if (stateRestoredRef.current) void saveStateRef.current();
      if (saveTimer.current) clearTimeout(saveTimer.current);
      lifecycle.current += 1;
      setListenersReady(false);
      offData();
      offExit();
      offOpen?.();
      for (const pane of resourcesRef.current) void bridge.closeResource(pane.resource.id).catch(() => {});
      resourcesRef.current = [];
      dirtyPanes.current.clear();
      bridge.setDirty?.(false);
      dirtyCallback.current?.(false);
      const open = [...runtimesById.current.entries()];
      runtimesById.current.clear();
      runtimes.current.clear();
      for (const [id, runtime] of open) {
        runtime.attached = false;
        runtime.attaching = false;
        runtime.closing = true;
        void runtime.writeQueue.catch(() => {}).then(() => bridge.close(id)).catch(() => {});
      }
      liveKeys.current.clear();
    };
  }, [bridge, commitLayout, commitResources, selectSession, updateSession]);

  useEffect(() => {
    let mounted = true;
    const unregister = registerTerminalDraftGuard(() => {
      if (!dirtyPanes.current.size) return true;
      if (!window.confirm(t("terminal.unsavedConfirm"))) return false;
      dirtyCallback.current?.(false);
      setTimeout(() => { if (mounted && dirtyPanes.current.size) dirtyCallback.current?.(true); }, 0);
      return true;
    });
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyPanes.current.size) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => { mounted = false; unregister(); window.removeEventListener("beforeunload", beforeUnload); };
  }, [bridge]);

  const isLive = useCallback((key: string, token: number) =>
    lifecycle.current === token && liveKeys.current.has(key), []);

  const startSession = useCallback(async (key: string, runtime: Runtime) => {
    if (!bridge) return;
    const token = lifecycle.current;
    try {
      const result = await bridge.start({ cols: runtime.terminal.cols || 80, rows: runtime.terminal.rows || 24 });
      const id = typeof result?.id === "string" ? result.id : "";
      if (!id) throw new Error(t("terminal.error.noSessionId"));
      runtime.id = id;
      runtimesById.current.set(id, runtime);
      updateSession(key, { id });
      if (!isLive(key, token)) {
        runtimesById.current.delete(id);
        runtime.id = undefined;
        if (!runtime.closing) await bridge.close(id).catch(() => {});
        return;
      }
      runtime.attached = true;
      runtime.attaching = true;
      await bridge.attach(id);
      if (!isLive(key, token) || runtime.closing) {
        runtimesById.current.delete(id);
        runtime.id = undefined;
        runtime.attached = false;
        runtime.attaching = false;
        if (!runtime.closing) await bridge.close(id).catch(() => {});
        return;
      }
      runtime.attaching = false;
      if (runtime.exitCode !== undefined) {
        runtime.attached = false;
        updateSession(key, { status: "exited", exitCode: runtime.exitCode });
        return;
      }
      await bridge.resize(id, runtime.terminal.cols, runtime.terminal.rows);
      runtime.lastSize = `${runtime.terminal.cols}x${runtime.terminal.rows}`;
      if (!isLive(key, token) || runtime.closing) {
        runtimesById.current.delete(id);
        runtime.id = undefined;
        runtime.attached = false;
        if (!runtime.closing) await bridge.close(id).catch(() => {});
        return;
      }
      if (runtime.exitCode !== undefined) {
        runtime.attached = false;
        updateSession(key, { status: "exited", exitCode: runtime.exitCode });
        return;
      }
      updateSession(key, { status: "ready" });
      if (activeKeyRef.current === key) runtime.terminal.focus();
    } catch (cause) {
      runtime.attached = false;
      runtime.attaching = false;
      if (runtime.closing) return;
      if (runtime.exitCode !== undefined) {
        updateSession(key, { status: "exited", exitCode: runtime.exitCode });
        return;
      }
      const id = runtime.id;
      if (id) {
        runtimesById.current.delete(id);
        runtime.id = undefined;
        await bridge.close(id).catch(() => {});
      }
      if (isLive(key, token)) updateSession(key, { status: "error" });
      if (lifecycle.current === token) setFailure(cause);
    }
  }, [bridge, isLive, setFailure, updateSession]);

  const handleReady = useCallback((key: string, runtime: Runtime) => {
    if (!liveKeys.current.has(key)) return;
    runtimes.current.set(key, runtime);
    const transcript = sessionsRef.current.find(session => session.key === key)?.transcript;
    if (!transcript) { void startSession(key, runtime); return; }
    runtime.terminal.write(`${transcript}\\r\\n`, () => { if (liveKeys.current.has(key)) void startSession(key, runtime); });
  }, [startSession]);

  const handleInput = useCallback((key: string, runtime: Runtime, data: string) => {
    const id = runtime.id;
    if (!bridge || !id || !runtime.attached || runtime.attaching || runtime.closing || !liveKeys.current.has(key)) return;
    runtime.writeQueue = runtime.writeQueue.then(() => bridge.write(id, data)).then(scheduleSave).catch(setFailure);
  }, [bridge, scheduleSave, setFailure]);

  const handleResize = useCallback((_key: string, runtime: Runtime, dimensions: Dimensions) => {
    const id = runtime.id;
    if (!bridge || !id || !runtime.attached || runtime.attaching || runtime.closing) return;
    const size = `${dimensions.cols}x${dimensions.rows}`;
    if (size === runtime.lastSize) return;
    runtime.lastSize = size;
    runtime.resizeQueue = runtime.resizeQueue.then(() => bridge.resize(id, dimensions.cols, dimensions.rows)).catch(setFailure);
  }, [bridge, setFailure]);

  const createSession = useCallback((target = activeKeyRef.current, edge: Edge = "right") => {
    if (!bridge || !listenersReady || !stateRestored || sessionsRef.current.length + resourcesRef.current.length >= MAX_SESSIONS) return;
    sessionNumber.current += 1;
    const key = crypto.randomUUID();
    const session: Session = { key, name: t("terminal.session", { number: sessionNumber.current }), status: "starting" };
    liveKeys.current.add(key);
    commitSessions([...sessionsRef.current, session]);
    commitLayout(splitPane(layoutRef.current, target, key, edge));
    selectSession(key);
    zoomedRef.current = null;
    setZoomed(null);
    setError("");
    scheduleSave();
  }, [bridge, commitSessions, commitLayout, listenersReady, selectSession, stateRestored, scheduleSave]);

  const removeSession = useCallback((key: string) => {
    liveKeys.current.delete(key);
    runtimes.current.delete(key);
    const remaining = sessionsRef.current.filter((item) => item.key !== key);
    commitSessions(remaining);
    commitLayout(removePane(layoutRef.current, key));
    setZoomed(current => { const next = current === key ? null : current; zoomedRef.current = next; return next; });
    scheduleSave();
    if (activeKeyRef.current !== key) return;
    const nextKey = remaining.at(-1)?.key ?? resourcesRef.current.at(-1)?.key ?? "";
    selectSession(nextKey);
    if (nextKey) requestAnimationFrame(() => runtimes.current.get(nextKey)?.terminal.focus());
  }, [commitSessions, commitLayout, selectSession, scheduleSave]);

  const closeSession = useCallback(async (key: string) => {
    const session = sessionsRef.current.find((item) => item.key === key);
    if (!session || session.status === "closing") return;
    const runtime = runtimes.current.get(key);
    const id = runtime?.id;
    if (!id || !bridge) {
      removeSession(key);
      return;
    }
    runtime.closing = true;
    runtime.attached = false;
    runtime.attaching = false;
    runtimesById.current.delete(id);
    updateSession(key, { status: "closing" });
    try {
      await runtime.writeQueue.catch(() => {});
      await bridge.close(id);
      runtime.id = undefined;
      removeSession(key);
    } catch (cause) {
      runtime.closing = false;
      runtime.attaching = false;
      runtime.attached = runtime.exitCode === undefined;
      if (runtime.attached) runtimesById.current.set(id, runtime);
      updateSession(key, runtime.exitCode === undefined ? { status: "ready" } : { status: "exited", exitCode: runtime.exitCode });
      setFailure(cause);
    }
  }, [bridge, removeSession, setFailure, updateSession]);

  const closeResourcePane = (key: string) => {
    const pane = resourcesRef.current.find(item => item.key === key);
    if (!pane || (dirtyPanes.current.has(key) && !window.confirm(t("terminal.unsavedConfirm")))) return;
    dirtyPanes.current.delete(key);
    bridge?.setDirty?.(dirtyPanes.current.size > 0);
    dirtyCallback.current?.(dirtyPanes.current.size > 0);
    commitResources(resourcesRef.current.filter(item => item.key !== key));
    commitLayout(removePane(layoutRef.current, key));
    if (zoomedRef.current === key) { zoomedRef.current = null; setZoomed(null); }
    if (activeKeyRef.current === key) selectSession(sessionsRef.current.at(-1)?.key ?? resourcesRef.current.at(-1)?.key ?? "");
    void bridge?.closeResource(pane.resource.id).catch(setFailure);
    scheduleSave();
  };

  const measured = measureLayout(layout, viewportSize.width, viewportSize.height);
  const orderedSessions = leafIds(layout).flatMap(key => sessions.find(session => session.key === key) ?? []);
  const preview = dropTarget ? measureLayout(
    movePane(layout, dropTarget.source, dropTarget.key, dropTarget.edge, dropTarget.outer), viewportSize.width, viewportSize.height,
  ).panes.get(dropTarget.source) : undefined;

  const focusPane = (key: string) => {
    selectSession(key);
    scheduleSave();
    document.getElementById(`terminal-panel-${key}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    runtimes.current.get(key)?.terminal.focus();
  };
  const toggleZoom = (key: string) => {
    setZoomed(current => { const next = current === key ? null : key; zoomedRef.current = next; scheduleSave(); return next; });
    requestAnimationFrame(() => focusPane(key));
  };
  const arrange = (value: string) => {
    if (value === "zoom") { if (activeKeyRef.current) toggleZoom(activeKeyRef.current); return; }
    const [rows, columns] = value.split("x").map(Number);
    const count = sessionsRef.current.length + resourcesRef.current.length;
    if (!rows || !columns || rows * columns > MAX_SESSIONS || rows * columns < count) return;
    for (let index = count; index < rows * columns; index++) createSession();
    commitLayout(gridLayout(leafIds(layoutRef.current), columns));
    zoomedRef.current = null;
    setZoomed(null);
  };
  const cancelDrag = () => {
    paneDrag.current = null;
    dropTargetRef.current = null;
    setDropTarget(null);
  };
  const moveWithKeyboard = (key: string, edge: Edge) => {
    if (zoomed) return;
    const source = measured.panes.get(key);
    if (!source) return;
    const horizontal = edge === "left" || edge === "right";
    const sign = edge === "left" || edge === "top" ? -1 : 1;
    const neighbors = [...measured.panes].flatMap(([id, rect]) => {
      const dx = rect.left + rect.width / 2 - source.left - source.width / 2;
      const dy = rect.top + rect.height / 2 - source.top - source.height / 2;
      return id !== key && (horizontal ? dx : dy) * sign > 0
        ? [{ id, distance: Math.abs(horizontal ? dx : dy) + 3 * Math.abs(horizontal ? dy : dx) }] : [];
    }).sort((a, b) => a.distance - b.distance);
    if (neighbors[0]) commitLayout(movePane(layoutRef.current, key, neighbors[0].id, edge, false));
  };
  const paneHandle = (key: string, name: string, showName = false) => (
    <button type="button" aria-label={t("terminal.dragPane", { name: name })} aria-describedby="terminal-tiling-help" title={t("terminal.dragHelp")}
      onClick={() => { if (ignoreDragClick.current) { ignoreDragClick.current = false; return; } focusPane(key); }}
      onDoubleClick={() => toggleZoom(key)}
      onKeyDown={event => {
        const edge = ({ ArrowLeft: "left", ArrowRight: "right", ArrowUp: "top", ArrowDown: "bottom" } as Record<string, Edge>)[event.key];
        if (!edge) return;
        event.preventDefault();
        moveWithKeyboard(key, edge);
      }}
      onPointerDown={event => {
        if (event.button !== 0 || paneCount < 2 || zoomed) return;
        ignoreDragClick.current = false;
        event.currentTarget.setPointerCapture(event.pointerId);
        paneDrag.current = { key: key, x: event.clientX, y: event.clientY, moved: false };
      }}
      onPointerMove={event => {
        const drag = paneDrag.current;
        if (!drag || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
        drag.moved = true;
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-terminal-pane]");
        const key = target?.dataset.terminalPane;
        const zone = target && dropZone(target.getBoundingClientRect(), event.clientX, event.clientY);
        const drop = key && key !== drag.key && zone ? { key, source: drag.key, ...zone } : null;
        dropTargetRef.current = drop;
        setDropTarget(drop);
      }}
      onPointerUp={() => {
        const drag = paneDrag.current;
        const drop = dropTargetRef.current;
        if (drag?.moved) {
          ignoreDragClick.current = true;
          setTimeout(() => { ignoreDragClick.current = false; }, 0);
          if (drop) commitLayout(movePane(layoutRef.current, drag.key, drop.key, drop.edge, drop.outer));
        }
        cancelDrag();
      }}
      onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}
      className="flex h-8 min-w-0 flex-1 touch-none select-none items-center gap-1 rounded-md px-1 text-[12px] font-medium text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus enabled:cursor-grab active:cursor-grabbing">
      <GripVertical size={14} className="shrink-0" aria-hidden="true" />{showName && <span className="truncate">{name}</span>}
    </button>
  );
  const unavailable = !bridge;

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-app text-ink" data-terminal-page onKeyDownCapture={event => {
      if (event.key !== "Escape" || (!paneDrag.current && !resizeDrag.current)) return;
      event.preventDefault();
      event.stopPropagation();
      if (resizeDrag.current) commitLayout(resizeDrag.current.tree);
      resizeDrag.current = null;
      cancelDrag();
    }}>
      <style>{`[data-terminal-page] * { scrollbar-color: var(--color-ink-tertiary) var(--color-inset); scrollbar-width: thin; } [data-terminal-page] .xterm-viewport { scrollbar-color: var(--color-ink-tertiary) var(--color-inset); scrollbar-width: thin; } [data-terminal-page] .xterm-viewport::-webkit-scrollbar { width: 8px; } [data-terminal-page] .xterm-viewport::-webkit-scrollbar-thumb { background: var(--color-ink-tertiary); border: 2px solid var(--color-inset); border-radius: 999px; }`}</style>
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline/50 px-3 py-1.5">
        <SquareTerminal size={16} className="shrink-0 text-accent" aria-hidden="true" />
        <h1 className="mr-auto text-[13px] font-semibold" title={`${t("terminal.host")} · ${t("terminal.savedLocally")} · ${t("terminal.restoreNote")}`}>{t("terminal.title")}</h1>
        {paneCount > 0 && <select aria-label={t("terminal.layout")} title={t("terminal.gridHelp")} value="" onChange={event => arrange(event.target.value)}
          className="min-w-0 rounded-md border border-hairline bg-app px-2 py-1.5 text-[12px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
          <option value="" disabled>{t("terminal.layout")}</option>
          <option value="zoom">{zoomed ? t("terminal.restoreLayout") : t("terminal.singlePane")}</option>
          {GRID_PRESETS.map(([rows, columns]) => <option key={`${rows}x${columns}`} value={`${rows}x${columns}`} disabled={rows * columns < paneCount}>{t("terminal.grid", { rows, columns })}</option>)}
          <option value={`1x${paneCount}`}>{t("terminal.singleRow")}</option>
          <option value={`${paneCount}x1`}>{t("terminal.singleColumn")}</option>
        </select>}
        <button
          type="button"
          aria-label={t("terminal.new")}
          className="ui-button ui-button-primary inline-flex items-center gap-2"
          onClick={() => createSession()}
          disabled={unavailable || !listenersReady || !stateRestored || paneCount >= MAX_SESSIONS}
          title={paneCount >= MAX_SESSIONS ? t("terminal.limit", { max: MAX_SESSIONS }) : undefined}
        >
          <Plus size={16} aria-hidden="true" />
          {t("terminal.new")}
        </button>
      </header>

      {error && (
        <div role="alert" className="flex shrink-0 items-start gap-2 border-b border-danger/25 bg-danger/10 px-5 py-2.5 text-[13px] text-danger max-sm:px-4">
          <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <p className="min-w-0 flex-1 break-words">{error}</p>
          <button type="button" className="shrink-0 rounded-md px-2 py-1 text-[12px] font-medium hover:bg-danger/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" onClick={() => setError("")}>
            {t("terminal.dismissError")}
          </button>
        </div>
      )}

      {unavailable ? (
        <section className="m-auto flex max-w-md flex-col items-center gap-3 px-6 py-12 text-center" aria-labelledby="terminal-unavailable-title">
          <SquareTerminal size={28} className="text-ink-secondary" aria-hidden="true" />
          <h2 id="terminal-unavailable-title" className="text-[16px] font-semibold">{t("terminal.unavailableTitle")}</h2>
          <p className="text-[13px] leading-5 text-ink-secondary">{t("terminal.unavailableBody")}</p>
        </section>
      ) : paneCount === 0 ? (
        <section className="m-auto flex max-w-md flex-col items-center gap-3 px-6 py-12 text-center" aria-labelledby="terminal-empty-title">
          <SquareTerminal size={28} className="text-ink-secondary" aria-hidden="true" />
          <h2 id="terminal-empty-title" className="text-[16px] font-semibold">{t("terminal.emptyTitle")}</h2>
          <p className="text-[13px] leading-5 text-ink-secondary">{t("terminal.emptyBody")}</p>
        </section>
      ) : (
        <>
          <p id="terminal-tiling-help" className="sr-only">{t("terminal.dragHelp")}</p>
          <div ref={viewport} className="min-h-0 min-w-0 flex-1 overflow-auto bg-app" data-terminal-viewport>
            <div className="relative" data-terminal-tiles style={{ width: zoomed ? viewportSize.width : measured.width, height: zoomed ? viewportSize.height : measured.height }}>
              {orderedSessions.map(session => {
                const visible = !zoomed || zoomed === session.key;
                const rect = zoomed === session.key ? { left: 0, top: 0, width: viewportSize.width, height: viewportSize.height } : measured.panes.get(session.key);
                const status = session.status === "ready" ? t("terminal.connected") : session.status === "starting" ? t("terminal.starting") : session.status === "exited" ? t("terminal.exited", { code: session.exitCode ?? 0 }) : session.status === "error" ? t("terminal.failed") : "";
                return (
                  <section key={session.key} id={`terminal-panel-${session.key}`} aria-label={session.name} data-terminal-pane={session.key} hidden={!visible}
                    style={{ ...rect, display: visible ? undefined : "none" }}
                    className="absolute flex min-h-0 min-w-0 flex-col overflow-hidden bg-app"
                    onFocusCapture={() => { selectSession(session.key); scheduleSave(); }}>
                    <div className={cn("flex h-8 shrink-0 items-center gap-0.5 border-b border-hairline/40 px-1", session.key === activeKey && "bg-raised/60")}>
                      {paneHandle(session.key, session.name)}
                      <span role="status" aria-label={status} title={status} className={cn("mx-1 size-1.5 shrink-0 rounded-full", session.status === "ready" ? "bg-success" : session.status === "error" ? "bg-danger" : "bg-ink-tertiary")}><span className="sr-only">{status}</span></span>
                      <button type="button" aria-label={t("terminal.splitRight", { name: session.name })} title={t("terminal.splitRight", { name: session.name })} disabled={paneCount >= MAX_SESSIONS} onClick={() => createSession(session.key, "right")} className={paneButton}><Columns2 size={14} aria-hidden="true" /></button>
                      <button type="button" aria-label={t("terminal.splitBelow", { name: session.name })} title={t("terminal.splitBelow", { name: session.name })} disabled={paneCount >= MAX_SESSIONS} onClick={() => createSession(session.key, "bottom")} className={paneButton}><Rows2 size={14} aria-hidden="true" /></button>
                      <button type="button" aria-label={zoomed === session.key ? t("terminal.restoreLayout") : t("terminal.maximize", { name: session.name })} title={zoomed === session.key ? t("terminal.restoreLayout") : t("terminal.maximize", { name: session.name })} onClick={() => toggleZoom(session.key)} className={paneButton}>{zoomed === session.key ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}</button>
                      <button type="button" aria-label={t("terminal.clearSession", { name: session.name })} title={t("terminal.clear")} disabled={session.status === "starting" || session.status === "closing"} onClick={() => runtimes.current.get(session.key)?.terminal.clear()} className={paneButton}><Eraser size={14} aria-hidden="true" /></button>
                      <button type="button" aria-label={t("terminal.closeSession", { name: session.name })} title={t("terminal.closeSession", { name: session.name })} disabled={session.status === "closing"} onClick={() => void closeSession(session.key)} className={paneButton}><X size={15} aria-hidden="true" /></button>
                    </div>
                    <div className="min-h-0 flex-1 overflow-hidden px-2 py-1">
                      <TerminalSurface sessionKey={session.key} visible={visible} colorScheme={colorScheme} onReady={handleReady} onInput={handleInput} onResize={handleResize} />
                    </div>
                  </section>
                );
              })}
              {resources.map(pane => {
                const visible = !zoomed || zoomed === pane.key;
                const rect = zoomed === pane.key ? { left: 0, top: 0, width: viewportSize.width, height: viewportSize.height } : measured.panes.get(pane.key);
                const name = pane.resource.label;
                return <section key={pane.key} id={`terminal-panel-${pane.key}`} aria-label={name} data-terminal-pane={pane.key} hidden={!visible}
                  style={{ ...rect, display: visible ? undefined : "none" }} className="absolute flex min-h-0 min-w-0 flex-col overflow-hidden bg-app"
                  onFocusCapture={() => { selectSession(pane.key); scheduleSave(); }}>
                  <div className={cn("flex h-8 shrink-0 items-center gap-0.5 border-b border-hairline/40 px-1", pane.key === activeKey && "bg-raised/60")}>
                    {paneHandle(pane.key, name, true)}
                    <button type="button" aria-label={t("terminal.splitRight", { name })} title={t("terminal.splitRight", { name })} disabled={paneCount >= MAX_SESSIONS} onClick={() => createSession(pane.key, "right")} className={paneButton}><Columns2 size={14} aria-hidden="true" /></button>
                    <button type="button" aria-label={t("terminal.splitBelow", { name })} title={t("terminal.splitBelow", { name })} disabled={paneCount >= MAX_SESSIONS} onClick={() => createSession(pane.key, "bottom")} className={paneButton}><Rows2 size={14} aria-hidden="true" /></button>
                    <button type="button" aria-label={zoomed === pane.key ? t("terminal.restoreLayout") : t("terminal.maximize", { name })} title={zoomed === pane.key ? t("terminal.restoreLayout") : t("terminal.maximize", { name })} onClick={() => toggleZoom(pane.key)} className={paneButton}>{zoomed === pane.key ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}</button>
                    <button type="button" aria-label={t("terminal.closeSession", { name })} title={t("terminal.closeSession", { name })} onClick={() => closeResourcePane(pane.key)} className={paneButton}><X size={15} aria-hidden="true" /></button>
                  </div>
                  <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
                    {pane.resource.kind === "git" ? <GitPane resourceId={pane.resource.id} bridge={bridge!} /> : <FilePane resource={pane.resource} bridge={bridge!} onDirtyChange={dirty => {
                      if (dirty) dirtyPanes.current.add(pane.key); else dirtyPanes.current.delete(pane.key);
                      bridge?.setDirty?.(dirtyPanes.current.size > 0);
                      dirtyCallback.current?.(dirtyPanes.current.size > 0);
                    }} />}
                  </div>
                </section>;
              })}
              {!zoomed && measured.dividers.map(divider => (
                <div key={divider.id} role="separator" aria-label={divider.axis === "row" ? t("terminal.resizeColumns") : t("terminal.resizeRows")}
                  aria-orientation={divider.axis === "row" ? "vertical" : "horizontal"}
                  aria-valuemin={0} aria-valuemax={100}
                  aria-valuenow={Math.round(100 * (divider.axis === "row" ? (divider.rect.left - measured.rects.get(divider.parent)!.left) / measured.rects.get(divider.parent)!.width : (divider.rect.top - measured.rects.get(divider.parent)!.top) / measured.rects.get(divider.parent)!.height))}
                  tabIndex={0} style={divider.rect}
                  className={cn("absolute z-10 touch-none bg-hairline/40 hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus", divider.axis === "row" ? "cursor-col-resize" : "cursor-row-resize")}
                  onPointerDown={event => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    event.currentTarget.focus();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    resizeDrag.current = { x: event.clientX, y: event.clientY, tree: layoutRef.current, divider, rects: measured.rects };
                  }}
                  onPointerMove={event => {
                    const drag = resizeDrag.current;
                    if (drag && event.currentTarget.hasPointerCapture(event.pointerId)) commitLayout(resizeDivider(drag.tree, drag.divider, drag.divider.axis === "row" ? event.clientX - drag.x : event.clientY - drag.y, drag.rects));
                  }}
                  onPointerUp={() => { resizeDrag.current = null; }}
                  onPointerCancel={() => { if (resizeDrag.current) commitLayout(resizeDrag.current.tree); resizeDrag.current = null; }}
                  onLostPointerCapture={() => { resizeDrag.current = null; }}
                  onKeyDown={event => {
                    const keys = divider.axis === "row" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
                    if (!keys.includes(event.key)) return;
                    event.preventDefault();
                    commitLayout(resizeDivider(layoutRef.current, divider, event.key === keys[0] ? -24 : 24, measured.rects));
                  }} />
              ))}
              {preview && <div aria-hidden="true" data-terminal-drop-preview style={preview} className="pointer-events-none absolute z-20 flex items-center justify-center border border-accent bg-accent/20 text-[12px] font-medium text-ink"><span className="rounded bg-app px-2 py-1">{dropTarget?.edge === "center" ? t("terminal.swapPreview") : t("terminal.movePreview")}</span></div>}
            </div>
          </div>
        </>
      )}
    </main>
  );
}
