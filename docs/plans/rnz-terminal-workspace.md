# Plan: `rnz` terminal workspace

Status: initial implementation in source. Linux isolated PTY/renderer and packaged CLI checks passed; production window lifecycle and macOS packaging still need verification. See [terminal verification](../verification/terminal.md) for limits and save risks.

## Goal

From a local RanzoBot terminal, open files, folders and Git history as panes inside the same tiled workspace:

- `rnz view path/to/file` opens a code-style editor where the file can be changed and saved.
- `rnz view path/to/folder` opens a navigable folder list; choosing a file opens it in the editor.
- `rnz git` opens the current repository's commit graph, commit details, changed files and diffs.

The shell stays running. The new pane opens beside the terminal that issued the command and participates in the existing split, resize, move, maximize and close interactions.

## Decisions and assumptions

1. **Editable files:** the first release includes editing and explicit saving. Unsaved changes must not be silently discarded or overwrite an observed external change.
2. **Local desktop only:** `rnz` works in RanzoBot's own host terminal, not remote workspaces, a separate terminal app, or a shell reached over SSH. Those need a separate access and connection design.
3. **Panes, not a new page:** opening a resource adds a tile without replacing the issuing shell. Pane names remain accessible, but visible titles may identify the file, folder or repository.
4. **Folder scope:** folder navigation stays inside the selected directory. A symlink escaping it is shown but not followed; a person may explicitly open its target with another `rnz view` command.
5. **Small first release:** Git is read-only: history, branch/tag labels, commit metadata, changed files and diffs. No staging, commit, checkout, push or other mutations.
6. **No extra editor dependency by default:** use the installed CodeMirror 6, already used in `src/components/data/SqlEditor.tsx`. Add individual language packages only when justified; plain text remains usable. Actual Monaco is a separate choice if Monaco-specific features are required.
7. **Transient resource panes:** preserve existing terminal session/layout persistence. File, folder and Git panes are not restored after leaving the page in the first release; do not persist file contents or repository data. Guard unsaved edits before closing or navigating away; crash recovery is not included. Reopening panes is a later decision.
8. **Desktop packaging:** target Linux and macOS first. Windows support is out of scope and must not be claimed. Do not claim a platform works until its packaged executable and command launch are tested there.

## Existing project constraints

- `src/components/TerminalPage.tsx` owns PTY lifecycles, event subscriptions and tile rendering. Its `Session` list currently represents only shells.
- `src/components/terminal-layout.ts` already provides stable keyed panes, nested layout, resizing, drag/drop and maximize geometry. It does not need a replacement layout engine.
- `electron/terminal-state.mjs` validates version 1 snapshots against the terminal-session IDs. Saving a mixed tile tree as-is would invalidate the saved layout.
- `electron/terminal-sessions.mjs`, `electron/main.mjs` and `electron/preload.cjs` enforce a local main-window/document-token boundary. A renderer or remote workspace must not gain arbitrary host file access.
- `electron-builder.yml` packages the terminal PTY runtime separately; the desktop does not require a globally installed Node runtime. The command must work in the packaged app without assuming one.
- `src/components/FilesView.tsx` is the Cloud sharing/settings surface, not a local file explorer. Do not route local host files through its cloud or server APIs.
- `third_party/waveterm/README.md` documents the existing Wave tiling reference. It contains no Wave `wsh` implementation; this is an independent design, not a claim of protocol compatibility.
- Terminal changes currently include uncommitted and untracked files. Preserve them; a delegate must not reset, clean, overwrite or assume a fresh worktree contains them.

## Proposed flow and trust boundary

