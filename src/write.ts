import { editableList, propKey } from "./graph";

/*
 * Note edits, as mutations of a note's parsed frontmatter. They run inside
 * Obsidian's fileManager.processFrontMatter, which reads the note's current
 * text, hands us the parsed object and saves it again.
 *
 * Every property the chart edits (parent, current membership, former
 * members) is a list, so values are always written as a list, even a single
 * one; see ensureListTypes for the matching property type.
 */

/** One property to rewrite, with the values the new list was planned from. */
export interface PropertyEdit {
  prop: string;
  values: string[];
  /** The property's values when the edit was planned (from the metadata cache). */
  expected: string[];
}

/** What an edit changed, so it can be undone. */
export interface WrittenProperty {
  /** The key as spelled in the note. */
  key: string;
  /** The key was absent before the edit. */
  added: boolean;
  /** The value before the edit (a copy). */
  before: unknown;
  /** The list written (a copy). */
  written: unknown[];
}

export interface WrittenNote<T> {
  target: T;
  label: string;
  properties: WrittenProperty[];
}

interface RestoreResult {
  failed: string[];
  conflicted: string[];
}

type Frontmatter = Record<string, unknown>;

/** Runs `mutate` on a note's frontmatter and saves it (Obsidian's processFrontMatter). */
type Process<T> = (target: T, mutate: (fm: Frontmatter) => void) => Promise<unknown>;

/** The note changed since the edit was planned, or holds values that can't be rewritten safely. */
export class EditConflictError extends Error {}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => sameValue((a as Frontmatter)[k], (b as Frontmatter)[k]));
  }
  return false;
}

/** The list to store for `values`. Items kept from before keep their original form (e.g. numbers). */
function listValue(old: unknown, values: string[]): unknown[] {
  const originals = new Map<string, unknown>();
  for (const item of Array.isArray(old) ? old : [old]) if (item != null) originals.set(String(item), item);
  return values.map((v) => (originals.has(v) ? originals.get(v) : v));
}

/**
 * Apply `edits` to a note's freshly parsed frontmatter. Every property must
 * still hold the values the edit was planned from, and only plain text (or
 * numbers); otherwise nothing is changed and an EditConflictError is thrown.
 */
export function applyEdits(fm: Frontmatter, edits: PropertyEdit[]): WrittenProperty[] {
  // Check everything before changing anything, so a refused edit leaves the note untouched.
  const keys = edits.map((e) => {
    const key = propKey(fm, e.prop) ?? e.prop; // keep the note's spelling, e.g. "Reports_To"
    const list = editableList(fm[key]);
    if (list === null) throw new EditConflictError(`"${key}" holds values that aren't plain text`);
    if (!sameValue(list, e.expected)) throw new EditConflictError(`"${key}" changed since the edit was planned`);
    return key;
  });
  return edits.map((e, i) => {
    const key = keys[i];
    const added = !Object.prototype.hasOwnProperty.call(fm, key);
    const before = added ? undefined : structuredClone(fm[key]);
    const value = listValue(fm[key], e.values);
    fm[key] = value;
    return { key, added, before, written: structuredClone(value) };
  });
}

/** Undo properties that still hold exactly what was written; returns the keys that have changed since. */
function restoreProperties(fm: Frontmatter, properties: WrittenProperty[]): string[] {
  const conflicts: string[] = [];
  for (const p of [...properties].reverse()) {
    if (!sameValue(fm[p.key], p.written)) {
      conflicts.push(p.key);
      continue;
    }
    if (p.added) delete fm[p.key];
    else fm[p.key] = structuredClone(p.before);
  }
  return conflicts;
}

/** Attempt every note restoration, collecting conflicts and failures instead of hiding them. */
export async function restoreWrittenNotes<T>(items: WrittenNote<T>[], process: Process<T>): Promise<RestoreResult> {
  const failed = new Set<string>();
  const conflicted = new Set<string>();
  for (const item of [...items].reverse()) {
    let conflicts: string[] = [];
    try {
      await process(item.target, (fm) => {
        conflicts = restoreProperties(fm, item.properties);
      });
      for (const key of conflicts) conflicted.add(`${item.label} (${key})`);
    } catch {
      failed.add(item.label);
    }
  }
  return { failed: [...failed], conflicted: [...conflicted] };
}

/** Edits to one note. */
export interface NoteChange<T> {
  target: T;
  label: string;
  edits: PropertyEdit[];
}

type WriteResult<T> =
  | { ok: true; written: WrittenNote<T>[] }
  /** `failed` couldn't be written; the `rolledBack` notes changed before it were restored. */
  | { ok: false; failed: string; error: unknown; rolledBack: number; rollback: RestoreResult };

/**
 * Write each note's edits in turn. If one fails, the notes already changed
 * are restored, so a change across several notes is all or nothing as far as
 * the notes allow (see the rollback result).
 */
export async function writeAll<T>(changes: NoteChange<T>[], process: Process<T>): Promise<WriteResult<T>> {
  const written: WrittenNote<T>[] = [];
  for (const c of changes) {
    let properties: WrittenProperty[] = [];
    try {
      // Checked against the note as it is now, so edits made since the chart
      // last read it are never silently overwritten.
      await process(c.target, (fm) => {
        properties = applyEdits(fm, c.edits);
      });
    } catch (error) {
      return { ok: false, failed: c.label, error, rolledBack: written.length, rollback: await restoreWrittenNotes(written, process) };
    }
    written.push({ target: c.target, label: c.label, properties });
  }
  return { ok: true, written };
}
