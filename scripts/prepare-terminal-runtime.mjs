import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PTY_PACKAGE = "@lydell/node-pty";
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;

export function targetsFor(platform = process.platform) {
  if (platform === "darwin") return ["arm64", "x64"].map((arch) => ({ platform, arch }));
  if (platform === "win32" || platform === "linux") return [{ platform, arch: "x64" }];
  throw new Error(`Unsupported terminal runtime platform: ${platform}`);
}

function packageVersion(root) {
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies?.[PTY_PACKAGE];
  if (!VERSION_PATTERN.test(version ?? "")) throw new Error(`${PTY_PACKAGE} must have an exact version pin`);
  return version;
}

function packageManifest(directory, name, version) {
  const manifestPath = join(directory, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error(`Missing package manifest: ${manifestPath}`);
  }
  if (manifest.name !== name || manifest.version !== version) {
    throw new Error(`${name} at ${directory} is ${manifest.name}@${manifest.version}; expected ${name}@${version}`);
  }
  for (const script of ["preinstall", "install", "postinstall"]) {
    if (manifest.scripts?.[script]) throw new Error(`${name} has an unexpected ${script} script`);
  }
  return manifest;
}

function requiredFiles({ platform, arch }) {
  const prefix = `prebuilds/${platform}-${arch}/`;
  if (platform === "linux") return [`${prefix}pty.node`];
  if (platform === "darwin") return [`${prefix}pty.node`, `${prefix}spawn-helper`];
  return [
    `${prefix}conpty.node`,
    `${prefix}conpty_console_list.node`,
    `${prefix}conpty/conpty.dll`,
    `${prefix}conpty/OpenConsole.exe`,
  ];
}

function regularFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function verifyTerminalRuntime(runtimeRoot, { platform, arch, version }) {
  if (!targetsFor(platform).some((target) => target.arch === arch)) {
    throw new Error(`Unsupported terminal runtime target: ${platform}-${arch}`);
  }
  const scope = join(runtimeRoot, "node_modules", "@lydell");
  const wrapperName = "node-pty";
  const nativeName = `node-pty-${platform}-${arch}`;
  const wrapperPath = join(scope, wrapperName);
  const nativePath = join(scope, nativeName);
  const wrapper = packageManifest(wrapperPath, PTY_PACKAGE, version);
  const native = packageManifest(nativePath, `@lydell/${nativeName}`, version);

  if (wrapper.optionalDependencies?.[`@lydell/${nativeName}`] !== version) {
    throw new Error(`${PTY_PACKAGE} does not declare @lydell/${nativeName}@${version}`);
  }
  if (!native.os?.includes(platform) || !native.cpu?.includes(arch)) {
    throw new Error(`${nativeName} does not target ${platform}-${arch}`);
  }
  for (const license of [join(wrapperPath, "LICENSE"), join(nativePath, "LICENSE")]) {
    if (!regularFile(license)) throw new Error(`Missing PTY license: ${license}`);
  }
  for (const file of requiredFiles({ platform, arch })) {
    const path = join(nativePath, file);
    if (!regularFile(path)) throw new Error(`Missing PTY runtime file: ${path}`);
    if (file.endsWith("spawn-helper") && (statSync(path).mode & 0o111) === 0) {
      throw new Error(`PTY helper is not executable: ${path}`);
    }
  }

  const staged = readdirSync(scope).sort();
  const expected = [wrapperName, nativeName].sort();
  if (staged.join("\n") !== expected.join("\n")) {
    throw new Error(`Unexpected PTY packages for ${platform}-${arch}: ${staged.join(", ")}`);
  }
  return true;
}

function copyEntry(source, destination) {
  const details = statSync(source);
  if (details.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source)) copyEntry(join(source, entry), join(destination, entry));
    chmodSync(destination, details.mode & 0o777);
    return;
  }
  if (!details.isFile()) throw new Error(`Unsupported PTY package entry: ${source}`);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  chmodSync(destination, details.mode & 0o777);
}

export function stageTerminalRuntime({ root, targets = targetsFor(), nodeModules = join(root, "node_modules") }) {
  const version = packageVersion(root);
  const stageRoot = join(root, "dist-native", "terminal-runtime");
  const wrapperSource = realpathSync(join(nodeModules, "@lydell", "node-pty"));
  const sourceScope = dirname(wrapperSource);
  packageManifest(wrapperSource, PTY_PACKAGE, version);
  rmSync(stageRoot, { recursive: true, force: true });

  const staged = [];
  for (const target of targets) {
    const { platform, arch } = target;
    if (!targetsFor(platform).some((supported) => supported.arch === arch)) {
      throw new Error(`Unsupported terminal runtime target: ${platform}-${arch}`);
    }
    const nativeName = `node-pty-${platform}-${arch}`;
    const runtimeRoot = join(stageRoot, `${platform}-${arch}`);
    const scope = join(runtimeRoot, "node_modules", "@lydell");
    mkdirSync(scope, { recursive: true });
    copyEntry(wrapperSource, join(scope, "node-pty"));
    copyEntry(join(sourceScope, nativeName), join(scope, nativeName));
    verifyTerminalRuntime(runtimeRoot, { ...target, version });
    staged.push(runtimeRoot);
  }
  return staged;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const staged = stageTerminalRuntime({ root });
  for (const path of staged) console.log(`Staged ${path}`);
}
