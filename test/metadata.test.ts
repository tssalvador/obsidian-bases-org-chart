import { test } from "node:test";
import assert from "node:assert/strict";
import { addDotted, planLeave, planReassign, removeParent, setPrimary } from "../src/edits";
import { asList, buildGraph, cardLines, collapseBelow, containsValue, descendants, groupLabel, linkLabel, linkTarget, markStranded, primaryParents, type GraphOptions, type OrgGraph, type OrgNode } from "../src/graph";
import { cardHeight, layoutGraph, layoutGroups, NODE_H, NODE_W } from "../src/layout";
import { curvePath } from "../src/render";

// ---- Edit decisions ----

const is = (name: string) => (raw: string) => linkTarget(raw).toLowerCase() === name.toLowerCase();
const same = (a: string, b: string) => linkTarget(a).toLowerCase() === linkTarget(b).toLowerCase();

test("setPrimary replaces the primary and keeps dotted-line values", () => {
  assert.deepEqual(setPrimary([], "[[B]]", is("B")), ["[[B]]"]);
  assert.deepEqual(setPrimary(["[[A]]"], "[[B]]", is("B")), ["[[B]]"]);
  assert.deepEqual(setPrimary(["[[A]]", "[[D1]]", "[[D2]]"], "[[B]]", is("B")), ["[[B]]", "[[D1]]", "[[D2]]"]);
  // Promoting an existing dotted-line manager doesn't list them twice.
  assert.deepEqual(setPrimary(["[[A]]", "[[B|Bee]]", "[[D]]"], "[[B]]", is("B")), ["[[B]]", "[[D]]"]);
});

test("removeParent reports what happened", () => {
  assert.deepEqual(removeParent(["[[A]]"], is("A")), { remaining: [], removed: true, promoted: null });
  assert.deepEqual(removeParent(["[[A]]", "[[D]]"], is("A")), { remaining: ["[[D]]"], removed: true, promoted: "[[D]]" });
  assert.deepEqual(removeParent(["[[A]]", "[[D]]"], is("D")), { remaining: ["[[A]]"], removed: true, promoted: null });
  assert.equal(removeParent(["[[A]]"], is("Z")).removed, false);
  assert.equal(removeParent([], is("A")).removed, false);
  // Duplicates of the target are all removed.
  assert.deepEqual(removeParent(["[[A]]", "[[A|Alias]]", "[[D]]"], is("A")).remaining, ["[[D]]"]);
});

test("planLeave moves a value to former, once", () => {
  assert.deepEqual(planLeave(["[[Acme]]", "[[Other]]"], [], "[[Acme]]", same), {
    current: ["[[Other]]"], former: ["[[Acme]]"], alreadyFormer: false,
  });
  // Appended after existing former values, original spelling kept.
  assert.deepEqual(planLeave(["[[Acme|ACME]]"], ["[[Old Co]]"], "[[Acme|ACME]]", same).former, ["[[Old Co]]", "[[Acme|ACME]]"]);
  // Already former: only removed from current.
  assert.deepEqual(planLeave(["[[Acme]]"], ["[[acme]]"], "[[Acme]]", same), {
    current: [], former: null, alreadyFormer: true,
  });
  // No former property configured.
  assert.deepEqual(planLeave(["[[Acme]]"], null, "[[Acme]]", same), { current: [], former: null, alreadyFormer: false });
  // Plain-text values work too.
  assert.deepEqual(planLeave(["Acme"], [], "Acme", same), { current: [], former: ["Acme"], alreadyFormer: false });
});

// ---- Reading metadata ----

test("asList normalises every value shape", () => {
  assert.deepEqual(asList(undefined), []);
  assert.deepEqual(asList(null), []);
  assert.deepEqual(asList(""), []);
  assert.deepEqual(asList("[[A]]"), ["[[A]]"]);
  assert.deepEqual(asList(["[[A]]", "", "  ", "[[B]]"]), ["[[A]]", "[[B]]"]);
  assert.deepEqual(asList([1, true]), ["1", "true"]);
  assert.deepEqual(asList(["[[A]]", null, undefined]), ["[[A]]"], "empty YAML list items aren't the text \"null\"");
  assert.deepEqual(asList(0), ["0"]);
});

