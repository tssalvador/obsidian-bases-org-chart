import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores, defineConfig } from "eslint/config";

export default defineConfig(
  globalIgnores([
    "node_modules",
    ".test-build",
    "esbuild.config.mjs",
    "versions.json",
    "main.js",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
  ]),
  {
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mts", "manifest.json"],
        },
        // import.meta.dirname is Node-only and @types/node isn't installed; ESLint runs on Node.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- see above
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".json"],
      },
    },
  },
  ...obsidianmd.configs.recommended,
  {
    // Tests run in Node with the built-in test runner and never ship in the
    // plugin; they also use loosely typed mocks of Obsidian's app.
    files: ["test/**/*.ts"],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "obsidianmd/no-nodejs-modules": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },
);
