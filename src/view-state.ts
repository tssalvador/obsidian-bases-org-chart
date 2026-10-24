import { clampZoom, type Transform } from "./viewport";

/** Zoom and collapsed teams, as the view saves them in Bases' ephemeral state. */
export interface ChartState {
  transform?: Transform;
  collapsed?: string[];
}

/** Saved state checked before use: string ids only, and a finite, positive zoom (clamped). Null if there's none. */
export function parseChartState(state: unknown): { collapsed?: Set<string>; transform?: Transform } | null {
  const s = (state as { orgChart?: unknown } | null | undefined)?.orgChart;
  if (!s || typeof s !== "object") return null;
  const { collapsed, transform: t } = s as { collapsed?: unknown; transform?: Partial<Record<"x" | "y" | "k", unknown>> };
  const out: { collapsed?: Set<string>; transform?: Transform } = {};
  if (Array.isArray(collapsed)) out.collapsed = new Set(collapsed.filter((id): id is string => typeof id === "string"));
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (t && finite(t.x) && finite(t.y) && finite(t.k) && t.k > 0) out.transform = { x: t.x, y: t.y, k: clampZoom(t.k) };
  return out;
}

/**
 * What an Org Chart view remembers about the Bases view it shows: which one,
 * its collapsed teams, and the zoom to restore. Bases reuses one view object
 * for all the Org Chart views in a base, hands back a view's saved state
 * before its data, and sends the data later; keeping this apart from the
 * DOM lets the order of those calls be tested.
 */
export class ViewMemory {
  /** The Bases view shown (its name), or null before the first one. */
  viewName: string | null = null;
  collapsed = new Set<string>();
  /** Collapse has been set, from saved state or "Initially expand levels". */
  seeded = false;
  /** The chart has been placed; false makes the next render open it afresh (100%, centred). */
  fitted = false;
  /** A saved zoom to apply at the next render. */
  pendingTransform: Transform | null = null;
  /** "Initially expand levels" when collapse was last set; null when unknown (fresh or restored). */
  lastDepth: number | null = null;

  /** Show view `name` afresh. */
  start(name: string | null): void {
    this.viewName = name;
    this.seeded = false;
    this.fitted = false;
    this.pendingTransform = null;
    this.lastDepth = null;
  }

  /**
   * Bases hands back the state it saved for view `name`, before that view's
   * data arrives. Switching from another Org Chart view starts afresh instead,
   * unless `restoreViews` is on. Returns null when the state isn't used;
   * otherwise whether the view started afresh first, and whether it was a
   * switch (the chart still shows the previous view's data).
   */
  restore(state: unknown, name: string | null, restoreViews: boolean): { started: boolean; switching: boolean } | null {
    const saved = parseChartState(state);
    if (!saved) return null;
    const switching = this.viewName !== null && name !== this.viewName;
    if (switching && !restoreViews) return null;
    const started = name !== this.viewName;
    if (started) this.start(name);
    if (saved.collapsed) {
      // Kept until "Initially expand levels" changes (see update).
      this.collapsed = saved.collapsed;
      this.seeded = true;
    }
    if (saved.transform) {
      this.pendingTransform = saved.transform;
      this.fitted = true;
    }
    return { started, switching };
  }

  /**
   * New data for view `name`. Starts afresh after a switch (unless restore
   * already did), and takes collapse from `seed` the first time or when
   * "Initially expand levels" (`depth`) changes; otherwise the user's toggles,
   * or the restored state, stay. Returns whether the view started afresh.
   */
  update(name: string | null, depth: number, seed: () => Set<string>): boolean {
    const started = name !== this.viewName;
    if (started) this.start(name);
    const depthChanged = this.lastDepth !== null && depth !== this.lastDepth;
    if (!this.seeded || depthChanged) {
      if (depthChanged) this.fitted = false;
      this.collapsed = seed();
      this.seeded = true;
    }
    this.lastDepth = depth;
    return started;
  }
}
