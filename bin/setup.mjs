#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const windows = process.platform === "win32";
const npmCommand = windows ? "npm.cmd" : "npm";
const sdkDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const projectDir = resolve(process.argv[2] || ".");
const moonCli = resolve(sdkDir, "bin", "moon.mjs");

function runNpm(args, cwd) {
  const result = spawnSync(npmCommand, args, { cwd, stdio: "inherit", shell: windows });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(resolve(projectDir, "package.json"))) {
  console.error(`A pasta informada não contém package.json: ${projectDir}`);
  process.exit(1);
}

console.log(`Preparando o Moon para ${windows ? "Windows" : process.platform === "darwin" ? "macOS" : process.platform}...`);
runNpm(["install"], sdkDir);
runNpm(["install"], projectDir);

const result = spawnSync(process.execPath, [moonCli, "run", projectDir, ...process.argv.slice(3)], {
  cwd: projectDir,
  stdio: "inherit",
  env: process.env,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
