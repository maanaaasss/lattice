import esbuild from "esbuild";
import builtins from "builtin-modules";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Paths are resolved from this file, not the cwd, so the build emits the
// same artifacts no matter where it is invoked from.
const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(pluginDir, "..");

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
  sourcemap: process.argv.includes("--production") ? false : "inline",
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
