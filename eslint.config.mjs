import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores, defineConfig } from "eslint/config";

export default defineConfig(
  globalIgnores([
    "node_modules",
    "dist",
    "coverage",
    "output",
    "eval",
    "test-vault",
    "test-documents",
    "test-fixtures",
    "Docs",
    // Dev-only CLIs. They run under tsx in Node and are typechecked by
    // `npm run typecheck` (tsconfig.check.json), but they are never bundled
    // into main.js, so the Obsidian plugin guidelines don't apply to them.
    "scripts",
    // Build configs, not plugin source.
    "**/esbuild.config.mjs",
    "main.js",
    "obsidian-plugin/main.js",
    "versions.json",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.check.json",
    "obsidian-plugin/tsconfig.json",
    "obsidian-plugin/package.json",
    "obsidian-plugin/package-lock.json",
  ]),
  {
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs", "vitest.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".json"],
      },
    },
  },
  ...obsidianmd.configs.recommended,
  {
    rules: {
      // Sentence case for labels and descriptions, but acronyms and API
      // identifiers keep their conventional casing.
      "obsidianmd/ui/sentence-case": [
        "error",
        {
          mode: "loose",
          acronyms: ["URL", "API", "TPM", "LLM", "IR", "JSON", "GPT", "CDN"],
          ignoreRegex: ["^https?://", "^sk-", "^gpt-", "^openai/", "^\\.\\.\\."],
        },
      ],
    },
  }
);