1. Main starts a terminal with a private, per-session command endpoint and capability. A packaged `rnz` launcher is made discoverable **inside that terminal** without changing the user's global PATH.
2. `rnz` parses `view [path]` or `git [path]`, resolves a relative path from the command process's **actual current working directory**, and requests an open. Shell quoting and expansion happen normally. Defaults: `rnz view` and `rnz git` use `.`; `--` permits names beginning with `-`.
3. The endpoint accepts only bounded, versioned open requests. It identifies the issuing session and owner, checks session liveness, creates a narrowly scoped resource grant and sends an event to the owning local renderer. The command reports success only after the renderer accepts the pane; timeout, a closed page, an invalid path or a full layout is a nonzero exit with a useful error.
4. The renderer opens a pane next to the issuing terminal. Its file and Git operations use opaque grant IDs, not a general-purpose `readFile(path)` or `exec(command)` bridge. Main validates owner, document token, active local workspace, grant type, path bounds and operation on every call.
5. Closing a resource pane revokes its grant. Closing the issuing shell, renderer navigation/crash, workspace switch or app shutdown invalidates its command capability and pending requests; main must not deliver stale events to a new document. Resource-pane grants are owned by the document and are revoked on pane close or document teardown.

### Transport proposal

Use a local Unix-domain socket owned by main, plus an unguessable session capability injected only into that PTY's environment. Use restrictive endpoint permissions where supported, bounded messages, rate limits, request timeouts and cleanup. The CLI channel may request an open only; it cannot retrieve file or Git contents. Never print capabilities in terminal output or logs.

A capability inherited by the shell is also inherited by its child processes. It prevents unrelated unauthenticated callers from using the endpoint; it does **not** distinguish the user from a program already running in that shell or a hostile process running as the same OS user. Such a process can request panes and already has that user's OS permissions. Do not claim stronger isolation. In particular, no renderer document token or file-read capability goes into the shell environment.

The first implementation slice must prototype a standalone launcher on packaged Linux and macOS before standardizing the transport: the existing Electron runtime can potentially run the CLI through `ELECTRON_RUN_AS_NODE`, but paths, signing, macOS hardened runtime, shell quoting and bundled resources must be verified rather than assumed. If that approach fails on a platform, choose a minimal packaged launcher for that platform and record the trade-off before proceeding. Do not intercept typed commands or trust an ANSI/OSC sequence from arbitrary terminal output as authorization.

### Proposed contracts to freeze before parallel implementation

The integration owner defines exact wire schemas and contract tests first. Proposed shape:

- CLI request: `{ version: 1, requestId, sessionCapability, action: "view" | "git", absolutePath }`.
- CLI result: `{ requestId, ok: true }` only after pane acceptance, or `{ requestId, ok: false, code, message }`; no file contents or secrets.
- Main-to-renderer open event: `{ requestId, sourceSessionId, resourceId, kind: "file" | "directory" | "git", label }`. The resource ID is opaque and owner/document-bound.
- Narrow resource calls: `listDirectory(resourceId, relativePath, cursor)`, `openChild(resourceId, relativePath)`, `readText(resourceId)`, `saveText(resourceId, expectedRevision, text)`, `gitHistory(resourceId, cursor)`, `gitCommit(resourceId, commitId, parentId?)`, `gitDiff(resourceId, commitId, parentId?, fileId)` and `closeResource(resourceId)`. Reads return a revision for conflict detection; saves return a new revision or a typed conflict. Exact result types and typed error codes are part of the frozen contract. Child file opens get their own grant; no caller-supplied absolute file paths for reads or writes.
- All requests, responses, text contents, directory pages, Git output, concurrency and history pages have explicit limits. A response says when it is truncated; it never silently displays an incomplete diff as complete.

Resource handles and paths are local-only. Never send contents, paths or CLI capabilities to a bot, server, cloud page or analytics. For directory traversal, validate path components, symlinks and actual filesystem targets in main on every operation; do not rely on a string-prefix check. Treat replacement/symlink races as a security design item, not merely a UI validation problem. Explicit single-file opens grant that file only. Render filenames, commit metadata and diffs as text, not HTML.

## Delegation slices

Each slice includes tests and a short handoff listing behavior, files changed, commands run and any untested platform. Paths below are intended ownership, not a mandate to create speculative abstractions. One integration owner handles shared files; parallel delegates should not all edit `TerminalPage.tsx`, `electron/main.mjs`, `electron/preload.cjs`, `electron/bridge-contract.json` or `src/types/ogb.d.ts`.

