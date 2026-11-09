import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRnzTransport } from "../electron/rnz-transport.mjs";

if (process.platform !== "linux" || !process.argv[2]) throw new Error("Usage: node scripts/verify-rnz-package.mjs /path/to/linux-unpacked");
const packageRoot = path.resolve(process.argv[2]);
const home = await mkdtemp(path.join(os.tmpdir(), "rnz-package-fixture-"));
const owner = {};
let received;
const transport = createRnzTransport({ onRequest: async request => { received = request; } });
try {
  await transport.start();
  await writeFile(path.join(home, "file with spaces.txt"), "fixture");
  const env = {
    ...transport.addSession("fixture", owner),
    HOME: home,
    PATH: "/usr/bin:/bin",
    RNZ_NODE: path.join(packageRoot, "openmausbot"),
    RNZ_CLI: path.join(packageRoot, "resources/terminal-cli/rnz-cli.mjs"),
  };
  const child = spawn(path.join(packageRoot, "resources/terminal-cli/rnz"), ["view", "file with spaces.txt"], {
    cwd: home, env, stdio: ["ignore", "pipe", "pipe"], signal: AbortSignal.timeout(10_000),
  });
  let stderr = "";
  child.stderr.on("data", value => { stderr += value; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0, stderr);
  assert.equal(received?.absolutePath, path.join(home, "file with spaces.txt"));
  assert.equal(received?.owner, owner);
  console.log("Packaged Linux rnz launcher and Electron Node runtime passed.");
} finally {
  await transport.close();
  await rm(home, { recursive: true, force: true });
}
