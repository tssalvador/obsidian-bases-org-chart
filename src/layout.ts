import type { OrgGraph } from "./graph";

export const NODE_W = 200;
export const NODE_H = 56;
const RANK_SEP = 56;
/** Extra height per card line beyond the first. */
export const LINE_H = 15;

/** Card height for `lines` lines under the name. */
export function cardHeight(lines: number): number {
  return NODE_H + LINE_H * Math.max(0, lines - 1);
}
const NODE_SEP = 24;
const TREE_GAP = 64;
const MARGIN = 24;
const SINGLETON_COLS = 5;
/** Cross-axis offset of stacked cards from their connector spine. */
const STACK_INDENT = 20;
const STACK_GAP = 12;

export type Direction = "TB" | "LR";

interface LayoutOptions {
  direction?: Direction;
  /** Nodes whose reports are hidden. */
  collapsed?: ReadonlySet<string>;
  /** Drop people with no manager, no reports and no dotted-line links. */
  hideIsolated?: boolean;
  /** Kept even when hideIsolated is on (e.g. former members the user asked to see). */
  keepIsolated?: (id: string) => boolean;
  /** Stack a leaf-only team into columns once it has more than this many people. 0 = never. */
  stackThreshold?: number;
  /** Viewport width / height. Trees are wrapped into rows to roughly match it. */
  aspect?: number;
  /** Card height (see cardHeight); defaults to NODE_H. */
  cardHeight?: number;
}

interface PlacedNode {
  id: string;
  x: number; // top-left
  y: number;
}

export interface Point {
  x: number;
  y: number;
}

/** A primary (solid) reporting line, as a polyline from manager to report. */
interface Route {
  from: string;
  to: string;
  points: Point[];
}

export interface Layout {
  /** Visible nodes only. */
  nodes: Map<string, PlacedNode>;
  routes: Route[];
  width: number;
  height: number;
  /** Card height used for this layout. */
  cardH: number;
  /** Direct primary reports per node (whether or not currently visible). */
  childCount: Map<string, number>;
  hiddenIsolated: number;
  hiddenCollapsed: number;
  /** Head of the largest visible tree, if any; used to centre the initial view. */
  focus?: string;
  /** Grouped layouts only: one labelled box per group. */
  groups?: GroupBox[];
  /** Grouped layouts only: primary links whose ends sit in different groups ("from\u0000to"). */
  crossEdges?: Set<string>;
}

export interface GroupSpec {
  label: string;
  /** Node ids in this group, as delivered by Bases. */
  ids: string[];
}

interface GroupBox {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** People shown in the box. */
  count: number;
}

const GROUP_HEADER = 30;
const GROUP_GAP = 40;

/**
 * Lay out each group as its own chart and pack the groups as boxes, like
 * trees are packed. Links between groups are reported in crossEdges and
 * drawn as connectors. Placeholder managers sit with their first report.
 */
