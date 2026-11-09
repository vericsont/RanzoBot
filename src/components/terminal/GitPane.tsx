import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

export type GitBridge = {
  gitHistory(id: string, cursor?: string): Promise<{ commits: Array<{ hash: string; parents: string[]; author: string; date: string; subject: string; refs: string[] }>; nextCursor: string | null }>;
  gitCommit(id: string, hash: string, parentId?: string): Promise<{ hash: string; parents: string[]; author: string; date: string; subject: string; body: string; files: Array<{ path: string; status: string; oldPath?: string }> }>;
  gitDiff(id: string, hash: string, parentId: string | undefined, path: string): Promise<{ text: string; truncated: boolean }>;
};

const MAX_DIFF_CHARS = 100_000;
const buttonClass = "rounded-md border border-hairline px-2 py-1 text-xs text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Commit = Awaited<ReturnType<GitBridge["gitHistory"]>>["commits"][number];
export function gitGraphRows(commits: Commit[]) {
  let lanes: string[] = [];
  return commits.map(commit => {
    const incoming = lanes;
    const found = incoming.indexOf(commit.hash);
    const node = found < 0 ? Math.min(incoming.length, 19) : found;
    const outgoing = incoming.filter(hash => hash !== commit.hash);
    for (const parent of commit.parents) if (!outgoing.includes(parent) && outgoing.length < 20) outgoing.splice(Math.min(node, outgoing.length), 0, parent);
    const edges = incoming.flatMap((hash, index) => hash === commit.hash ? [] : [{ from: index, to: outgoing.indexOf(hash) }]);
    const parents = commit.parents.map(hash => outgoing.indexOf(hash)).filter(index => index >= 0);
    const truncated = (found < 0 && incoming.length >= 20) || parents.length !== commit.parents.length;
    lanes = outgoing;
    return { node, incoming: incoming.length, edges, parents, truncated, width: Math.max(incoming.length, outgoing.length, node + 1) };
  });
}

