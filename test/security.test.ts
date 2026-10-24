import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, editableList, propValue, resolveImage, type OrgGraph, type OrgNode } from "../src/graph";
import { applyEdits, EditConflictError, restoreWrittenNotes, writeAll, type WrittenNote } from "../src/write";
import { ensureListTypes, propertyNames } from "../src/property-types";
import { layoutGraph } from "../src/layout";
import { DEFAULT_SETTINGS, cleanPropertyName, normalizeSettings, shouldWarnLargeChart } from "../src/settings";

test("remote images require explicit opt-in", () => {
  const app = {
    metadataCache: { getFirstLinkpathDest: (): null => null },
    vault: { getResourcePath: () => "" },
  } as any;
  const url = "https://example.com/avatar.png";
  assert.equal(resolveImage(app, url, "note.md"), undefined);
  assert.equal(resolveImage(app, url, "note.md", true), url);
});

test("settings normalization tolerates malformed persisted data", () => {
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  const malformed = normalizeSettings({
    parentProperty: 42,
    fields: { property: "role" },
    direction: "sideways",
    allowRemoteImages: "true",
    imageProperty: "",
    largeChartWarningThreshold: Number.POSITIVE_INFINITY,
  });
  assert.equal(malformed.parentProperty, "reports_to");
  assert.deepEqual(malformed.fields, []);
  assert.equal(malformed.direction, "TB");
  assert.equal(malformed.allowRemoteImages, false);
  assert.equal(malformed.imageProperty, "", "an intentionally empty optional property stays empty");
  assert.equal(malformed.largeChartWarningThreshold, 2000);

  const clamped = normalizeSettings({ fields: [{ property: " role " }], largeChartWarningThreshold: -10 });
  assert.deepEqual(clamped.fields, [{ property: "role", show: true }]);
  assert.equal(clamped.nameProperty, "", "no legacy fallback to a title property");
  assert.equal(clamped.largeChartWarningThreshold, 0);
  assert.equal(normalizeSettings({ largeChartWarningThreshold: 50_000 }).largeChartWarningThreshold, 10_000, "matches the slider's maximum");
  assert.equal(normalizeSettings({}).restoreViews, false, "views re-centre when switching back unless turned on");
  assert.equal(normalizeSettings({ restoreViews: true }).restoreViews, true);
  assert.equal(normalizeSettings({ restoreViews: "yes" }).restoreViews, false);
  assert.equal(normalizeSettings({}).noteMenu, true, "note actions on right-click are on unless turned off");
  assert.equal(normalizeSettings({ noteMenu: false }).noteMenu, false);
  assert.equal(normalizeSettings({ noteMenu: "off" }).noteMenu, true, "a malformed value falls back to the default");
});

test("undo restores only what it wrote, and reports newer edits and failures", async () => {
  const notes = new Map<string, Record<string, unknown>>([["person", { reports_to: "[[Old]]", role: "x" }]]);
  const process = async (target: string, mutate: (fm: Record<string, unknown>) => void) => {
    const fm = notes.get(target);
    if (!fm) throw new Error("missing note");
    mutate(fm);
  };
  const properties = applyEdits(notes.get("person")!, [
    { prop: "reports_to", values: ["[[Boss]]"], expected: ["[[Old]]"] },
    { prop: "former", values: ["[[Acme]]"], expected: [] },
  ]);
  assert.deepEqual(notes.get("person")!, { reports_to: ["[[Boss]]"], role: "x", former: ["[[Acme]]"] });
  const item: WrittenNote<string> = { target: "person", label: "Person", properties };

  assert.deepEqual(await restoreWrittenNotes([item], process), { failed: [], conflicted: [] });
  assert.deepEqual(notes.get("person")!, { reports_to: "[[Old]]", role: "x" }, "original value and shape back; added key removed");

  applyEdits(notes.get("person")!, [{ prop: "reports_to", values: ["[[Boss]]"], expected: ["[[Old]]"] }]);
  notes.get("person")!.reports_to = ["[[Newer]]"];
  const again: WrittenNote<string> = { ...item, properties: item.properties.slice(0, 1) };
  assert.deepEqual(await restoreWrittenNotes([again], process), { failed: [], conflicted: ["Person (reports_to)"] });
  assert.deepEqual(notes.get("person")!.reports_to, ["[[Newer]]"], "newer content is not overwritten");

  const failed = await restoreWrittenNotes([{ ...item, target: "gone", label: "Gone" }], process);
  assert.deepEqual(failed, { failed: ["Gone"], conflicted: [] });
});

