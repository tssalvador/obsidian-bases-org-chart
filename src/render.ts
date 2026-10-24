import { cardLines, type OrgGraph, type OrgNode } from "./graph";
import { LINE_H, NODE_W, type Direction, type Layout, type Point } from "./layout";

const STRIPE_W = 5;
const AVATAR = 36;
const TOGGLE_H = 16;
let seq = 0;

/** Obsidian's createSvg, with attributes and parent as positional arguments. */
function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attr: Record<string, string | number> = {},
  parent?: Element
): SVGElementTagNameMap[K] {
  return createSvg(tag, { attr, parent });
}

/** Deterministic hue per colour value so colours are stable across renders. */
function hue(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** "Ada Lovelace" -> "AL"; "madonna" -> "M". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => /\p{L}|\p{N}/u.test(w));
  if (!words.length) return "?";
  const first = [...words[0]][0];
  const last = words.length > 1 ? [...words[words.length - 1]][0] : "";
  return (first + last).toUpperCase();
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, Math.max(1, max - 1)) + "…" : s;
}

function polyline(points: Point[]): string {
  return points.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ");
}

/**
 * Smooth curve for dotted lines and links between groups. Normally from the
 * manager's outgoing edge to the report's incoming edge; when the report
 * isn't further along the reporting direction (e.g. in a group placed
 * higher up), it joins the facing sides instead so the curve doesn't loop.
 */
export function curvePath(layout: Layout, from: string, to: string, dir: Direction): string | null {
  const a = layout.nodes.get(from);
  const b = layout.nodes.get(to);
  if (!a || !b) return null;
  const H = layout.cardH;
  const W = NODE_W;
  const h = (x1: number, y1: number, x2: number, y2: number) => {
    const k = Math.max(40, Math.abs(x2 - x1) / 2) * Math.sign(x2 - x1 || 1);
    return `M${x1},${y1} C${x1 + k},${y1} ${x2 - k},${y2} ${x2},${y2}`;
  };
  const v = (x1: number, y1: number, x2: number, y2: number) => {
    const k = Math.max(40, Math.abs(y2 - y1) / 2) * Math.sign(y2 - y1 || 1);
    return `M${x1},${y1} C${x1},${y1 + k} ${x2},${y2 - k} ${x2},${y2}`;
  };
  if (dir === "LR") {
    if (b.x >= a.x + W) return h(a.x + W, a.y + H / 2, b.x, b.y + H / 2);
    return b.y >= a.y
      ? v(a.x + W / 2, a.y + H, b.x + W / 2, b.y)
      : v(a.x + W / 2, a.y, b.x + W / 2, b.y + H);
  }
  if (b.y >= a.y + H) return v(a.x + W / 2, a.y + H, b.x + W / 2, b.y);
  return b.x >= a.x
    ? h(a.x + W, a.y + H / 2, b.x, b.y + H / 2)
    : h(a.x, a.y + H / 2, b.x + W, b.y + H / 2);
}

interface RenderHandlers {
  onClick(node: OrgNode, evt: MouseEvent): void;
  /** Open the note (Enter on a focused card). */
  onOpen(node: OrgNode): void;
  onHover(node: OrgNode, evt: MouseEvent, targetEl: Element): void;
  onToggle(node: OrgNode): void;
  /** A reporting line (manager -> report) was clicked. */
  onEdgeClick(from: string, to: string, evt: MouseEvent): void;
  onContextMenu(node: OrgNode, evt: MouseEvent): void;
}

