import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 4096;
const MAX_PATH_BYTES = 4096;
const USAGE = "Usage: rnz view [--] [path] | rnz git [--] [path]";

function cleanMessage(message) {
  return [...message].map(character => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("").slice(0, 500);
}

export function parseRnzArgs(argv) {
  const [action, ...args] = argv;
  if (action !== "view" && action !== "git") throw new Error(USAGE);
  let target = ".";
  if (args[0] === "--") {
    if (args.length > 2) throw new Error(USAGE);
    if (args.length === 2) target = args[1];
  } else if (args.length) {
    if (args.length !== 1 || args[0].startsWith("-")) throw new Error(USAGE);
    target = args[0];
  }
  if (target.includes("\0")) throw new Error("The path is invalid");
  const absolutePath = path.resolve(process.cwd(), target);
  if (Buffer.byteLength(absolutePath) > MAX_PATH_BYTES) throw new Error("The path is too long");
  return { action, absolutePath };
}

function sendRequest({ socketPath, token, action, absolutePath }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let input = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => finish(new Error("The terminal did not accept the request in time")), REQUEST_TIMEOUT_MS);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.on("error", () => finish(new Error("The RanzoBot terminal endpoint is unavailable")));
    socket.on("connect", () => socket.write(`${JSON.stringify({ version: 1, token, action, absolutePath })}\n`));
    socket.on("data", chunk => {
      input = Buffer.concat([input, chunk]);
      if (input.length > MAX_RESPONSE_BYTES) return finish(new Error("The terminal returned an invalid response"));
      const newline = input.indexOf(10);
      if (newline === -1) return;
      if (newline !== input.length - 1) return finish(new Error("The terminal returned an invalid response"));
      let response;
      try { response = JSON.parse(input.subarray(0, newline).toString("utf8")); }
      catch { return finish(new Error("The terminal returned an invalid response")); }
      if (response?.ok === true && Object.keys(response).length === 1) return finish(null);
      if (response?.ok === false && typeof response.message === "string" && Object.keys(response).length === 2) {
        return finish(new Error(cleanMessage(response.message) || "The pane could not be opened"));
      }
      finish(new Error("The terminal returned an invalid response"));
    });
    socket.on("end", () => {
      if (!settled) finish(new Error("The terminal closed before accepting the request"));
    });
  });
}

export async function runRnzCli(argv = process.argv.slice(2), env = process.env) {
  let request;
  try { request = parseRnzArgs(argv); }
  catch (error) {
    process.stderr.write(`rnz: ${error.message}\n`);
    return 2;
  }

  if (typeof env.RNZ_SOCKET !== "string" || !path.isAbsolute(env.RNZ_SOCKET) ||
      typeof env.RNZ_TOKEN !== "string" || !/^[0-9a-f]{64}$/.test(env.RNZ_TOKEN)) {
    process.stderr.write("rnz: unavailable outside a RanzoBot terminal\n");
    return 1;
  }

  try {
    await sendRequest({ socketPath: env.RNZ_SOCKET, token: env.RNZ_TOKEN, ...request });
    return 0;
  } catch (error) {
    process.stderr.write(`rnz: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runRnzCli();
}