test("deep hierarchies lay out without recursive stack overflow", () => {
  const count = 15_000;
  const nodes = new Map<string, OrgNode>();
  const edges: OrgGraph["edges"] = [];
  for (let i = 0; i < count; i++) {
    const id = String(i);
    nodes.set(id, { id, file: null, title: id, subtitle: "", fields: [], colorKey: "" });
    if (i > 0) edges.push({ from: String(i - 1), to: id, primary: true });
  }
  const layout = layoutGraph({ nodes, edges, external: [], brokenCycles: [] });
  assert.equal(layout.nodes.size, count);
  assert.equal(layout.routes.length, count - 1);
});

test("large chart warning respects threshold and approval", () => {
  assert.equal(shouldWarnLargeChart(2001, 2000, 0), true);
  assert.equal(shouldWarnLargeChart(2000, 2000, 0), false);
  assert.equal(shouldWarnLargeChart(50_000, 0, 0), false);
  assert.equal(shouldWarnLargeChart(50_000, 2000, 50_000), false);
  assert.equal(shouldWarnLargeChart(50_001, 2000, 50_000), true);
});

test("edits are checked against the note as it is now, not the metadata cache", () => {
  const fm: Record<string, unknown> = { reports_to: ["[[Old]]"] };
  const written = applyEdits(fm, [{ prop: "reports_to", values: ["[[New]]"], expected: ["[[Old]]"] }]);
  assert.deepEqual(fm, { reports_to: ["[[New]]"] });
  assert.deepEqual(written, [{ key: "reports_to", added: false, before: ["[[Old]]"], written: ["[[New]]"] }]);

  // The cache said [[Old]], but the note already holds a newer edit: nothing changes.
  const newer: Record<string, unknown> = { reports_to: ["[[Newer]]"], companies: ["[[A]]"] };
  assert.throws(
    () => applyEdits(newer, [
      { prop: "companies", values: [], expected: ["[[A]]"] },
      { prop: "reports_to", values: ["[[New]]"], expected: ["[[Old]]"] },
    ]),
    EditConflictError
  );
  assert.deepEqual(newer, { reports_to: ["[[Newer]]"], companies: ["[[A]]"] }, "no partial edit");

  // A missing property matches an empty plan; a single value matches a one-item plan.
  const empty: Record<string, unknown> = {};
  applyEdits(empty, [{ prop: "reports_to", values: ["[[A]]"], expected: [] }]);
  assert.deepEqual(empty, { reports_to: ["[[A]]"] });
  const scalar: Record<string, unknown> = { reports_to: "[[A]]" };
  applyEdits(scalar, [{ prop: "reports_to", values: ["[[B]]"], expected: ["[[A]]"] }]);
  assert.deepEqual(scalar, { reports_to: ["[[B]]"] });
});