/** Circular avatar at the card's left: the image if it loads, otherwise initials. */
function drawAvatar(g: SVGGElement, node: OrgNode, clipId: string, cardH: number): void {
  const x = STRIPE_W + 10;
  const y = (cardH - AVATAR) / 2;
  const placeholder = () => {
    const a = svg("g", { class: "org-chart-avatar is-initials" }, g);
    svg("circle", { cx: x + AVATAR / 2, cy: y + AVATAR / 2, r: AVATAR / 2 }, a);
    svg("text", { x: x + AVATAR / 2, y: y + AVATAR / 2 + 4, "text-anchor": "middle" }, a).textContent =
      initials(node.title);
    return a;
  };
  if (!node.image || node.ghost) {
    placeholder();
    return;
  }
  const img = svg("image", {
    class: "org-chart-avatar",
    x, y, width: AVATAR, height: AVATAR,
    href: node.image,
    preserveAspectRatio: "xMidYMid slice",
    "clip-path": `url(#${clipId})`,
  }, g);
  img.addEventListener("error", () => img.replaceWith(placeholder()), { once: true });
}

/** Pill on the card's outgoing edge: report count when expanded, "+N" when collapsed. */
function drawToggle(g: SVGGElement, count: number, collapsed: boolean, dir: Direction, cardH: number, onToggle: () => void) {
  const label = collapsed ? `+${count}` : String(count);
  const w = Math.max(24, 10 + label.length * 7);
  const cx = dir === "TB" ? NODE_W / 2 : NODE_W;
  const cy = dir === "TB" ? cardH : cardH / 2;
  const t = svg("g", {
    class: collapsed ? "org-chart-toggle is-collapsed" : "org-chart-toggle",
    transform: `translate(${cx - w / 2},${cy - TOGGLE_H / 2})`,
    tabindex: 0,
    role: "button",
    "aria-expanded": String(!collapsed),
  }, g);
  svg("title", {}, t).textContent = `${collapsed ? "Expand" : "Collapse"} ${count} direct report${count === 1 ? "" : "s"}`;
  svg("rect", { width: w, height: TOGGLE_H, rx: TOGGLE_H / 2 }, t);
  svg("text", { x: w / 2, y: TOGGLE_H / 2 + 4, "text-anchor": "middle" }, t).textContent = label;
  const fire = (evt: Event) => {
    evt.stopPropagation();
    evt.preventDefault();
    onToggle();
  };
  t.addEventListener("click", fire);
  t.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter" || evt.key === " ") fire(evt);
  });
}

