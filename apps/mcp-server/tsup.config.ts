import { defineConfig } from "tsup";
import { version } from "./package.json";

export default defineConfig({
  env: { PKG_VERSION: version },
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  target: "node20",
  // Inline workspace packages so the published tarball is self-contained;
  // native/runtime deps stay external and install normally.
  noExternal: [/^@synapse\//],
  external: ["better-sqlite3", "@modelcontextprotocol/sdk", "zod", "@huggingface/transformers"],
  banner: { js: "#!/usr/bin/env node" },
  clean: true,
});