test("edits always write lists, keeping untouched values as they were", () => {
  const edit = (value: unknown, values: string[], expected: string[]) => {
    const fm: Record<string, unknown> = { p: value };
    const [written] = applyEdits(fm, [{ prop: "p", values, expected }]);
    assert.deepEqual(written.written, fm.p, "undo compares against what was really written");
    return fm.p;
  };
  assert.deepEqual(edit("[[A]]", ["[[B]]"], ["[[A]]"]), ["[[B]]"], "a single value becomes a one-item list");
  assert.deepEqual(edit("[[A]]", [], ["[[A]]"]), [], "emptied: an empty list");
  assert.deepEqual(edit(undefined, ["[[B]]"], []), ["[[B]]"], "a new property is a list");
  assert.deepEqual(edit(null, ["[[B]]"], []), ["[[B]]"]);
  assert.deepEqual(edit(["[[A]]"], ["[[A]]", "[[B]]"], ["[[A]]"]), ["[[A]]", "[[B]]"]);
  assert.deepEqual(edit([7, "[[A]]"], ["7"], ["7", "[[A]]"]), [7], "a kept number stays a number");
  assert.deepEqual(edit(7, ["7", "[[B]]"], ["7"]), [7, "[[B]]"]);
});

test("ensureListTypes gives the plugin's properties the List type", () => {
  const assigned: Record<string, string> = { reports_to: "multitext", title: "text", tags: "tags", companies: "date" };
  const calls: [string, string][] = [];
  const app = {
    metadataTypeManager: {
      properties: { role: {}, teams: {} },
      getAssignedWidget: (name: string) => assigned[name.toLowerCase()] ?? null,
      setType: (name: string, type: string) => {
        calls.push([name, type]);
        assigned[name.toLowerCase()] = type;
        return Promise.resolve();
      },
    },
  };
  assert.deepEqual(
    ensureListTypes(app, ["reports_to", "Reports_To", "companies", " companies_previous ", "", "tags", "Companies"]),
    ["companies", "companies_previous"]
  );
  assert.deepEqual(calls, [["companies", "multitext"], ["companies_previous", "multitext"]], "list types are left alone; others, or none, become List");
  assert.deepEqual(ensureListTypes(app, ["companies", "companies_previous"]), [], "already List: nothing to do");
  assert.deepEqual(ensureListTypes({}, ["reports_to"]), [], "no registry: types are left as they are");
  assert.deepEqual(ensureListTypes(null, ["reports_to"]), []);
  const broken = { metadataTypeManager: { getAssignedWidget: () => { throw new Error("changed internals"); }, setType: () => undefined } };
  assert.deepEqual(ensureListTypes(broken, ["reports_to"]), [], "a registry that throws is ignored");
  const rejecting = { metadataTypeManager: { getAssignedWidget: () => null, setType: () => Promise.reject(new Error("save failed")) } };
  assert.deepEqual(ensureListTypes(rejecting, ["reports_to"]), ["reports_to"], "a failed save doesn't throw");

  assert.deepEqual(propertyNames(app).sort(), ["role", "teams"]);
  assert.deepEqual(propertyNames(null), []);
});

test("multi-note writes are all or nothing", async () => {
  const notes = new Map<string, Record<string, unknown>>([
    ["leaver", { companies: ["[[Acme]]"] }],
    ["report", { reports_to: ["[[Leaver]]"] }],
    ["locked", { reports_to: ["[[Leaver]]"] }],
  ]);
  const process = async (target: string, mutate: (fm: Record<string, unknown>) => void) => {
    if (target === "locked") throw new Error("disk full");
    const fm = structuredClone(notes.get(target)!); // like processFrontMatter: saved only if mutate succeeds
    mutate(fm);
    notes.set(target, fm);
  };
  const change = (target: string, prop: string, values: string[], expected: string[]) =>
    ({ target, label: target, edits: [{ prop, values, expected }] });

  const ok = await writeAll([change("leaver", "companies", [], ["[[Acme]]"]), change("report", "reports_to", ["[[Boss]]"], ["[[Leaver]]"])], process);
  assert.equal(ok.ok, true);
  assert.deepEqual(notes.get("report"), { reports_to: ["[[Boss]]"] });
  if (ok.ok) await restoreWrittenNotes(ok.written, process);
  assert.deepEqual(notes.get("leaver"), { companies: ["[[Acme]]"] }, "undone");

  const failed = await writeAll([
    change("leaver", "companies", [], ["[[Acme]]"]),
    change("report", "reports_to", ["[[Boss]]"], ["[[Leaver]]"]),
    change("locked", "reports_to", ["[[Boss]]"], ["[[Leaver]]"]),
  ], process);
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.failed, "locked");
    assert.equal(failed.rolledBack, 2);
    assert.deepEqual(failed.rollback, { failed: [], conflicted: [] });
  }
  assert.deepEqual(notes.get("leaver"), { companies: ["[[Acme]]"] }, "earlier notes rolled back");
  assert.deepEqual(notes.get("report"), { reports_to: ["[[Leaver]]"] });

  // A note that changed since the edit was planned stops everything before it's written.
  const stale = await writeAll([change("report", "reports_to", ["[[Boss]]"], ["[[Someone else]]"])], process);
  assert.ok(!stale.ok && stale.error instanceof EditConflictError && stale.rolledBack === 0);
  assert.deepEqual(notes.get("report"), { reports_to: ["[[Leaver]]"] });
});

