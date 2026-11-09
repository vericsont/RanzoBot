import { useCallback, useEffect, useRef, useState } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { basicSetup, EditorView } from "codemirror";
import { useColorScheme } from "@/lib/color-scheme";
import { t } from "@/lib/i18n";

export type FileResource = { id: string; kind: "file" | "directory"; label: string };
export type FileBridge = {
  listDirectory(id: string, relativePath: string): Promise<{ entries: Array<{ name: string; kind: "file" | "directory" | "symlink" | "other" }> }>;
  openChild(id: string, relativePath: string): Promise<FileResource>;
  readText(id: string): Promise<{ text: string; revision: string; readOnly: boolean; readOnlyReason?: string }>;
  saveText(id: string, expectedRevision: string, text: string): Promise<{ revision: string }>;
  closeResource(id: string): Promise<void>;
};

type Entry = Awaited<ReturnType<FileBridge["listDirectory"]>>["entries"][number];
type DirectoryView = { kind: "directory"; id: string; path: string; entries?: Entry[]; loading: boolean; opening?: boolean; error?: string };
type FileView = {
  kind: "file";
  resource: FileResource;
  parent?: { id: string; path: string };
  savedText?: string;
  revision?: string;
  readOnly?: boolean;
  readOnlyReason?: string;
  loading: boolean;
  error?: string;
};
type View = DirectoryView | FileView;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error);
}

function joinPath(path: string, name: string): string {
  return path ? `${path}/${name}` : name;
}

function closeQuietly(bridge: FileBridge, id: string) {
  void Promise.resolve().then(() => bridge.closeResource(id)).catch(() => undefined);
}

function editorTheme(dark: boolean) {
  return EditorView.theme({
    "&": { height: "100%", backgroundColor: "transparent", color: "var(--color-ink)", fontSize: "12.5px" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "var(--font-mono, monospace)", lineHeight: "24px", overflow: "auto" },
    ".cm-content": { padding: "8px 0", caretColor: "var(--color-ink)" },
    ".cm-line": { padding: "0 12px" },
    ".cm-cursor": { borderLeftColor: "var(--color-ink)" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "color-mix(in srgb, var(--color-accent) 25%, transparent)" },
  }, { dark });
}

function TextEditor({
  text,
  readOnly,
  scheme,
  onChange,
  onSave,
}: {
  text: string;
  readOnly: boolean;
  scheme: "light" | "dark";
  onChange: (text: string) => void;
  onSave: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const initial = useRef({ text, readOnly });
  const theme = useRef(new Compartment());
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };

  useEffect(() => {
    const separator = initial.current.text.match(/\r\n|\r|\n/)?.[0] ?? "\n";
    const mixed = /[\r\n]/.test(initial.current.text.split(separator).join(""));
    const editor = new EditorView({
      doc: initial.current.text,
      parent: host.current!,
      extensions: [
        basicSetup,
        ...(mixed ? [] : [EditorState.lineSeparator.of(separator)]),
        EditorView.lineWrapping,
        EditorView.editable.of(!initial.current.readOnly),
        EditorView.contentAttributes.of({ "aria-label": "File contents", "aria-multiline": "true", spellcheck: "false" }),
        theme.current.of(editorTheme(scheme === "dark")),
        EditorView.domEventHandlers({
          keydown: (event) => {
            if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") {
              event.preventDefault();
              callbacks.current.onSave();
              return true;
            }
            return false;
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) callbacks.current.onChange(update.state.sliceDoc());
        }),
      ],
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: theme.current.reconfigure(editorTheme(scheme === "dark")) });
  }, [scheme]);

  return <div ref={host} data-testid="file-editor" className="min-h-0 flex-1 overflow-hidden rounded-md border border-hairline/50 bg-inset focus-within:ring-1 focus-within:ring-accent" />;
}

