import type { App, TFile } from "obsidian";

export interface OrgNode {
  id: string; // file path, or "ghost:<name>" for parents outside the view
  file: TFile | null; // null for ghost nodes
  title: string;
  /** First line under the name: first shown non-empty field, or a placeholder's status. */
  subtitle: string;
  /** Configured card fields, in order, with display values ("" when empty). */
  fields: { property: string; value: string; show: boolean }[];
  /** Value of the colour property (first value, display text) that picks the stripe colour. */
  colorKey: string;
  /** Loadable avatar URL, if the image property resolves to an image. */
  image?: string;
  /** Matched the view's "former member" rule. */
  former?: boolean;
  /** Former member (or hidden former member's placeholder) who still has current reports. */
  departed?: boolean;
  /** Current reports of this departed manager. */
  strandedReports?: number;
  /** This person's main manager is a former member. */
  stranded?: boolean;
  /** True for a parent that is not in the current view (filtered out or missing note). */
  ghost?: boolean;
  /** Placeholder with no note: the link target its reports name (not the alias). */
  linkTarget?: string;
}

/** A person backed by a note (not a placeholder without one). */
export type NotedNode = OrgNode & { file: TFile };

export function hasNote(node: OrgNode | null | undefined): node is NotedNode {
  return !!node?.file;
}

interface OrgEdge {
  from: string; // parent id
  to: string; // child id
  /** First listed parent = primary (solid line, drives layout); others are dotted-line. */
  primary?: boolean;
}

export interface OrgGraph {
  nodes: Map<string, OrgNode>;
  edges: OrgEdge[];
  /** Parent links that point outside the current view (or to missing notes). */
  external: { child: string; target: string }[];
  /** Edges dropped to break cycles. */
  brokenCycles: OrgEdge[];
}

export interface CardField {
  property: string;
  show: boolean;
}

export const MAX_FIELDS = 5;

/** Lines drawn under the name: a placeholder's status, else shown, non-empty fields. */
export function cardLines(node: OrgNode): string[] {
  if (node.ghost) {
    // A hidden former member with current reports (see markStranded).
    const status = node.departed ? "former member" : node.subtitle;
    return status ? [status] : [];
  }
  return node.fields.filter((f) => f.show && f.value).map((f) => f.value);
}

export interface GraphOptions {
  parentProperty: string;
  /** Property holding the display name; empty, omitted or missing value falls back to the file name. */
  nameProperty?: string;
  /** Up to five properties for each card, in order; `show: false` = tooltip only. */
  fields?: CardField[];
  colorProperty: string;
  /** Frontmatter property holding an avatar image. Empty disables images. */
  imageProperty?: string;
  /** Permit HTTP(S) avatar URLs to load from outside the vault. */
  allowRemoteImages?: boolean;
  /** A note is "former" when this property contains any of formerValues (both required). */
  formerProperty?: string;
  formerValues?: string[];
}

