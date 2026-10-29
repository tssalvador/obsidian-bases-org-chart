import { propValue, singleText, type CardField } from "./graph";
import type { PropertyEdit } from "./write";

/*
 * Editing a card in place: which of its properties can be edited, and the
 * edits to save. Kept free of Obsidian so it can be tested on its own.
 */

/** A property shown on the card that can be edited in place. */
export interface EditableField {
  property: string;
  /** Its value when editing started, as text ("" when empty). */
  value: string;
  /** Numbers are stored as numbers again. */
  number: boolean;
  /** The card's name (the name property) rather than a field. */
  name: boolean;
}

export interface EditableOptions {
  /** Property holding the card's name; empty means the file name, which isn't edited here. */
  nameProperty: string;
  /** The configured card fields; only those shown on the card are edited. */
  fields: CardField[];
}

/**
 * The card's editable properties, in card order: the name (when it comes
 * from a property), then each shown field holding a single plain value.
 * Lists, links, checkboxes and other values are left out, as are properties
 * whose type (`typeOf`, e.g. from Obsidian's property registry) is a list or
 * checkbox even when they're empty. Each property appears once.
 */
export function editableFields(
  fm: Record<string, unknown> | undefined,
  opts: EditableOptions,
  typeOf: (property: string) => string | null,
  isMultiValue: (type: string | null) => boolean
): EditableField[] {
  const out: EditableField[] = [];
  const seen = new Set<string>();
  const consider = (property: string, name: boolean) => {
    const p = property.trim();
    if (!p || seen.has(p.toLowerCase())) return;
    seen.add(p.toLowerCase());
    const type = typeOf(p);
    if (isMultiValue(type)) return;
    const raw = propValue(fm, p);
    const value = singleText(raw);
    if (value === null) return;
    out.push({ property: p, value, number: typeof raw === "number" || type === "number", name });
  };
  if (opts.nameProperty) consider(opts.nameProperty, true);
  for (const f of opts.fields) if (f.show) consider(f.property, false);
  return out;
}

/** The edits for the text typed into each field (by property); unchanged fields are left out. */
export function fieldEdits(fields: EditableField[], typed: ReadonlyMap<string, string>): PropertyEdit[] {
  const edits: PropertyEdit[] = [];
  for (const f of fields) {
    const text = typed.get(f.property);
    if (text === undefined || text.trim() === f.value.trim()) continue;
    // A blank name empties the property, so the card falls back to the file name.
    edits.push({ prop: f.property, values: [text], expected: [f.value], single: f.number ? "number" : "text" });
  }
  return edits;
}
