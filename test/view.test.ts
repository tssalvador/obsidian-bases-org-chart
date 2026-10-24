import { test } from "node:test";
import assert from "node:assert/strict";
import { asList, buildGraph, descendants, linkTarget, type OrgNode } from "../src/graph";
import { dropProblem, reassignPlans } from "../src/edits";
import { fillCardMenu, MENU_SECTION, type MenuItemLike, type MenuLike } from "../src/menu";
import { inOwnBasesTab } from "../src/viewport";
import { parseChartState, ViewMemory } from "../src/view-state";

/** In-memory notes: frontmatter by note name; links resolve by name. */
function mockApp(notes: Record<string, Record<string, unknown>>) {
  const files = Object.keys(notes).map((name) => ({ path: `Notes/${name}.md`, basename: name }));
  const byName = new Map(files.map((f) => [f.basename.toLowerCase(), f]));
  const app = {
    metadataCache: {
      getFileCache: (f: { basename: string }) => ({ frontmatter: notes[f.basename] }),
      getFirstLinkpathDest: (t: string) => byName.get(t.toLowerCase()) ?? null,
    },
  };
  return { app: app as any, files: files as any[] };
}
const OPTS = { parentProperty: "reports_to", colorProperty: "" };
const P = (n: string) => `Notes/${n}.md`;

// ---- What the view remembers between Bases' calls ----

const saved = (collapsed: string[], k = 0.7) => ({ orgChart: { collapsed, transform: { x: 10, y: 20, k } } });
const seedWith = (...ids: string[]) => {
  const calls = { count: 0 };
  return { calls, seed: () => (calls.count++, new Set(ids)) };
};

test("a new view seeds collapse from 'Initially expand levels' and opens afresh", () => {
  const m = new ViewMemory();
  const { calls, seed } = seedWith("Boss");
  assert.equal(m.update("A", 2, seed), true, "the first data starts the view");
  assert.deepEqual([...m.collapsed], ["Boss"]);
  assert.equal(calls.count, 1);
  assert.equal(m.fitted, false, "opens at 100%, centred");
  assert.equal(m.update("A", 2, seed), false, "more data for the same view");
  assert.equal(calls.count, 1, "the user's toggles are kept");
});

test("state handed back to a new view object is kept when its data arrives", () => {
  // Bases re-creates the view (e.g. Table -> Org Chart), then sends the data.
  const m = new ViewMemory();
  const restored = m.restore(saved(["Mgr"]), "A", false);
  assert.deepEqual(restored, { started: true, switching: false });
  const { calls, seed } = seedWith("Other");
  assert.equal(m.update("A", 2, seed), false);
  assert.equal(calls.count, 0, "restored collapse isn't re-seeded");
  assert.deepEqual([...m.collapsed], ["Mgr"]);
  assert.deepEqual(m.pendingTransform, { x: 10, y: 20, k: 0.7 });
  assert.equal(m.fitted, true, "the saved zoom is used instead of opening afresh");
  // Changing "Initially expand levels" afterwards re-seeds and re-centres.
  assert.equal(m.update("A", 3, seed), false);
  assert.equal(calls.count, 1);
  assert.deepEqual([...m.collapsed], ["Other"]);
  assert.equal(m.fitted, false);
});

test("switching between Org Chart views starts afresh unless restoring is on", () => {
  const m = new ViewMemory();
  m.update("A", 0, () => new Set());
  m.collapsed.add("Mgr");
  // Off (the default): B's saved state is ignored and B starts afresh with its data.
  assert.equal(m.restore(saved(["X"]), "B", false), null);
  assert.equal(m.update("B", 0, () => new Set(["fresh"])), true);
  assert.deepEqual([...m.collapsed], ["fresh"]);
  assert.equal(m.pendingTransform, null);
  // On: A's saved state is used, and its data doesn't start it again.
  assert.deepEqual(m.restore(saved(["Mgr"]), "A", true), { started: true, switching: true });
  assert.equal(m.update("A", 0, () => new Set(["fresh"])), false);
  assert.deepEqual([...m.collapsed], ["Mgr"]);
  assert.deepEqual(m.pendingTransform, { x: 10, y: 20, k: 0.7 });
});

