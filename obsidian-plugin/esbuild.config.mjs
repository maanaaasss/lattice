import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Paths are resolved from this file, not the cwd, so the build emits the
// same artifacts no matter where it is invoked from.
const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(pluginDir, "..");

// Externals: every Node built-in, bare and `node:`-prefixed.
const builtins = new Set();
for (const name of builtinModules) {
  builtins.add(name);
  if (!name.startsWith("node:")) builtins.add(`node:${name}`);
}

const context = await esbuild.context({
  entryPoints: [path.join(pluginDir, "main.ts")],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  // No sourcemap on the default (release) build: the output is byte-for-byte
  // reproducible from a clean checkout, which community review verifies by
  // rebuilding and comparing against the published asset. Use --watch for an
  // inline sourcemap during local development.
  sourcemap: process.argv.includes("--watch") ? "inline" : false,
  treeShaking: true,
  // Obsidian convention: the plugin bundle lives at the repo root next to
  // manifest.json, which is also where release assets are picked up from.
  outfile: path.join(rootDir, "main.js"),
  // Resolve parent project's src/ imports
  nodePaths: [rootDir],
});

if (process.argv.includes("--watch")) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}
