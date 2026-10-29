/*
 * The vault's property names and types, from Obsidian's property registry
 * (app.metadataTypeManager). It isn't part of Obsidian's public API, so every
 * use is guarded: if it changes, suggestions go empty and types are left as
 * they are.
 */

interface PropertyRegistry {
  /** Properties used in the vault's notes, by lower-case name. */
  properties?: Record<string, unknown>;
  /** The type assigned to a property (as in the Properties view), or null. Names match regardless of case. */
  getAssignedWidget?(name: string): unknown;
  /** Assign a type to a property and save it with the vault's settings. */
  setType?(name: string, type: string): unknown;
}

/** Obsidian's list types: List, and its own aliases and tags. */
const LIST_TYPES = new Set(["multitext", "aliases", "tags"]);

function registry(app: unknown): PropertyRegistry | undefined {
  return (app as { metadataTypeManager?: PropertyRegistry } | null | undefined)?.metadataTypeManager;
}

/** Names of the properties used in the vault's notes. */
export function propertyNames(app: unknown): string[] {
  return Object.keys(registry(app)?.properties ?? {});
}

/**
 * Give each property Obsidian's List type unless it already has a list type,
 * so the Properties view shows and edits it as a list. Returns the names
 * changed. Empty names are skipped; names match regardless of case.
 */
export function ensureListTypes(app: unknown, names: string[]): string[] {
  const types = registry(app);
  if (typeof types?.getAssignedWidget !== "function" || typeof types.setType !== "function") return [];
  const seen = new Set<string>();
  const changed: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    try {
      const type = types.getAssignedWidget(name);
      if (typeof type === "string" && LIST_TYPES.has(type)) continue;
      // Saved asynchronously; a failure leaves the type as it was.
      void Promise.resolve(types.setType(name, "multitext")).catch(() => undefined);
      changed.push(name);
    } catch {
      // The registry didn't behave as expected: leave this property's type alone.
    }
  }
  return changed;
}

/** The type assigned to a property (e.g. "text", "number", "multitext"), or null when none or unknown. */
export function propertyType(app: unknown, name: string): string | null {
  const types = registry(app);
  if (!name || typeof types?.getAssignedWidget !== "function") return null;
  try {
    const type = types.getAssignedWidget(name);
    return typeof type === "string" ? type : null;
  } catch {
    return null;
  }
}

/** Types whose values aren't a single line of text: lists, checkboxes. */
export function isMultiValueType(type: string | null): boolean {
  return type !== null && (LIST_TYPES.has(type) || type === "checkbox");
}