export function FilePane({ resource, bridge, onDirtyChange }: {
  resource: FileResource;
  bridge: FileBridge;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const scheme = useColorScheme();
  const [view, setView] = useState<View>(() => resource.kind === "directory"
    ? { kind: "directory", id: resource.id, path: "", loading: true }
    : { kind: "file", resource, loading: true });
  const [draft, setDraft] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState("");
  const bridgeRef = useRef(bridge);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const request = useRef(0);
  const ownedChild = useRef<string | null>(null);
  const draftRef = useRef(draft);
  const saving = useRef(new Set<string>());
  bridgeRef.current = bridge;
  onDirtyChangeRef.current = onDirtyChange;
  draftRef.current = draft;

  const dirty = view.kind === "file" && !view.loading && !view.error && !view.readOnly && view.savedText !== undefined && view.savedText !== draft;
  useEffect(() => { onDirtyChangeRef.current(dirty); }, [dirty]);

  const loadDirectory = useCallback(async (id: string, path: string, version: number) => {
    try {
      const { entries } = await bridgeRef.current.listDirectory(id, path);
      if (request.current !== version) return;
      const sorted = [...entries].sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
      setView({ kind: "directory", id, path, entries: sorted, loading: false });
    } catch (error) {
      if (request.current === version) setView({ kind: "directory", id, path, loading: false, error: errorMessage(error) });
    }
  }, []);

  const loadFile = useCallback(async (id: string, version: number) => {
    try {
      const result = await bridgeRef.current.readText(id);
      if (request.current !== version) return;
      setDraft(result.text);
      setView((current) => current.kind === "file" && current.resource.id === id
        ? { ...current, savedText: result.text, revision: result.revision, readOnly: result.readOnly, readOnlyReason: result.readOnlyReason, loading: false, error: undefined }
        : current);
    } catch (error) {
      if (request.current === version) setView((current) => current.kind === "file" && current.resource.id === id
        ? { ...current, loading: false, error: errorMessage(error) }
        : current);
    }
  }, []);

  useEffect(() => {
    const version = ++request.current;
    setDraft("");
    setSaveMessage("");
    if (resource.kind === "directory") {
      setView({ kind: "directory", id: resource.id, path: "", loading: true });
      void loadDirectory(resource.id, "", version);
    } else {
      setView({ kind: "file", resource, loading: true });
      void loadFile(resource.id, version);
    }
    return () => {
      request.current += 1;
      if (ownedChild.current) {
        closeQuietly(bridgeRef.current, ownedChild.current);
        ownedChild.current = null;
      }
    };
  }, [resource.id, resource.kind, loadDirectory, loadFile]);

  const setDirectory = (id: string, path: string) => {
    const version = ++request.current;
    setView({ kind: "directory", id, path, loading: true });
    setSaveMessage("");
    void loadDirectory(id, path, version);
  };

  const changeDraft = (text: string) => {
    draftRef.current = text;
    if (view.kind === "file" && !view.readOnly && view.savedText !== undefined) onDirtyChangeRef.current(view.savedText !== text);
    setDraft(text);
    setSaveMessage("");
  };

  const save = useCallback(async () => {
    const current = view;
    if (current.kind !== "file" || current.loading || current.readOnly || current.revision === undefined || current.savedText === undefined) return;
    const id = current.resource.id;
    if (saving.current.has(id) || draftRef.current === current.savedText) return;
    const text = draftRef.current;
    const version = request.current;
    saving.current.add(id);
    setSavingId(id);
    setSaveMessage("Saving…");
    try {
      const result = await bridgeRef.current.saveText(id, current.revision, text);
      if (request.current !== version) return;
      setView((latest) => latest.kind === "file" && latest.resource.id === id
        ? { ...latest, savedText: text, revision: result.revision }
        : latest);
      setSaveMessage("Saved");
    } catch (error) {
      if (request.current !== version) return;
      const message = errorMessage(error);
      const conflict = /conflict|revision|changed/i.test(message)
        || Boolean(error && typeof error === "object" && "code" in error && String(error.code).toLowerCase() === "conflict");
      setSaveMessage(`${conflict ? "Conflict" : "Save failed"}: ${message}`);
    } finally {
      saving.current.delete(id);
      setSavingId((active) => active === id ? null : active);
    }
  }, [view]);

  const backFromFile = () => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    if (view.kind !== "file" || !view.parent || !ownedChild.current) return;
    const childId = ownedChild.current;
    ownedChild.current = null;
    closeQuietly(bridgeRef.current, childId);
    setDraft("");
    draftRef.current = "";
    setSaveMessage("");
    setDirectory(view.parent.id, view.parent.path);
  };

  const openEntry = async (entry: Entry) => {
    if (view.kind !== "directory" || view.loading || view.opening || (entry.kind !== "file" && entry.kind !== "directory")) return;
    const id = view.id;
    const path = joinPath(view.path, entry.name);
    if (entry.kind === "directory") {
      setDirectory(id, path);
      return;
    }

    const version = ++request.current;
    const parent = { id, path: view.path };
    setView({ ...view, opening: true, error: undefined });
    let child: FileResource;
    try {
      child = await bridgeRef.current.openChild(id, path);
    } catch (error) {
      if (request.current === version) setView({ ...view, opening: false, error: errorMessage(error) });
      return;
    }
    if (request.current !== version) {
      closeQuietly(bridgeRef.current, child.id);
      return;
    }
    ownedChild.current = child.id;
    setDraft("");
    draftRef.current = "";
    setSaveMessage("");
    setView({ kind: "file", resource: child, parent, loading: true });
    await loadFile(child.id, version);
  };

  const file = view.kind === "file" ? view : null;
  return (
    <section className="flex h-full min-h-0 min-w-0 w-full flex-col gap-2 bg-app p-2 text-ink" aria-label={file ? `File ${file.resource.label}` : `Directory ${resource.label}`}>
      <header className="flex min-w-0 items-center gap-2">
        {file?.parent && <button type="button" onClick={backFromFile} className="shrink-0 rounded px-2 py-1 text-sm hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">Back</button>}
        {view.kind === "directory" && view.path && <button type="button" disabled={view.loading || view.opening} onClick={() => setDirectory(view.id, view.path.includes("/") ? view.path.slice(0, view.path.lastIndexOf("/")) : "")} className="shrink-0 rounded px-2 py-1 text-sm hover:bg-raised disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">Up</button>}
        <strong className="min-w-0 flex-1 truncate" title={file?.resource.label ?? resource.label}>{file?.resource.label ?? resource.label}</strong>
        {dirty && <span className="text-xs text-ink-secondary">Unsaved changes</span>}
        {file && !file.loading && file.readOnly && <span className="text-xs text-ink-secondary" title={file.readOnlyReason}>Read-only{file.readOnlyReason ? `: ${file.readOnlyReason}` : ""}</span>}
        {file && <button type="button" onClick={() => void save()} disabled={file.loading || !!file.readOnly || savingId === file.resource.id || !dirty} className="rounded px-3 py-1 text-sm hover:bg-raised disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">Save</button>}
      </header>

      {file && !file.loading && !file.error && !file.readOnly && <p className="text-xs text-ink-secondary">{t("terminal.saveMetadataWarning")}</p>}
      {view.kind === "directory" && <div className="text-xs text-ink-secondary" aria-label="Current directory">{view.path || "/"}</div>}
      {view.kind === "file" && <div className="text-xs text-ink-secondary">Ctrl/⌘-S to save</div>}
      {view.loading && <div role="status" className="text-sm text-ink-secondary">Loading…</div>}
      {view.kind === "directory" && view.error && <div role="alert" className="text-sm text-danger">{view.error}</div>}
      {view.kind === "file" && view.error && <div role="alert" className="text-sm text-danger">{view.error}</div>}
      {saveMessage && <div role={saveMessage.startsWith("Conflict") || saveMessage.startsWith("Save failed") ? "alert" : "status"} className={`text-sm ${saveMessage.startsWith("Conflict") || saveMessage.startsWith("Save failed") ? "text-danger" : "text-ink-secondary"}`}>{saveMessage}</div>}

      {view.kind === "directory" && !view.loading && !view.error && (
        <ul className="min-h-0 flex-1 space-y-1 overflow-auto" aria-label="Directory entries">
          {(view.entries ?? []).map((entry) => {
            const openable = entry.kind === "directory" || entry.kind === "file";
            return <li key={`${entry.kind}:${entry.name}`}>
              <button type="button" disabled={!openable || view.opening} onClick={() => void openEntry(entry)} className="w-full rounded px-2 py-1 text-left text-sm hover:bg-raised disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus" aria-label={`${entry.name}${entry.kind === "directory" ? ", directory" : entry.kind === "symlink" ? ", symbolic link not followed" : entry.kind === "other" ? ", unsupported entry" : ""}`}>
                <span>{entry.name}{entry.kind === "directory" ? "/" : ""}</span>
                {!openable && <span className="ml-2 text-xs text-ink-secondary">{entry.kind === "symlink" ? "symbolic link not followed" : "unsupported"}</span>}
              </button>
            </li>;
          })}
          {!view.entries?.length && <li className="px-2 py-2 text-sm text-ink-secondary">This directory is empty.</li>}
        </ul>
      )}
      {view.kind === "file" && !view.loading && !view.error && view.savedText !== undefined && <TextEditor key={view.resource.id} text={view.savedText} readOnly={!!view.readOnly} scheme={scheme} onChange={changeDraft} onSave={() => void save()} />}
    </section>
  );
}