export function GitPane({ resourceId, bridge }: { resourceId: string; bridge: GitBridge }) {
  const [commits, setCommits] = useState<Awaited<ReturnType<GitBridge["gitHistory"]>>["commits"]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [commit, setCommit] = useState<Awaited<ReturnType<GitBridge["gitCommit"]>> | null>(null);
  const [parentId, setParentId] = useState<string | undefined>();
  const [fileIndex, setFileIndex] = useState(-1);
  const [commitLoading, setCommitLoading] = useState(false);
  const [commitError, setCommitError] = useState("");
  const [diff, setDiff] = useState("");
  const [diffTruncated, setDiffTruncated] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState("");
  const historySequence = useRef(0);
  const historyBusy = useRef(false);
  const commitSequence = useRef(0);
  const diffSequence = useRef(0);

  const loadHistory = useCallback(async (cursor?: string, reset = false) => {
    if (historyBusy.current && !reset) return;
    historyBusy.current = true;
    const sequence = reset ? ++historySequence.current : historySequence.current;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const page = await bridge.gitHistory(resourceId, cursor);
      if (sequence !== historySequence.current) return;
      setCommits(current => reset ? page.commits : [...current, ...page.commits.filter(item => !current.some(existing => existing.hash === item.hash))]);
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (sequence === historySequence.current) setHistoryError(message(error));
    } finally {
      if (sequence === historySequence.current) {
        historyBusy.current = false;
        setHistoryLoading(false);
      }
    }
  }, [bridge, resourceId]);

  useEffect(() => {
    setCommits([]);
    setNextCursor(null);
    setHistoryError("");
    setSelectedHash(null);
    setCommit(null);
    setParentId(undefined);
    setFileIndex(-1);
    void loadHistory(undefined, true);
    return () => {
      historySequence.current += 1;
      commitSequence.current += 1;
      diffSequence.current += 1;
    };
  }, [loadHistory]);

  const selectCommit = (hash: string) => {
    setSelectedHash(hash);
    setCommit(null);
    setParentId(undefined);
    setFileIndex(-1);
    setCommitLoading(true);
    setCommitError("");
    setDiff("");
    setDiffTruncated(false);
    setDiffError("");
    diffSequence.current += 1;
    const sequence = ++commitSequence.current;
    void bridge.gitCommit(resourceId, hash).then(result => {
      if (sequence !== commitSequence.current) return;
      setCommit(result);
      setParentId(result.parents[0]);
      setFileIndex(result.files.length ? 0 : -1);
    }).catch(error => {
      if (sequence === commitSequence.current) setCommitError(message(error));
    }).finally(() => {
      if (sequence === commitSequence.current) setCommitLoading(false);
    });
  };

  const selectParent = (parent: string) => {
    if (!selectedHash) return;
    setParentId(parent);
    setCommit(null);
    setFileIndex(-1);
    setDiff("");
    setCommitError("");
    setCommitLoading(true);
    diffSequence.current += 1;
    const sequence = ++commitSequence.current;
    void bridge.gitCommit(resourceId, selectedHash, parent).then(result => {
      if (sequence !== commitSequence.current) return;
      setCommit(result);
      setFileIndex(result.files.length ? 0 : -1);
    }).catch(error => {
      if (sequence === commitSequence.current) setCommitError(message(error));
    }).finally(() => {
      if (sequence === commitSequence.current) setCommitLoading(false);
    });
  };

  const selectedFile = commit?.files[fileIndex];
  useEffect(() => {
    if (!commit || commit.hash !== selectedHash || !selectedFile) {
      setDiff("");
      setDiffTruncated(false);
      setDiffLoading(false);
      return;
    }
    const sequence = ++diffSequence.current;
    setDiff("");
    setDiffTruncated(false);
    setDiffError("");
    setDiffLoading(true);
    void bridge.gitDiff(resourceId, commit.hash, parentId, selectedFile.path).then(result => {
      if (sequence !== diffSequence.current) return;
      setDiff(result.text.slice(0, MAX_DIFF_CHARS));
      setDiffTruncated(result.truncated || result.text.length > MAX_DIFF_CHARS);
    }).catch(error => {
      if (sequence === diffSequence.current) setDiffError(message(error));
    }).finally(() => {
      if (sequence === diffSequence.current) setDiffLoading(false);
    });
    return () => {
      if (sequence === diffSequence.current) diffSequence.current += 1;
    };
  }, [bridge, commit, parentId, resourceId, selectedFile, selectedHash]);

  const refresh = () => { void loadHistory(undefined, true); };
  const graph = gitGraphRows(commits);
  const graphWidth = Math.max(1, ...graph.map(row => row.width)) * 14;
  const binaryDiff = Boolean(selectedFile && /binary/i.test(selectedFile.status)) || /(?:^|\n)(?:Binary files? .* differ|GIT binary patch|Binary file .* (?:changed|has changed))/i.test(diff);

  return (
    <section className="flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden bg-app text-ink" aria-label="Git history">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline/50 px-3 py-2">
        <h2 className="mr-auto min-w-0 truncate text-sm font-semibold">Git history</h2>
        <button type="button" className={buttonClass} onClick={refresh} aria-label="Refresh history">
          <RefreshCw size={14} aria-hidden="true" /> <span>Refresh</span>
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <section className="flex max-h-[42%] min-h-36 shrink-0 flex-col border-b border-hairline/50" aria-label="Commit history" aria-busy={historyLoading}>
          <div className="min-h-0 flex-1 overflow-auto">
            {commits.length ? (
              <ol className="divide-y divide-hairline/40">
                {commits.map((item, index) => (
                  <li key={item.hash}>
                    <button type="button" aria-pressed={selectedHash === item.hash} onClick={() => selectCommit(item.hash)}
                      className={`flex w-full min-w-0 gap-3 px-3 py-2 text-left hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-focus ${selectedHash === item.hash ? "bg-raised" : ""}`}>
                      <svg aria-hidden="true" width={graphWidth} viewBox={`0 0 ${graphWidth} 40`} preserveAspectRatio="none" className="shrink-0 self-stretch overflow-visible text-accent">
                        {Array.from({ length: graph[index]!.incoming }, (_, lane) => <path key={`in-${lane}`} d={`M ${lane * 14 + 7} 0 V 20`} fill="none" stroke="currentColor" strokeWidth="1" />)}
                        {graph[index]!.edges.map(edge => <path key={`edge-${edge.from}`} d={`M ${edge.from * 14 + 7} 20 L ${edge.to * 14 + 7} 40`} fill="none" stroke="currentColor" strokeWidth="1" />)}
                        {graph[index]!.parents.map((lane, parent) => <path key={`parent-${parent}`} d={`M ${graph[index]!.node * 14 + 7} 20 L ${lane * 14 + 7} 40`} fill="none" stroke="currentColor" strokeWidth="1" />)}
                        <circle cx={graph[index]!.node * 14 + 7} cy="20" r="3" fill="var(--color-app)" stroke="currentColor" strokeWidth="1.5" />
                      </svg>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">{item.subject || "(no subject)"}</span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-secondary">
                          <code>{item.hash.slice(0, 10)}</code><span className="truncate">{item.author}</span><time>{item.date}</time>
                          {item.parents.length > 0 && <span title={`Parents: ${item.parents.join(", ")}`}>↳ {item.parents.map(parent => parent.slice(0, 8)).join(" · ")}</span>}
                        </span>
                        {item.refs.length > 0 && <span className="mt-1 flex flex-wrap gap-1">{item.refs.map((ref, index) => <span key={`${ref}-${index}`} className="max-w-full truncate rounded bg-raised px-1.5 py-0.5 text-[10px] text-ink-secondary">{ref}</span>)}</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            ) : historyLoading ? <p className="p-3 text-sm text-ink-secondary" role="status">Loading history…</p>
              : historyError ? null : <p className="p-3 text-sm text-ink-secondary">No commits found.</p>}
          </div>
          {graph.some(row => row.truncated) && <p className="px-3 py-1 text-xs text-ink-secondary">Graph limited to 20 lanes.</p>}
          {historyError && <p className="px-3 py-2 text-sm text-danger" role="alert">Could not load history: {historyError}</p>}
          {nextCursor && <button type="button" className={`${buttonClass} m-2 self-start`} onClick={() => void loadHistory(nextCursor)} disabled={historyLoading}>Load more</button>}
        </section>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Commit details" aria-busy={commitLoading || diffLoading}>
          {selectedHash === null ? <p className="p-4 text-sm text-ink-secondary">Select a commit to view its changes.</p>
            : commitLoading ? <p className="p-4 text-sm text-ink-secondary" role="status">Loading commit…</p>
              : commitError ? <p className="p-4 text-sm text-danger" role="alert">Could not load commit: {commitError}</p>
                : commit ? <>
                  <div className="shrink-0 border-b border-hairline/40 p-3">
                    <h3 className="break-words text-sm font-semibold">{commit.subject || "(no subject)"}</h3>
                    <p className="mt-1 break-words text-xs text-ink-secondary">{commit.author} · <time>{commit.date}</time></p>
                    <code className="mt-1 block break-all text-[11px] text-ink-tertiary">{commit.hash}</code>
                    {commit.body && <p className="mt-2 whitespace-pre-wrap break-words text-xs text-ink-secondary">{commit.body}</p>}
                    {commit.parents.length > 1 && <label className="mt-3 flex min-w-0 flex-wrap items-center gap-2 text-xs text-ink-secondary">
                      Compare with parent
                      <select aria-label="Compare with parent" value={parentId ?? ""} onChange={event => selectParent(event.target.value)}
                        className="min-w-0 max-w-full rounded-md border border-hairline bg-app px-2 py-1 text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
                        {commit.parents.map((parent, index) => <option key={parent} value={parent}>Parent {index + 1} · {parent.slice(0, 10)}</option>)}
                      </select>
                    </label>}
                  </div>
                  {commit.files.length === 0 ? <p className="p-3 text-sm text-ink-secondary">No changed files.</p> : <>
                    <label className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline/40 p-2 text-xs text-ink-secondary">
                      Changed file
                      <select aria-label="Changed file" value={fileIndex} onChange={event => { diffSequence.current += 1; setFileIndex(Number(event.target.value)); }}
                        className="min-w-0 flex-1 rounded-md border border-hairline bg-app px-2 py-1.5 text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
                        {commit.files.map((file, index) => <option key={`${index}-${file.path}`} value={index}>{file.status} · {file.path}{file.oldPath ? ` (from ${file.oldPath})` : ""}</option>)}
                      </select>
                    </label>
                    <div className="min-h-0 min-w-0 flex-1 overflow-auto">
                      {diffLoading ? <p className="p-3 text-sm text-ink-secondary" role="status">Loading diff…</p>
                        : diffError ? <p className="p-3 text-sm text-danger" role="alert">Could not load diff: {diffError}</p>
                          : binaryDiff ? <p className="p-3 text-sm text-ink-secondary" role="status">Binary file change; no text diff is available.</p>
                            : <>
                              {diffTruncated && <p className="sticky top-0 border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs text-ink" role="status">Diff output truncated; only the available beginning is shown.</p>}
                              {diff ? <pre className="min-w-0 whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-5 text-ink">{diff}</pre> : <p className="p-3 text-sm text-ink-secondary">No diff available.</p>}
                            </>}
                    </div>
                  </>}
                </> : null}
        </section>
      </div>
    </section>
  );
}
