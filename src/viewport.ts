/**
 * Pan/zoom for an SVG content group, without dependencies.
 *
 * - Trackpad two-finger scroll / mouse wheel: pan, unless `wheelPans` says
 *   otherwise (a chart embedded in a note), when the page scrolls instead
 * - Pinch, or Ctrl/Cmd + wheel: zoom around the pointer
 * - Drag empty space: pan (a drag never counts as a click). Cards can be
 *   claimed for their own drag through `dragHandler`.
 * - Keyboard (when the canvas has focus): + / - zoom, 0 fit, arrows pan
 */
import type { Component } from "obsidian";

export interface Transform {
  x: number;
  y: number;
  k: number;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2.5;
const DRAG_THRESHOLD = 4;

export function clampZoom(k: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

/** Transform that fits a content box into a viewport, never enlarging past 1:1. */
export function fitTransform(contentW: number, contentH: number, viewW: number, viewH: number, pad = 16): Transform {
  if (contentW <= 0 || contentH <= 0 || viewW <= 0 || viewH <= 0) return { x: 0, y: 0, k: 1 };
  const k = clampZoom(Math.min(1, (viewW - pad * 2) / contentW, (viewH - pad * 2) / contentH));
  return { k, x: (viewW - contentW * k) / 2, y: Math.max(pad, (viewH - contentH * k) / 2) };
}

/**
 * Initial view at 100% zoom. On each axis: if the chart fits, centre it;
 * otherwise centre on `focus` (a content-space point, e.g. the head of the
 * largest org), clamped so the view never scrolls past the chart's edges.
 */
export function openTransform(
  contentW: number,
  contentH: number,
  viewW: number,
  viewH: number,
  focus: { x: number; y: number } = { x: 0, y: 0 }
): Transform {
  const axis = (content: number, view: number, f: number) =>
    content <= view ? (view - content) / 2 : Math.min(0, Math.max(view - content, view / 2 - f));
  return { k: 1, x: axis(contentW, viewW, focus.x), y: axis(contentH, viewH, focus.y) };
}

/**
 * Keep the chart on screen. Per axis: a chart smaller than the view can move
 * anywhere inside it; a larger one can't scroll past its own edges. `pad` is
 * the empty space allowed between the chart and the view's edge.
 */
export function clampTransform(t: Transform, contentW: number, contentH: number, viewW: number, viewH: number, pad = 48): Transform {
  if (contentW <= 0 || contentH <= 0 || viewW <= 0 || viewH <= 0) return t;
  const axis = (pos: number, content: number, view: number) => {
    const size = content * t.k;
    const lo = Math.min(pad, view - size - pad);
    const hi = Math.max(pad, view - size - pad);
    return Math.min(hi, Math.max(lo, pos));
  };
  return { k: t.k, x: axis(t.x, contentW, viewW), y: axis(t.y, contentH, viewH) };
}

/** Zoom by `factor` keeping the screen point (px, py) fixed. */
export function zoomAt(t: Transform, factor: number, px: number, py: number): Transform {
  const k = clampZoom(t.k * factor);
  const f = k / t.k;
  return { k, x: px - (px - t.x) * f, y: py - (py - t.y) * f };
}

/**
 * Whether `el` sits in a Bases tab of its own (including the sidebar), rather
 * than embedded in a note, a canvas or a hover preview. Uses Obsidian's leaf
 * markup: each tab's content carries its view type.
 */
export function inOwnBasesTab(el: { closest(selector: string): unknown }): boolean {
  return !!el.closest('.workspace-leaf-content[data-type="bases"]');
}

export class Viewport {
  t: Transform = { x: 0, y: 0, k: 1 };
  private content: SVGGElement | null = null;
  private contentW = 0;
  private contentH = 0;
  private suppressClick = false;
  onChange: (t: Transform) => void = () => {};
  /** Return true to claim a pointerdown (e.g. to drag a card) instead of panning. */
  dragHandler: ((e: PointerEvent) => boolean) | null = null;
  /** Whether a plain scroll pans the chart. When false it's left to the page; Ctrl/Cmd and pinch still zoom. */
  wheelPans: () => boolean = () => true;

  /** Listeners are registered on `owner`, so they're removed when it unloads. */
  constructor(private el: HTMLElement, owner: Component) {
    owner.registerDomEvent(el, "wheel", (e) => this.onWheel(e), { passive: false });
    owner.registerDomEvent(el, "pointerdown", (e) => this.onPointerDown(e));
    // Capture phase so a drag-release never reaches the card's click handler.
    owner.registerDomEvent(el, "click", (e) => {
      if (this.suppressClick) {
        e.stopPropagation();
        e.preventDefault();
        this.suppressClick = false;
      }
    }, { capture: true });
    owner.registerDomEvent(el, "keydown", (e) => this.onKey(e));
  }

  /** Attach freshly rendered content, keeping the current transform. */
  setContent(content: SVGGElement, w: number, h: number): void {
    this.content = content;
    this.contentW = w;
    this.contentH = h;
    this.apply();
  }

  set(t: Transform): void {
    const k = clampZoom(t.k);
    this.t = clampTransform({ ...t, k }, this.contentW, this.contentH, this.el.clientWidth, this.el.clientHeight);
    this.apply();
  }

  fit(): void {
    this.set(fitTransform(this.contentW, this.contentH, this.el.clientWidth, this.el.clientHeight));
  }

  /** Open at 100% centred on `focus` (see openTransform). */
  open(focus?: { x: number; y: number }): void {
    this.set(openTransform(this.contentW, this.contentH, this.el.clientWidth, this.el.clientHeight, focus));
  }

  zoomBy(factor: number): void {
    this.set(zoomAt(this.t, factor, this.el.clientWidth / 2, this.el.clientHeight / 2));
  }

  /** Shift so that a content-space point lands where `before` (screen) was. */
  keepPointAt(contentX: number, contentY: number, screenX: number, screenY: number): void {
    this.set({ k: this.t.k, x: screenX - contentX * this.t.k, y: screenY - contentY * this.t.k });
  }

  /** Swallow the click that follows a drag the viewport didn't handle itself. */
  suppressNextClick(): void {
    this.suppressClick = true;
    this.el.win.setTimeout(() => (this.suppressClick = false), 0);
  }

  private apply(): void {
    if (this.content) {
      this.content.setAttribute("transform", `translate(${this.t.x},${this.t.y}) scale(${this.t.k})`);
    }
    this.onChange(this.t);
  }

  private local(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private onWheel(e: WheelEvent): void {
    // A trackpad pinch arrives as a wheel event with ctrlKey set.
    const zoom = e.ctrlKey || e.metaKey;
    if (!zoom && !this.wheelPans()) return; // not prevented, so the page scrolls
    e.preventDefault();
    // deltaMode 1 = lines (some mice); normalise to pixels.
    const scale = e.deltaMode === 1 ? 16 : 1;
    if (zoom) {
      const [px, py] = this.local(e);
      // Pinch sends many small deltas; a mouse wheel sends big notches. Cap each step.
      const factor = Math.min(1.25, Math.max(0.8, Math.exp(-e.deltaY * scale * 0.01)));
      this.set(zoomAt(this.t, factor, px, py));
    } else {
      this.set({ ...this.t, x: this.t.x - e.deltaX * scale, y: this.t.y - e.deltaY * scale });
    }
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    if ((e.target as Element).closest?.(".org-chart-toggle")) return;
    if (this.dragHandler && this.dragHandler(e)) return;
    const sx = e.clientX, sy = e.clientY;
    const start = { ...this.t };
    let dragging = false;
    const move = (ev: PointerEvent) => {
      // The button was released where this element couldn't see it (e.g. over
      // the toolbar before the drag began): end here, or hovering would pan.
      if ((ev.buttons & 1) === 0) {
        up();
        return;
      }
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!dragging) {
        dragging = true;
        try {
          this.el.setPointerCapture(e.pointerId);
        } catch {
          // Pointer already released (or synthetic); panning still works without capture.
        }
        this.el.addClass("is-panning");
      }
      this.set({ ...start, x: start.x + dx, y: start.y + dy });
    };
    const up = () => {
      this.el.removeEventListener("pointermove", move);
      this.el.removeEventListener("pointerup", up);
      this.el.removeEventListener("pointercancel", up);
      if (dragging) {
        this.suppressClick = true;
        this.el.removeClass("is-panning");
        // Only suppress the click that ends this drag.
        this.el.win.setTimeout(() => (this.suppressClick = false), 0);
      }
    };
    this.el.addEventListener("pointermove", move);
    this.el.addEventListener("pointerup", up);
    this.el.addEventListener("pointercancel", up);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.target !== this.el) return;
    const step = 60;
    const keys: Record<string, () => void> = {
      "+": () => this.zoomBy(1.2),
      "=": () => this.zoomBy(1.2),
      "-": () => this.zoomBy(1 / 1.2),
      "0": () => this.fit(),
      ArrowLeft: () => this.set({ ...this.t, x: this.t.x + step }),
      ArrowRight: () => this.set({ ...this.t, x: this.t.x - step }),
      ArrowUp: () => this.set({ ...this.t, y: this.t.y + step }),
      ArrowDown: () => this.set({ ...this.t, y: this.t.y - step }),
    };
    const fn = keys[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  }
}
