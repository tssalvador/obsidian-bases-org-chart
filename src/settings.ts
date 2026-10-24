import { MAX_FIELDS, type CardField } from "./graph";
import type { Direction } from "./layout";

export interface OrgChartSettings {
  parentProperty: string;
  /** Card name; empty = file name. */
  nameProperty: string;
  /** Card lines under the name, in order (max 5); show: false = tooltip only. */
  fields: CardField[];
  colorProperty: string;
  imageProperty: string;
  /** Permit avatar URLs to contact hosts outside the vault. */
  allowRemoteImages: boolean;
  /** A card's right-click menu also shows Obsidian's usual note actions, as on Bases' cards. */
  noteMenu: boolean;
  currentProperty: string;
  formerProperty: string;
  direction: Direction;
  /** Warn before rendering more people than this; 0 disables the warning. */
  largeChartWarningThreshold: number;
  /** Switching back to an Org Chart view restores its zoom and collapsed teams instead of re-centring. */
  restoreViews: boolean;
}

// Neutral defaults: nothing here assumes a particular vault's property names
// beyond the plugin's own "reports_to" convention and Obsidian's common "image".
export const DEFAULT_SETTINGS: OrgChartSettings = {
  parentProperty: "reports_to",
  nameProperty: "",
  fields: [],
  colorProperty: "",
  imageProperty: "image",
  allowRemoteImages: false,
  noteMenu: true,
  currentProperty: "",
  formerProperty: "",
  direction: "TB",
  largeChartWarningThreshold: 2000,
  restoreViews: false,
};

/** Return a trimmed property name without control characters, or a fallback. */
export function cleanPropertyName(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  const invalid = [...trimmed].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
  return invalid ? fallback : trimmed;
}

/** Upper bound of the warning threshold (matches the settings slider). */
export const MAX_WARNING_THRESHOLD = 10_000;

/** A warning threshold clamped to the slider's range; anything else gives the default. */
export function warningThreshold(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SETTINGS.largeChartWarningThreshold;
  return Math.min(MAX_WARNING_THRESHOLD, Math.max(0, Math.round(value)));
}

/** Validate persisted plugin data; anything malformed falls back to its default. */
export function normalizeSettings(loaded: unknown): OrgChartSettings {
  const data: Record<string, unknown> = loaded && typeof loaded === "object" && !Array.isArray(loaded)
    ? { ...(loaded as Record<string, unknown>) }
    : {};
  const rawFields: unknown[] = Array.isArray(data.fields) ? data.fields : [];
  const fields = rawFields
    .filter((field): field is { property: string; show?: unknown } =>
      !!field && typeof field === "object" && typeof (field as { property?: unknown }).property === "string")
    .map((field) => ({ property: cleanPropertyName(field.property), show: field.show !== false }))
    .slice(0, MAX_FIELDS);
  return {
    parentProperty: cleanPropertyName(data.parentProperty, DEFAULT_SETTINGS.parentProperty) || DEFAULT_SETTINGS.parentProperty,
    nameProperty: cleanPropertyName(data.nameProperty, DEFAULT_SETTINGS.nameProperty),
    fields,
    colorProperty: cleanPropertyName(data.colorProperty, DEFAULT_SETTINGS.colorProperty),
    imageProperty: cleanPropertyName(data.imageProperty, DEFAULT_SETTINGS.imageProperty),
    allowRemoteImages: data.allowRemoteImages === true,
    noteMenu: typeof data.noteMenu === "boolean" ? data.noteMenu : DEFAULT_SETTINGS.noteMenu,
    currentProperty: cleanPropertyName(data.currentProperty, DEFAULT_SETTINGS.currentProperty),
    formerProperty: cleanPropertyName(data.formerProperty, DEFAULT_SETTINGS.formerProperty),
    direction: data.direction === "LR" || data.direction === "TB" ? data.direction : DEFAULT_SETTINGS.direction,
    largeChartWarningThreshold: warningThreshold(data.largeChartWarningThreshold),
    restoreViews: data.restoreViews === true,
  };
}

export function shouldWarnLargeChart(people: number, threshold: number, approvedUpTo: number): boolean {
  return threshold > 0 && people > threshold && people > approvedUpTo;
}