### 0. Contracts and feasibility — integration owner (M; blocks all coding slices)

- Confirm the remaining assumptions above; editable files and Linux/macOS scope are user decisions.
- Freeze request/result types, file revision and save-conflict semantics, resource/grant lifetimes, limits, error codes, unsaved-change guards and pane-acceptance acknowledgement. Decide which behavior on session close is distinct from document teardown.
- Prototype launcher/runtime and endpoint behavior in isolated Linux/macOS fixtures. Decide platform-specific launchers only after evidence.
- Own proposed wire types such as `shared/terminal-workspace.ts`, bridge signatures, test fixtures and the integration points in the five shared files above. Other slices implement to this contract with injected/mock bridges.
- **Done:** contract tests cover valid/invalid messages and lifecycle; launcher feasibility and unsupported platforms are documented; each delegate has a concrete interface.

### 1. `rnz` launcher and session transport (L; after 0)

- Own new CLI/transport modules and tests, e.g. `electron/rnz-cli.*`, `electron/rnz-transport.mjs`, `electron/rnz-transport.node-test.mjs`; coordinate PTY environment wiring with the integration owner.
- Resolve paths in the CLI process after `cd`, not from terminal startup directory. Support Unicode, spaces, quoted paths, `--`, helpful usage, exit status and an unavailable/expired endpoint.
- Bind capabilities to the session and owner; validate types, version, message size and request count. Clean up endpoints, capabilities, pending timeouts and process resources on all lifecycle paths.
- Package the command without modifying global shell startup files or requiring a separate Node install. Test login shells that replace PATH during startup; if the launcher cannot be found, report the limitation rather than claiming support. Detect and document any `rnz` PATH collision; do not overwrite a system executable. Allocate session identity and capability before PTY spawn and clean them up if spawn fails.
- **Done:** a real shell in an isolated PTY invokes the command after `cd`, receives a bounded acknowledgement or error, and cannot reuse a revoked/wrong-session capability. No PTY output framing is used as the security boundary.

### 2. Local file/directory service (L; after 0)

- Own new `electron/terminal-files.mjs` and `electron/terminal-files.node-test.mjs`, or equivalent contract-owned modules. Main owns the grants; no general renderer filesystem API.
- List directories in bounded, stable pages with names, file/directory/symlink types and clear permission errors. Support navigation and keyboard selection; navigation outside the approved root is refused.
- Read and save bounded UTF-8 text only. Report binary/unsupported encoding, oversized files, missing files, broken links, directory changes and permission failures explicitly; never block on FIFOs, devices or sockets. Preserve existing line endings and UTF-8 BOM when saving.
- Provide explicit save for an existing granted file only; validate the expected revision and report changed, replaced or deleted files as conflicts without discarding the editor draft. Use a reviewed durable-write strategy that preserves permissions and handles links and metadata safely; fail closed where preservation cannot be guaranteed. No autosave or implicit file creation.
- Re-check containment and symlinks at use time. Investigate Linux/macOS no-follow/handle-based traversal and race protections; if a supported platform cannot enforce the scope, fail closed or return to the owner for a decision rather than claiming a guarantee. A pre-save revision check followed by replacement cannot eliminate the race with an unrelated concurrent writer; document that limitation and review the strategy before implementation.
- **Done:** isolated filesystem tests include safe saves, conflict detection, concurrent writes, failed/interrupted writes, permissions and metadata, traversal, escaping symlinks, link swaps, special files, large/binary data, unusual filenames and revoked grants.

### 3. Read-only Git service (L; after 0)