test("linkTarget and linkLabel parse wikilink forms", () => {
  const cases: [string, string, string][] = [
    ["[[Jane Doe]]", "Jane Doe", "Jane Doe"],
    ["[[Jane Doe|Jane]]", "Jane Doe", "Jane"],
    ["[[Jane Doe#Role]]", "Jane Doe", "Jane Doe"],
    ["[[Jane Doe#Role|J]]", "Jane Doe", "J"],
    ["[[Notes/Jane Doe]]", "Notes/Jane Doe", "Notes/Jane Doe"],
    ["  [[ Jane Doe ]]  ", "Jane Doe", "Jane Doe"],
    ["Jane Doe", "Jane Doe", "Jane Doe"],
    ["[[Ben Ops (Audit)]]", "Ben Ops (Audit)", "Ben Ops (Audit)"],
  ];
  for (const [raw, target, label] of cases) {
    assert.equal(linkTarget(raw), target, raw);
    assert.equal(linkLabel(raw), label, raw);
  }
});

test("containsValue compares link targets, aliases and text", () => {
  assert.ok(containsValue("[[Acme]]", "Acme"));
  assert.ok(containsValue(["[[Other]]", "[[Acme|ACME Pty]]"], "acme pty"));
  assert.ok(containsValue("Acme", "[[Acme]]"));
  assert.ok(!containsValue("[[Acme Holdings]]", "Acme"));
  assert.ok(!containsValue([], "Acme"));
  assert.ok(!containsValue("[[Acme]]", "  "));
});

/** In-memory notes: frontmatter by note name; links resolve by name or path. */
function mockApp(notes: Record<string, Record<string, unknown> | null>) {
  const files = Object.keys(notes).map((name) => ({ path: `Notes/${name}.md`, basename: name }));
  const find = (t: string) =>
    files.find((f) => f.basename.toLowerCase() === t.toLowerCase() || f.path.toLowerCase() === `${t}.md`.toLowerCase()) ?? null;
  const app = {
    metadataCache: {
      getFileCache: (f: { basename: string }) => (notes[f.basename] === null ? null : { frontmatter: notes[f.basename] }),
      getFirstLinkpathDest: (t: string) => find(t),
    },
  };
  return { app: app as any, files: files as any[] };
}
const OPTS: GraphOptions = { parentProperty: "reports_to", nameProperty: "title", fields: [{ property: "role", show: true }], colorProperty: "companies" };

test("buildGraph reads titles, subtitles and categories from frontmatter", () => {
  const { app, files } = mockApp({
    Jane: { title: "Jane D.", role: ["Engineer", "[[Guild|Guild lead]]"], companies: ["[[Acme|ACME]]", "[[Other]]"] },
    Bob: { role: 42, companies: "Plain Co" },
    Ann: null, // no frontmatter at all
  });
  const g = buildGraph(app, files, OPTS);
  const n = (x: string) => g.nodes.get(`Notes/${x}.md`)!;
  assert.equal(n("Jane").title, "Jane D.", "title property wins over the file name");
  assert.equal(n("Jane").subtitle, "Engineer, Guild lead", "lists joined, aliases shown");
  assert.equal(n("Jane").colorKey, "ACME", "first value, alias shown");
  assert.equal(n("Bob").subtitle, "42");
  assert.equal(n("Bob").colorKey, "Plain Co");
  assert.equal(n("Ann").title, "Ann");
  assert.equal(n("Ann").subtitle, "");
});

test("buildGraph resolves parents written in different ways", () => {
  const { app, files } = mockApp({
    Boss: {},
    A: { reports_to: "[[Boss]]" },
    B: { reports_to: ["[[Boss|The Boss]]"] },
    C: { reports_to: "[[Notes/Boss]]" },
    D: { reports_to: "[[Boss#Team]]" },
    E: { reports_to: "Boss" },
    F: { reports_to: ["", "[[Boss]]"] },
  });
  const g = buildGraph(app, files, OPTS);
  const reports = g.edges.filter((e) => e.from === "Notes/Boss.md").map((e) => e.to.slice(6, -3)).sort();
  assert.deepEqual(reports, ["A", "B", "C", "D", "E", "F"]);
  assert.ok(g.edges.every((e) => e.primary));
});

test("buildGraph ignores a missing or empty parent property", () => {
  const { app, files } = mockApp({ A: { reports_to: [] }, B: { reports_to: null }, C: {}, D: { reports_to: "" } });
  const g = buildGraph(app, files, OPTS);
  assert.equal(g.edges.length, 0);
  assert.equal(g.external.length, 0);
});