/** Draws the chart into `parent` and returns the group the viewport pans and zooms. */
export function renderSvg(
  parent: HTMLElement,
  graph: OrgGraph,
  layout: Layout,
  dir: Direction,
  collapsed: ReadonlySet<string>,
  handlers: RenderHandlers
): SVGGElement {
  const id = ++seq;
  // Accessible name from a visually hidden element. Not aria-label (Obsidian's
  // tooltip handler assumes an HTMLElement and throws on SVG) and not an SVG
  // <title> (browsers show it as a tooltip over the whole chart).
  const label = parent.createDiv({ cls: "org-chart-sr-only", text: `Org chart with ${layout.nodes.size} people` });
  label.id = `org-chart-label-${id}`;
  // A group rather than an image: an image's contents are hidden from screen
  // readers, and the cards and team toggles inside are focusable controls.
  const root = svg("svg", { class: "org-chart-svg", role: "group", "aria-labelledby": label.id });
  parent.appendChild(root);

  const defs = svg("defs", {}, root);
  const content = svg("g", { class: "org-chart-content" }, root);

  // Group boxes (grouped views) sit behind everything.
  if (layout.groups?.length) {
    const groupLayer = svg("g", { class: "org-chart-groups" }, content);
    for (const gb of layout.groups) {
      const box = svg("g", { class: "org-chart-group", transform: `translate(${gb.x},${gb.y})` }, groupLayer);
      svg("rect", { class: "org-chart-group-box", width: gb.w, height: gb.h, rx: 10, ry: 10 }, box);
      const label = svg("text", { class: "org-chart-group-label", x: 14, y: 20 }, box);
      label.textContent = gb.label;
      const count = svg("tspan", { class: "org-chart-group-count", dx: 8 }, label);
      count.textContent = String(gb.count);
    }
  }

  // Primary reporting lines under the cards.
  const edgeLayer = svg("g", { class: "org-chart-edges" }, content);
  const tag = (el: Element, from: string, to: string) => {
    el.setAttribute("data-from", from);
    el.setAttribute("data-to", to);
    return el;
  };
  for (const r of layout.routes) {
    const from = graph.nodes.get(r.from);
    const cls = ["org-chart-edge", from?.ghost ? "is-ghost" : "", from?.departed && graph.nodes.get(r.to)?.stranded ? "is-stranded" : ""];
    tag(svg("path", { d: polyline(r.points), class: cls.filter(Boolean).join(" ") }, edgeLayer), r.from, r.to);
  }

  // Wide invisible strokes make lines easy to click. They sit under the cards
  // (so cards stay fully clickable) while the visible dotted lines are drawn on top.
  const hitLayer = svg("g", { class: "org-chart-edge-hits" }, content);
  const hits: { d: string; from: string; to: string }[] = layout.routes.map((r) => ({ d: polyline(r.points), from: r.from, to: r.to }));
  const isCross = (from: string, to: string) => !!layout.crossEdges?.has(`${from}\u0000${to}`);
  for (const e of graph.edges) {
    if (e.primary && !isCross(e.from, e.to)) continue;
    const d = curvePath(layout, e.from, e.to, dir);
    if (d) hits.push({ d, from: e.from, to: e.to });
  }
  // Main reporting lines between groups: solid curves under the cards.
  for (const e of graph.edges) {
    if (!e.primary || !isCross(e.from, e.to)) continue;
    const d = curvePath(layout, e.from, e.to, dir);
    const cls = ["org-chart-edge", "is-cross", graph.nodes.get(e.from)?.departed && graph.nodes.get(e.to)?.stranded ? "is-stranded" : ""];
    if (d) tag(svg("path", { d, class: cls.filter(Boolean).join(" ") }, edgeLayer), e.from, e.to);
  }
  // Visible paths per link, resolved lazily once (dotted ones are drawn after this loop).
  let pathIndex: Map<string, SVGPathElement[]> | null = null;
  const visibleFor = (from: string, to: string): SVGPathElement[] => {
    if (!pathIndex) {
      const index = new Map<string, SVGPathElement[]>();
      content.querySelectorAll<SVGPathElement>(".org-chart-edge").forEach((p) => {
        const k = `${p.dataset.from}\u0000${p.dataset.to}`;
        const list = index.get(k);
        if (list) list.push(p);
        else index.set(k, [p]);
      });
      pathIndex = index;
    }
    return pathIndex.get(`${from}\u0000${to}`) ?? [];
  };
  for (const h of hits) {
    const hit = tag(svg("path", { d: h.d, class: "org-chart-edge-hit" }, hitLayer), h.from, h.to);
    const label = svg("title", {}, hit);
    const a = graph.nodes.get(h.to)?.title ?? "", b = graph.nodes.get(h.from)?.title ?? "";
    label.textContent = `${a} reports to ${b} · click to remove`;
    hit.addEventListener("mouseenter", () => visibleFor(h.from, h.to).forEach((p) => p.classList.add("is-hover")));
    hit.addEventListener("mouseleave", () => visibleFor(h.from, h.to).forEach((p) => p.classList.remove("is-hover")));
    hit.addEventListener("click", (evt) => handlers.onEdgeClick(h.from, h.to, evt as MouseEvent));
  }

  const nodeLayer = svg("g", { class: "org-chart-nodes" }, content);
  // Avatars appear only when at least one visible card has an image; other
  // cards then get initials so names stay aligned.
  const avatars = [...layout.nodes.keys()].some((n) => graph.nodes.get(n)?.image);
  const clipId = `org-chart-avatar-clip-${id}`;
  if (avatars) {
    const clip = svg("clipPath", { id: clipId, clipPathUnits: "objectBoundingBox" }, defs);
    svg("circle", { cx: 0.5, cy: 0.5, r: 0.5 }, clip);
  }
  const textX = STRIPE_W + 10 + (avatars ? AVATAR + 10 : 0);
  const textRoom = NODE_W - textX - 8;

  for (const [nid, placed] of layout.nodes) {
    const node = graph.nodes.get(nid);
    if (!node) continue;
    const g = svg("g", {
      class: [
        "org-chart-node",
        node.ghost ? "is-ghost" : "",
        node.former ? "is-former" : "",
        node.departed ? "is-departed" : "",
        node.stranded ? "is-stranded" : "",
      ].filter(Boolean).join(" "),
      transform: `translate(${placed.x},${placed.y})`,
      tabindex: node.file ? 0 : -1,
      "data-id": nid,
    }, nodeLayer);

    if (collapsed.has(nid)) g.classList.add("is-collapsed");
    // Tooltip: every configured field (shown or hover-only), labelled.
    const fieldLines = node.ghost ? cardLines(node) : node.fields.filter((f) => f.value).map((f) => `${f.property}: ${f.value}`);
    svg("title", {}, g).textContent = [
      node.title + (node.former ? " (former)" : ""),
      ...fieldLines,
      node.departed ? `⚠ Former member with ${node.strandedReports} current report${node.strandedReports === 1 ? "" : "s"}` : "",
      node.stranded ? "⚠ Main manager is a former member" : "",
      collapsed.has(nid) ? "Click to expand team · double-click to open" : "",
    ]
      .filter(Boolean)
      .join("\n");
    const H = layout.cardH;
    svg("rect", { class: "org-chart-card", width: NODE_W, height: H, rx: 6, ry: 6 }, g);

    if (node.colorKey && !node.ghost) {
      const stripe = svg("rect", { class: "org-chart-stripe", width: STRIPE_W, height: H, rx: 2 }, g);
      stripe.setAttribute("fill", `hsl(${hue(node.colorKey)}, 60%, 55%)`);
    }

    if (avatars) drawAvatar(g, node, clipId, H);

    // Name plus the lines under it, centred vertically in the card.
    const lines = cardLines(node);
    const blockH = 18 + LINE_H * Math.max(0, lines.length - 1) + (lines.length ? 15 : 0);
    const top = (H - blockH) / 2;
    svg("text", { class: "org-chart-title", x: textX, y: lines.length ? top + 13 : H / 2 + 5 }, g).textContent =
      truncate(node.title, Math.floor(textRoom / 7.2));
    lines.forEach((line, i) => {
      svg("text", { class: "org-chart-subtitle", x: textX, y: top + 31 + i * LINE_H }, g).textContent =
        truncate(line, Math.floor(textRoom / 6.2));
    });

    if (node.stranded) {
      const badge = svg("g", { class: "org-chart-badge", transform: `translate(${NODE_W - 9},9)` }, g);
      svg("title", {}, badge).textContent = "Main manager is a former member";
      svg("circle", { r: 7 }, badge);
      svg("text", { y: 4, "text-anchor": "middle" }, badge).textContent = "!";
    }

    const count = layout.childCount.get(nid) ?? 0;
    if (count > 0) drawToggle(g, count, collapsed.has(nid), dir, H, () => handlers.onToggle(node));

    // Collapsed managers stay clickable (to expand) even without a note.
    if (node.file || collapsed.has(nid)) {
      g.addEventListener("click", (evt) => handlers.onClick(node, evt));
      g.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter" && evt.target === g) handlers.onOpen(node);
      });
      g.addEventListener("mouseover", (evt) => handlers.onHover(node, evt, g));
    }
    if (node.file) {
      g.addEventListener("contextmenu", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        handlers.onContextMenu(node, evt);
      });
    }
  }

  // Dotted-line managers above the cards, so they're never hidden behind one.
  const dottedLayer = svg("g", { class: "org-chart-dotted" }, content);
  for (const e of graph.edges) {
    if (e.primary) continue;
    const d = curvePath(layout, e.from, e.to, dir);
    if (d) tag(svg("path", { d, class: "org-chart-edge is-dotted" }, dottedLayer), e.from, e.to);
  }

  return content;
}
