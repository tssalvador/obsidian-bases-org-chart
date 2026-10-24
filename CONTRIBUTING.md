# Contributing

## About this project

The code in this repository was generated with AI assistance, starting from a personal need: seeing the people in an Obsidian vault as an org chart. It's shared so others can use it, tinker with it and fork it as they like.

The plugin aims to **do one thing**: extend Bases to show notes as an org chart. Contributions are welcome when they improve how it does that, such as bug fixes, performance, accessibility, documentation and tests. Changes that alter its core functionality or take it towards a different use case are better suited to a fork.

## Building

```bash
npm install
npm run dev      # rebuild main.js on every change
npm run build    # type-check, then production build
npm test         # unit tests (Node's built-in test runner)
npm run lint     # ESLint with Obsidian's plugin rules
```

To try changes in Obsidian, put the repository (or a symlink to it) at `<vault>/.obsidian/plugins/bases-org-chart/`, run `npm run dev`, and reload the plugin (toggle it off and on under Settings → Community plugins).

## Conventions

- **Dependencies:** keep them to a minimum. There are no runtime dependencies; the layout is a small in-house tidy-tree algorithm. Dev dependencies follow Obsidian's sample plugin (TypeScript, esbuild, the Obsidian type definitions, and ESLint with `eslint-plugin-obsidianmd`). Tests use Node's built-in runner, typed by a small local shim instead of `@types/node`. Prefer writing a few dozen lines over adding a package, and pin exact versions.
- **Official APIs first:** use Obsidian's own methods wherever one exists (e.g. `fileManager.processFrontMatter` for property edits) rather than hand-rolled equivalents.
- **Note edits:** anything that writes to notes goes through `applyEdits` (`src/write.ts`) inside `app.fileManager.processFrontMatter`, and offers Undo. Each edit passes the values it was planned from (`expected`); `applyEdits` checks them against the note's freshly parsed frontmatter and changes nothing if they differ, because the metadata cache can lag behind recent edits.
- **Testable logic:** keep decisions that don't need Obsidian out of `src/main.ts`, so the unit tests can cover them: what a view remembers between Bases' calls (`src/view-state.ts`), the card menu (`src/menu.ts`), edit plans and drop rules (`src/edits.ts`). `main.ts` connects them to Obsidian.
- **Checks:** `npm run check` runs everything a release needs: version metadata, type-check and build, lint, tests, and `npm audit`. The audit covers the build tools too and fails on high or critical advisories. It reports, but allows, moderate ones, because the Obsidian type definitions depend on an old `moment` with a moderate advisory that can't be fixed without downgrading the lint plugin; none of these packages are bundled into `main.js`.
- **Lint and tests** must pass before a release.

## Decisions

- **Properties are read from the metadata cache, not Bases values** (October 2026). Bases gives each entry typed values (`entry.getValue("note.reports_to")`), but their public API only offers `toString()` and, for lists, `length()`/`get()`. A link's resolved file and display name aren't public, and its text is the raw `[[Target]]`, so link parsing (`linkTarget`, `linkLabel` in `src/graph.ts`) would stay anyway. Switching would also mean the chart shows values from Bases while edits are checked against the frontmatter. Revisit if Obsidian makes a link value's file and display text public.

- **Property names are case-insensitive** (October 2026). Obsidian keeps one type per property name regardless of case, and Bases finds `Reports_To:` when asked for `reports_to`, so the chart does too (`propKey` in `src/graph.ts`). `processFrontMatter` gives a plain, case-sensitive object, so edits write to the note's own spelling of the key rather than adding a second one.

- **The parent, current membership and former members properties are lists** (October 2026). A parent property holds a main manager and dotted lines, and membership properties hold several groups, so edits always write lists, and the plugin gives these properties Obsidian's List type (`ensureListTypes` in `src/property-types.ts`) rather than following whatever type Obsidian inferred. Obsidian has no public API for property types, so this uses its internal property registry, guarded so that a change there leaves types alone. Types are set on load, when the settings tab closes (never per keystroke, so half-typed names get no type) and before an edit.

## Releasing

1. Update `version` in `manifest.json` and `package.json` (`x.y.z`), and add `"x.y.z": "<minAppVersion>"` to `versions.json`.
2. Commit, then tag the commit with the bare version (e.g. `1.0.0`, no `v`) and push the tag.
3. The Release workflow checks that the tag matches `manifest.json`, runs `npm run check`, builds, attests the build's provenance, and creates a draft GitHub release with `main.js`, `manifest.json` and `styles.css` attached. Review the draft and publish it.