test("buildGraph uses the configured property names", () => {
  const { app, files } = mockApp({ Boss: {}, A: { manager: "[[Boss]]", reports_to: "[[Nobody]]", title_x: "Alpha" } });
  const g = buildGraph(app, files, { parentProperty: "manager", fields: [{ property: "title_x", show: true }], colorProperty: "team" });
  assert.equal(g.edges.length, 1);
  assert.equal(g.edges[0].from, "Notes/Boss.md");
  assert.equal(g.nodes.get("Notes/A.md")!.subtitle, "Alpha");
  assert.ok(![...g.nodes.values()].some((n) => n.ghost), "reports_to is ignored when another property is configured");
});

test("markStranded flags current reports of former managers", () => {
  const { app, files } = mockApp({
    Boss: {},
    Gone: { reports_to: "[[Boss]]", left: true },
    A: { reports_to: "[[Gone]]" },
    B: { reports_to: ["[[Gone]]"] },
    C: { reports_to: ["[[Boss]]", "[[Gone]]"] }, // only dotted-line to the leaver
    Old: { reports_to: "[[Gone]]", left: true }, // a former report isn't flagged
    Deep: { reports_to: "[[A]]" }, // grand-report isn't flagged
  });
  const g = buildGraph(app, files, OPTS);
  const former = new Set(["Notes/Gone.md", "Notes/Old.md"]);
  for (const n of g.nodes.values()) n.former = !!n.file && former.has(n.file.path);
  const ids = markStranded(g, (n) => !!n.former);
  assert.deepEqual(ids, ["Notes/A.md", "Notes/B.md"]);
  const gone = g.nodes.get("Notes/Gone.md")!;
  assert.equal(gone.departed, true);
  assert.equal(gone.strandedReports, 2);
  assert.ok(!g.nodes.get("Notes/C.md")!.stranded);
  assert.ok(!g.nodes.get("Notes/Deep.md")!.stranded);
  assert.ok(!g.nodes.get("Notes/Boss.md")!.departed);
  // Every render re-marks the same graph; counts must not accumulate.
  assert.deepEqual(markStranded(g, (n) => !!n.former), ids);
  assert.equal(gone.strandedReports, 2, "re-marking doesn't double the count");
  markStranded(g, () => false);
  assert.ok(!gone.departed && !g.nodes.get("Notes/A.md")!.stranded, "flags clear when no longer stranded");
});

test("markStranded works when the former manager is hidden from the view", () => {
  const { app, files } = mockApp({ Gone: {}, A: { reports_to: "[[Gone]]" } });
  // Gone filtered out: A's manager becomes a placeholder pointing at Gone's note.
  const g = buildGraph(app, files.filter((f: any) => f.basename !== "Gone"), OPTS);
  const ghost = [...g.nodes.values()].find((n) => n.ghost)!;
  assert.equal(ghost.subtitle, "outside this view");
  const ids = markStranded(g, (n) => !!n.ghost && n.file?.path === "Notes/Gone.md");
  assert.deepEqual(ids, ["Notes/A.md"]);
  assert.deepEqual(cardLines(ghost), ["former member"]);
  assert.equal(ghost.departed, true);
  markStranded(g, () => false);
  assert.deepEqual(cardLines(ghost), ["outside this view"], "the placeholder's status comes back");
});

test("planReassign moves a leaver's reports to the leaver's manager", () => {
  const leaver = is("Gone"), boss = is("Boss");
  // Primary -> replaced by the leaver's manager, dotted lines kept.
  assert.deepEqual(planReassign(["[[Gone]]", "[[D]]"], leaver, "[[Boss]]", boss), ["[[Boss]]", "[[D]]"]);
  // Already had the new manager as a dotted line: not repeated.
  assert.deepEqual(planReassign(["[[Gone]]", "[[Boss|B]]", "[[D]]"], leaver, "[[Boss]]", boss), ["[[Boss]]", "[[D]]"]);
  // Leaver only a dotted line: that line is dropped, primary untouched.
  assert.deepEqual(planReassign(["[[A]]", "[[Gone]]"], leaver, "[[Boss]]", boss), ["[[A]]"]);
  // Leaver had no manager: next dotted line promoted, or none left.
  assert.deepEqual(planReassign(["[[Gone]]", "[[D]]"], leaver, null, () => false), ["[[D]]"]);
  assert.deepEqual(planReassign(["[[Gone]]"], leaver, null, () => false), []);
  // Doesn't list the leaver.
  assert.equal(planReassign(["[[A]]"], leaver, "[[Boss]]", boss), null);
});