/** Case-insensitive match of a property value (link or text, single or list) against a target name. */
export function containsValue(value: unknown, target: string): boolean {
  const t = linkTarget(target).toLowerCase();
  if (!t) return false;
  return asList(value).some((raw) => {
    const v = raw.trim();
    return linkTarget(v).toLowerCase() === t || linkLabel(v).toLowerCase() === t;
  });
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"]);

/**
 * Resolves an image property value to a URL the renderer can load:
 * "[[pic.jpg]]", "![[pic.jpg|100]]" or a plain vault path -> app resource URL;
 * http(s) URLs pass through only when `allowRemote` is true. Anything else
 * (missing file, non-image, or blocked remote URL) -> undefined.
 */
export function resolveImage(app: App, value: unknown, sourcePath: string, allowRemote = false): string | undefined {
  const raw = asList(value)[0]?.trim();
  if (!raw) return undefined;
  if (/^https?:\/\//i.test(raw)) return allowRemote ? raw : undefined;
  const target = linkTarget(raw.replace(/^!/, ""));
  const file = app.metadataCache.getFirstLinkpathDest(target, sourcePath);
  if (!file || !IMAGE_EXT.has(file.extension?.toLowerCase())) return undefined;
  return app.vault.getResourcePath(file);
}

/** Normalise a frontmatter value to a list of raw link strings. Empty list items (YAML null) are dropped. */
export function asList(v: unknown): string[] {
  if (v == null || v === "") return [];
  return (Array.isArray(v) ? v : [v])
    .filter((x) => x != null)
    .map((x) => String(x))
    .filter((s) => s.trim() !== "");
}

/**
 * Like asList, but null when the value holds anything that can't be written
 * back as text without loss (nested lists, objects, booleans). Used before edits.
 */
export function editableList(v: unknown): string[] | null {
  if (v == null || v === "") return [];
  const items = Array.isArray(v) ? v : [v];
  const ok = items.every((x) => x == null || typeof x === "string" || (typeof x === "number" && Number.isFinite(x)));
  return ok ? asList(items) : null;
}

/**
 * A frontmatter value by property name: the exact key, else a key differing
 * only in case (Obsidian treats property names case-insensitively).
 */
export function propValue(fm: Record<string, unknown> | undefined, prop: string): unknown {
  const key = propKey(fm, prop);
  return fm && key !== null ? fm[key] : undefined;
}

/** The note's spelling of property `prop` (exact, else case-insensitive), or null if absent. */
export function propKey(fm: Record<string, unknown> | undefined, prop: string): string | null {
  if (!fm || !prop) return null;
  if (Object.prototype.hasOwnProperty.call(fm, prop)) return prop;
  const lower = prop.toLowerCase();
  return Object.keys(fm).find((k) => k.toLowerCase() === lower) ?? null;
}

/** "[[Target|Alias]]" -> "Target". Plain strings pass through. */
export function linkTarget(raw: string): string {
  const m = raw.trim().match(/^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/);
  return (m ? m[1] : raw).trim();
}

/** "[[Target|Alias]]" -> "Alias" (or Target). Used for display only. */
export function linkLabel(raw: string): string {
  const m = raw.trim().match(/^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]$/);
  if (!m) return raw.trim();
  return (m[2] || m[1]).trim();
}

function display(v: unknown): string {
  return asList(v).map(linkLabel).join(", ");
}

function nameOf(fm: Record<string, unknown>, prop: string): string {
  if (!prop) return "";
  const v = asList(propValue(fm, prop))[0];
  return v ? linkLabel(v) : "";
}

/** The note matches the view's former-member rule: its former property contains one of the values. */
function matchesFormerRule(fm: Record<string, unknown>, opts: GraphOptions): boolean {
  if (!opts.formerProperty || !opts.formerValues?.length) return false;
  const value = propValue(fm, opts.formerProperty);
  return opts.formerValues.some((target) => containsValue(value, target));
}

export function buildGraph(app: App, files: TFile[], opts: GraphOptions): OrgGraph {
  const fieldDefs: CardField[] = (opts.fields ?? [])
    .filter((f) => f.property)
    .slice(0, MAX_FIELDS);
  const nodes = new Map<string, OrgNode>();
  const parentsRaw = new Map<TFile, string[]>();

  for (const file of files) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
    const fields = fieldDefs.map((d) => ({ property: d.property, show: d.show, value: display(propValue(fm, d.property)) }));
    const colorValue = asList(propValue(fm, opts.colorProperty))[0];
    nodes.set(file.path, {
      id: file.path,
      file,
      title: nameOf(fm, opts.nameProperty ?? "") || file.basename,
      subtitle: fields.find((f) => f.show && f.value)?.value ?? "",
      fields,
      colorKey: colorValue ? linkLabel(colorValue) : "",
      image: opts.imageProperty ? resolveImage(app, propValue(fm, opts.imageProperty), file.path, opts.allowRemoteImages === true) : undefined,
      former: matchesFormerRule(fm, opts),
    });
    parentsRaw.set(file, asList(propValue(fm, opts.parentProperty)));
  }

  const edges: OrgEdge[] = [];
  const external: { child: string; target: string }[] = [];
  const seen = new Set<string>();

  for (const [childFile, raws] of parentsRaw) {
    const child = childFile.path;
    for (const raw of raws) {
      const target = linkTarget(raw);
      const dest = app.metadataCache.getFirstLinkpathDest(target, childFile.path);
      if (dest && dest.path === child) continue; // self-reference
      let parentId: string;
      let outside = false;
      if (dest && nodes.has(dest.path)) {
        parentId = dest.path;
      } else {
        // Parent exists but is filtered out of this view, or the note doesn't exist.
        // Without a note, the placeholder is identified by the link target
        // (not the alias), so "[[Jane Doe|Jane]]" and "[[Jane Smith|Jane]]" stay apart.
        outside = true;
        parentId = `ghost:${dest ? dest.path : target.toLowerCase()}`;
        if (!nodes.has(parentId)) {
          nodes.set(parentId, {
            id: parentId,
            file: dest ?? null,
            title: dest ? dest.basename : linkLabel(raw),
            subtitle: dest ? "outside this view" : "no note",
            fields: [],
            colorKey: "",
            ghost: true,
            linkTarget: dest ? undefined : target,
          });
        }
      }
      const key = `${parentId}\u0000${child}`;
      if (seen.has(key)) continue; // the same manager listed twice
      seen.add(key);
      edges.push({ from: parentId, to: child });
      if (outside) external.push({ child, target: nodes.get(parentId)?.title ?? target });
    }
  }

  const brokenCycles = breakCycles(nodes, edges);
  const broken = new Set(brokenCycles);
  const kept = edges.filter((e) => !broken.has(e));
  // The first surviving parent of each child is its primary (solid) manager and
  // drives the layout; any others are dotted-line reports drawn on top.
  const hasPrimary = new Set<string>();
  for (const e of kept) {
    e.primary = !hasPrimary.has(e.to);
    hasPrimary.add(e.to);
  }
  return { nodes, edges: kept, external, brokenCycles };
}