test("state handed back for the view already shown is applied without starting afresh", () => {
  // e.g. back in history to the same base and view
  const m = new ViewMemory();
  m.update("A", 0, () => new Set());
  assert.deepEqual(m.restore(saved(["Mgr"]), "A", false), { started: false, switching: false });
  assert.deepEqual([...m.collapsed], ["Mgr"]);
});

test("saved state is checked before use", () => {
  assert.equal(parseChartState(null), null);
  assert.equal(parseChartState({}), null, "nothing saved by this plugin");
  assert.deepEqual(parseChartState({ orgChart: { collapsed: ["a", 1, null, "b"] } }), { collapsed: new Set(["a", "b"]) });
  assert.deepEqual(parseChartState({ orgChart: { transform: { x: 1, y: 2, k: 99 } } }), { transform: { x: 1, y: 2, k: 2.5 } }, "zoom clamped");
  for (const transform of [{ x: NaN, y: 0, k: 1 }, { x: 0, y: 0, k: 0 }, { x: "1", y: 0, k: 1 }, null]) {
    assert.deepEqual(parseChartState({ orgChart: { transform } }), {}, `ignored: ${JSON.stringify(transform)}`);
  }
});

// ---- Dropping a card on someone ----

test("drop rules: not on yourself, your manager, your own team or a placeholder without a note", () => {
  const { app, files } = mockApp({
    Boss: {}, Mgr: { reports_to: "[[Boss]]" }, Dev: { reports_to: "[[Mgr]]" },
    Other: {}, Dot: { reports_to: ["[[Other]]", "[[Dev]]"] }, // dotted line to Dev
    Lone: { reports_to: "[[Nobody]]" },
  });
  const g = buildGraph(app, files, OPTS);
  const person = { path: P("Mgr"), managerPath: P("Boss"), below: descendants(g, P("Mgr")) };
  assert.equal(dropProblem(g, P("Mgr"), person), "self");
  assert.equal(dropProblem(g, P("Boss"), person), "already");
  assert.equal(dropProblem(g, P("Dev"), person), "loop");
  assert.equal(dropProblem(g, P("Dot"), person), "loop", "below through a dotted line too");
  assert.equal(dropProblem(g, "ghost:nobody", person), "no note");
  assert.equal(dropProblem(g, "missing", person), "no note");
  assert.equal(dropProblem(g, P("Other"), person), null);
  assert.equal(dropProblem(g, P("Lone"), person), null);
});

// ---- Moving a leaver's reports ----

function plansFor(notes: Record<string, Record<string, unknown>>, leaver: string, former: string[] = []) {
  const { app, files } = mockApp(notes);
  const g = buildGraph(app, files, OPTS);
  for (const n of g.nodes.values()) n.former = !!n.file && former.includes(n.file.basename);
  const name = (n: OrgNode) => (n.file?.basename ?? n.linkTarget ?? n.title).toLowerCase();
  return reassignPlans(g, P(leaver), {
    values: (report) => asList(notes[report.file.basename].reports_to),
    linkTo: (manager) => `[[${manager.file?.basename ?? manager.linkTarget ?? manager.title}]]`,
    refersTo: (raw, person) => linkTarget(raw).toLowerCase() === name(person),
  }).map((p) => [p.node.title, p.values]);
}

test("a leaver's reports move to the leaver's own manager", () => {
  const notes = {
    Boss: {}, Leaver: { reports_to: "[[Boss]]" },
    Ann: { reports_to: "[[Leaver]]" },
    Bea: { reports_to: ["[[Other]]", "[[Leaver]]"] }, // only a dotted line to the leaver
    Cal: { reports_to: ["[[Leaver]]", "[[Boss]]"] }, // already has Boss as a dotted line
    Dee: { reports_to: ["[[Leaver]]", "[[X]]"] },
    Old: { reports_to: "[[Leaver]]" }, // a former member
    Other: {}, X: {},
  };
  assert.deepEqual(plansFor(notes, "Leaver", ["Old"]), [
    ["Ann", ["[[Boss]]"]],
    ["Bea", ["[[Other]]"]],
    ["Cal", ["[[Boss]]"]],
    ["Dee", ["[[Boss]]", "[[X]]"]],
  ]);
});