test("addDotted appends after existing managers, once", () => {
  assert.deepEqual(addDotted(["[[Main]]"], "[[New]]", is("New")), ["[[Main]]", "[[New]]"]);
  assert.deepEqual(addDotted(["[[Main]]", "[[D]]"], "[[New]]", is("New")), ["[[Main]]", "[[D]]", "[[New]]"]);
  assert.equal(addDotted(["[[Main]]", "[[New|N]]"], "[[New]]", is("New")), null);
  assert.equal(addDotted(["[[New]]"], "[[New]]", is("New")), null, "already the main manager");
});

test("card fields keep their order; hidden ones are tooltip-only; empty ones are skipped", () => {
  const { app, files } = mockApp({
    Jane: { role: "Engineer", "e-mail": "jane@example.com", phone: "", team: ["[[Platform|Plat]]"], country: "AU", extra: "x" },
  });
  const fields = [
    { property: "team", show: true },
    { property: "role", show: true },
    { property: "phone", show: true }, // empty
    { property: "e-mail", show: false }, // tooltip only
    { property: "country", show: true },
    { property: "extra", show: true }, // 6th: beyond the limit
  ];
  const n = buildGraph(app, files, { parentProperty: "reports_to", colorProperty: "companies", fields }).nodes.get("Notes/Jane.md")!;
  assert.deepEqual(n.fields.map((f) => f.property), ["team", "role", "phone", "e-mail", "country"], "max five, in order");
  assert.deepEqual(cardLines(n), ["Plat", "Engineer", "AU"]);
  assert.equal(n.fields.find((f) => f.property === "e-mail")!.value, "jane@example.com", "hidden field still read for the tooltip");
  assert.equal(n.subtitle, "Plat", "subtitle = first shown, non-empty field");
});

test("no fields means name only; placeholders show their status line", () => {
  const { app, files } = mockApp({ A: { role: "x", reports_to: "[[Missing]]" } });
  const g = buildGraph(app, files, { parentProperty: "reports_to", colorProperty: "companies", fields: [] });
  assert.deepEqual(cardLines(g.nodes.get("Notes/A.md")!), []);
  const ghost = [...g.nodes.values()].find((x) => x.ghost)!;
  assert.deepEqual(cardLines(ghost), ["no note"]);
});


test("taller cards: height grows per line and layout keeps cards apart", () => {
  assert.equal(cardHeight(0), NODE_H);
  assert.equal(cardHeight(1), NODE_H);
  assert.equal(cardHeight(4), NODE_H + 45);
  const notes: Record<string, any> = { Boss: {} };
  for (let i = 0; i < 4; i++) notes["R" + i] = { reports_to: "[[Boss]]" };
  notes.Deep = { reports_to: "[[R0]]" };
  const { app, files } = mockApp(notes);
  const g = buildGraph(app, files, OPTS);
  for (const dir of ["TB", "LR"] as const) {
    const H = cardHeight(5);
    const l = layoutGraph(g, { direction: dir, cardHeight: H, stackThreshold: 2 });
    assert.equal(l.cardH, H);
    const ns = [...l.nodes.values()];
    for (let i = 0; i < ns.length; i++)
      for (let j = i + 1; j < ns.length; j++) {
        const a = ns[i], b = ns[j];
        assert.ok(!(a.x < b.x + NODE_W && b.x < a.x + NODE_W && a.y < b.y + H && b.y < a.y + H), `${dir}: ${a.id} overlaps ${b.id}`);
      }
  }
});

test("the name comes from the configured property, else the file name", () => {
  const { app, files } = mockApp({
    A: { title: "Alpha", display_name: "[[Ada Lovelace|Ada]]" },
    B: { title: "" },
    C: {},
  });
  const base: GraphOptions = { parentProperty: "reports_to", colorProperty: "", fields: [] };
  const names = (o: object) => {
    const g = buildGraph(app, files, { ...base, ...o });
    return ["A", "B", "C"].map((n) => g.nodes.get(`Notes/${n}.md`)!.title);
  };
  assert.deepEqual(names({}), ["A", "B", "C"], "defaults to the file name");
  assert.deepEqual(names({ nameProperty: "title" }), ["Alpha", "B", "C"]);
  assert.deepEqual(names({ nameProperty: "display_name" }), ["Ada", "B", "C"], "links show their alias");
  assert.deepEqual(names({ nameProperty: "" }), ["A", "B", "C"], "empty = file name");
});

