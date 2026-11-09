import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { stageTerminalRuntime, targetsFor, verifyTerminalRuntime } from "./prepare-terminal-runtime.mjs";

const version = "1.2.0-beta.18";
const temporaryDirectories = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(targets) {
  const root = mkdtempSync(join(tmpdir(), "omb-terminal-runtime-"));
  temporaryDirectories.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { "@lydell/node-pty": version } }));
  const scope = join(root, "node_modules", "@lydell");
  const optionalDependencies = Object.fromEntries(targets.map(({ platform, arch }) => [
    `@lydell/node-pty-${platform}-${arch}`, version,
  ]));
  const wrapper = join(scope, "node-pty");
  mkdirSync(wrapper, { recursive: true });
  writeFileSync(join(wrapper, "package.json"), JSON.stringify({
    name: "@lydell/node-pty", version, optionalDependencies,
  }));
  writeFileSync(join(wrapper, "LICENSE"), "MIT\n");
  writeFileSync(join(wrapper, "index.js"), 'module.exports = require(`@lydell/node-pty-${process.platform}-${process.arch}`);\n');

  for (const target of targets) {
    const { platform, arch } = target;
    const name = `node-pty-${platform}-${arch}`;
    const packageRoot = join(scope, name);
    const prebuild = join(packageRoot, "prebuilds", `${platform}-${arch}`);
    const os = platform;
    mkdirSync(prebuild, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
      name: `@lydell/${name}`, version, license: "MIT", os: [os], cpu: [arch],
      exports: "./lib/index.js",
    }));
    writeFileSync(join(packageRoot, "LICENSE"), "MIT\n");
    const lib = join(packageRoot, "lib");
    mkdirSync(lib);
    writeFileSync(join(lib, "index.js"), `module.exports = { target: "${platform}-${arch}" };\n`);
    const files = platform === "linux" ? ["pty.node"]
      : platform === "darwin" ? ["pty.node", "spawn-helper"]
        : ["conpty.node", "conpty_console_list.node", "conpty/conpty.dll", "conpty/OpenConsole.exe"];
    for (const file of files) {
      const path = join(prebuild, file);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "fixture\n");
      if (file === "spawn-helper" && process.platform !== "win32") chmodSync(path, 0o755);
    }
  }
  return root;
}

const allTargets = [
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "win32", arch: "x64" },
  { platform: "linux", arch: "x64" },
];

describe("terminal runtime packaging", () => {
  it("matches the desktop packaging matrix", () => {
    expect(targetsFor("darwin")).toEqual(allTargets.slice(0, 2));
    expect(targetsFor("win32")).toEqual([allTargets[2]]);
    expect(targetsFor("linux")).toEqual([allTargets[3]]);
    expect(() => targetsFor("freebsd")).toThrow(/Unsupported/);
  });

  it("stages only each target's complete wrapper and native package, preserving executable bits", () => {
    const targets = process.platform === "win32" ? allTargets.filter(({ platform }) => platform !== "darwin") : allTargets;
    const root = fixture(targets);
    const staged = stageTerminalRuntime({ root, targets });
    expect(staged).toHaveLength(targets.length);
    for (const target of targets) {
      const runtime = join(root, "dist-native", "terminal-runtime", `${target.platform}-${target.arch}`);
      expect(verifyTerminalRuntime(runtime, { ...target, version })).toBe(true);
      expect(readFileSync(join(runtime, "node_modules", "@lydell", "node-pty", "LICENSE"), "utf8")).toBe("MIT\n");
      if (target.platform === "darwin") {
        expect(statSync(join(runtime, "node_modules", "@lydell", `node-pty-${target.platform}-${target.arch}`, "prebuilds", `${target.platform}-${target.arch}`, "spawn-helper")).mode & 0o111).toBe(0o111);
      }
    }
  });

  it("resolves the staged platform package through the wrapper", () => {
    const target = targetsFor(process.platform).find(({ arch }) => arch === process.arch);
    if (!target) return;
    const root = fixture([target]);
    stageTerminalRuntime({ root, targets: [target] });
    const wrapper = join(root, "dist-native", "terminal-runtime", `${target.platform}-${target.arch}`, "node_modules", "@lydell", "node-pty");
    expect(createRequire(import.meta.url)(wrapper)).toEqual({ target: `${target.platform}-${target.arch}` });
  });

  it("rejects incomplete packages and unexpected install hooks", () => {
    const root = fixture([allTargets[3]]);
    const [runtime] = stageTerminalRuntime({ root, targets: [allTargets[3]] });
    const binary = join(runtime, "node_modules", "@lydell", "node-pty-linux-x64", "prebuilds", "linux-x64", "pty.node");
    rmSync(binary);
    expect(() => verifyTerminalRuntime(runtime, { ...allTargets[3], version })).toThrow(/Missing PTY runtime file/);

    const hookRoot = fixture([allTargets[3]]);
    const wrapper = join(hookRoot, "node_modules", "@lydell", "node-pty", "package.json");
    const manifest = JSON.parse(readFileSync(wrapper, "utf8"));
    manifest.scripts = { install: "node-gyp rebuild" };
    writeFileSync(wrapper, JSON.stringify(manifest));
    expect(() => stageTerminalRuntime({ root: hookRoot, targets: [allTargets[3]] })).toThrow(/unexpected install script/);
  });

  it("wires package and CI/release entry points to staging and outside-ASAR resources", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(manifest.dependencies).toMatchObject({
      "@lydell/node-pty": version,
      "@xterm/xterm": "6.0.0",
      "@xterm/addon-fit": "0.11.0",
    });
    expect(manifest.scripts["package:prepare"]).toContain("pnpm build:terminal-runtime");
    for (const name of ["@xterm/xterm", "@xterm/addon-fit"]) {
      const dependency = JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), "utf8"));
      for (const script of ["preinstall", "install", "postinstall"]) expect(dependency.scripts?.[script]).toBeUndefined();
    }
    for (const script of ["package:mac", "package:win", "package:linux", "package:linux:offline", "package:linux:dir"]) {
      expect(manifest.scripts[script]).toContain("pnpm package:prepare");
    }
    for (const [file, command] of [
      ["release.yml", "pnpm package:mac"],
      ["release.yml", "pnpm package:win"],
      ["release.yml", "pnpm package:linux"],
      ["package-win.yml", "pnpm package:win"],
      ["package-linux.yml", "pnpm package:linux:offline"],
      ["ci.yml", "pnpm package:linux:offline"],
    ]) {
      expect(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8")).toContain(command);
    }
    for (const path of ["../third_party/xterm/LICENSE", "../third_party/xterm-addon-fit/LICENSE"]) {
      expect(readFileSync(new URL(path, import.meta.url), "utf8")).toContain("Permission is hereby granted");
    }
    const builder = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
    for (const path of [
      "dist-native/terminal-runtime/darwin-${arch}/node_modules/@lydell",
      "dist-native/terminal-runtime/win32-x64/node_modules/@lydell",
      "dist-native/terminal-runtime/linux-x64/node_modules/@lydell",
      "terminal-runtime/node_modules/@lydell",
      "third_party/xterm/LICENSE",
      "third_party/xterm-addon-fit/LICENSE",
    ]) expect(builder).toContain(path);
  });
});
