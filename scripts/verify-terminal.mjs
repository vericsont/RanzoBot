import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const fixtureEnv = "OMB_TERMINAL_FIXTURE";
const timeoutMs = 8_000;

function fixtureEnvironment(output, shell) {
  const home = join(output, "home");
  const tmp = join(output, "tmp");
  mkdirSync(home, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: home,
    USER: "terminal-fixture",
    LOGNAME: "terminal-fixture",
    SHELL: shell,
    LANG: "C.UTF-8",
    TMPDIR: tmp,
    XDG_CONFIG_HOME: join(output, "config"),
    XDG_CACHE_HOME: join(output, "cache"),
    XDG_DATA_HOME: join(output, "data"),
    APPDATA: join(output, "config", "roaming"),
    LOCALAPPDATA: join(output, "data", "local"),
    ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
    ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
  };
}

async function startRendererFixture(output) {
  const { createServer } = await import("vite");
  const fixturePage = `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">
import React, { createElement } from "react";
import { createRoot } from "react-dom/client";
import { TerminalPage } from "/src/components/TerminalPage.tsx";
import "/src/styles.css";
document.documentElement.style.cssText = "width:100%;height:100%;margin:0";
document.body.style.cssText = "width:100%;height:100%;margin:0";
document.querySelector("#root").style.cssText = "display:flex;width:100%;height:100%";
createRoot(document.querySelector("#root")).render(createElement(TerminalPage));
</script></body></html>`;
  const terminalFixturePlugin = {
    name: "terminal-verification-fixture",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
        if (pathname.startsWith("/api/") || pathname === "/.well-known/openmausbot/environment") {
          response.statusCode = 404;
          response.end();
          return;
        }
        if (pathname !== "/__terminal_fixture__") return next();
        void server.transformIndexHtml(request.url ?? pathname, fixturePage).then(html => {
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.end(html);
        }, next);
      });
    },
  };
  const previousPort = process.env.OMB_PORT;
  process.env.OMB_PORT = "0";
  let server;
  try {
    server = await createServer({
      configFile: join(root, "vite.config.ts"),
      cacheDir: join(output, "vite-cache"),
      plugins: [terminalFixturePlugin],
      server: { host: "127.0.0.1", port: 0, strictPort: true },
    });
    await server.listen();
  } catch (error) {
    await server?.close();
    throw error;
  } finally {
    if (previousPort === undefined) delete process.env.OMB_PORT;
    else process.env.OMB_PORT = previousPort;
  }
  const address = server.httpServer.address();
  assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}/__terminal_fixture__`, close: () => server.close() };
}

async function runElectron(output, shell, rendererUrl) {
  const electron = require("electron");
  const app = join(output, "app");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "terminal-fixture", version: "1.0.0", main: "main.mjs", type: "module" }));
  writeFileSync(join(app, "main.mjs"), `await import(${JSON.stringify(new URL("./verify-terminal.mjs", import.meta.url).href)});\n`);
  const env = { ...fixtureEnvironment(output, shell), [fixtureEnv]: "1", OMB_TERMINAL_OUTPUT: output, OMB_TERMINAL_RENDERER_URL: rendererUrl };
  const args = [];
  if (process.platform === "linux") args.push("--no-sandbox", "--disable-gpu");
  args.push(app);
  const child = spawn(electron, args, { cwd: output, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { log += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { log += chunk; });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 60_000);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (value, signal) => resolve(value ?? (signal ? 1 : 0)));
  }).finally(() => clearTimeout(watchdog));
  writeFileSync(join(output, "electron.log"), log);
  if (code !== 0) {
    console.error(log || "Electron exited without diagnostic output.");
    try { console.error(readFileSync(join(output, "progress.log"), "utf8")); } catch {}
  }
  assert.equal(code, 0, "Electron PTY fixture failed");
  const receipt = JSON.parse(readFileSync(join(output, "receipt.json"), "utf8"));
  assert.equal(receipt.passed, true);
  return receipt;
}

async function waitFor(check, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function verifyBridgeRenderer({ BrowserWindow, ipcMain, session, pty, home, rendererUrl, progress, createTerminalSessions, registerTerminalIpc, terminalSenderAllowed, createTerminalStateStore, createTerminalResources, createTerminalFiles, createTerminalGit, createRnzTransport }) {
  const origin = new URL(rendererUrl).origin;
  session.defaultSession.webRequest.onBeforeRequest(({ url }, callback) => {
    let protocol;
    let requestOrigin;
    try {
      const parsed = new URL(url);
      protocol = parsed.protocol;
      requestOrigin = parsed.origin;
    } catch {}
    callback({ cancel: requestOrigin !== origin && !["data:", "blob:", "about:"].includes(protocol) });
  });
  let window;
  let resources;
  const sessionIds = [];
  const transport = createRnzTransport({ onRequest: request => resources.open(request) });
  await transport.start();
  const manager = createTerminalSessions({
    loadPty: () => pty,
    env: { PATH: "/usr/bin:/bin", HOME: home, USER: "terminal-fixture", LOGNAME: "terminal-fixture", SHELL: process.env.SHELL, LANG: "C.UTF-8" },
    home,
    sessionEnvironment: (id, owner) => ({ ...transport.addSession(id, owner), RNZ_NODE: process.execPath, RNZ_CLI: join(root, "electron/rnz-cli.mjs"), PATH: `${join(root, "electron")}:/usr/bin:/bin` }),
    onRemove: (owner, id) => { transport.revoke(id); resources.closeSession(owner, id); },
    onData: (owner, id, data, sequence) => owner.send("host-terminal:data", id, data, sequence),
    onExit: (owner, id, code) => owner.send("host-terminal:exit", id, code),
  });
  resources = createTerminalResources({ files: createTerminalFiles(), git: createTerminalGit(), sessionAllowed: (owner, id) => manager.owns(owner, id), ownerAllowed: owner => Boolean(window && !window.isDestroyed() && window.webContents === owner) });
  const sessions = {
    start(owner, input) {
      const result = manager.start(owner, input);
      sessionIds.push(result.id);
      return result;
    },
    attach: (...args) => manager.attach(...args),
    ack: (...args) => manager.ack(...args),
    write: (...args) => manager.write(...args),
    resize: (...args) => manager.resize(...args),
    close: (...args) => manager.close(...args),
  };
  const documentToken = randomUUID();
  const terminalStateStore = createTerminalStateStore({ file: join(home, "..", "terminal-state.json") });
  registerTerminalIpc({
    ipcMain,
    sessions,
    terminalState: terminalStateStore,
    resources,
    authorize: (event, token) => {
      if (!terminalSenderAllowed(event, {
        owner: window,
        localOrigin: origin,
        localWorkspace: true,
        token,
        expectedToken: documentToken,
      })) throw new Error("Terminal fixture authorization failed");
      return event.sender;
    },
  });
  const text = key => window.webContents.executeJavaScript(`(() => {
    const pane = [...document.querySelectorAll("[data-terminal-pane]")].find(item => item.dataset.terminalPane === ${JSON.stringify(key)});
    const terminal = pane?.querySelector(".xterm-rows");
    return terminal?.innerText ?? terminal?.textContent ?? "";
  })()`);
  const until = async (check, description) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await delay(30);
    }
    const state = await window.webContents.executeJavaScript(`JSON.stringify({
      body: document.body.innerText,
      buttons: [...document.querySelectorAll("button")].map(button => [button.textContent.trim(), button.disabled]),
      remote: window.ogb?.remoteClient?.active,
      bridge: typeof window.ogb?.hostTerminal?.start,
    })`).catch(() => "<destroyed>");
    throw new Error(`Timed out waiting for renderer ${description}: ${state}`);
  };
  const typeLine = async line => {
    await window.webContents.executeJavaScript("document.querySelector('.xterm-helper-textarea')?.focus()");
    for (const character of line) window.webContents.sendInputEvent({ type: "char", keyCode: character });
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "ENTER" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "ENTER" });
  };
  const write = (id, data) => window.webContents.executeJavaScript(
    `window.ogb.hostTerminal.write(${JSON.stringify(id)}, ${JSON.stringify(data)})`,
  );
  const sizes = value => [...value.replaceAll("\r", "").matchAll(/(?:^|\n)(\d{1,3})\s+(\d{1,3})(?:\n|$)/g)].map(match => `${match[1]}x${match[2]}`);

  const rendererErrors = [];
  try {
    window = new BrowserWindow({
      show: true,
      width: 960,
      height: 700,
      webPreferences: {
        preload: join(root, "electron/preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        additionalArguments: [`--omb-local-origin=${origin}`],
      },
    });
    window.webContents.on("console-message", details => {
      if (details.level === "error") rendererErrors.push({ message: details.message, line: details.lineNumber, source: details.sourceId });
    });
    await window.loadURL(rendererUrl);
    await window.webContents.executeJavaScript(`globalThis.__terminalErrors = []; window.addEventListener("error", event => globalThis.__terminalErrors.push(event.message)); window.addEventListener("unhandledrejection", event => globalThis.__terminalErrors.push(String(event.reason)));`);
    window.webContents.send("host-terminal:document-token", documentToken);
    window.focus();
    await until(() => window.webContents.executeJavaScript(
      `typeof window.ogb?.hostTerminal?.start === "function" && Boolean(document.querySelector("[data-terminal-page]"))`,
    ), "mounted real TerminalPage and preload bridge");
    progress("preload-renderer-ready");
    await until(() => window.webContents.executeJavaScript(
      `[...document.querySelectorAll("button")].find(button => button.textContent.trim() === "New terminal")?.disabled === false`,
    ), "terminal page bridge listeners");
    await window.webContents.executeJavaScript(`
      [...document.querySelectorAll("button")].find(button => button.textContent.trim() === "New terminal")?.click()
    `);
    await until(() => window.webContents.executeJavaScript(
      `document.querySelector('[data-terminal-pane]')?.getAttribute('aria-label') === "Terminal 1" && document.body.innerText.includes("Connected")`,
    ), "first bridged PTY session");
    await until(() => window.webContents.executeJavaScript("Boolean(document.querySelector('.xterm-helper-textarea'))"), "xterm input surface");

    const firstKey = await window.webContents.executeJavaScript(`document.querySelector('[data-terminal-pane]').dataset.terminalPane`);
    await typeLine("echo RENDERER_BRIDGE_OUTPUT");
    await until(async () => (await text(firstKey)).includes("RENDERER_BRIDGE_OUTPUT"), "renderer input and bridged output");

    const firstSessionId = sessionIds.at(-1);
    assert.ok(firstSessionId);
    const repo = join(home, "rnz-project");
    mkdirSync(join(repo, "nested"), { recursive: true });
    writeFileSync(join(repo, "hello.txt"), "\uFEFFfixture line\r\n");
    writeFileSync(join(repo, "conflict.txt"), "initial\n");
    writeFileSync(join(repo, "nested", "inner.txt"), "nested fixture\n");
    const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    execFileSync("git", ["init", "-q"], { cwd: repo, env: gitEnv });
    execFileSync("git", ["add", "--", "hello.txt", "conflict.txt", "nested/inner.txt"], { cwd: repo, env: gitEnv });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Fixture commit"], { cwd: repo, env: gitEnv });
    await write(firstSessionId, 'cd "$HOME/rnz-project"; rnz view hello.txt\r');
    await until(() => window.webContents.executeJavaScript(`Boolean(document.querySelector('[data-terminal-pane][aria-label="hello.txt"] .cm-content'))`), "rnz opens an editable file beside its shell");
    await window.webContents.executeJavaScript(`(() => { const el = document.querySelector('[data-terminal-pane][aria-label="hello.txt"] .cm-content'); el.focus(); const range = document.createRange(); range.selectNodeContents(el); range.collapse(false); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); })()`);
    window.webContents.sendInputEvent({ type: "char", keyCode: "X" });
    await until(() => window.webContents.executeJavaScript(`document.querySelector('[data-terminal-pane][aria-label="hello.txt"]')?.innerText.includes('Unsaved changes')`), "file edit becomes dirty");
    await window.webContents.executeJavaScript(`window.confirm = () => false; document.querySelector('button[aria-label="Close hello.txt"]').click()`);
    assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('[data-terminal-pane][aria-label="hello.txt"]'))`), true, "cancelled close discarded the editor");
    assert.equal(readFileSync(join(repo, "hello.txt"), "utf8"), "\uFEFFfixture line\r\n", "unsaved edit changed the file");
    await window.webContents.executeJavaScript(`document.querySelector('[data-terminal-pane][aria-label="hello.txt"] button:not([aria-label])')?.click()`);
    await until(() => readFileSync(join(repo, "hello.txt"), "utf8").includes("X"), "saving the edited fixture file");
    assert.equal(readFileSync(join(repo, "hello.txt"), "utf8"), "\uFEFFfixture line\r\nX", "editor changed the original BOM or line endings");
    await until(() => window.webContents.executeJavaScript(`!document.querySelector('[data-terminal-pane][aria-label="hello.txt"]')?.innerText.includes('Unsaved changes')`), "saved editor becomes clean");
    writeFileSync(join(home, "..", "rnz-editor.png"), (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript(`document.documentElement.setAttribute('data-skin', 'daylight')`);
    await delay(150);
    writeFileSync(join(home, "..", "rnz-editor-light.png"), (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript(`document.documentElement.setAttribute('data-skin', 'midnight')`);
    window.setSize(640, 700);
    await delay(150);
    writeFileSync(join(home, "..", "rnz-editor-narrow.png"), (await window.webContents.capturePage()).toPNG());
    window.setSize(960, 700);
    await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="Close hello.txt"]').click()`);
    await until(() => window.webContents.executeJavaScript(`!document.querySelector('[data-terminal-pane][aria-label="hello.txt"]')`), "closing the editor pane");
    await write(firstSessionId, "rnz view conflict.txt\r");
    await until(() => window.webContents.executeJavaScript(`Boolean(document.querySelector('[data-terminal-pane][aria-label="conflict.txt"] .cm-content'))`), "opening the conflict fixture");
    await window.webContents.executeJavaScript(`(() => { const el = document.querySelector('[data-terminal-pane][aria-label="conflict.txt"] .cm-content'); el.focus(); const range = document.createRange(); range.selectNodeContents(el); range.collapse(false); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); })()`);
    window.webContents.sendInputEvent({ type: "char", keyCode: "X" });
    await until(() => window.webContents.executeJavaScript(`document.querySelector('[data-terminal-pane][aria-label="conflict.txt"]')?.innerText.includes('Unsaved changes')`), "conflict draft becomes dirty");
    writeFileSync(join(repo, "conflict.txt"), "external change\n");
    await window.webContents.executeJavaScript(`document.querySelector('[data-terminal-pane][aria-label="conflict.txt"] button:not([aria-label])').click()`);
    await until(() => window.webContents.executeJavaScript(`document.querySelector('[data-terminal-pane][aria-label="conflict.txt"]')?.innerText.includes('Conflict:')`), "external file change is reported");
    assert.equal(readFileSync(join(repo, "conflict.txt"), "utf8"), "external change\n");
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-terminal-pane][aria-label="conflict.txt"] .cm-content')?.textContent.includes('X')`), true, "conflict discarded the draft");
    await window.webContents.executeJavaScript(`window.confirm = () => true; document.querySelector('button[aria-label="Close conflict.txt"]').click()`);
    await until(() => window.webContents.executeJavaScript(`!document.querySelector('[data-terminal-pane][aria-label="conflict.txt"]')`), "discarding the conflict fixture");
    await write(firstSessionId, "rnz view .\r");
    await until(() => window.webContents.executeJavaScript(`Boolean(document.querySelector('[data-terminal-pane][aria-label="rnz-project"] button[aria-label="nested, directory"]'))`), "rnz opens a directory");
    await window.webContents.executeJavaScript(`document.querySelector('[data-terminal-pane][aria-label="rnz-project"] button[aria-label="nested, directory"]').click()`);
    await until(() => window.webContents.executeJavaScript(`Boolean(document.querySelector('[data-terminal-pane][aria-label="rnz-project"] button[aria-label="inner.txt"]'))`), "navigating a nested directory");
    await window.webContents.executeJavaScript(`document.querySelector('[data-terminal-pane][aria-label="rnz-project"] button[aria-label="inner.txt"]').click()`);
    await until(() => window.webContents.executeJavaScript(`document.querySelector('[data-terminal-pane][aria-label="rnz-project"] .cm-content')?.textContent.includes('nested fixture')`), "opening a nested file");
    await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="Close rnz-project"]').click()`);
    await until(() => window.webContents.executeJavaScript(`!document.querySelector('[data-terminal-pane][aria-label="rnz-project"]')`), "closing the directory pane");
    await write(firstSessionId, "rnz git\r");
    await until(() => window.webContents.executeJavaScript(`Boolean(document.querySelector('[aria-label="Git history"]')) && document.querySelector('[aria-label="Git history"]').innerText.includes('Fixture commit')`), "rnz opens Git history");
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('[aria-label="Git history"] button')].find(button => button.textContent.includes('Fixture commit'))?.click()`);
    await until(() => window.webContents.executeJavaScript(`Boolean(document.querySelector('[aria-label="Changed file"]'))`), "commit file list");
    await window.webContents.executeJavaScript(`(() => { const select = document.querySelector('[aria-label="Changed file"]'); select.value = [...select.options].find(option => option.textContent.includes('hello.txt')).value; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await until(() => window.webContents.executeJavaScript(`document.querySelector('[aria-label="Git history"]')?.innerText.includes('fixture line')`), "selecting a commit displays its diff");
    writeFileSync(join(home, "..", "rnz-git.png"), (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="Close rnz-project"]').click()`);
    await until(() => window.webContents.executeJavaScript(`!document.querySelector('[aria-label="Git history"]')`), "closing Git history");
    progress("rnz-workspace-verified");
    await write(firstSessionId, "stty size\r");
    await until(async () => sizes(await text(firstKey)).length > 0, "renderer-reported initial terminal size");
    const initialSize = sizes(await text(firstKey)).at(-1);
    window.setSize(1200, 850);
    await delay(350);
    await write(firstSessionId, "stty size\r");
    await until(async () => sizes(await text(firstKey)).some(size => size !== initialSize), "renderer resize reaching the PTY");

    await window.webContents.executeJavaScript(`
      [...document.querySelectorAll("button")].find(button => button.textContent.trim() === "New terminal" && !button.disabled)?.click()
    `);
    await until(() => window.webContents.executeJavaScript(
      `document.querySelectorAll('[data-terminal-pane]').length === 2 && [...document.querySelectorAll('[data-terminal-pane]')].every(pane => pane.innerText.includes('Connected'))`,
    ), "two visible bridged PTY sessions");
    const secondSessionId = sessionIds.at(-1);
    const secondKey = await window.webContents.executeJavaScript(`document.querySelectorAll('[data-terminal-pane]')[1].dataset.terminalPane`);
    assert.ok(secondSessionId && secondSessionId !== firstSessionId);
    await write(secondSessionId, "echo SECOND_TILE_OUTPUT\r");
    await until(async () => (await text(secondKey)).includes("SECOND_TILE_OUTPUT"), "second tile output");

    const run = script => window.webContents.executeJavaScript(script);
    const click = label => run(`document.querySelector('button[aria-label="${label}"]')?.click()`);
    const paneRect = key => run(`(() => { const r = document.querySelector('[data-terminal-pane="${key}"]').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
    const chooseLayout = async value => {
      await run(`(() => { const select = document.querySelector('select[aria-label="Arrange panes"]'); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await delay(100);
    };
    const sendMouse = (type, x, y, extra = {}) => window.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), ...extra });
    const dragOver = async (from, to) => {
      sendMouse("mouseMove", from.x, from.y);
      sendMouse("mouseDown", from.x, from.y, { button: "left", clickCount: 1 });
      for (let step = 1; step <= 10; step++) {
        sendMouse("mouseMove", from.x + (to.x - from.x) * step / 10, from.y + (to.y - from.y) * step / 10, { button: "left", modifiers: ["leftButtonDown"] });
        await delay(15);
      }
    };
    const drag = async (from, to) => { await dragOver(from, to); sendMouse("mouseUp", to.x, to.y, { button: "left", clickCount: 1 }); };
    const dragPane = async (source, target, x, y) => {
      const from = await run(`(() => { const r = document.querySelector('[data-terminal-pane="${source}"] button').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      const to = await paneRect(target);
      await drag(from, { x: to.left + to.width * x, y: to.top + to.height * y });
    };
    for (const [edge, x, y] of [["bottom", 0.5, 0.7], ["top", 0.5, 0.3], ["left", 0.3, 0.5], ["right", 0.7, 0.5]]) {
      await dragPane(secondKey, firstKey, x, y);
      await until(async () => {
        const first = await paneRect(firstKey); const second = await paneRect(secondKey);
        if (edge === "bottom") return second.top >= first.top + first.height;
        if (edge === "top") return first.top >= second.top + second.height;
        if (edge === "left") return first.left >= second.left + second.width;
        return second.left >= first.left + first.width;
      }, `dragging a pane to the ${edge}`);
      assert.equal(sessionIds.length, 2, `${edge} drop restarted a shell`);
    }
    const beforeSwap = await paneRect(firstKey);
    await dragPane(secondKey, firstKey, 0.5, 0.5);
    await until(async () => (await paneRect(secondKey)).left === beforeSwap.left, "center drop swaps panes");
    await dragPane(secondKey, firstKey, 0.7, 0.5);
    await until(async () => (await paneRect(secondKey)).left > (await paneRect(firstKey)).left, "restoring side-by-side panes");
    assert.ok((await text(firstKey)).includes("RENDERER_BRIDGE_OUTPUT"));
    assert.ok((await text(secondKey)).includes("SECOND_TILE_OUTPUT"));

    for (const [layout, orientation, dimension, dx, dy] of [["1x2", "vertical", "width", 70, 0], ["2x1", "horizontal", "height", 0, 70]]) {
      await chooseLayout(layout);
      await delay(250);
      await write(firstSessionId, "stty size\r");
      await delay(150);
      const beforeSize = sizes(await text(firstKey)).at(-1);
      const beforeRect = await paneRect(firstKey);
      const divider = await run(`(() => { const r = document.querySelector('[role="separator"][aria-orientation="${orientation}"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await drag(divider, { x: divider.x + dx, y: divider.y + dy });
      await until(async () => (await paneRect(firstKey))[dimension] > beforeRect[dimension] + 30, `resizing ${orientation} divider`);
      await delay(200);
      await write(firstSessionId, "stty size\r");
      await until(async () => { const current = sizes(await text(firstKey)).at(-1); return current && current !== beforeSize; }, `${orientation} divider resize reaching the PTY`);
    }
    await chooseLayout("2x2");
    await until(() => run(`document.querySelectorAll('[data-terminal-pane]').length === 4 && [...document.querySelectorAll('[data-terminal-pane]')].every(pane => pane.innerText.includes('Connected'))`), "four connected shells");
    const fourthKey = await run(`document.querySelector('[data-terminal-pane][aria-label="Terminal 4"]').dataset.terminalPane`);
    await dragPane(fourthKey, firstKey, 0.5, 0.05);
    await until(async () => {
      const fourth = await paneRect(fourthKey); const first = await paneRect(firstKey);
      return fourth.width > first.width * 1.8 && fourth.top < first.top;
    }, "outer drop spans the target row");
    writeFileSync(join(home, "..", "custom-layout.png"), (await window.webContents.capturePage()).toPNG());

    await chooseLayout("3x3");
    await until(() => run(`document.querySelectorAll('[data-terminal-pane]').length === 9 && [...document.querySelectorAll('[data-terminal-pane]')].every(pane => pane.innerText.includes('Connected'))`), "nine connected shells");
    const grid = await run(`(() => { const panes = [...document.querySelectorAll('[data-terminal-pane]')].map(p => p.getBoundingClientRect()); return { rows: new Set(panes.map(p => p.top)).size, columns: new Set(panes.map(p => p.left)).size }; })()`);
    assert.deepEqual(grid, { rows: 3, columns: 3 });
    assert.equal(sessionIds.length, 9);
    await run(`globalThis.terminalFixtureSurfaces = [...document.querySelectorAll('[data-terminal-surface]')]`);
    const firstIdByName = new Map(await run(`([...document.querySelectorAll('[data-terminal-pane]')].map(p => [p.getAttribute('aria-label'), p.dataset.terminalPane]))`));
    for (let index = 0; index < 9; index++) await write(sessionIds[index], `echo TILE_${index + 1}_OK\r`);
    await until(async () => {
      for (let index = 0; index < 9; index++) if (!(await text(firstIdByName.get(`Terminal ${index + 1}`))).includes(`TILE_${index + 1}_OK`)) return false;
      return true;
    }, "all nine shells accept input");
    writeFileSync(join(home, "..", "grid-3x3.png"), (await window.webContents.capturePage()).toPNG());
    await click("Maximize Terminal 1");
    await until(() => run(`document.querySelectorAll('[data-terminal-pane]:not([hidden])').length === 1`), "1×1 maximized pane");
    await write(secondSessionId, "echo HIDDEN_ALIVE\r");
    await click("Restore layout");
    await until(() => run(`document.querySelectorAll('[data-terminal-pane]:not([hidden])').length === 9`), "restore 3×3");
    await until(async () => (await text(secondKey)).includes("HIDDEN_ALIVE"), "hidden terminal output survives maximize");
    assert.equal(await run(`globalThis.terminalFixtureSurfaces.every(node => node.isConnected && [...document.querySelectorAll('[data-terminal-surface]')].includes(node))`), true, "layout remounted terminal surfaces");
    assert.equal(sessionIds.length, 9, "layout changes restarted shells");

    await click("Maximize Terminal 1");
    await until(() => run(`document.querySelectorAll('[data-terminal-pane]:not([hidden])').length === 1`), "maximize first pane");
    await click("Restore layout");
    await until(() => run(`document.querySelectorAll('[data-terminal-pane]:not([hidden])').length === 9`), "restore before changing panes");
    await click("Move Terminal 2");
    await click("Maximize Terminal 2");
    await until(() => run(`document.activeElement?.classList.contains('xterm-helper-textarea') && document.activeElement.closest('[data-terminal-pane]')?.getAttribute('aria-label') === 'Terminal 2'`), "maximizing a pane focuses its shell");
    await click("Restore layout");
    await until(() => run(`document.querySelectorAll('[data-terminal-pane]:not([hidden])').length === 9`), "restore layout after changing panes");
    const beforeCancel = await paneRect(firstKey);
    const fromCancel = await run(`(() => { const r = document.querySelector('[data-terminal-pane="${secondKey}"] button').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await dragOver(fromCancel, { x: beforeCancel.left + beforeCancel.width / 2, y: beforeCancel.top + beforeCancel.height / 2 });
    await until(() => run(`Boolean(document.querySelector('[data-terminal-drop-preview]'))`), "drop preview before cancel");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "ESCAPE" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "ESCAPE" });
    sendMouse("mouseUp", beforeCancel.left + beforeCancel.width / 2, beforeCancel.top + beforeCancel.height / 2, { button: "left", clickCount: 1 });
    await until(() => run(`!document.querySelector('[data-terminal-drop-preview]')`), "Escape cancels a pane drag");
    assert.deepEqual(await paneRect(firstKey), beforeCancel);
    await drag(fromCancel, { x: 20, y: 20 });
    assert.deepEqual(await paneRect(firstKey), beforeCancel, "dropping outside the layout moved a pane");
    await run(`document.documentElement.setAttribute('data-skin', 'daylight')`);
    await delay(250);
    writeFileSync(join(home, "..", "grid-light.png"), (await window.webContents.capturePage()).toPNG());
    await run(`document.documentElement.setAttribute('data-skin', 'midnight')`);

    window.setSize(640, 700);
    await delay(250);
    const narrow = await run(`(() => { const view = document.querySelector('[data-terminal-viewport]'); return { scrollable: view.scrollWidth > view.clientWidth, minWidth: Math.min(...[...document.querySelectorAll('[data-terminal-pane]')].map(p => p.getBoundingClientRect().width)) }; })()`);
    assert.equal(narrow.scrollable, true);
    assert.ok(narrow.minWidth >= 239);
    writeFileSync(join(home, "..", "grid-narrow.png"), (await window.webContents.capturePage()).toPNG());
    window.setSize(1200, 850);
    rendererErrors.length = 0;
    await run("globalThis.__terminalErrors.length = 0");
    for (let number = 3; number <= 9; number++) await click(`Close Terminal ${number}`);
    await until(() => run(`document.querySelectorAll('[data-terminal-pane]').length === 2`), "closing extra grid panes");
    await delay(300);
    const pageErrors = await run("globalThis.__terminalErrors");
    assert.deepEqual(rendererErrors, [], "closing a pane wrote a JavaScript error to the Electron renderer console");
    assert.deepEqual(pageErrors, [], "closing a pane raised a JavaScript error in the renderer");
    await chooseLayout("2x1");
    await write(firstSessionId, "echo FIRST_TILE_ALIVE\r");
    await write(secondSessionId, "echo SECOND_TILE_ALIVE\r");
    await until(async () => (await text(firstKey)).includes("FIRST_TILE_ALIVE") && (await text(secondKey)).includes("SECOND_TILE_ALIVE"), "original shells remain interactive after grid changes and closes");
    await delay(350);
    const savedState = terminalStateStore.load();
    assert.equal(savedState.sessions.length, 2, "saved terminal sessions did not follow closes");
    assert.equal(savedState.sessions.find(item => item.key === firstKey)?.transcript.includes("FIRST_TILE_ALIVE"), true, "saved transcript omitted recent output");
    const savedPaneCount = node => node.kind === "pane" ? 1 : node.children.reduce((count, child) => count + savedPaneCount(child), 0);
    assert.equal(savedPaneCount(savedState.layout), 2, "saved split layout omitted a pane");
    progress("nested-tiling-verified");

    await write(firstSessionId, "sleep 30; echo INTERRUPT_FAILED\r");
    await until(async () => (await text(firstKey)).includes("sleep 30; echo INTERRUPT_FAILED"), "foreground command in renderer");
    await delay(100);
    await write(firstSessionId, "\x03");
    await delay(100);
    await write(firstSessionId, "echo RENDERER_AFTER_INTERRUPT\r");
    await until(async () => (await text(firstKey)).includes("RENDERER_AFTER_INTERRUPT"), "renderer Ctrl-C recovery");
    assert.equal(/(?:^|[\r\n])INTERRUPT_FAILED(?:[\r\n]|$)/.test(await text(firstKey)), false);

    await write(firstSessionId, "exit\r");
    await until(() => window.webContents.executeJavaScript('document.body.innerText.includes("Exited with code 0")'), "renderer exit state");
    await write(secondSessionId, "echo $$ > $HOME/renderer-terminal-shell.pid; sleep 30\r");
    const pidFile = join(home, "renderer-terminal-shell.pid");
    await until(async () => existsSync(pidFile) && (await text(secondKey)).includes("sleep 30"), "renderer cleanup shell PID");
    const childPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    await window.webContents.executeJavaScript(`
      [...document.querySelectorAll("button")].find(button => button.getAttribute("aria-label") === "Close Terminal 2")?.click()
    `);
    await until(async () => await window.webContents.executeJavaScript('document.querySelectorAll(`[data-terminal-pane]`).length === 1') && manager.size() === 0, "renderer session cleanup");
    await waitFor(() => {
      try { process.kill(childPid, 0); return false; }
      catch (error) { return error.code === "ESRCH"; }
    }, "renderer-closed shell termination");
    progress("preload-renderer-verified");
  } finally {
    const hadSessions = manager.size() > 0;
    manager.closeAll();
    resources.closeAll();
    await transport.close();
    if (hadSessions) await delay(650);
    if (window && !window.isDestroyed()) window.destroy();
    for (const channel of ["start", "attach", "write", "resize", "close", "restore-state", "save-state", "open-ack", "resource-list", "resource-child", "resource-read", "resource-save", "resource-history", "resource-commit", "resource-diff", "resource-close"]) ipcMain.removeHandler(`host-terminal:${channel}`);
  }
}

async function runFixture(output) {
  assert.ok(process.versions.electron, "fixture must run inside Electron");
  assert.ok(["linux", "darwin"].includes(process.platform), `unsupported platform: ${process.platform}`);

  const progress = label => writeFileSync(join(output, "progress.log"), `${label}\n`, { flag: "a" });
  progress("run-fixture-entered");
  const { app, BrowserWindow, ipcMain, session } = await import("electron");
  const { createTerminalSessions, loadTerminalPty, registerTerminalIpc, terminalSenderAllowed } = await import("../electron/terminal-sessions.mjs");
  const { createTerminalStateStore } = await import("../electron/terminal-state.mjs");
  const { createTerminalResources } = await import("../electron/terminal-resources.mjs");
  const { createTerminalFiles } = await import("../electron/terminal-files.mjs");
  const { createTerminalGit } = await import("../electron/terminal-git.mjs");
  const { createRnzTransport } = await import("../electron/rnz-transport.mjs");
  const home = join(output, "home");
  app.setPath("userData", join(output, "profile"));
  app.setPath("sessionData", join(output, "profile"));
  app.setPath("cache", join(output, "cache"));
  app.commandLine.appendSwitch("disable-background-networking");

  progress("before-app-ready");
  await app.whenReady();
  progress("electron-ready");
  const pty = loadTerminalPty();
  progress("native-pty-loaded");
  const sessionsData = [];
  const exits = [];
  let sessions;
  sessions = createTerminalSessions({
    loadPty: () => pty,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: home,
      USER: "terminal-fixture",
      LOGNAME: "terminal-fixture",
      SHELL: process.env.SHELL,
      LANG: "C.UTF-8",
      DISPLAY: process.env.DISPLAY,
      XAUTHORITY: process.env.XAUTHORITY,
    },
    home,
    onData: (_owner, id, data, sequence) => {
      sessionsData.push([id, data]);
      sessions.ack(_owner, id, sequence);
    },
    onExit: (_owner, id, code) => exits.push([id, code]),
  });
  const owner = {};
  const collect = id => sessionsData.filter(([sessionId]) => sessionId === id).map(([, data]) => data).join("");
  const start = () => {
    const { id } = sessions.start(owner, { cols: 80, rows: 24 });
    sessions.attach(owner, id);
    return id;
  };

  try {
    assert.equal(typeof pty.spawn, "function", "real @lydell/node-pty did not load in Electron");
    const id = start();
    progress("first-session-started");
    sessions.write(owner, id, "printf 'PTY_REAL_OUTPUT\\n'\r");
    await waitFor(() => collect(id).includes("PTY_REAL_OUTPUT"), "real PTY output");
    progress("input-output-verified");

    if (process.platform === "linux" && process.env.DISPLAY && existsSync("/usr/bin/gitk")) {
      const repo = join(home, "gitk-repo");
      mkdirSync(repo);
      const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
      execFileSync("git", ["init", "-q"], { cwd: repo, env: gitEnv });
      execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-qm", "fixture"], { cwd: repo, env: gitEnv });
      sessions.write(owner, id, `cd "$HOME/gitk-repo"; /usr/bin/gitk --all > "$HOME/gitk.log" 2>&1 & p=$!; sleep 2; if kill -0 "$p" 2>/dev/null; then /usr/bin/xwininfo -root -tree > "$HOME/gitk-windows" 2>/dev/null; printf '\\n%s\\n' GITK_DISPLAY_OK; kill "$p"; wait "$p" 2>/dev/null; else printf '\\n%s\\n' GITK_DISPLAY_FAILED; fi\r`);
      await waitFor(() => /(?:^|[\r\n])GITK_DISPLAY_(?:OK|FAILED)(?:[\r\n]|$)/.test(collect(id)), "gitk display check");
      assert.match(collect(id), /(?:^|[\r\n])GITK_DISPLAY_OK(?:[\r\n]|$)/, readFileSync(join(home, "gitk.log"), "utf8"));
      if (existsSync("/usr/bin/xwininfo")) assert.match(readFileSync(join(home, "gitk-windows"), "utf8"), /\("gitk" "Gitk"\)/);
      progress("gitk-display-verified");
    }

    sessions.resize(owner, id, 117, 41);
    sessions.write(owner, id, "stty size\r");
    await waitFor(() => collect(id).includes("41 117"), "kernel PTY resize");
    progress("resize-verified");

    sessions.write(owner, id, "sleep 30; printf 'INTERRUPT_FAILED\\n'\r");
    await waitFor(() => collect(id).includes("sleep 30; printf"), "interactive foreground command");
    await delay(100);
    sessions.write(owner, id, "\x03");
    await delay(100);
    sessions.write(owner, id, "printf 'PTY_AFTER_INTERRUPT\\n'\r");
    await waitFor(() => collect(id).includes("PTY_AFTER_INTERRUPT"), "Ctrl-C recovery");
    assert.equal(/(?:^|[\r\n])INTERRUPT_FAILED(?:[\r\n]|$)/.test(collect(id)), false, "Ctrl-C did not interrupt the foreground command");
    progress("interrupt-verified");

    sessions.write(owner, id, "exit\r");
    await waitFor(() => exits.some(([sessionId]) => sessionId === id), "shell exit event");
    assert.deepEqual(exits.find(([sessionId]) => sessionId === id), [id, 0]);
    assert.equal(sessions.size(), 0, "normally exited PTY remained registered");
    progress("exit-verified");

    const closingId = start();
    sessions.write(owner, closingId, "printf '%s\\n' \"$$\" > \"$HOME/terminal-shell.pid\"; sleep 30\r");
    await waitFor(() => existsSync(join(home, "terminal-shell.pid")) && collect(closingId).includes("sleep 30"), "cleanup shell PID");
    const childPid = Number(readFileSync(join(home, "terminal-shell.pid"), "utf8").trim());
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    sessions.close(owner, closingId);
    assert.equal(sessions.size(), 0, "closed PTY remained registered");
    await waitFor(() => {
      try { process.kill(childPid, 0); return false; }
      catch (error) { return error.code === "ESRCH"; }
    }, "closed shell process termination");
    progress("close-cleanup-verified");
    await verifyBridgeRenderer({
      BrowserWindow,
      ipcMain,
      session,
      pty,
      home,
      rendererUrl: process.env.OMB_TERMINAL_RENDERER_URL,
      progress,
      createTerminalSessions,
      registerTerminalIpc,
      terminalSenderAllowed,
      createTerminalStateStore,
      createTerminalResources,
      createTerminalFiles,
      createTerminalGit,
      createRnzTransport,
    });

    writeFileSync(join(output, "receipt.json"), JSON.stringify({
      passed: true,
      platform: process.platform,
      electron: process.versions.electron,
      node: process.versions.node,
      pty: JSON.parse(readFileSync(join(root, "node_modules/@lydell/node-pty/package.json"), "utf8")).version,
      checks: [
        "installed Electron loaded the real @lydell/node-pty native module",
        "interactive shell input produced real PTY output",
        ...(process.platform === "linux" && process.env.DISPLAY && existsSync("/usr/bin/gitk") ? [existsSync("/usr/bin/xwininfo") ? "gitk opened a window on the fixture display" : "gitk remained running on the fixture display"] : []),
        "resize changed the PTY's reported rows and columns",
        "Ctrl-C interrupted a foreground process and the shell accepted more input",
        "exit reported status 0 and removed its session",
        "close removed its session and terminated the shell process",
        "nested 2D layouts: all four side drops, center swaps, outer-group docking, and both divider axes",
        "nine real shells in 3x3, maximize/restore, narrow-window scrolling, and no terminal remounts",
        "closing terminal panes emitted no renderer JavaScript errors",
        "rnz opened, edited and saved a file, navigated a directory and inspected a Git commit via the real PTY and renderer",
      ],
      profile: "temporary HOME, XDG data/config/cache, Electron userData/sessionData, and temp directory",
      bridgeRenderer: "real Electron preload, host-terminal IPC handlers, and TerminalPage mounted in an isolated Vite fixture with loopback-only networking",
    }, null, 2));
  } finally {
    const hadSessions = sessions.size() > 0;
    sessions.closeAll();
    if (hadSessions) await delay(650);
    assert.equal(sessions.size(), 0);
  }
}

if (process.versions.electron) {
  if (process.env[fixtureEnv] !== "1" || !process.env.OMB_TERMINAL_OUTPUT) {
    throw new Error("Refusing to run outside the isolated terminal fixture");
  }
  const output = process.env.OMB_TERMINAL_OUTPUT;
  const { app } = require("electron");
  runFixture(output).then(() => app.exit(0), error => {
    console.error(error);
    try { writeFileSync(join(output, "failure.txt"), String(error?.stack ?? error)); } catch {}
    app.exit(1);
  });
} else {
  const output = mkdtempSync(join(tmpdir(), "openmausbot-terminal-"));
  const shell = join(output, "synthetic-shell");
  writeFileSync(shell, "#!/bin/sh\nexec /bin/sh -i\n");
  chmodSync(shell, 0o700);
  let renderer;
  try {
    renderer = await startRendererFixture(output);
    const receipt = await runElectron(output, shell, renderer.url);
    const keep = process.argv.includes("--keep-fixture");
    if (!keep) rmSync(output, { recursive: true, force: true });
    console.log(JSON.stringify({ ...receipt, fixtureRemoved: !keep, ...(keep ? { fixtureDirectory: output } : {}) }, null, 2));
  } catch (error) {
    console.error(error);
    console.error(`Fixture retained for diagnosis: ${output}`);
    process.exitCode = 1;
  } finally {
    await renderer?.close();
  }
}
