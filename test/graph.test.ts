import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, containsValue, linkTarget, resolveImage } from "../src/graph";
import { clampTransform, fitTransform, openTransform, Viewport, zoomAt } from "../src/viewport";
import { initials } from "../src/render";
import { NODE_H, NODE_W, layoutGraph } from "../src/layout";

type FM = Record<string, unknown>;

/** Minimal stand-in for app.metadataCache over an in-memory set of notes. */
function mockApp(notes: Record<string, FM>) {
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

const OPTS = { parentProperty: "reports_to", fields: [{ property: "role", show: true }], colorProperty: "companies" };
const p = (n: string) => `Notes/${n}.md`;

test("linkTarget strips wikilink syntax, aliases and headings", () => {
  assert.equal(linkTarget("[[Jane Doe]]"), "Jane Doe");
  assert.equal(linkTarget("[[Jane Doe|Jane]]"), "Jane Doe");
  assert.equal(linkTarget("[[Jane Doe#Role|J]]"), "Jane Doe");
  assert.equal(linkTarget("Jane Doe"), "Jane Doe");
});

test("builds parent -> child edges; first parent is primary, rest dotted-line", () => {
  const { app, files } = mockApp({
    Boss: { role: "CEO", companies: ["[[Acme]]"] },
    A: { reports_to: "[[Boss]]" },
    B: { reports_to: ["[[A]]", "[[Boss]]"] },
  });
  const g = buildGraph(app, files, OPTS);
  const edges = g.edges.map((e) => `${e.from}>${e.to}:${e.primary ? "P" : "D"}`).sort();
  assert.deepEqual(edges, [`${p("A")}>${p("B")}:P`, `${p("Boss")}>${p("A")}:P`, `${p("Boss")}>${p("B")}:D`]);
  assert.equal(g.nodes.get(p("Boss"))!.subtitle, "CEO");
  assert.equal(g.nodes.get(p("Boss"))!.colorKey, "Acme");
});

test("unresolved parent becomes one shared ghost node", () => {
  const { app, files } = mockApp({
    A: { reports_to: "[[Nobody]]" },
    B: { reports_to: "[[Nobody]]" },
  });
  const g = buildGraph(app, files, OPTS);
  const ghosts = [...g.nodes.values()].filter((n) => n.ghost);
  assert.equal(ghosts.length, 1);
  assert.equal(ghosts[0].title, "Nobody");
  assert.equal(g.external.length, 2);
  assert.equal(g.edges.length, 2);
});

test("cycles are broken and the cycle still lays out as one tree", () => {
  const { app, files } = mockApp({
    X: { reports_to: "[[Y]]" },
    Y: { reports_to: "[[Z]]" },
    Z: { reports_to: "[[X]]" },
  });
  const g = buildGraph(app, files, OPTS);
  assert.equal(g.brokenCycles.length, 1);
  assert.equal(g.edges.length, 2);
  const l = layoutGraph(g, { direction: "TB" });
  const ys = new Set([...l.nodes.values()].map((n) => n.y));
  assert.equal(ys.size, 3, "three ranks = a chain, not a loop");
});

test("self-reference and duplicate links are ignored", () => {
  const { app, files } = mockApp({
    Boss: {},
    A: { reports_to: ["[[A]]", "[[Boss]]", "[[Boss|B]]"] },
  });
  const g = buildGraph(app, files, OPTS);
  assert.equal(g.edges.length, 1);
  assert.equal(g.brokenCycles.length, 0);
});

test("dotted-line manager doesn't pull a peer down a rank", () => {
  const { app, files } = mockApp({
    Boss: {},
    Ops: { reports_to: "[[Boss]]" },
    Tech: { reports_to: "[[Boss]]" },
    Mgr: { reports_to: "[[Tech]]" },
    Dev: { reports_to: ["[[Mgr]]", "[[Ops]]"] },
  });
  const l = layoutGraph(buildGraph(app, files, OPTS), { direction: "TB" });
  assert.equal(l.nodes.get(p("Ops"))!.y, l.nodes.get(p("Tech"))!.y, "Ops and Tech are peers");
  assert.ok(l.nodes.get(p("Boss"))!.y < l.nodes.get(p("Ops"))!.y);
});

test("separate orgs occupy disjoint columns; singletons sit below the trees", () => {
  const { app, files } = mockApp({
    A1: {}, A2: { reports_to: "[[A1]]" }, A3: { reports_to: "[[A1]]" },
    B1: {}, B2: { reports_to: "[[B1]]" },
    Solo: {},
  });
  const l = layoutGraph(buildGraph(app, files, OPTS), { direction: "TB" });
  const box = (ids: string[]) => {
    const ns = ids.map((n) => l.nodes.get(p(n))!);
    return {
      x0: Math.min(...ns.map((n) => n.x)), x1: Math.max(...ns.map((n) => n.x + NODE_W)),
      y0: Math.min(...ns.map((n) => n.y)), y1: Math.max(...ns.map((n) => n.y + NODE_H)),
    };
  };
  const A = box(["A1", "A2", "A3"]);
  const B = box(["B1", "B2"]);
  assert.ok(A.x1 <= B.x0 || B.x1 <= A.x0 || A.y1 <= B.y0 || B.y1 <= A.y0, "org boxes don't overlap");
  assert.ok(A.x0 <= B.x0 && A.y0 <= B.y0, "larger org first");
  const treeBottom = Math.max(...["A2", "A3", "B2"].map((n) => l.nodes.get(p(n))!.y));
  assert.ok(l.nodes.get(p("Solo"))!.y > treeBottom, "singleton below trees");
});

const BIG = {
  CEO: {},
  VP1: { reports_to: "[[CEO]]" }, VP2: { reports_to: "[[CEO]]" }, VP3: { reports_to: "[[CEO]]" },
  M1: { reports_to: "[[VP1]]" }, M2: { reports_to: "[[VP1]]" }, M3: { reports_to: "[[VP2]]" },
  E1: { reports_to: "[[M1]]" }, E2: { reports_to: "[[M1]]" }, E3: { reports_to: "[[M1]]" },
  E4: { reports_to: "[[M3]]" }, Solo1: {}, Solo2: {},
};

test("no two cards overlap", () => {
  for (const dir of ["TB", "LR"] as const) {
    const { app, files } = mockApp(BIG);
    const l = layoutGraph(buildGraph(app, files, OPTS), { direction: dir });
    const ns = [...l.nodes.values()];
    for (let i = 0; i < ns.length; i++)
      for (let j = i + 1; j < ns.length; j++) {
        const a = ns[i], b = ns[j];
        const overlap = a.x < b.x + NODE_W && b.x < a.x + NODE_W && a.y < b.y + NODE_H && b.y < a.y + NODE_H;
        assert.ok(!overlap, `${dir}: ${a.id} overlaps ${b.id}`);
      }
  }
});

test("each manager is centred over their reports", () => {
  const { app, files } = mockApp(BIG);
  const l = layoutGraph(buildGraph(app, files, OPTS), { direction: "TB" });
  const cx = (n: string) => l.nodes.get(p(n))!.x + NODE_W / 2;
  assert.equal(cx("M1"), (cx("E1") + cx("E3")) / 2);
  assert.equal(cx("VP1"), (cx("M1") + cx("M2")) / 2);
  assert.equal(cx("CEO"), (cx("VP1") + cx("VP3")) / 2);
  assert.equal(cx("M3"), cx("E4"), "single report sits directly below");
});

test("left-to-right ranks along x", () => {
  const { app, files } = mockApp(BIG);
  const l = layoutGraph(buildGraph(app, files, OPTS), { direction: "LR" });
  const x = (n: string) => l.nodes.get(p(n))!.x;
  assert.ok(x("CEO") < x("VP1") && x("VP1") < x("M1") && x("M1") < x("E1"));
  assert.equal(x("VP1"), x("VP3"));
});

test("resolveImage handles links, embeds, URLs and rejects non-images", () => {
  const files: Record<string, { path: string; basename: string; extension: string }> = {
    "pic.jpg": { path: "att/pic.jpg", basename: "pic", extension: "jpg" },
    "doc.pdf": { path: "att/doc.pdf", basename: "doc", extension: "pdf" },
  };
  const app: any = {
    metadataCache: { getFirstLinkpathDest: (t: string) => files[t] ?? null },
    vault: { getResourcePath: (f: { path: string }) => `app://local/${f.path}` },
  };
  assert.equal(resolveImage(app, "[[pic.jpg]]", "n.md"), "app://local/att/pic.jpg");
  assert.equal(resolveImage(app, "![[pic.jpg|100]]", "n.md"), "app://local/att/pic.jpg");
  assert.equal(resolveImage(app, ["[[pic.jpg]]", "[[x.png]]"], "n.md"), "app://local/att/pic.jpg");
  assert.equal(resolveImage(app, "https://example.com/a.png", "n.md", true), "https://example.com/a.png");
  assert.equal(resolveImage(app, "[[doc.pdf]]", "n.md"), undefined);
  assert.equal(resolveImage(app, "[[missing.jpg]]", "n.md"), undefined);
  assert.equal(resolveImage(app, "", "n.md"), undefined);
  assert.equal(resolveImage(app, null, "n.md"), undefined);
});

test("initials", () => {
  assert.equal(initials("Ada Lovelace"), "AL");
  assert.equal(initials("Mary Ann van der Berg"), "MB");
  assert.equal(initials("madonna"), "M");
  assert.equal(initials("Élodie Ōtsuka"), "ÉŌ");
  assert.equal(initials("  "), "?");
});

test("collapsed managers hide their whole subtree", () => {
  const { app, files } = mockApp(BIG);
  const g = buildGraph(app, files, OPTS);
  const l = layoutGraph(g, { collapsed: new Set([p("VP1")]) });
  for (const n of ["M1", "M2", "E1", "E2", "E3"]) assert.ok(!l.nodes.has(p(n)), `${n} hidden`);
  assert.ok(l.nodes.has(p("VP1")) && l.nodes.has(p("M3")));
  assert.equal(l.hiddenCollapsed, 5);
  assert.equal(l.childCount.get(p("VP1")), 2, "count still reported for the toggle");
});

test("hideIsolated drops unlinked people but keeps dotted-line-only people", () => {
  const { app, files } = mockApp({
    Boss: {}, A: { reports_to: "[[Boss]]" },
    Solo: {},
    Dot: { reports_to: ["[[A]]"] },
  });
  const all = layoutGraph(buildGraph(app, files, OPTS), {});
  const hid = layoutGraph(buildGraph(app, files, OPTS), { hideIsolated: true });
  assert.ok(all.nodes.has(p("Solo")));
  assert.ok(!hid.nodes.has(p("Solo")));
  assert.equal(hid.hiddenIsolated, 1);
});

test("large leaf teams stack into columns without overlapping", () => {
  const notes: Record<string, FM> = { Mgr: {} };
  for (let i = 0; i < 9; i++) notes["R" + i] = { reports_to: "[[Mgr]]" };
  const { app, files } = mockApp(notes);
  const g = buildGraph(app, files, OPTS);
  const flat = layoutGraph(g, { stackThreshold: 0 });
  const stacked = layoutGraph(g, { stackThreshold: 4 });
  assert.ok(stacked.width < flat.width / 2, "stacked is much narrower");
  const xs = new Set([...stacked.nodes.values()].filter((n) => n.id !== p("Mgr")).map((n) => n.x));
  assert.equal(xs.size, 3, "9 reports at threshold 4 -> 3 columns");
  const ns = [...stacked.nodes.values()];
  for (let i = 0; i < ns.length; i++)
    for (let j = i + 1; j < ns.length; j++) {
      const a = ns[i], b = ns[j];
      assert.ok(!(a.x < b.x + NODE_W && b.x < a.x + NODE_W && a.y < b.y + NODE_H && b.y < a.y + NODE_H), "no overlap");
    }
  assert.equal(stacked.routes.length, 9, "every report keeps a connector");
});

test("teams with sub-teams are never stacked", () => {
  const notes: Record<string, FM> = { Mgr: {}, Lead: { reports_to: "[[Mgr]]" }, Dev: { reports_to: "[[Lead]]" } };
  for (let i = 0; i < 8; i++) notes["R" + i] = { reports_to: "[[Mgr]]" };
  const { app, files } = mockApp(notes);
  const l = layoutGraph(buildGraph(app, files, OPTS), { stackThreshold: 4 });
  const ys = new Set(["Lead", "R0", "R7"].map((n) => l.nodes.get(p(n))!.y));
  assert.equal(ys.size, 1, "direct reports share one row");
});

test("zoomAt keeps the pointer fixed; fitTransform fits and never enlarges", () => {
  const t = zoomAt({ x: 10, y: 20, k: 1 }, 2, 110, 120);
  // content point under the pointer before: ((110-10)/1, (120-20)/1) = (100,100)
  assert.equal(t.x + 100 * t.k, 110);
  assert.equal(t.y + 100 * t.k, 120);
  const f = fitTransform(2000, 1000, 1000, 600, 0);
  assert.equal(f.k, 0.5);
  assert.equal(fitTransform(100, 100, 1000, 1000).k, 1);
});

test("containsValue matches links, aliases and plain text case-insensitively", () => {
  assert.ok(containsValue(["[[Initech Ltd]]"], "Initech Ltd"));
  assert.ok(containsValue("[[Initech Ltd|Initech]]", "initech"));
  assert.ok(containsValue("[[Acme]]", "[[Acme]]"));
  assert.ok(!containsValue(["[[Acme Corp]]"], "Acme"));
  assert.ok(!containsValue(null, "Acme"));
  assert.ok(!containsValue(["[[Acme]]"], ""));
});

test("former members are flagged from the configured property and value", () => {
  const { app, files } = mockApp({
    Old: { companies_previous: ["[[Acme]]"] },
    Now: { companies: ["[[Acme]]"] },
  });
  const g = buildGraph(app, files, { ...OPTS, formerProperty: "companies_previous", formerValues: ["Acme"] });
  assert.equal(g.nodes.get(p("Old"))!.former, true);
  assert.equal(g.nodes.get(p("Now"))!.former, false);
  const either = buildGraph(app, files, { ...OPTS, formerProperty: "companies_previous", formerValues: ["Globex", "[[Acme]]"] });
  assert.equal(either.nodes.get(p("Old"))!.former, true, "any of several values");
  const none = buildGraph(app, files, { ...OPTS, formerProperty: "companies_previous", formerValues: [] });
  assert.equal(none.nodes.get(p("Old"))!.former, false, "no values: no rule");
});

test("many small trees wrap into rows to fit the viewport shape", () => {
  const notes: Record<string, FM> = {};
  for (let i = 0; i < 30; i++) {
    notes["M" + i] = {};
    notes["R" + i] = { reports_to: `[[M${i}]]` };
  }
  const { app, files } = mockApp(notes);
  const l = layoutGraph(buildGraph(app, files, OPTS), { aspect: 16 / 10 });
  const ratio = l.width / l.height;
  assert.ok(ratio > 0.8 && ratio < 3.2, `aspect ${ratio.toFixed(2)} near 1.6`);
});

test("openTransform: 100% zoom, centred when it fits, focused and clamped when not", () => {
  // Fits: centred on both axes.
  assert.deepEqual(openTransform(400, 200, 1000, 600), { k: 1, x: 300, y: 200 });
  // Wider and taller than the view, focus near the top middle (TB root).
  const t = openTransform(5000, 2000, 1000, 600, { x: 2500, y: 50 });
  assert.equal(t.k, 1);
  assert.equal(t.x, 500 - 2500, "focus centred horizontally");
  assert.equal(t.y, 0, "top-aligned rather than scrolled above the chart");
  // Focus near the right edge is clamped so the view doesn't run past it.
  assert.equal(openTransform(5000, 100, 1000, 600, { x: 4990, y: 0 }).x, 1000 - 5000);
});

test("layout reports the largest org's head as focus", () => {
  const { app, files } = mockApp({
    Small: {}, S1: { reports_to: "[[Small]]" },
    Big: {}, B1: { reports_to: "[[Big]]" }, B2: { reports_to: "[[Big]]" },
  });
  assert.equal(layoutGraph(buildGraph(app, files, OPTS)).focus, p("Big"));
});

test("keepIsolated keeps chosen people visible when hiding unlinked ones", () => {
  const { app, files } = mockApp({ Boss: {}, A: { reports_to: "[[Boss]]" }, Solo: {}, Old: {} });
  const g = buildGraph(app, files, OPTS);
  const l = layoutGraph(g, { hideIsolated: true, keepIsolated: (id) => id === p("Old") });
  assert.ok(l.nodes.has(p("Old")));
  assert.ok(!l.nodes.has(p("Solo")));
  assert.equal(l.hiddenIsolated, 1);
});

test("clampTransform keeps the chart on screen", () => {
  // Larger than the view: can't scroll past its edges (48px slack).
  assert.deepEqual(clampTransform({ x: 500, y: 500, k: 1 }, 3000, 2000, 1000, 600), { x: 48, y: 48, k: 1 });
  assert.deepEqual(clampTransform({ x: -9000, y: -9000, k: 1 }, 3000, 2000, 1000, 600), { x: 1000 - 3000 - 48, y: 600 - 2000 - 48, k: 1 });
  // Inside the allowed range: untouched.
  assert.deepEqual(clampTransform({ x: -700, y: -300, k: 1 }, 3000, 2000, 1000, 600), { x: -700, y: -300, k: 1 });
  // Smaller than the view: stays fully visible.
  assert.deepEqual(clampTransform({ x: -500, y: 900, k: 1 }, 200, 100, 1000, 600), { x: 48, y: 600 - 100 - 48, k: 1 });
  // Zoom is taken into account.
  assert.deepEqual(clampTransform({ x: 900, y: 0, k: 0.5 }, 1000, 400, 1000, 600), { x: 1000 - 500 - 48, y: 48, k: 0.5 });
});

test("scrolling pans a chart in its own tab; elsewhere the page scrolls, and Ctrl/Cmd still zooms", () => {
  // Stand-ins for the canvas element and the owning component (which registers the listeners).
  const listeners: Record<string, (e: any) => void> = {};
  const owner = { registerDomEvent: (_el: unknown, type: string, fn: (e: any) => void) => { listeners[type] = fn; } };
  const el = { clientWidth: 800, clientHeight: 600, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const vp = new Viewport(el as any, owner as any);
  let ownTab = true;
  vp.wheelPans = () => ownTab;
  const wheel = (init: Record<string, unknown>) => {
    let prevented = false;
    listeners.wheel({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, clientX: 400, clientY: 300, ...init, preventDefault: () => { prevented = true; } });
    return prevented;
  };

  assert.equal(wheel({ deltaY: 50 }), true, "own tab: the chart takes the scroll");
  assert.deepEqual(vp.t, { x: 0, y: -50, k: 1 });

  ownTab = false;
  assert.equal(wheel({ deltaY: 50, deltaX: 20 }), false, "embedded: left to the page");
  assert.deepEqual(vp.t, { x: 0, y: -50, k: 1 }, "and the chart doesn't move");
  assert.equal(wheel({ deltaY: -50, ctrlKey: true }), true, "pinch or Ctrl+scroll zooms");
  assert.ok(vp.t.k > 1);
  const k = vp.t.k;
  assert.equal(wheel({ deltaY: 50, metaKey: true }), true, "Cmd+scroll zooms");
  assert.ok(vp.t.k < k);
});
