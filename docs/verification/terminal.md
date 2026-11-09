# Terminal tiling and independent PTY smoke

The terminal uses nested row/column groups with weighted dividers. Use **Arrange panes** for 1×2, 2×1, 2×2, 2×3, 3×2, 3×3 and 4×4 grids (rows × columns), or a single row/column of existing panes. Presets add missing terminals but never close existing ones; smaller grids are disabled. The 1×1 action maximizes the active pane and restores the previous layout on the next click.

Each pane has split-right, split-below and maximize controls. Drag its grip to a side to insert, the center to swap, or an outer edge to dock beside the target group. Arrow keys on the grip move panes; arrow keys on a divider resize it. Escape cancels a drag. Small windows scroll instead of shrinking panes below their minimum size.

The shell inherits the host's graphical display and XDG configuration variables, so graphical commands such as `gitk` can use the desktop session. Other application environment variables remain filtered; provider credentials can be configured through the shell or the provider's own sign-in.

## `rnz` workspace panes

In the local Linux or macOS terminal, `rnz view file`, `rnz view folder`, and `rnz git` open a pane beside the issuing shell. Paths resolve from that command's working directory; quote names with spaces. `rnz view` and `rnz git` default to the current directory. The file editor has explicit Save and Ctrl/⌘-S; a changed or deleted file causes a conflict instead of replacing the observed change. Unsaved panes ask before closing or leaving. Git history is read-only.

File panes accept UTF-8 regular files up to 4 MiB. Mixed-line-ending or hard-linked files are read-only. Symlinks are not followed, and a folder with more than 500 entries reports a limit instead of a partial listing. Git requires an installed Git executable; diff output is bounded. Resource panes and unsaved drafts are not restored after a crash or after leaving the page. The capability in a shell's environment is inherited by its child processes, which can request panes but cannot retrieve file contents over that command channel.

Known save limitations: the revision check and rename are not an atomic compare-and-swap against an unrelated writer; a concurrent write in between can be lost. Path-based checks cannot eliminate every symlink/namespace race. Atomic replacement preserves mode and owner/group where possible, but not ACLs or extended attributes, and the parent directory is not fsynced. Do not claim stronger guarantees without a platform-specific solution.

The layout follows the [Wave Terminal source reference](../../third_party/waveterm/README.md). There is a 16-session resource limit. The local app profile saves pane names, nested split weights, active/maximized pane and up to 128 KB of recent plain-text scrollback per pane. Restore starts a new shell in the home directory; it does not resume foreground processes or restore the working directory. Leaving Terminal closes PTYs, but saved panes and output return when the page is reopened. This state is local-only and never available to bots or remote pages.

## Independent smoke

Run the installed Electron binary against a disposable interactive shell and the real `@lydell/node-pty` native module:

```sh
xvfb-run -a node scripts/verify-terminal.mjs
```

On macOS, run `node scripts/verify-terminal.mjs` from a graphical session. Linux uses Xvfb so no window appears on the user's desktop. Prerequisites are installed project dependencies, Node, and `xvfb-run` on headless Linux.

The script creates a temporary Electron fixture app rather than launching the repository's normal Electron entry point. Its `HOME`, XDG config/cache/data, temp directory, Electron `userData`/`sessionData`, synthetic shell and Vite cache are isolated under a temporary directory. The shell is a fixture wrapper around `/bin/sh -i`; it does not read the user's shell startup files. The fixture is removed on success and retained with logs on failure. Add `--keep-fixture` to retain a successful fixture and its desktop grid, custom-layout and narrow-window screenshots for inspection.

The smoke verifies:

- Electron loads the real native PTY and starts the synthetic interactive shell.
- Input produces output; resizing changes the PTY's reported dimensions (`stty size`).
- On Linux, when `/usr/bin/gitk` is installed, it starts against a disposable Git repository on the fixture display. With `/usr/bin/xwininfo`, the fixture also verifies its window.
- Ctrl-C interrupts a foreground command, subsequent input still works, and `exit` reports code 0.
- Explicit close removes the session and terminates the shell process.
- The real preload bridge and `TerminalPage` work through fixture-registered terminal IPC: renderer input/output, a renderer resize reaching the PTY, Ctrl-C, shell exit and UI-triggered cleanup.
- Side drops move panes left, right, above and below; center drops swap panes and outer-edge drops span the target group.
- Horizontal and vertical divider drags change the shell's reported PTY size.
- A 3×3 grid runs nine real shells, each accepting input. Maximizing to 1×1 and restoring keeps terminal DOM nodes, processes and hidden output intact.
- A narrow window scrolls the grid instead of crushing panes below their minimum size. Closing added panes updates the persisted session list; saved recent output and layout reload through the private main-process state store. Pane names remain accessible without being displayed in the compact pane controls.
- `rnz view` opens, edits and saves a fixture file after `cd`, preserving its UTF-8 BOM and CRLF; cancelled close keeps the draft, and an external modification causes a conflict without overwriting it. `rnz view .` navigates a nested folder and opens its file. `rnz git` shows a fixture commit and its diff, while the original shell stays interactive.
- Pane closing emits no renderer JavaScript error in the isolated Electron fixture.
- Escape and out-of-layout drops cancel moves; switching maximized panes focuses the visible terminal. Dark/light and narrow-window captures support visual inspection.

The renderer is the source `TerminalPage` served from an isolated Vite fixture, not the full application. The fixture uses the production preload and terminal IPC/session modules, with the same frame/origin/token authorization helper. Browser requests are restricted to the fixture's loopback origin; API routes return local 404s and the Vite proxy target is port 0. The script starts only its disposable local Vite server and contacts no pre-existing/live application server, external host, workspace data or credentials.

Coverage boundary: this does not launch `electron/main.mjs`, so it does not verify the app's production window lifecycle, local-workspace gating, document-token issuance/revocation, native unsaved-change dialogs, navigation cleanup wiring or navigation to the Terminal page. It also does not verify packaged `terminal-runtime` loading or test on macOS or Windows. Those are outside this independent real-PTY smoke.

The packaged Linux command and Electron Node runtime can be checked separately without launching the normal app or accessing a real home:

```sh
node scripts/verify-rnz-package.mjs /absolute/path/to/linux-unpacked
```

This checks the packaged executable and CLI resource against a temporary socket and file; it does not check the production app window or a packaged PTY. The macOS package and hardened runtime have not been verified.

Recorded run:

```text
Command: rtk xvfb-run -a node scripts/verify-terminal.mjs
Result: passed; disposable fixture removed
Platform: linux
Electron: 43.7.9 (Node 24.21.0)
@lydell/node-pty: 1.2.0-beta.18
```