test("layoutGroups: each group is its own box; members sit inside; boxes don't overlap", () => {
  const { app, files } = mockApp({
    Boss: {}, A1: { reports_to: "[[Boss]]" }, A2: { reports_to: "[[Boss]]" },
    Lead: { reports_to: "[[Boss]]" }, B1: { reports_to: "[[Lead]]" }, B2: { reports_to: "[[Lead]]" },
    Solo: {}, Orphan: { reports_to: "[[Missing]]" },
  });
  const g = buildGraph(app, files, OPTS);
  const P = (n: string) => `Notes/${n}.md`;
  const groups = [
    { label: "Alpha", ids: ["Boss", "A1", "A2"].map(P) },
    { label: "Beta", ids: ["Lead", "B1", "B2", "Orphan"].map(P) },
    { label: "Empty", ids: [] },
    { label: "No value", ids: [P("Solo")] },
  ];
  const l = layoutGroups(g, groups, { aspect: 1.6 });
  const groupBoxes = l.groups!;
  assert.deepEqual(groupBoxes.map((b) => [b.label, b.count]), [["Alpha", 3], ["Beta", 5], ["No value", 1]], "empty groups dropped; placeholder joins its report's group");
  const boxOf = (label: string) => groupBoxes.find((b) => b.label === label)!;
  const inside = (id: string, label: string) => {
    const n = l.nodes.get(id)!, b = boxOf(label);
    return n.x >= b.x && n.y >= b.y && n.x + NODE_W <= b.x + b.w && n.y + l.cardH <= b.y + b.h;
  };
  for (const n of ["Boss", "A1", "A2"]) assert.ok(inside(P(n), "Alpha"), n);
  for (const n of ["Lead", "B1", "B2", "Orphan"]) assert.ok(inside(P(n), "Beta"), n);
  const ghost = [...g.nodes.values()].find((n) => n.ghost)!;
  assert.ok(inside(ghost.id, "Beta"), "placeholder");
  const bs = groupBoxes;
  for (let i = 0; i < bs.length; i++)
    for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i], b = bs[j];
      assert.ok(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), `${a.label} overlaps ${b.label}`);
    }
  // Lead reports to Boss across groups; Lead heads Beta's tree.
  assert.deepEqual([...l.crossEdges!], [`${P("Boss")}\u0000${P("Lead")}`]);
  assert.ok(l.routes.every((r) => !(r.from === P("Boss") && r.to === P("Lead"))), "cross link isn't an in-group route");
  assert.equal(l.childCount.get(P("Lead")), 2);
});

test("curves join facing sides when the report isn't below the manager", () => {
  const mk = (pts: Record<string, [number, number]>) => ({
    nodes: new Map(Object.entries(pts).map(([id, [x, y]]) => [id, { id, x, y }])),
    routes: [], width: 0, height: 0, cardH: 56, childCount: new Map(), hiddenIsolated: 0, hiddenCollapsed: 0,
  }) as any;
  const start = (d: string | null) => d!.match(/^M([-\d.]+),([-\d.]+)/)!.slice(1).map(Number);
  // Below: bottom centre -> top centre.
  assert.deepEqual(start(curvePath(mk({ a: [0, 0], b: [0, 200] }), "a", "b", "TB")), [100, 56]);
  // Up and to the right: manager's right side.
  assert.deepEqual(start(curvePath(mk({ a: [0, 300], b: [500, 0] }), "a", "b", "TB")), [200, 328]);
  // Up and to the left: manager's left side.
  assert.deepEqual(start(curvePath(mk({ a: [500, 300], b: [0, 0] }), "a", "b", "TB")), [500, 328]);
  // LR, report to the left and above: manager's top.
  assert.deepEqual(start(curvePath(mk({ a: [500, 300], b: [0, 0] }), "a", "b", "LR")), [600, 300]);
  assert.equal(curvePath(mk({ a: [0, 0] }), "a", "missing", "TB"), null);
});