/** DFS from every node; any edge to a node on the current stack closes a cycle and is dropped. */
function breakCycles(nodes: Map<string, OrgNode>, edges: OrgEdge[]): OrgEdge[] {
  const out = new Map<string, OrgEdge[]>();
  for (const e of edges) {
    const list = out.get(e.from);
    if (list) list.push(e);
    else out.set(e.from, [e]);
  }
  const state = new Map<string, 0 | 1 | 2>(); // 0/undefined=new, 1=on stack, 2=done
  const broken: OrgEdge[] = [];

  // Sorted for deterministic results across renders.
  for (const start of [...nodes.keys()].sort()) {
    if (state.get(start)) continue;
    const stack: { id: string; i: number }[] = [{ id: start, i: 0 }];
    state.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const list = out.get(top.id) ?? [];
      if (top.i >= list.length) {
        state.set(top.id, 2);
        stack.pop();
        continue;
      }
      const e = list[top.i++];
      const s = state.get(e.to);
      if (s === 1) broken.push(e);
      else if (!s) {
        state.set(e.to, 1);
        stack.push({ id: e.to, i: 0 });
      }
    }
  }
  return broken;
}

/**
 * Flag current people whose main manager is a former member, and those
 * managers. `isFormer` decides for each manager node (including placeholders
 * for former members hidden from the view). Returns the flagged reports'
 * ids, ordered by title. Safe to call again on the same graph (each render does).
 */
export function markStranded(graph: OrgGraph, isFormer: (node: OrgNode) => boolean): string[] {
  for (const n of graph.nodes.values()) {
    n.departed = false;
    n.strandedReports = 0;
    n.stranded = false;
  }
  const stranded: OrgNode[] = [];
  for (const e of graph.edges) {
    if (!e.primary) continue;
    const manager = graph.nodes.get(e.from);
    const report = graph.nodes.get(e.to);
    if (!manager || !report || report.former || report.ghost || !isFormer(manager)) continue;
    manager.departed = true;
    manager.strandedReports = (manager.strandedReports ?? 0) + 1;
    report.stranded = true;
    stranded.push(report);
  }
  return stranded.sort((a, b) => a.title.localeCompare(b.title)).map((n) => n.id);
}

/** Each person's main (primary) manager. */
export function primaryParents(graph: OrgGraph): Map<string, string> {
  const parent = new Map<string, string>();
  for (const e of graph.edges) if (e.primary) parent.set(e.to, e.from);
  return parent;
}

/** Everyone below `id` through any reporting link, main or dotted. */
export function descendants(graph: OrgGraph, id: string): Set<string> {
  const out = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = out.get(e.from);
    if (list) list.push(e.to);
    else out.set(e.from, [e.to]);
  }
  const below = new Set<string>();
  const stack = [id];
  for (let v = stack.pop(); v !== undefined; v = stack.pop()) {
    for (const w of out.get(v) ?? []) {
      if (!below.has(w)) {
        below.add(w);
        stack.push(w);
      }
    }
  }
  return below;
}

/** The managers to collapse so that only the top `levels` levels show (roots are the first level). */
export function collapseBelow(graph: OrgGraph, levels: number): Set<string> {
  const parent = primaryParents(graph);
  const depth = new Map<string, number>(); // roots are 0
  const depthOf = (id: string): number => {
    // Walk up to a root or a node of known depth, then number the chain on the way back.
    const chain: string[] = [];
    const onChain = new Set<string>();
    let d = -1;
    for (let v: string | undefined = id; v !== undefined && !onChain.has(v); v = parent.get(v)) {
      const known = depth.get(v);
      if (known !== undefined) {
        d = known;
        break;
      }
      chain.push(v);
      onChain.add(v);
    }
    for (let i = chain.length - 1; i >= 0; i--) depth.set(chain[i], ++d);
    return depth.get(id) ?? 0;
  };
  return new Set([...new Set(parent.values())].filter((m) => depthOf(m) >= levels - 1));
}

/** Readable label for a Bases group value: "[[A|Alias]], [[B]]" -> "Alias, B". */
export function groupLabel(raw: string): string {
  const parts: string[] = raw.match(/\[\[[^\]]*\]\]|[^,]+/g) ?? [];
  return parts.map((p) => linkLabel(p.trim())).filter(Boolean).join(", ");
}