test("property names with control characters are refused", () => {
  assert.equal(cleanPropertyName(" reports_to "), "reports_to");
  assert.equal(cleanPropertyName("bad\nname"), "");
  assert.equal(cleanPropertyName("bad\u0085name", "fallback"), "fallback");
  assert.equal(cleanPropertyName(42, "fallback"), "fallback");
  assert.equal(normalizeSettings({ parentProperty: "x\u0000" }).parentProperty, "reports_to");
});

test("edits refuse values that can't be written back as text", () => {
  for (const value of [[{}], true, {}, [["nested"]]]) {
    const fm: Record<string, unknown> = { reports_to: value };
    assert.throws(() => applyEdits(fm, [{ prop: "reports_to", values: [], expected: [] }]), EditConflictError);
    assert.deepEqual(fm, { reports_to: value }, "left untouched");
  }
  assert.equal(editableList([{ a: 1 }]), null);
  assert.equal(editableList([true]), null);
  assert.deepEqual(editableList(["[[A]]", 7, null]), ["[[A]]", "7"], "empty items dropped, numbers as text");
});

test("property names match regardless of case, keeping the note's spelling", () => {
  assert.equal(propValue({ Reports_To: "[[A]]" }, "reports_to"), "[[A]]");
  assert.equal(propValue({ reports_to: "[[B]]", Reports_To: "[[A]]" }, "reports_to"), "[[B]]", "exact match wins");
  const fm: Record<string, unknown> = { Reports_To: ["[[A]]"] };
  const written = applyEdits(fm, [{ prop: "reports_to", values: ["[[B]]"], expected: ["[[A]]"] }]);
  assert.deepEqual(fm, { Reports_To: ["[[B]]"] }, "no second, differently cased key");
  assert.equal(written[0].key, "Reports_To", "undo restores the same key");
});

test("placeholders without a note are identified by link target, not alias", () => {
  const files = ["A", "B", "C"].map((n) => ({ path: `${n}.md`, basename: n })) as any[];
  const fm: Record<string, unknown> = {
    A: { reports_to: "[[Jane Doe|Jane]]" },
    B: { reports_to: "[[Jane Smith|Jane]]" },
    C: { reports_to: "[[jane doe]]" },
  };
  const app = {
    metadataCache: {
      getFileCache: (f: { basename: string }) => ({ frontmatter: fm[f.basename] }),
      getFirstLinkpathDest: (): null => null,
    },
  } as any;
  const g = buildGraph(app, files, { parentProperty: "reports_to", colorProperty: "" });
  const ghosts = [...g.nodes.values()].filter((n) => n.ghost);
  assert.equal(ghosts.length, 2, "same alias, different people");
  const doe = ghosts.find((n) => n.linkTarget === "Jane Doe")!;
  assert.equal(doe.title, "Jane", "the alias is still what's shown");
  assert.deepEqual(g.edges.filter((e) => e.from === doe.id).map((e) => e.to).sort(), ["A.md", "C.md"]);
});