export function layoutGroups(graph: OrgGraph, groups: GroupSpec[], opts: LayoutOptions = {}): Layout {
  const groupOf = new Map<string, number>();
  groups.forEach((g, i) => g.ids.forEach((id) => graph.nodes.has(id) && !groupOf.has(id) && groupOf.set(id, i)));
  // Anyone not listed in a group (placeholders) joins the group of their first listed report.
  for (const e of graph.edges) {
    const g = groupOf.get(e.to);
    if (g !== undefined && !groupOf.has(e.from)) groupOf.set(e.from, g);
  }
  for (const id of graph.nodes.keys()) if (!groupOf.has(id)) groupOf.set(id, 0);
  const group = (id: string) => groupOf.get(id) ?? 0;

  // One pass to split nodes and in-group links into per-group sub-graphs.
  const subs: OrgGraph[] = groups.map(() => ({ nodes: new Map(), edges: [], external: [], brokenCycles: [] }));
  for (const n of graph.nodes.values()) subs[group(n.id)]?.nodes.set(n.id, n);
  for (const e of graph.edges) if (group(e.from) === group(e.to)) subs[group(e.from)]?.edges.push(e);
  // "No reporting links" means none at all: a link to someone in another group counts.
  const linked = new Set<string>();
  for (const e of graph.edges) {
    linked.add(e.from);
    linked.add(e.to);
  }
  const subOpts: LayoutOptions = { ...opts, keepIsolated: (id) => linked.has(id) || !!opts.keepIsolated?.(id) };
  const parts = groups.map((g, i) => ({ label: g.label, layout: subs[i].nodes.size ? layoutGraph(subs[i], subOpts) : null }));

  const cardH = opts.cardHeight ?? NODE_H;
  const shown = parts.filter((p): p is { label: string; layout: Layout } => !!p.layout && p.layout.nodes.size > 0);
  const aspect = opts.aspect && opts.aspect > 0 ? opts.aspect : 16 / 10;
  const area = shown.reduce((s, p) => s + (p.layout.width + GROUP_GAP) * (p.layout.height + GROUP_HEADER + GROUP_GAP), 0);
  let rowLimit = Math.max(Math.sqrt(area * aspect), NODE_W);
  for (const p of shown) rowLimit = Math.max(rowLimit, p.layout.width);

  const nodes = new Map<string, PlacedNode>();
  const routes: Route[] = [];
  const boxes: GroupBox[] = [];
  const childCount = new Map<string, number>();
  let hiddenIsolated = 0;
  let hiddenCollapsed = 0;
  let focus: string | undefined;
  let focusSize = -1;

  let x = MARGIN, y = MARGIN, rowH = 0;
  for (const p of parts) {
    const l = p.layout;
    if (!l) continue;
    hiddenIsolated += l.hiddenIsolated;
    hiddenCollapsed += l.hiddenCollapsed;
    for (const [id, c] of l.childCount) childCount.set(id, c);
    if (!l.nodes.size) continue;
    if (x > MARGIN && x - MARGIN + l.width > rowLimit) {
      x = MARGIN;
      y += rowH + GROUP_GAP;
      rowH = 0;
    }
    const h = l.height + GROUP_HEADER;
    boxes.push({ label: p.label, x, y, w: l.width, h, count: l.nodes.size });
    const ox = x, oy = y + GROUP_HEADER;
    for (const n of l.nodes.values()) nodes.set(n.id, { id: n.id, x: n.x + ox, y: n.y + oy });
    for (const r of l.routes) routes.push({ from: r.from, to: r.to, points: r.points.map((pt) => ({ x: pt.x + ox, y: pt.y + oy })) });
    if (l.focus && l.nodes.size > focusSize) {
      focus = l.focus;
      focusSize = l.nodes.size;
    }
    x += l.width + GROUP_GAP;
    rowH = Math.max(rowH, h);
  }

  const crossEdges = new Set<string>();
  for (const e of graph.edges) {
    if (e.primary && nodes.has(e.from) && nodes.has(e.to) && group(e.from) !== group(e.to)) {
      crossEdges.add(`${e.from}\u0000${e.to}`);
    }
  }

  let width = 0, height = 0;
  for (const b of boxes) {
    width = Math.max(width, b.x + b.w);
    height = Math.max(height, b.y + b.h);
  }
  return {
    nodes, routes, width: width + MARGIN, height: height + MARGIN, cardH,
    childCount, hiddenIsolated, hiddenCollapsed, focus, groups: boxes, crossEdges,
  };
}


/**
 * Dependency-free org layout. Primary edges form a forest (each person has at
 * most one primary manager and cycles are already broken in buildGraph), so
 * each tree is laid out recursively: a subtree is as wide as its children side
 * by side, and a manager is centred over them. Large teams with no further
 * reports are stacked into columns. Trees are packed along the cross axis,
 * largest first; people with no links go in a grid after them (or are hidden).
 *
 * Everything is computed in an abstract (cross, main) space, where main is the
 * reporting direction, then mapped to x/y for the chosen direction.
 */
