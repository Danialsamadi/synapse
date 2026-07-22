// Rebuilds better-sqlite3 if its native binary was built for a different Node
// version (ERR_DLOPEN_FAILED) — otherwise the MCP client just sees "Connection closed".
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

// better-sqlite3 is a dep of @synapse/store, so resolve it from there
const require = createRequire(new URL("../../packages/store/package.json", import.meta.url));
try {
  require("better-sqlite3");
} catch (err) {
  if (err.code !== "ERR_DLOPEN_FAILED") throw err;
  console.error(`[synapse] better-sqlite3 binary mismatch (Node ${process.version}), rebuilding...`);
  execSync("pnpm rebuild -r better-sqlite3", { cwd: new URL("../..", import.meta.url), stdio: "inherit" });
}