test("groupLabel shows link names and aliases", () => {
  assert.equal(groupLabel("[[Ada Root]]"), "Ada Root");
  assert.equal(groupLabel("[[Platform Team|Platform]], [[Data]]"), "Platform, Data");
  assert.equal(groupLabel("Acme, Globex"), "Acme, Globex");
  assert.equal(groupLabel("[[Folder/Team A]]"), "Folder/Team A");
  assert.equal(groupLabel(""), "");
});

test("a manager outside the view listed twice is one link, counted once", () => {
  const { app, files } = mockApp({ A: { reports_to: ["[[Nobody]]", "[[Nobody|N]]"] }, B: { reports_to: "[[Nobody]]" } });
  const g = buildGraph(app, files, OPTS);
  assert.equal(g.edges.length, 2);
  assert.equal(g.external.length, 2, "one per person, not per listed value");
});

test("the colour comes from the first value as a whole, commas included", () => {
  const { app, files } = mockApp({ A: { companies: ["[[Acme, Inc.|Acme, Inc.]]", "[[Other]]"] }, B: { companies: "Plain, Co" } });
  const g = buildGraph(app, files, OPTS);
  assert.equal(g.nodes.get("Notes/A.md")!.colorKey, "Acme, Inc.");
  assert.equal(g.nodes.get("Notes/B.md")!.colorKey, "Plain, Co");
});

test("containsValue accepts the target written as a link with an alias", () => {
  assert.ok(containsValue(["[[Acme]]"], "[[Acme|ACME]]"));
  assert.ok(containsValue(["[[Acme]]"], "[[Acme#History]]"));
});

test("grouped views only hide people with no links at all, in any group", () => {
  const { app, files } = mockApp({
    Boss: {}, Peer: { reports_to: "[[Boss]]" },
    Lead: { reports_to: "[[Boss]]" }, // its only link crosses into another group
    Solo: {},
  });
  const g = buildGraph(app, files, OPTS);
  const P = (n: string) => `Notes/${n}.md`;
  const groups = [{ label: "A", ids: [P("Boss"), P("Peer")] }, { label: "B", ids: [P("Lead"), P("Solo")] }];
  const l = layoutGroups(g, groups, { hideIsolated: true });
  assert.deepEqual([...l.nodes.keys()].sort(), [P("Boss"), P("Lead"), P("Peer")]);
  assert.equal(l.hiddenIsolated, 1, "only Solo");
  assert.deepEqual([...l.crossEdges!], [`${P("Boss")}\u0000${P("Lead")}`], "the line between groups is still drawn");
});

test("collapseBelow keeps the top levels open; descendants follow every link", () => {
  const { app, files } = mockApp({
    CEO: {}, VP: { reports_to: "[[CEO]]" }, Mgr: { reports_to: "[[VP]]" }, Dev: { reports_to: "[[Mgr]]" },
    Other: {}, Dot: { reports_to: ["[[Other]]", "[[Dev]]"] }, // dotted line to Dev
  });
  const g = buildGraph(app, files, OPTS);
  const P = (n: string) => `Notes/${n}.md`;
  const sorted = (s: Set<string>) => [...s].sort();
  assert.deepEqual(sorted(collapseBelow(g, 1)), [P("CEO"), P("Mgr"), P("Other"), P("VP")], "level 1: every manager");
  assert.deepEqual(sorted(collapseBelow(g, 2)), [P("Mgr"), P("VP")], "level 2: roots' teams open");
  assert.deepEqual(sorted(collapseBelow(g, 3)), [P("Mgr")]);
  assert.deepEqual(sorted(collapseBelow(g, 6)), []);
  assert.equal(primaryParents(g).get(P("Dot")), P("Other"));
  assert.deepEqual(sorted(descendants(g, P("VP"))), [P("Dev"), P("Dot"), P("Mgr")], "includes the dotted-line report");
  assert.deepEqual(sorted(descendants(g, P("Dot"))), []);
});

test("collapseBelow handles very deep chains", () => {
  const count = 15_000;
  const nodes = new Map<string, OrgNode>();
  const edges: OrgGraph["edges"] = [];
  for (let i = 0; i < count; i++) {
    nodes.set(String(i), { id: String(i), file: null, title: String(i), subtitle: "", fields: [], colorKey: "" });
    if (i > 0) edges.push({ from: String(i - 1), to: String(i), primary: true });
  }
  const g: OrgGraph = { nodes, edges, external: [], brokenCycles: [] };
  assert.equal(collapseBelow(g, 3).size, count - 1 - 2, "every manager from the third level down");
});