- Own new `electron/terminal-git.mjs` and `electron/terminal-git.node-test.mjs` or equivalent. Use the installed Git executable through argument arrays, not a shell or a new Git library. `server/checkpoints.ts` demonstrates bounded subprocess handling but manages a different shadow repository and must not be reused for user-repo mutation.
- Discover the repository from the requested directory, including subdirectories and worktrees. Return a bounded, paginated commit graph with IDs, parents, refs, author/date and subject, plus selected-commit metadata, changed paths and per-file diffs. Anchor pagination to a stable traversal; detect/refetch when the repository changes.
- Handle root commits, merge-parent selection, renamed/deleted files, binary changes, detached HEAD, no commits, non-repositories, missing Git and unavailable/oversized output. Use Git's NUL-safe formats for filenames; test SHA-1 and SHA-256 object IDs where supported.
- Run explicitly read-only commands, with no shell interpolation, pager, external diff/textconv or unnecessary optional locks. Neutralize configuration that can launch helpers, such as filesystem monitors; bound runtime/output and cancel abandoned work. Never fetch or modify refs/index/worktree. Treat repository content/config as untrusted.
- **Done:** tests construct temporary repositories and compare expected graph, merge parents, file statuses and diffs; assert worktree/index/refs unchanged, truncation is visible, and unsafe helpers are not run.

### 4. Mixed-pane workspace integration (L; after 0 and transport contract)

- Integration owner owns `src/components/TerminalPage.tsx`, `src/components/terminal-layout.ts` only if necessary, and terminal state/bridge integration. Keep PTY lifetime separate from non-terminal pane lifetime; preserve stable mounted xterm nodes when adding/moving/maximizing resources.
- Accept a main-issued open event and split beside its **source session**, not whichever pane happens to be active. Handle simultaneous requests, source closure, maximized layouts, the existing 16-session cap and a separately explicit total tile limit; acknowledge only after insertion succeeds.
- Implement close, focus, accessible names, drag/drop, keyboard movement, maximize and resize consistently for mixed pane kinds. Closing a resource must never kill a PTY; closing a PTY must not accidentally close unrelated resource panes. Guard unsaved edits when closing a pane, using Back, leaving Terminal, switching workspaces, reloading or quitting; only discard after explicit confirmation. Coordinate app/window lifecycle with main and do not claim crash recovery.
- Keep v1 terminal persistence valid: strip transient resource leaves from the saved tree and normalize remaining terminal-only splits; map active/zoomed keys to valid terminal keys. Do not overwrite a valid existing snapshot with an invalid mixed layout. Restore saved shells as before, without replaying `rnz` or restoring resource contents.
- **Done:** component/layout tests prove terminal-only persistence, mixed layouts and no PTY restarts/leaks. The original terminal fixture still passes.

### 5. File explorer and editor UI (L; after 0 and file contract; parallel with 3)

- Own new `src/components/terminal/FilePane.tsx`, `DirectoryPane.tsx` and their tests. Accept only the narrow bridge/props; integration owner mounts them.
- File pane: editable CodeMirror with line numbers, scrolling, text selection, search, theme and a visible path/name. Provide a dirty indicator, explicit Save button and Ctrl/Cmd-S. Start with plain text; language highlighting can be added selectively without blocking the feature. Show loading, empty, binary, too-large, removed, conflict and permission states; read-only files remain viewable with an explanation.
- Keep the draft on failed/conflicting saves. If edits occur while a save is in flight, mark only the saved revision clean and retain newer edits. Offer reload only with explicit discard confirmation. Protect unsaved changes on pane close, Back and app navigation via the shared lifecycle contract; no autosave.
- Directory pane: visible current relative location, parent navigation within the granted root, directories-first entries, keyboard-accessible buttons and paginated loading. Clicking a directory navigates; clicking a file opens the file viewer without closing the issuing shell. Specify whether the file replaces the folder pane or opens another pane in the contract; default to replacing the folder pane, with Back available to return to the folder. Retain the folder grant for Back, revoke the child file grant when returning, and revoke both when the pane closes.
- Prevent stale asynchronous responses from replacing a newer selection; clean up listeners, editors and grants on close.
- **Done:** UI tests cover nested navigation, file selection, editing/saving, keyboard shortcuts, dirty guards, concurrent edits during save, conflict and failed-save recovery, Back, errors and theme; screenshots cover narrow and normal windows in both themes.

### 6. Git history and diff UI (L; after 0 and Git contract; parallel with 5)