export function layoutGraph(graph: OrgGraph, opts: LayoutOptions = {}): Layout {
  const direction = opts.direction ?? "TB";
  const collapsed = opts.collapsed ?? new Set<string>();
  const threshold = opts.stackThreshold ?? 0;

  const title = (id: string) => graph.nodes.get(id)?.title ?? id;
  const byTitle = (a: string, b: string) => title(a).localeCompare(title(b)) || a.localeCompare(b);

  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  const dotted = new Set<string>();
  for (const e of graph.edges) {
    if (!e.primary) {
      dotted.add(e.from);
      dotted.add(e.to);
      continue;
    }
    const list = children.get(e.from);
    if (list) list.push(e.to);
    else children.set(e.from, [e.to]);
    hasParent.add(e.to);
  }
  for (const list of children.values()) list.sort(byTitle);
  const childCount = new Map([...children].map(([id, list]) => [id, list.length]));

  const kidsOf = (id: string) => (collapsed.has(id) ? [] : children.get(id) ?? []);
  const isStacked = (id: string) => {
    const kids = kidsOf(id);
    return threshold > 0 && kids.length > threshold && kids.every((k) => kidsOf(k).length === 0);
  };

  const TB = direction === "TB";
  const cardH = opts.cardHeight ?? NODE_H;
  const cardC = TB ? NODE_W : cardH; // card size across the tree
  const cardM = TB ? cardH : NODE_W; // card size along the reporting direction
  const depthStep = cardM + RANK_SEP;

  const stackShape = (n: number) => {
    const cols = Math.ceil(n / threshold);
    return { cols, rows: Math.ceil(n / cols), width: cols * (STACK_INDENT + cardC) + (cols - 1) * NODE_SEP };
  };

  const extent = new Map<string, number>();
  const measure = (root: string): number => {
    const stack: { id: string; expanded: boolean }[] = [{ id: root, expanded: false }];
    for (let frame = stack.pop(); frame; frame = stack.pop()) {
      if (!frame.expanded) {
        stack.push({ id: frame.id, expanded: true });
        const kids = kidsOf(frame.id);
        for (let i = kids.length - 1; i >= 0; i--) stack.push({ id: kids[i], expanded: false });
        continue;
      }
      const kids = kidsOf(frame.id);
      let w: number;
      if (isStacked(frame.id)) {
        w = stackShape(kids.length).width;
      } else {
        w = NODE_SEP * Math.max(0, kids.length - 1);
        for (const kid of kids) w += extent.get(kid) ?? cardC;
      }
      extent.set(frame.id, Math.max(cardC, w));
    }
    return extent.get(root) ?? cardC;
  };

  const fullSize = (root: string): number => {
    const sizes = new Map<string, number>();
    const stack: { id: string; expanded: boolean }[] = [{ id: root, expanded: false }];
    for (let frame = stack.pop(); frame; frame = stack.pop()) {
      if (!frame.expanded) {
        stack.push({ id: frame.id, expanded: true });
        const kids = children.get(frame.id) ?? [];
        for (let i = kids.length - 1; i >= 0; i--) stack.push({ id: kids[i], expanded: false });
        continue;
      }
      let size = 1;
      for (const kid of children.get(frame.id) ?? []) size += sizes.get(kid) ?? 1;
      sizes.set(frame.id, size);
    }
    return sizes.get(root) ?? 1;
  };

  const roots = [...graph.nodes.keys()].filter((id) => !hasParent.has(id)).sort(byTitle);
  const trees = roots.filter((r) => children.has(r));
  let singletons = roots.filter((r) => !children.has(r));
  let hiddenIsolated = 0;
  if (opts.hideIsolated) {
    const keep = singletons.filter((id) => dotted.has(id) || !!opts.keepIsolated?.(id));
    hiddenIsolated = singletons.length - keep.length;
    singletons = keep;
  }
  const sizes = new Map(trees.map((r) => [r, fullSize(r)]));
  trees.sort((a, b) => (sizes.get(b) ?? 1) - (sizes.get(a) ?? 1) || byTitle(a, b));

  // Abstract positions (top-left of each card) and routes.
  const pos = new Map<string, { c: number; m: number }>();
  /** A placed node's position; every id passed here has been placed already. */
  const at = (id: string) => {
    const p = pos.get(id);
    if (!p) throw new Error(`Layout: ${id} has no position`);
    return p;
  };
  const abstractRoutes: { from: string; to: string; pts: [number, number][] }[] = [];

  const route = (parent: string, child: string, viaSpine?: number) => {
    const p = at(parent);
    const k = at(child);
    const sc = p.c + cardC / 2;
    const sm = p.m + cardM;
    const bus = sm + RANK_SEP / 2;
    const pts: [number, number][] = [[sc, sm], [sc, bus]];
    if (viaSpine === undefined) {
      const ec = k.c + cardC / 2;
      pts.push([ec, bus], [ec, k.m]);
    } else {
      const mid = k.m + cardM / 2;
      pts.push([viaSpine, bus], [viaSpine, mid], [k.c, mid]);
    }
    abstractRoutes.push({ from: parent, to: child, pts });
  };

  /** Places a subtree within [start, start + extent] with the node at main position m. */
  const place = (root: string, start: number, m: number): void => {
    type Frame =
      | { kind: "enter"; id: string; start: number; m: number }
      | { kind: "finish"; id: string; kids: string[] };
    const stack: Frame[] = [{ kind: "enter", id: root, start, m }];
    for (let frame = stack.pop(); frame; frame = stack.pop()) {
      if (frame.kind === "finish") {
        const first = at(frame.kids[0]).c;
        const last = at(frame.kids[frame.kids.length - 1]).c;
        at(frame.id).c = (first + last) / 2;
        for (const kid of frame.kids) route(frame.id, kid);
        continue;
      }

      const kids = kidsOf(frame.id);
      const w = extent.get(frame.id) ?? cardC;
      pos.set(frame.id, { c: frame.start + w / 2 - cardC / 2, m: frame.m });
      if (!kids.length) continue;

      if (isStacked(frame.id)) {
        const { rows, width } = stackShape(kids.length);
        const blockStart = frame.start + (w - width) / 2;
        kids.forEach((kid, j) => {
          const col = Math.floor(j / rows);
          const row = j % rows;
          const colStart = blockStart + col * (STACK_INDENT + cardC + NODE_SEP);
          pos.set(kid, { c: colStart + STACK_INDENT, m: frame.m + depthStep + row * (cardM + STACK_GAP) });
          route(frame.id, kid, colStart + STACK_INDENT / 2);
        });
        continue;
      }

      let kidsTotal = NODE_SEP * (kids.length - 1);
      for (const kid of kids) kidsTotal += extent.get(kid) ?? cardC;
      let cursor = frame.start + (w - kidsTotal) / 2;
      const childFrames: Frame[] = [];
      for (const kid of kids) {
        childFrames.push({ kind: "enter", id: kid, start: cursor, m: frame.m + depthStep });
        cursor += (extent.get(kid) ?? cardC) + NODE_SEP;
      }
      stack.push({ kind: "finish", id: frame.id, kids });
      for (let i = childFrames.length - 1; i >= 0; i--) stack.push(childFrames[i]);
    }
  };

  // Lay each tree out at the origin, measure it, then shelf-pack the trees
  // into rows so the whole chart roughly matches the viewport's shape.
  const visible = (r: string): string[] => {
    const out: string[] = [];
    const stack = [r];
    for (let v = stack.pop(); v; v = stack.pop()) {
      out.push(v);
      for (const kid of kidsOf(v)) stack.push(kid);
    }
    return out;
  };
  const boxes = trees.map((r) => {
    measure(r);
    const routeStart = abstractRoutes.length;
    place(r, 0, 0);
    const ids = visible(r);
    let main = -Infinity;
    for (const id of ids) main = Math.max(main, at(id).m + cardM);
    return { r, ids, routeStart, routeEnd: abstractRoutes.length, cross: extent.get(r) ?? cardC, main };
  });

  const aspect = opts.aspect && opts.aspect > 0 ? opts.aspect : 16 / 10;
  // Target row length along the cross axis: cross/main of the whole chart ≈ the
  // viewport's width/height (TB) or height/width (LR).
  const crossPerMain = TB ? aspect : 1 / aspect;
  const area = boxes.reduce((s, b) => s + (b.cross + TREE_GAP) * (b.main + TREE_GAP), 0);
  // Loops rather than Math.max(...array): spreading huge arrays overflows the call stack.
  let rowLimit = Math.max(Math.sqrt(area * crossPerMain), cardC);
  for (const b of boxes) rowLimit = Math.max(rowLimit, b.cross);

  let rowStart = MARGIN;
  let rowMain = 0;
  let cursor = MARGIN;
  for (const b of boxes) {
    if (cursor > MARGIN && cursor - MARGIN + b.cross > rowLimit) {
      rowStart += rowMain + TREE_GAP;
      rowMain = 0;
      cursor = MARGIN;
    }
    for (const id of b.ids) {
      const p = at(id);
      p.c += cursor;
      p.m += rowStart;
    }
    for (let i = b.routeStart; i < b.routeEnd; i++) {
      for (const pt of abstractRoutes[i].pts) {
        pt[0] += cursor;
        pt[1] += rowStart;
      }
    }
    cursor += b.cross + TREE_GAP;
    rowMain = Math.max(rowMain, b.main);
  }

  let mainEnd = MARGIN;
  for (const p of pos.values()) mainEnd = Math.max(mainEnd, p.m + cardM);
  const gridStart = trees.length ? mainEnd + TREE_GAP : MARGIN;
  singletons.forEach((id, i) => {
    pos.set(id, {
      c: MARGIN + (i % SINGLETON_COLS) * (cardC + NODE_SEP),
      m: gridStart + Math.floor(i / SINGLETON_COLS) * (cardM + NODE_SEP),
    });
  });

  const toXY = (c: number, m: number): Point => (TB ? { x: c, y: m } : { x: m, y: c });
  const nodes = new Map<string, PlacedNode>();
  for (const [id, p] of pos) nodes.set(id, { id, ...toXY(p.c, p.m) });
  const routes: Route[] = abstractRoutes.map((r) => ({
    from: r.from,
    to: r.to,
    points: r.pts.map(([c, m]) => toXY(c, m)),
  }));

  let width = 0;
  let height = 0;
  for (const p of nodes.values()) {
    width = Math.max(width, p.x + NODE_W);
    height = Math.max(height, p.y + cardH);
  }

  const shownOrIsolated = nodes.size + hiddenIsolated;
  return {
    nodes,
    routes,
    width: width + MARGIN,
    height: height + MARGIN,
    cardH,
    childCount,
    hiddenIsolated,
    hiddenCollapsed: graph.nodes.size - shownOrIsolated,
    focus: boxes[0]?.r,
  };
}
