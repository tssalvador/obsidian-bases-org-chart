import { test } from "node:test";
import assert from "node:assert/strict";
import { singleText } from "../src/graph";
import { editableFields, fieldEdits } from "../src/inline-edit";
import { applyEdits, EditConflictError, restoreWrittenNotes } from "../src/write";
import { isMultiValueType } from "../src/property-types";

const noTypes = () => null;
const fields = (...props: [string, boolean][]) => props.map(([property, show]) => ({ property, show }));

// ---- What can be edited ----

test("singleText accepts one plain value and refuses lists, links and other values", () => {
  assert.equal(singleText("CEO"), "CEO");
  assert.equal(singleText(42), "42");
  assert.equal(singleText(undefined), "");
  assert.equal(singleText(null), "");
  assert.equal(singleText(""), "");
  assert.equal(singleText(["CEO"]), null, "a list, even of one");
  assert.equal(singleText("[[Acme]]"), null, "a link is shown by its alias; editing it would lose the link");
  assert.equal(singleText("![[pic.png]]"), null);
  assert.equal(singleText("See [[Acme]] for details"), "See [[Acme]] for details", "text with a link inside is still text");
  assert.equal(singleText(true), null);
  assert.equal(singleText({ a: 1 }), null);
  assert.equal(singleText(Number.NaN), null);
});

test("the name (from a property) comes first, then shown fields in card order", () => {
  const fm = { title: "Ada Root", role: "CEO", phone: "0491 570 006", email: "ada@acme.example" };
  const got = editableFields(fm, { nameProperty: "title", fields: fields(["role", true], ["email", false], ["phone", true]) }, noTypes, isMultiValueType);
  assert.deepEqual(got.map((f) => [f.property, f.value, f.name]), [
    ["title", "Ada Root", true],
    ["role", "CEO", false],
    ["phone", "0491 570 006", false],
  ], "tooltip-only fields aren't on the card, so aren't edited");
});

test("a name from the file name isn't editable; empty shown fields are, so they can be filled in", () => {
  const got = editableFields({ role: "CEO" }, { nameProperty: "", fields: fields(["role", true], ["phone", true]) }, noTypes, isMultiValueType);
  assert.deepEqual(got.map((f) => [f.property, f.value]), [["role", "CEO"], ["phone", ""]]);
  const missingTitle = editableFields({}, { nameProperty: "title", fields: [] }, noTypes, isMultiValueType);
  assert.deepEqual(missingTitle.map((f) => [f.property, f.value]), [["title", ""]], "a name property can be filled in");
});

test("lists, links, checkboxes and list-typed properties are left out", () => {
  const fm = { teams: ["Eng"], manager: "[[Ben Ops]]", active: true, tags: undefined, role: "CTO" };
  const types: Record<string, string> = { tags: "tags", active: "checkbox" };
  const got = editableFields(
    fm,
    { nameProperty: "", fields: fields(["teams", true], ["manager", true], ["active", true], ["tags", true], ["role", true]) },
    (p) => types[p] ?? null,
    isMultiValueType
  );
  assert.deepEqual(got.map((f) => f.property), ["role"], "an empty property whose type is a list stays read-only too");
});

test("each property appears once, matched regardless of case; numbers are marked", () => {
  const fm = { Title: "Ada", level: 7 };
  const got = editableFields(fm, { nameProperty: "title", fields: fields(["TITLE", true], ["level", true]) }, noTypes, isMultiValueType);
  assert.deepEqual(got.map((f) => [f.property, f.value, f.number]), [["title", "Ada", false], ["level", "7", true]]);
  const typed = editableFields({}, { nameProperty: "", fields: fields(["level", true]) }, () => "number", isMultiValueType);
  assert.equal(typed[0].number, true, "an empty number property is stored as a number");
});

// ---- What gets saved ----

test("only changed fields are saved, as single values; a blank name is ignored", () => {
  const fs = editableFields(
    { title: "Ada", role: "CEO", level: 7 },
    { nameProperty: "title", fields: fields(["role", true], ["phone", true], ["level", true]) },
    noTypes,
    isMultiValueType
  );
  const edits = fieldEdits(fs, new Map([["title", "  "], ["role", "CEO "], ["phone", "0491 570 110"], ["level", "8"]]));
  assert.deepEqual(edits, [
    { prop: "phone", values: ["0491 570 110"], expected: [""], single: "text" },
    { prop: "level", values: ["8"], expected: ["7"], single: "number" },
  ]);
});

test("a single edit writes one value, keeps the note's spelling, and undoes cleanly", async () => {
  const fm: Record<string, unknown> = { Role: "CEO", level: 7, other: ["kept"] };
  const written = applyEdits(fm, [
    { prop: "role", values: [" Chief Executive "], expected: ["CEO"], single: "text" },
    { prop: "level", values: ["8"], expected: ["7"], single: "number" },
    { prop: "phone", values: ["0491 570 110"], expected: [""], single: "text" },
  ]);
  assert.deepEqual(fm, { Role: "Chief Executive", level: 8, other: ["kept"], phone: "0491 570 110" });
  const process = async (_t: string, mutate: (f: Record<string, unknown>) => void) => mutate(fm);
  const result = await restoreWrittenNotes([{ target: "ada", label: "Ada", properties: written }], process);
  assert.deepEqual(result, { failed: [], conflicted: [] });
  assert.deepEqual(fm, { Role: "CEO", level: 7, other: ["kept"] }, "an added property is removed again");
});

test("clearing a field leaves the property empty; non-numeric text in a number field stays text", () => {
  const fm: Record<string, unknown> = { role: "CEO", level: 7 };
  applyEdits(fm, [
    { prop: "role", values: [""], expected: ["CEO"], single: "text" },
    { prop: "level", values: ["seven"], expected: ["7"], single: "number" },
  ]);
  assert.deepEqual(fm, { role: null, level: "seven" });
});

test("a single edit is refused when the note changed, or now holds a list, and nothing is written", () => {
  const changed: Record<string, unknown> = { role: "CTO", phone: "1" };
  assert.throws(
    () => applyEdits(changed, [
      { prop: "phone", values: ["2"], expected: ["1"], single: "text" },
      { prop: "role", values: ["COO"], expected: ["CEO"], single: "text" },
    ]),
    EditConflictError
  );
  assert.deepEqual(changed, { role: "CTO", phone: "1" }, "the earlier, valid edit isn't applied either");
  const list: Record<string, unknown> = { role: ["CEO"] };
  assert.throws(() => applyEdits(list, [{ prop: "role", values: ["COO"], expected: ["CEO"], single: "text" }]), EditConflictError);
  assert.deepEqual(list, { role: ["CEO"] });
});