- Own new `src/components/terminal/GitPane.tsx` and tests. Integration owner mounts it using the common pane contract.
- Show a paginated commit graph/list with branch/tag labels, a selected commit's metadata, changed-file list and readable diff. Include a parent chooser for merges, binary/renamed-file states, loading/empty/error/truncated states and refresh. Do not silently select a different commit on refresh.
- Use bounded rendering/virtualization for long histories or diffs where needed. Support keyboard selection, narrow panes and dark/light themes. Display untrusted strings as text.
- **Done:** UI tests cover graph/commit/file selection, merge parents, binary and truncated diffs, refresh and stale requests; tested with a fixture repository, not a user's repository.

### 7. End-to-end integration, packaging and release verification (L; after 1–6)

- Integration owner wires `electron/main.mjs`, `electron/preload.cjs`, `electron/bridge-contract.json`, `src/types/ogb.d.ts`, `src/components/TerminalPage.tsx`, resource cleanup and `electron-builder.yml`/packaging scripts. Delegates hand off modules, not competing edits to those files.
- Extend `scripts/verify-terminal.mjs` or a separate fixture with a temporary HOME, isolated Electron profile, synthetic shell and temporary Git repository. Use real PTY, preload, IPC, CLI and renderer. Test `cd` then `rnz view` file/folder, navigate a nested folder, edit and save a file, verify its bytes on disk, then run `rnz git`, select a commit and inspect a diff; keep the source shell interactive throughout.
- Test failure paths: unavailable/stale endpoint, bad/cross-session capability, remote page, document navigation, concurrent requests, full layout, missing/oversized files, outside-root links, save conflicts and failed writes, unsaved-close/navigation guards, no Git repository, binary and merge changes. Verify saved terminal state remains valid and temporary panes do not restore.
- Run project lint/typecheck, relevant unit and Electron tests, terminal fixture and package smoke. Inspect screenshots once in both themes at desktop and narrow widths. Package-test the actual command and resource paths separately on every platform claimed as supported; record untested platforms explicitly.
- Update `docs/verification/terminal.md` with the precise fixture and coverage boundaries. No verification against the user's live app, files, repositories or credentials.
- **Done:** a packaged local app can execute both commands, the acceptance journeys pass in isolated fixtures, all cleanup/security regressions pass, and platform evidence is recorded.

## Integration order and parallel work

1. **0 first:** confirm assumptions and freeze contracts; no delegate edits shared integration files.
2. **Parallel wave:** 1, 2 and 3 build transport, files and Git against frozen contracts; 5 and 6 may build against fixtures/mocks once their interfaces are frozen. The integration owner prepares 4.
3. Integrate 1–6 incrementally under 7, including editing and saving. Run the isolated end-to-end fixture and Linux/macOS packaging checks. Repair cross-slice issues in the integration owner's branch.

A delegate must start from a snapshot that includes the current uncommitted terminal files. A fresh Git worktree will not automatically contain them; coordinate the snapshot explicitly. Do not run cleanup/reset operations on the user's working tree. Do not delegate multiple slices that write the same integration files at the same time.

## Acceptance checklist

- [ ] From an existing RanzoBot shell after `cd`, `rnz view 'file with spaces'` opens the correct editor beside that shell; editing and saving updates the intended file.
- [ ] `rnz view folder` navigates nested directories, opens a selected file and cannot traverse out of the granted root through paths or symlinks.
- [ ] `rnz git` in a repository subdirectory opens a navigable commit graph; choosing a commit and file shows the correct diff, including root and merge commits.
- [ ] Unsaved changes require confirmation before dismissal; failed/conflicting saves keep the draft and report the issue. Line endings, BOM and permissions are handled as specified.
- [ ] Missing paths, binary/large files, non-repositories, timeouts and truncated data are understandable; CLI errors use nonzero exits.
- [ ] Concurrent commands route to the correct source pane; terminal input, splitting, moving, resizing, maximize, close and v1 persistence remain functional.
- [ ] Remote/unauthorized callers cannot obtain host resources. Tokens, file contents and repository data do not reach bots, remote pages or logs.
- [ ] Isolated real-PTY/renderer tests, security regressions and applicable packaging tests pass. Unsupported or untested platforms are stated, not assumed.