test("without a manager, the next dotted line takes over; a manager without a note is linked by name", () => {
  assert.deepEqual(plansFor({ Leaver: {}, Ann: { reports_to: ["[[Leaver]]", "[[Y]]"] }, Bo: { reports_to: "[[Leaver]]" }, Y: {} }, "Leaver"), [
    ["Ann", ["[[Y]]"]],
    ["Bo", []],
  ]);
  assert.deepEqual(plansFor({ Leaver: { reports_to: "[[Nobody]]" }, Ann: { reports_to: "[[Leaver]]" } }, "Leaver"), [["Ann", ["[[Nobody]]"]]]);
  assert.deepEqual(plansFor({ Leaver: {} }, "Leaver"), [], "no reports");
  assert.deepEqual(plansFor({ Leaver: {} }, "Missing"), []);
});

// ---- A card's right-click menu ----

/** Records what's added to a menu, in order. */
function recordingMenu() {
  const items: (MenuRecord | "----")[] = [];
  const menu: MenuLike = {
    addItem(cb) {
      const rec: MenuRecord = {};
      const item: MenuItemLike = {
        setSection(section) { rec.section = section; return this; },
        setTitle(title) { rec.title = title; return this; },
        setIcon(icon) { rec.icon = icon; return this; },
        setWarning(warning) { rec.warning = warning; return this; },
        onClick(callback) { rec.run = callback; return this; },
      };
      items.push(rec);
      cb(item);
    },
    addSeparator() { items.push("----"); },
  };
  return { menu, items };
}
interface MenuRecord { section?: string; title?: string; icon?: string; warning?: boolean; run?: () => unknown }
const titles = (items: (MenuRecord | "----")[]) => items.map((i) => (i === "----" ? i : `${i.title ?? ""} [${i.section ?? ""}]`));

test("the card menu puts the chart's actions first, and Delete file last after the note's own menu", () => {
  const { menu, items } = recordingMenu();
  const ran: string[] = [];
  fillCardMenu(menu, {
    addDotted: () => ran.push("dotted"),
    leave: [{ label: "Acme", run: () => ran.push("leave Acme") }, { label: "Globex", run: () => ran.push("leave Globex") }],
    open: () => ran.push("open"),
    noteMenu: { add: () => menu.addItem((i) => i.setSection("open").setTitle("(Obsidian's items)")), deleteFile: () => ran.push("delete") },
  });
  assert.deepEqual(titles(items), [
    `Add dotted-line manager… [${MENU_SECTION}]`,
    `Remove from Acme [${MENU_SECTION}]`,
    `Remove from Globex [${MENU_SECTION}]`,
    "(Obsidian's items) [open]",
    "----",
    "Delete file []",
  ]);
  const del = items[items.length - 1] as MenuRecord;
  assert.equal(del.warning, true);
  for (const item of items) if (item !== "----") item.run?.();
  assert.deepEqual(ran, ["dotted", "leave Acme", "leave Globex", "delete"]);
});

test("with the note's menu off, the chart's actions come before Open in new tab", () => {
  const { menu, items } = recordingMenu();
  const ran: string[] = [];
  fillCardMenu(menu, { leave: [{ label: "Acme", run: () => ran.push("leave") }], open: () => ran.push("open") });
  assert.deepEqual(titles(items), [`Remove from Acme [${MENU_SECTION}]`, "Open in new tab [open]"], "no dotted-line item without a manager");
  (items[1] as MenuRecord).run?.();
  assert.deepEqual(ran, ["open"]);
});

// ---- Where the chart is ----

test("only a chart in its own Bases tab counts as being in one", () => {
  const inside = (selectors: string[]) => ({ closest: (s: string) => (selectors.includes(s) ? {} : null) });
  assert.equal(inOwnBasesTab(inside(['.workspace-leaf-content[data-type="bases"]'])), true);
  assert.equal(inOwnBasesTab(inside(['.workspace-leaf-content[data-type="markdown"]'])), false, "embedded in a note");
  assert.equal(inOwnBasesTab(inside([])), false, "a hover preview");
});
