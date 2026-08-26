#!/usr/bin/env node
import { runCli } from "./cli.js";

runCli(process.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exit(1);
});
