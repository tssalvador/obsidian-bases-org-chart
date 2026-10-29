import {
  AbstractInputSuggest,
  BasesView,
  ButtonComponent,
  debounce,
  Events,
  FuzzySuggestModal,
  Keymap,
  ListValue,
  Menu,
  Modal,
  Notice,
  NullValue,
  parsePropertyId,
  Plugin,
  PluginSettingTab,
  prepareSimpleSearch,
  Scope,
  SearchComponent,
  Setting,
  type App,
  type BasesAllOptions,
  type BasesEntry,
  type BasesEntryGroup,
  type BasesPropertyId,
  type BasesViewConfig,
  type HoverParent,
  type HoverPopover,
  type PaneType,
  type QueryController,
  type SettingDefinition,
  type SettingDefinitionItem,
  type TFile,
  type Value,
} from "obsidian";
import { asList, buildGraph, cardLines, collapseBelow, descendants, groupLabel, linkLabel, linkTarget, hasNote, markStranded, MAX_FIELDS, primaryParents, propValue, type NotedNode, type OrgGraph, type OrgNode } from "./graph";
import { EditConflictError, restoreWrittenNotes, writeAll, type PropertyEdit } from "./write";
import { ensureListTypes, isMultiValueType, propertyNames, propertyType } from "./property-types";
import { CardEditor } from "./card-editor";
import { editableFields, fieldEdits, type EditableField } from "./inline-edit";
import { addDotted, dropProblem, planLeave, reassignPlans, removeParent, setPrimary, type ReassignPlan } from "./edits";
import { cardHeight, layoutGraph, layoutGroups, NODE_W, type GroupSpec, type Layout } from "./layout";
import { fillCardMenu } from "./menu";
import { renderSvg } from "./render";
import { inOwnBasesTab, Viewport } from "./viewport";
import { ViewMemory, type ChartState } from "./view-state";
import { DEFAULT_SETTINGS, MAX_WARNING_THRESHOLD, cleanPropertyName, normalizeSettings, shouldWarnLargeChart, warningThreshold, type OrgChartSettings } from "./settings";

/*
 * Bases Org Chart.
 * Adds an "Org Chart" view type to Obsidian Bases that renders the Base's
 * notes as a parent -> child tree, driven by a configurable parent property
 * (default "reports_to").
 */

const VIEW_TYPE = "org-chart";
/** Fired when plugin settings change, so open views re-render. */
const settingsEvents = new Events();
const SETTINGS_CHANGED = "changed";
const DOUBLE_CLICK_MS = 400;
const DRAG_THRESHOLD = 5;
const EDGE_PAN_ZONE = 48;
const EDGE_PAN_SPEED = 14;

interface ViewSettings extends OrgChartSettings {
  hideIsolated: boolean;
  /** The view's "…contains" values (see formerValues). */
  formerValues: string[];
  showFormer: boolean;
  stackThreshold: number;
  initialDepth: number;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown error";
}

/** The text of a Bases formula result: one entry per item of a list, none for an empty value. */
function valueTexts(value: Value): string[] {
  if (value instanceof NullValue) return [];
  if (value instanceof ListValue) {
    const out: string[] = [];
    for (let i = 0; i < value.length(); i++) out.push(...valueTexts(value.get(i)));
    return out;
  }
  const text = value.toString().trim();
  return text ? [text] : [];
}

/** The frontmatter property chosen in a "property" view option; null if unset or a file/formula property. */
function propertyName(config: BasesViewConfig | undefined, key: string): string | null {
  const id = config?.getAsPropertyId(key);
  if (!id) return null;
  const { type, name } = parsePropertyId(id);
  return type === "note" ? cleanPropertyName(name) || null : null;
}

function viewOptions(settings: OrgChartSettings): BasesAllOptions[] {
  const prop = (key: string, displayName: string, fallback: string) => ({
    type: "property" as const,
    key,
    displayName,
    placeholder: fallback ? `Default: ${fallback}` : "None",
    filter: (id: BasesPropertyId) => parsePropertyId(id).type === "note",
  });
  return [
    {
      type: "group" as const,
      displayName: "Properties",
      items: [
        prop("parentProperty", "Parent", settings.parentProperty),
        prop("nameProperty", "Name", settings.nameProperty || "file name"),
        prop("colorProperty", "Colour by", settings.colorProperty),
        prop("imageProperty", "Image", settings.imageProperty),
      ],
    },
    {
      type: "group" as const,
      displayName: "Former members",
      items: [
        { type: "toggle" as const, key: "showFormer", displayName: "Show former members", default: false },
        prop("currentProperty", "Current membership", settings.currentProperty),
        prop("formerProperty", "Former when property", settings.formerProperty),
        {
          type: "formula" as const,
          key: "formerValue",
          displayName: "…contains",
          default: "",
          placeholder: "e.g. \"Acme\", or this.file.name",
        },
      ],
    },
    {
      type: "group" as const,
      displayName: "Layout",
      items: [
        {
          type: "dropdown" as const,
          key: "direction",
          displayName: "Direction",
          default: settings.direction,
          options: { TB: "Top to bottom", LR: "Left to right" },
        },
        { type: "toggle" as const, key: "hideIsolated", displayName: "Hide people with no reporting links", default: false },
        {
          type: "slider" as const,
          key: "stackThreshold",
          displayName: "Stack teams larger than (0 = never)",
          default: 6,
          min: 0,
          max: 20,
          step: 1,
          instant: true,
        },
        {
          type: "slider" as const,
          key: "initialDepth",
          displayName: "Initially expand levels (0 = all)",
          default: 0,
          min: 0,
          max: 6,
          step: 1,
        },
      ],
    },
  ];
}

interface DragState {
  node: NotedNode;
  el: SVGGElement;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  /** Pointer offset from the card's top-left, in content units. */
  grabX: number;
  grabY: number;
  active: boolean;
  ghost: SVGGElement | null;
  target: string | null;
  valid: boolean;
  raf: number | null;
  /** Everyone below the dragged person (any link), who can't become their manager; set once the drag starts. */
  below: Set<string>;
  /** The note of the dragged person's current main manager, if any. */
  managerPath: string | null;
  cleanup: () => void;
}

/** Confirmation dialog with a short sentence (bold parts allowed) and an optional note. */
class ConfirmModal extends Modal {
  constructor(
    app: App,
    private opts: {
      title: string;
      body: (string | { strong: string })[];
      note?: string | null;
      cta: string;
      warning?: boolean;
      /** Optional checkbox; its value is passed to onConfirm. */
      checkbox?: { label: string; detail?: string; checked: boolean };
      onConfirm: (checked: boolean) => void;
    }
  ) {
    super(app);
  }

  onOpen(): void {
    const o = this.opts;
    this.setTitle(o.title);
    const p = this.contentEl.createEl("p");
    for (const part of o.body) p.append(typeof part === "string" ? part : createEl("strong", { text: part.strong }));
    if (o.note) this.contentEl.createEl("p", { cls: "setting-item-description", text: o.note });
    let checked = o.checkbox?.checked ?? false;
    if (o.checkbox) {
      const row = new Setting(this.contentEl).setName(o.checkbox.label).addToggle((t) =>
        t.setValue(checked).onChange((v) => (checked = v))
      );
      if (o.checkbox.detail) row.setDesc(o.checkbox.detail);
      row.settingEl.addClass("org-chart-modal-option");
    }
    const confirm = () => {
      this.close();
      o.onConfirm(checked);
    };
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => {
        b.setButtonText(o.cta).onClick(confirm);
        if (o.warning) b.setDestructive().setCta();
        else b.setCta();
      });
    // Enter confirms only non-destructive dialogs, and never while a button
    // or toggle has focus (Enter then activates that control instead).
    if (!o.warning) {
      this.scope.register([], "Enter", (e) => {
        const active = this.modalEl.doc.activeElement;
        if (active && this.modalEl.contains(active) && active.matches("button, .checkbox-container, input")) return;
        e.preventDefault();
        confirm();
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Pick a person from the chart. */
class PersonPickerModal extends FuzzySuggestModal<NotedNode> {
  constructor(app: App, private people: NotedNode[], placeholder: string, private onPick: (node: NotedNode) => void) {
    super(app);
    this.setPlaceholder(placeholder);
  }

  getItems(): NotedNode[] {
    return this.people;
  }

  getItemText(node: NotedNode): string {
    return node.subtitle ? `${node.title} — ${node.subtitle}` : node.title;
  }

  onChooseItem(node: NotedNode): void {
    this.onPick(node);
  }
}

/** Lines under the name on the busiest card (at least 1); a loop, so huge charts can't overflow the call stack. */
function maxCardLines(graph: OrgGraph): number {
  let max = 1;
  for (const n of graph.nodes.values()) max = Math.max(max, cardLines(n).length);
  return max;
}

class OrgChartView extends BasesView implements HoverParent {
  type = VIEW_TYPE;
  hoverPopover: HoverPopover | null = null;
  private getSettings: () => OrgChartSettings;
  private rootEl: HTMLElement;
  private statusEl: HTMLElement;
  private find: SearchComponent;
  private canvasEl: HTMLElement;
  private viewport: Viewport;
  private unlinkedBtn: ButtonComponent;
  private formerBtn: ButtonComponent;
  private zoomLabel: ButtonComponent;

  /** Which Bases view is shown, its collapsed teams and zoom (Bases reuses this object across Org Chart views). */
  private memory = new ViewMemory();
  private selected: string | null = null;
  private lastClick: { id: string; at: number } | null = null;
  private contentEl: SVGGElement | null = null;
  private drag: DragState | null = null;
  /** The card being edited in place, if any. */
  private editor: { id: string; panel: CardEditor } | null = null;
  /** Bases sent new data while a card was being edited; applied when editing ends. */
  private dataPending = false;
  private openFrame: number | null = null;
  private needsInitialOpen = false;
  private largeChartApprovedUpTo = 0;
  private revealAfterRender: string | null = null;

  private graph: OrgGraph | null = null;
  private layout: Layout | null = null;
  private findHits: string[] = [];
  private formerCount = 0;
  /** Set when the view is grouped (Bases' Group option). */
  private groupSpecs: GroupSpec[] | null = null;
  private formerPaths = new Set<string>();
  private strandedIds: string[] = [];
  private strandedIndex = -1;
  private findIndex = -1;

  constructor(controller: QueryController, containerEl: HTMLElement, getSettings: () => OrgChartSettings) {
    super(controller);
    this.getSettings = getSettings;
    this.rootEl = containerEl.createDiv({ cls: "org-chart-root" });

    const bar = this.rootEl.createDiv({ cls: "org-chart-toolbar" });
    this.statusEl = bar.createDiv({ cls: "org-chart-status" });
    const tools = bar.createDiv({ cls: "org-chart-tools" });
    this.find = new SearchComponent(tools).setPlaceholder("Find person…").onChange(() => this.runFind(false));
    this.find.inputEl.addClass("org-chart-find");
    this.find.inputEl.setAttribute("aria-label", "Find person in chart");
    const button = (icon: string, label: string, fn: () => void) =>
      new ButtonComponent(tools).setIcon(icon).setTooltip(label, { placement: "bottom" })
        .setClass("clickable-icon").setClass("org-chart-tool").onClick(fn);
    this.unlinkedBtn = button("users", "Show people with no reporting links", () =>
      this.setOption("hideIsolated", !this.settings().hideIsolated)
    );
    this.formerBtn = button("history", "Show former members", () =>
      this.setOption("showFormer", !this.settings().showFormer)
    );
    tools.createDiv({ cls: "org-chart-tool-sep" });
    button("chevrons-down-up", "Collapse all", () => this.setAllCollapsed(true));
    button("chevrons-up-down", "Expand all", () => this.setAllCollapsed(false));
    button("zoom-out", "Zoom out", () => this.viewport.zoomBy(1 / 1.25));
    this.zoomLabel = new ButtonComponent(tools).setButtonText("100%").setClass("org-chart-zoom-level")
      .setTooltip("Current zoom. Click to reset to 100%", { placement: "bottom" })
      .onClick(() => this.viewport.zoomBy(1 / this.viewport.t.k));
    button("zoom-in", "Zoom in", () => this.viewport.zoomBy(1.25));
    button("maximize", "Fit to view", () => this.viewport.fit());

    this.canvasEl = this.rootEl.createDiv({ cls: "org-chart-canvas", attr: { tabindex: "0" } });
    this.viewport = new Viewport(this.canvasEl, this);
    this.viewport.onChange = (t) => {
      this.zoomLabel.setButtonText(`${Math.round(t.k * 100)}%`);
      this.placeEditor();
    };
    this.viewport.dragHandler = (e) => this.startCardDrag(e);
    // Scrolling pans only a chart in its own tab. Elsewhere (embedded in a
    // note, a canvas or a hover preview) it moves the page around it; drag to pan.
    this.viewport.wheelPans = () => inOwnBasesTab(this.rootEl);

    this.registerDomEvent(this.find.inputEl, "keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.runFind(true, e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        this.clearFind();
      }
    });
  }

  onload(): void {
    this.registerEvent(settingsEvents.on(SETTINGS_CHANGED, () => this.onDataUpdated()));
    this.register(() => {
      this.endDrag(true);
      // Typed text isn't lost when the view closes mid-edit.
      this.closeEditor(true);
      if (this.openFrame !== null) this.canvasEl.win.cancelAnimationFrame(this.openFrame);
      this.openFrame = null;
      this.needsInitialOpen = false;
    });
  }

  // ---- Bases ephemeral state: keeps zoom and collapse across re-creation ----
  // Bases calls these on its views (they aren't in the public BasesView type;
  // its own versions do nothing).
  getEphemeralState(): unknown {
    const orgChart: ChartState = { transform: this.viewport.t, collapsed: [...this.memory.collapsed] };
    return { orgChart };
  }

  setEphemeralState(state: unknown): void {
    const restored = this.memory.restore(state, this.config?.name ?? null, this.getSettings().restoreViews);
    if (!restored) return;
    if (restored.started) this.resetForNewView();
    // Already showing this view's data (e.g. back in history): apply it now.
    // After a switch, the chart still holds the previous view's data.
    if (!restored.switching && this.graph) this.render();
  }

  /** Another Bases view is shown: forget the find box, selection and large-chart approval. */
  private resetForNewView(): void {
    this.largeChartApprovedUpTo = 0;
    this.selected = null;
    this.findHits = [];
    this.findIndex = -1;
    if (this.find.getValue()) {
      this.find.setValue("");
      this.find.onChanged();
    }
  }

  /**
   * The view's "…contains" values. The option is a Bases formula, so
   * `this.file.name` is the note an embedded view sits in (for a base in its
   * own tab, Bases uses the note opened last, as in its filters). When Bases
   * can't evaluate it (no such note yet, or not valid as a formula) or it gives
   * nothing, the option's text is used as it is, without surrounding quotes:
   * "Acme" and plain Acme both work.
   */
  private formerValues(): string[] {
    const raw = this.config?.get("formerValue");
    if (typeof raw !== "string" || !raw.trim()) return [];
    try {
      const texts = valueTexts(this.config.getEvaluatedFormula(this, "formerValue"));
      if (texts.length) return texts;
    } catch {
      // Bases has no note to evaluate against yet: fall back to the text.
    }
    return [raw.trim().replace(/^(["'])(.*)\1$/, "$2")];
  }

  /** Change a per-view option; Bases saves it to the .base file and re-renders. */
  private setOption(key: string, value: unknown): void {
    this.memory.fitted = false; // showing or hiding people changes the chart's size
    this.config.set(key, value);
  }

  private settings(): ViewSettings {
    const g = this.getSettings();
    const get = (k: string) => this.config?.get(k);
    const num = (k: string, d: number) => {
      const v = Number(get(k));
      return get(k) == null || Number.isNaN(v) ? d : v;
    };
    const dir = get("direction");
    const prop = (key: string) => propertyName(this.config, key);
    return {
      parentProperty: prop("parentProperty") ?? g.parentProperty,
      nameProperty: prop("nameProperty") ?? g.nameProperty,
      fields: g.fields,
      colorProperty: prop("colorProperty") ?? g.colorProperty,
      imageProperty: prop("imageProperty") ?? g.imageProperty,
      allowRemoteImages: g.allowRemoteImages,
      noteMenu: g.noteMenu,
      currentProperty: prop("currentProperty") ?? g.currentProperty,
      formerProperty: prop("formerProperty") ?? g.formerProperty,
      formerValues: this.formerValues(),
      showFormer: get("showFormer") === true,
      direction: dir === "LR" || dir === "TB" ? dir : g.direction,
      hideIsolated: get("hideIsolated") === true,
      stackThreshold: num("stackThreshold", 6),
      initialDepth: num("initialDepth", 0),
      largeChartWarningThreshold: g.largeChartWarningThreshold,
      restoreViews: g.restoreViews,
    };
  }

  // Called by Bases whenever the query results or view config change.
  onDataUpdated(): void {
    // Redrawing would move the card from under the panel; wait until editing ends.
    if (this.editor) {
      this.dataPending = true;
      return;
    }
    const s = this.settings();
    const groups: BasesEntryGroup[] = this.data?.groupedData ?? [];
    // Grouped when Bases' Group option is set: several groups, or one with a value.
    const grouped = groups.length > 1 || (groups.length === 1 && groups[0].hasKey());
    if (grouped) {
      const specs: GroupSpec[] = groups.map((g) => ({
        label: g.hasKey() ? groupLabel(String(g.key ?? "").trim()) : "",
        ids: g.entries.map((e: BasesEntry) => e.file.path),
      }));
      // Bases order, but people without a value last.
      this.groupSpecs = [...specs.filter((g: GroupSpec) => g.label), ...specs.filter((g: GroupSpec) => !g.label).map((g: GroupSpec) => ({ ...g, label: "No value" }))];
    } else {
      this.groupSpecs = null;
    }
    const files: TFile[] = groups.flatMap((g) => g.entries.map((e: BasesEntry) => e.file));

    const all = buildGraph(this.app, files, s);
    const former = [...all.nodes.values()].filter((n) => n.former).filter(hasNote);
    this.formerCount = former.length;
    this.formerPaths = new Set(former.map((n) => n.file.path));
    // Hidden former members are removed before the graph is built, so their
    // reports show their manager as "outside this view" instead of vanishing.
    this.graph = s.showFormer || !former.length
      ? all
      : buildGraph(this.app, files.filter((f) => !all.nodes.get(f.path)?.former), s);

    // Another view in the same base (or the first data) starts afresh, unless
    // setEphemeralState restored it. Collapse comes from "Initially expand
    // levels" the first time or when that option changes.
    const graph = this.graph;
    const seed = () => (s.initialDepth > 0 ? collapseBelow(graph, s.initialDepth) : new Set<string>());
    if (this.memory.update(this.config?.name ?? null, s.initialDepth, seed)) this.resetForNewView();

    this.render(s);
  }

  private render(s: ViewSettings = this.settings(), anchor?: { id: string; sx: number; sy: number }): void {
    if (this.drag) this.endDrag(true);
    if (this.editor) {
      // Redrawing anyway (e.g. a team toggled): save the edit; no second redraw for pending data.
      this.dataPending = false;
      this.closeEditor(true);
    }
    if (this.openFrame !== null) {
      this.canvasEl.win.cancelAnimationFrame(this.openFrame);
      this.openFrame = null;
    }
    const graph = this.graph;
    if (!graph) return;
    // Drop collapse entries for people no longer in the view.
    for (const id of this.memory.collapsed) if (!graph.nodes.has(id)) this.memory.collapsed.delete(id);

    const toggleState = (button: ButtonComponent, on: boolean, showLabel: string, hideLabel: string) => {
      button.buttonEl.toggleClass("is-active", on);
      button.buttonEl.setAttribute("aria-pressed", String(on));
      button.setTooltip(on ? hideLabel : showLabel, { placement: "bottom" });
    };
    toggleState(this.unlinkedBtn, !s.hideIsolated, "Show people with no reporting links", "Hide people with no reporting links");
    toggleState(this.formerBtn, s.showFormer, "Show former members", "Hide former members");
    // Only useful when someone matches the former-member rule (or to turn it off).
    this.formerBtn.buttonEl.toggle(this.formerCount > 0 || s.showFormer);

    this.canvasEl.empty();
    // Nothing below refers to the previous drawing.
    this.layout = null;
    this.contentEl = null;
    const people = [...graph.nodes.values()].filter((node) => !node.ghost).length;
    if (people === 0) {
      this.statusEl.setText("No notes match this view.");
      return;
    }
    if (shouldWarnLargeChart(people, s.largeChartWarningThreshold, this.largeChartApprovedUpTo)) {
      this.statusEl.setText(`${people} people · rendering paused`);
      const warning = this.canvasEl.createDiv({ cls: "org-chart-empty" });
      warning.createDiv({ text: `This chart contains ${people} people, above the ${s.largeChartWarningThreshold} warning threshold.` });
      new ButtonComponent(warning).setButtonText("Render anyway").setCta().onClick(() => {
        this.largeChartApprovedUpTo = people;
        this.render(s);
      });
      return;
    }

    const layoutOpts = {
      direction: s.direction,
      collapsed: this.memory.collapsed,
      hideIsolated: s.hideIsolated,
      // Former members the user asked to see stay visible even with no links.
      keepIsolated: s.showFormer ? (id: string) => !!graph.nodes.get(id)?.former : undefined,
      stackThreshold: s.stackThreshold,
      // One height for every card: enough for the busiest one.
      cardHeight: cardHeight(maxCardLines(graph)),
      aspect: this.canvasEl.clientWidth && this.canvasEl.clientHeight
        ? this.canvasEl.clientWidth / this.canvasEl.clientHeight
        : undefined,
    };
    this.layout = this.groupSpecs ? layoutGroups(graph, this.groupSpecs, layoutOpts) : layoutGraph(graph, layoutOpts);
    const layout = this.layout;
    this.strandedIds = markStranded(
      graph,
      (n) => !!n.former || (!!n.ghost && !!n.file && this.formerPaths.has(n.file.path))
    );
    if (this.strandedIndex >= this.strandedIds.length) this.strandedIndex = -1;

    const parts = [`${people} people`, `${graph.edges.length} reporting links`];
    if (this.groupSpecs) parts.push(`${layout.groups?.length ?? 0} groups`);
    if (this.formerCount) parts.push(s.showFormer ? `${this.formerCount} former` : `${this.formerCount} former hidden`);
    if (layout.hiddenIsolated) parts.push(`${layout.hiddenIsolated} with no links hidden`);
    if (layout.hiddenCollapsed) parts.push(`${layout.hiddenCollapsed} in collapsed teams`);
    if (graph.external.length) parts.push(`${graph.external.length} to managers outside this view`);
    if (graph.brokenCycles.length) parts.push(`${graph.brokenCycles.length} circular link(s) ignored`);
    if (graph.edges.length === 0) parts.push(`no "${s.parentProperty}" values set`);
    this.statusEl.empty();
    if (this.strandedIds.length) {
      const n = this.strandedIds.length;
      new ButtonComponent(this.statusEl)
        .setButtonText(`⚠ ${n} reporting to former members`)
        .setClass("org-chart-warning")
        .setTooltip(`${n} ${n === 1 ? "person's" : "people's"} main manager is a former member. Click to jump to each in turn.`, { placement: "bottom" })
        .onClick(() => this.nextStranded());
      this.statusEl.appendText(" · ");
    }
    this.statusEl.appendText(parts.join(" · "));

    if (layout.nodes.size === 0) {
      this.canvasEl.createDiv({
        cls: "org-chart-empty",
        text: `Nobody has a "${s.parentProperty}" link yet. Use the people button in the toolbar to show everyone.`,
      });
      return;
    }

    const content = renderSvg(this.canvasEl, graph, layout, s.direction, this.memory.collapsed, {
      onClick: (node: OrgNode, evt: MouseEvent) => {
        // Mod-click opens the note (Cmd/Ctrl: new tab; with Alt or Shift: a split or window).
        const where = Keymap.isModEvent(evt);
        if (where && node.file) {
          this.lastClick = null;
          this.openNote(node, where);
          return;
        }
        // Double-click detected here rather than via "dblclick": expanding a
        // team re-renders between the two clicks, replacing the element.
        const now = Date.now();
        const last = this.lastClick;
        this.lastClick = { id: node.id, at: now };
        if (last && last.id === node.id && now - last.at < DOUBLE_CLICK_MS) {
          this.lastClick = null;
          this.startEdit(node);
          return;
        }
        if (this.memory.collapsed.has(node.id)) {
          this.select(node.id);
          this.toggle(node.id);
          return;
        }
        this.select(node.id);
      },
      // Enter edits. (Mod+Enter and F2 are Obsidian's own shortcuts and never reach the card.)
      onActivate: (node: OrgNode) => this.startEdit(node),
      onHover: (node: OrgNode, evt: MouseEvent, targetEl: Element) => {
        if (!node.file) return;
        this.app.workspace.trigger("hover-link", {
          event: evt,
          source: VIEW_TYPE,
          hoverParent: this,
          targetEl,
          linktext: node.file.path,
        });
      },
      onToggle: (node: OrgNode) => this.toggle(node.id),
      onEdgeClick: (from: string, to: string) => this.confirmRemoveLink(from, to),
      onContextMenu: (node: OrgNode, evt: MouseEvent) => this.showCardMenu(node, evt),
    });
    this.contentEl = content;
    this.viewport.setContent(content, layout.width, layout.height);

    if (anchor) {
      this.needsInitialOpen = false;
      const p = layout.nodes.get(anchor.id);
      if (p) this.viewport.keepPointAt(p.x, p.y, anchor.sx, anchor.sy);
    } else if (this.memory.pendingTransform) {
      this.needsInitialOpen = false;
      this.viewport.set(this.memory.pendingTransform);
      this.memory.pendingTransform = null;
    } else if (!this.memory.fitted || this.needsInitialOpen) {
      // Open at 100% centred on the largest org's head. Defer one frame so
      // the canvas has its final size.
      const f = layout.focus ? layout.nodes.get(layout.focus) : undefined;
      const focus = f ? { x: f.x + NODE_W / 2, y: f.y + layout.cardH / 2 } : undefined;
      this.needsInitialOpen = true;
      this.openFrame = this.canvasEl.win.requestAnimationFrame(() => {
        this.openFrame = null;
        this.needsInitialOpen = false;
        this.memory.fitted = true;
        this.viewport.open(focus);
      });
      this.memory.fitted = true;
    }
    if (this.find.getValue().trim()) {
      // The people, their names or what's visible may have changed.
      this.updateFindHits();
      this.highlight();
    }
    if (this.selected) this.select(this.selected);
    if (this.revealAfterRender) {
      const id = this.revealAfterRender;
      this.revealAfterRender = null;
      this.revealIfOffscreen(id);
    }
  }

  private openNote(node: OrgNode, where: PaneType | boolean): void {
    if (node.file) void this.app.workspace.getLeaf(where).openFile(node.file);
  }

  // ---- Edit a card's name and fields in place ----

  /** The card's properties that can be edited in place (see editableFields). */
  private editableFieldsFor(node: NotedNode): EditableField[] {
    const s = this.settings();
    const fm = this.app.metadataCache.getFileCache(node.file)?.frontmatter;
    return editableFields(fm, { nameProperty: s.nameProperty, fields: s.fields }, (p) => propertyType(this.app, p), isMultiValueType);
  }

  /** Edit the card in place; a placeholder, or a card with nothing editable, opens its note instead. */
  private startEdit(node: OrgNode): void {
    if (!hasNote(node) || node.ghost || node.file.extension !== "md") {
      this.openNote(node, "tab");
      return;
    }
    const fields = this.editableFieldsFor(node);
    if (!fields.length) {
      this.openNote(node, "tab");
      return;
    }
    this.closeEditor(true);
    if (!this.nodeEl(node.id)) return;
    this.select(node.id);
    // Escape cancels the edit, not whatever Obsidian would otherwise do with it.
    const scope = new Scope(this.app.scope);
    const panel: CardEditor = new CardEditor(this.rootEl, {
      title: node.title,
      fileName: node.file.basename,
      fields,
      onSave: (typed) => void this.saveFields(node, fields, typed),
      onClose: () => {
        this.app.keymap.popScope(scope);
        if (this.editor?.panel === panel) this.editor = null;
        if (this.dataPending && !this.editor) {
          this.dataPending = false;
          this.onDataUpdated();
        }
      },
    });
    scope.register([], "Escape", () => {
      panel.close(false);
      return false;
    });
    this.app.keymap.pushScope(scope);
    this.editor = { id: node.id, panel };
    this.placeEditor();
    panel.focus();
  }

  /** Keep the panel over its card as the chart pans and zooms. */
  private placeEditor(): void {
    const e = this.editor;
    if (!e) return;
    const card = this.nodeEl(e.id)?.querySelector(".org-chart-card");
    if (card) e.panel.place(card.getBoundingClientRect());
    else e.panel.close(true);
  }

  private closeEditor(save: boolean): void {
    this.editor?.panel.close(save);
  }

  private async saveFields(node: NotedNode, fields: EditableField[], typed: Map<string, string>): Promise<void> {
    const edits = fieldEdits(fields, typed);
    if (!edits.length) return;
    const props = edits.map((e) => e.prop).join(", ");
    await this.writeNotes(
      [{ file: node.file, edits }],
      node.id,
      `Updated ${node.title}'s ${props}.`,
      `Undone: ${node.title}'s ${props} restored.`
    );
  }

  private select(id: string | null): void {
    this.selected = id;
    this.canvasEl.querySelectorAll<SVGGElement>(".org-chart-node").forEach((g) => {
      g.toggleClass("is-selected", g.dataset.id === id);
    });
  }

  // ---- Drag a card onto someone to change their manager ----

  private toContent(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.canvasEl.getBoundingClientRect();
    const t = this.viewport.t;
    return { x: (clientX - r.left - t.x) / t.k, y: (clientY - r.top - t.y) / t.k };
  }

  /** Claims pointerdown on a real card so dragging it moves the card rather than panning. */
  private startCardDrag(e: PointerEvent): boolean {
    const el = (e.target as Element).closest?.<SVGGElement>(".org-chart-node") ?? null;
    const node = el ? this.graph?.nodes.get(el.dataset.id ?? "") : undefined;
    const placed = node ? this.layout?.nodes.get(node.id) : undefined;
    // Only Markdown notes have properties to edit; anything else pans as usual.
    if (!el || !hasNote(node) || node.ghost || node.file.extension !== "md" || !placed) return false;
    // A drag whose pointerup never arrived (e.g. released outside the window)
    // must not leak its listeners or keymap scope.
    this.endDrag(true);

    const c = this.toContent(e.clientX, e.clientY);
    const move = (ev: PointerEvent) => {
      // Released where the window couldn't see it (e.g. outside it): cancel.
      if ((ev.buttons & 1) === 0) this.endDrag(true);
      else this.onDragMove(ev.clientX, ev.clientY);
    };
    const up = () => this.endDrag(false);
    const cancel = () => this.endDrag(true);
    // Escape cancels the drag: a keymap scope on top of Obsidian's own.
    const scope = new Scope(this.app.scope);
    scope.register([], "Escape", () => {
      this.endDrag(true);
      return false;
    });
    this.app.keymap.pushScope(scope);
    // The window the chart is in, which may be a pop-out window.
    const win = this.canvasEl.win;
    win.addEventListener("pointermove", move);
    win.addEventListener("pointerup", up);
    win.addEventListener("pointercancel", cancel);
    this.drag = {
      node, el,
      startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY,
      grabX: c.x - placed.x, grabY: c.y - placed.y,
      active: false, ghost: null, target: null, valid: false, raf: null,
      below: new Set(), managerPath: null,
      cleanup: () => {
        win.removeEventListener("pointermove", move);
        win.removeEventListener("pointerup", up);
        win.removeEventListener("pointercancel", cancel);
        this.app.keymap.popScope(scope);
      },
    };
    return true;
  }

  private onDragMove(clientX: number, clientY: number): void {
    const d = this.drag;
    if (!d) return;
    d.lastX = clientX;
    d.lastY = clientY;
    if (!d.active) {
      if (Math.hypot(clientX - d.startX, clientY - d.startY) < DRAG_THRESHOLD) return;
      d.active = true;
      // Worked out once the drag really starts, not on every click.
      if (this.graph) d.below = descendants(this.graph, d.node.id);
      d.managerPath = this.currentManager(d.node)?.file?.path ?? null;
      d.ghost = d.el.cloneNode(true) as SVGGElement;
      d.ghost.classList.add("is-drag-ghost");
      d.ghost.classList.remove("is-selected", "is-match", "is-current");
      this.contentEl?.appendChild(d.ghost);
      d.el.classList.add("is-drag-source");
      this.canvasEl.addClass("is-dragging");
      const tick = () => {
        if (!this.drag?.active) return;
        this.edgePan();
        this.drag.raf = this.canvasEl.win.requestAnimationFrame(tick);
      };
      d.raf = this.canvasEl.win.requestAnimationFrame(tick);
    }
    this.updateDrag();
  }

  /** Scroll the chart when dragging near the pane's edge so distant managers are reachable. */
  private edgePan(): void {
    const d = this.drag;
    if (!d) return;
    const r = this.canvasEl.getBoundingClientRect();
    const speed = (dist: number) => (dist < EDGE_PAN_ZONE ? Math.ceil(((EDGE_PAN_ZONE - dist) / EDGE_PAN_ZONE) * EDGE_PAN_SPEED) : 0);
    const dx = speed(d.lastX - r.left) - speed(r.right - d.lastX);
    const dy = speed(d.lastY - r.top) - speed(r.bottom - d.lastY);
    if (!dx && !dy) return;
    const t = this.viewport.t;
    this.viewport.set({ ...t, x: t.x + dx, y: t.y + dy });
    this.updateDrag();
  }

  private updateDrag(): void {
    const d = this.drag;
    if (!d?.active || !d.ghost || !this.layout) return;
    const c = this.toContent(d.lastX, d.lastY);
    d.ghost.setAttribute("transform", `translate(${c.x - d.grabX},${c.y - d.grabY})`);

    let target: string | null = null;
    for (const [id, p] of this.layout.nodes) {
      if (id !== d.node.id && c.x >= p.x && c.x <= p.x + NODE_W && c.y >= p.y && c.y <= p.y + this.layout.cardH) {
        target = id;
        break;
      }
    }
    if (target !== d.target) {
      this.nodeEl(d.target)?.classList.remove("is-drop-target", "is-drop-invalid");
      d.target = target;
      d.valid = !!target && !!this.graph
        && dropProblem(this.graph, target, { path: d.node.file.path, managerPath: d.managerPath, below: d.below }) === null;
      const el = this.nodeEl(target);
      el?.classList.toggle("is-drop-target", d.valid);
      el?.classList.toggle("is-drop-invalid", !!target && !d.valid);
    }
  }

  private nodeEl(id: string | null): SVGGElement | null {
    if (!id) return null;
    return this.canvasEl.querySelector<SVGGElement>(`.org-chart-node[data-id="${CSS.escape(id)}"]:not(.is-drag-ghost)`);
  }

  private currentManager(person: OrgNode): OrgNode | undefined {
    const e = this.graph?.edges.find((x) => x.primary && x.to === person.id);
    return e ? this.graph?.nodes.get(e.from) : undefined;
  }

  private endDrag(cancelled: boolean): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    d.cleanup();
    if (d.raf !== null) this.canvasEl.win.cancelAnimationFrame(d.raf);
    if (!d.active) return; // a plain click; let the click handler deal with it
    d.ghost?.remove();
    d.el.classList.remove("is-drag-source");
    this.nodeEl(d.target)?.classList.remove("is-drop-target", "is-drop-invalid");
    this.canvasEl.removeClass("is-dragging");
    this.viewport.suppressNextClick();
    if (cancelled || !d.valid || !d.target) return;

    const target = this.graph?.nodes.get(d.target);
    if (!hasNote(target)) return;
    const current = this.currentManager(d.node);
    new ConfirmModal(this.app, {
      title: "Change manager",
      body: ["Set ", { strong: d.node.title }, " as reporting to ", { strong: target.title }, "?"],
      note: current ? `Currently reports to ${current.title}.` : null,
      cta: "Confirm",
      onConfirm: () => void this.setManager(d.node, target),
    }).open();
  }

  /** Does a raw parent value (e.g. "[[Name|Alias]]") point at `parent`? */
  private refersTo(raw: string, parent: OrgNode, sourcePath: string): boolean {
    if (parent.file) {
      return this.app.metadataCache.getFirstLinkpathDest(linkTarget(raw), sourcePath)?.path === parent.file.path;
    }
    // Placeholder with no note: match by the link target it was created from.
    return linkTarget(raw).toLowerCase() === (parent.linkTarget ?? parent.title).toLowerCase();
  }

  /** A property's values on a note, from the metadata cache (rechecked against the file on write). */
  private values(file: TFile, prop: string): string[] {
    return asList(propValue(this.app.metadataCache.getFileCache(file)?.frontmatter, prop));
  }

  private parentValues(person: NotedNode, prop: string): string[] {
    return this.values(person.file, prop);
  }

  /** Make `target` the primary manager, keeping any dotted-line managers. */
  private async setManager(person: NotedNode, target: NotedNode): Promise<void> {
    const file = person.file;
    const prop = this.settings().parentProperty;
    const link = `[[${this.app.metadataCache.fileToLinktext(target.file, file.path, true)}]]`;
    const expected = this.parentValues(person, prop);
    const values = setPrimary(expected, link, (raw) => this.refersTo(raw, target, file.path));
    await this.writeParents(person, { prop, values, expected }, `${person.title} now reports to ${target.title}.`);
  }

  private confirmRemoveLink(from: string, to: string): void {
    const graph = this.graph;
    const manager = graph?.nodes.get(from);
    const person = graph?.nodes.get(to);
    if (!graph || !manager || !hasNote(person)) return;
    const prop = this.settings().parentProperty;
    const expected = this.parentValues(person, prop);
    const r = removeParent(expected, (raw) => this.refersTo(raw, manager, person.file.path));
    const remaining = r.remaining;
    if (!r.removed) {
      new Notice(`Couldn't find ${manager.title} in ${person.title}'s "${prop}".`);
      return;
    }
    let consequence: string | null = null;
    if (r.promoted) {
      const next = graph.nodes.get(
        graph.edges.find((e) => e.to === person.id && !e.primary && e.from !== from)?.from ?? ""
      );
      consequence = `${next?.title ?? linkLabel(r.promoted)} (currently a dotted-line manager) will become their main manager.`;
    } else if (!remaining.length) {
      consequence = `${person.title} will have no manager.`;
    }
    new ConfirmModal(this.app, {
      title: "Remove reporting line",
      body: [{ strong: person.title }, " will no longer report to ", { strong: manager.title }, "."],
      note: consequence,
      cta: "Remove",
      warning: true,
      onConfirm: () => void this.writeParents(person, { prop, values: remaining, expected }, `${person.title} no longer reports to ${manager.title}.`),
    }).open();
  }

  private writeParents(person: NotedNode, edit: PropertyEdit, message: string): Promise<void> {
    return this.writeNotes([{ file: person.file, edits: [edit] }], person.id, message, `Undone: ${person.title}'s reporting lines restored.`);
  }

  /**
   * Rewrite the given properties across one or more notes, then
   * offer a single Undo for all of them. If a write fails part-way, the notes
   * already changed are rolled back.
   */
  private async writeNotes(
    changes: { file: TFile; edits: PropertyEdit[] }[],
    focusId: string,
    message: string,
    undoMessage: string
  ): Promise<void> {
    const process = (file: TFile, mutate: (fm: Record<string, unknown>) => void) =>
      this.app.fileManager.processFrontMatter(file, mutate);
    const problemsIn = (result: { conflicted: string[]; failed: string[] }) => [
      ...(result.conflicted.length ? [`newer edits in ${result.conflicted.join(", ")}`] : []),
      ...(result.failed.length ? [`write failures in ${result.failed.join(", ")}`] : []),
    ];

    // The reporting properties are lists: make sure Obsidian has them as List
    // too, including a view's own choice of parent or membership property.
    // Card fields edited in place keep their own type.
    ensureListTypes(this.app, changes.flatMap((c) => c.edits.filter((e) => !e.single).map((e) => e.prop)));
    const result = await writeAll(changes.map((c) => ({ target: c.file, label: c.file.basename, edits: c.edits })), process);
    if (!result.ok) {
      const problems = problemsIn(result.rollback);
      const rollback = problems.length
        ? `Rollback was incomplete because of ${problems.join(" and ")}. Review those notes before continuing.`
        : result.rolledBack
          ? "Earlier completed changes were rolled back."
          : "No earlier notes were changed.";
      const reason = result.error instanceof EditConflictError
        ? `${errorMessage(result.error)}; nothing was written to it. Try again once the chart has refreshed`
        : errorMessage(result.error);
      new Notice(`Couldn't update ${result.failed}: ${reason}. ${rollback}`);
      return;
    }

    const written = result.written;
    this.selected = focusId;
    this.revealAfterRender = focusId;
    const frag = createFragment((f) => {
      f.appendText(message + " ");
      const undo = f.createEl("a", { text: "Undo", href: "#" });
      undo.addEventListener("click", (e) => {
        e.preventDefault();
        notice.hide();
        void restoreWrittenNotes(written, process).then((restored) => {
          this.revealAfterRender = focusId;
          const problems = problemsIn(restored);
          new Notice(problems.length ? `Undo was incomplete because of ${problems.join(" and ")}.` : undoMessage);
        }).catch((err: unknown) => {
          new Notice(`Couldn't undo the change: ${errorMessage(err)}.`);
        });
      });
    });
    const notice = new Notice(frag, 10000);
  }

  // ---- Right-click menu ----

  /**
   * The chart's own actions first. With "Note actions on right-click", then
   * Obsidian's usual menu for the note, built the way Bases' cards build it,
   * with Delete file last (see fillCardMenu).
   */
  private showCardMenu(node: OrgNode, evt: MouseEvent): void {
    if (!hasNote(node)) return;
    const file = node.file;
    this.select(node.id);
    const s = this.settings();
    // Obsidian's menu for this right-click; it shows it once filled in.
    const menu = Menu.forEvent(evt);
    const current = s.currentProperty ? this.values(file, s.currentProperty) : [];
    fillCardMenu(menu, {
      edit: this.editableFieldsFor(node).length ? () => this.startEdit(node) : undefined,
      addDotted: this.currentManager(node) ? () => this.pickDottedManager(node) : undefined,
      leave: current.map((raw) => ({ label: linkLabel(raw), run: () => this.confirmLeave(node, raw) })),
      open: () => this.openNote(node, "tab"),
      noteMenu: s.noteMenu
        ? {
            // Open, rename and copy path, plus the actions Obsidian and other plugins add for a note.
            add: () => this.app.workspace.handleLinkContextMenu(menu, file.path, ""),
            deleteFile: () => {
              // Obsidian's own prompt: it asks first, unless turned off, and uses the chosen trash.
              const target = this.app.vault.getFileByPath(file.path);
              if (target) void this.app.fileManager.promptForDeletion(target);
            },
          }
        : undefined,
    });
  }

  /** Choose someone to add as an extra (dotted-line) manager, then confirm. */
  private pickDottedManager(person: NotedNode): void {
    if (!this.graph) return;
    const parents = new Set(this.graph.edges.filter((e) => e.to === person.id).map((e) => e.from));
    const below = descendants(this.graph, person.id);
    const candidates = [...this.graph.nodes.values()]
      .filter(hasNote)
      .filter((n) => !n.ghost && n.id !== person.id && !parents.has(n.id) && !below.has(n.id))
      .sort((a, b) => a.title.localeCompare(b.title));
    if (!candidates.length) {
      new Notice(`No one in this view can be added as ${person.title}'s manager.`);
      return;
    }
    new PersonPickerModal(this.app, candidates, `Who else does ${person.title} report to?`, (target) => {
      const main = this.currentManager(person);
      new ConfirmModal(this.app, {
        title: "Add dotted-line manager",
        body: ["Add ", { strong: person.title }, " as also reporting to ", { strong: target.title }, "?"],
        note: main ? `${main.title} stays their main manager.` : null,
        cta: "Add",
        onConfirm: () => void this.addDottedManager(person, target),
      }).open();
    }).open();
  }

  private async addDottedManager(person: NotedNode, target: NotedNode): Promise<void> {
    const file = person.file;
    const prop = this.settings().parentProperty;
    const link = `[[${this.app.metadataCache.fileToLinktext(target.file, file.path, true)}]]`;
    const expected = this.parentValues(person, prop);
    const values = addDotted(expected, link, (raw) => this.refersTo(raw, target, file.path));
    if (!values) {
      new Notice(`${person.title} already reports to ${target.title}.`);
      return;
    }
    await this.writeParents(person, { prop, values, expected }, `${person.title} now also reports to ${target.title} (dotted line).`);
  }

  /** Same group? Compares resolved notes for links, otherwise names. */
  private sameValue(a: string, b: string, sourcePath: string): boolean {
    const mc = this.app.metadataCache;
    const da = mc.getFirstLinkpathDest(linkTarget(a), sourcePath);
    const db = mc.getFirstLinkpathDest(linkTarget(b), sourcePath);
    if (da && db) return da.path === db.path;
    return linkTarget(a).toLowerCase() === linkTarget(b).toLowerCase();
  }

  /** Remove `raw` from the current property and add it to the former property. */
  private confirmLeave(node: NotedNode, raw: string): void {
    const file = node.file;
    const s = this.settings();
    const name = linkLabel(raw);
    const currentBefore = this.values(file, s.currentProperty);
    const formerBefore = s.formerProperty ? this.values(file, s.formerProperty) : null;
    const plan = planLeave(currentBefore, formerBefore, raw, (a, b) => this.sameValue(a, b, file.path));
    const edits: PropertyEdit[] = [{ prop: s.currentProperty, values: plan.current, expected: currentBefore }];
    let note: string;
    if (!s.formerProperty) {
      note = `It will be removed from "${s.currentProperty}".`;
    } else if (plan.alreadyFormer) {
      note = `${name} is already in "${s.formerProperty}"; it will only be removed from "${s.currentProperty}".`;
    } else {
      note = `${name} will be moved from "${s.currentProperty}" to "${s.formerProperty}".`;
      if (plan.former && formerBefore) edits.push({ prop: s.formerProperty, values: plan.former, expected: formerBefore });
    }
    // Their current reports, and where they'd go: the leaver's own main manager.
    const reportPlans = this.reassignPlans(node);
    const managerName = this.currentManager(node)?.title ?? null;
    const n = reportPlans.length;
    const checkbox = n
      ? {
          label: managerName
            ? `Move their ${n} report${n === 1 ? "" : "s"} to ${managerName}`
            : `Remove ${node.title} as manager of their ${n} report${n === 1 ? "" : "s"}`,
          detail: reportPlans.map((r) => r.node.title).join(", "),
          checked: true,
        }
      : undefined;

    new ConfirmModal(this.app, {
      title: "Remove from group",
      body: ["Remove ", { strong: node.title }, " from ", { strong: name }, "?"],
      note,
      cta: "Remove",
      warning: true,
      checkbox,
      onConfirm: (move) => {
        const changes = [{ file, edits }];
        if (move) for (const r of reportPlans) changes.push({ file: r.node.file, edits: [{ prop: s.parentProperty, values: r.values, expected: r.expected }] });
        const moved = move && n ? `, ${n} report${n === 1 ? "" : "s"} ${managerName ? `moved to ${managerName}` : "unassigned"}` : "";
        void this.writeNotes(changes, node.id, `${node.title} removed from ${name}${moved}.`, `Undone: ${node.title} is back in ${name}.`);
      },
    }).open();
  }

  /** For each person listing `leaver` as a manager, their new parent values (see reassignPlans in edits.ts). */
  private reassignPlans(leaver: NotedNode): ReassignPlan[] {
    if (!this.graph) return [];
    const prop = this.settings().parentProperty;
    return reassignPlans(this.graph, leaver.id, {
      values: (report) => this.parentValues(report, prop),
      linkTo: (manager, report) => manager.file
        ? `[[${this.app.metadataCache.fileToLinktext(manager.file, report.file.path, true)}]]`
        : `[[${manager.linkTarget ?? manager.title}]]`,
      refersTo: (raw, person, report) => this.refersTo(raw, person, report.file.path),
    });
  }

  /** Centre on a node at the current zoom if it's outside the visible area. */
  private revealIfOffscreen(id: string): void {
    const p = this.layout?.nodes.get(id);
    if (!p || !this.layout) return;
    const t = this.viewport.t;
    const w = this.canvasEl.clientWidth, h = this.canvasEl.clientHeight;
    const sx = t.x + p.x * t.k, sy = t.y + p.y * t.k;
    const H = this.layout.cardH;
    if (sx >= 0 && sy >= 0 && sx + NODE_W * t.k <= w && sy + H * t.k <= h) return;
    this.viewport.set({ k: t.k, x: w / 2 - (p.x + NODE_W / 2) * t.k, y: h / 2 - (p.y + H / 2) * t.k });
  }

  /** Screen position of a node's top-left, used to keep it still across re-layouts. */
  private anchorFor(id: string) {
    const p = this.layout?.nodes.get(id);
    if (!p) return undefined;
    const t = this.viewport.t;
    return { id, sx: t.x + p.x * t.k, sy: t.y + p.y * t.k };
  }

  private toggle(id: string): void {
    const anchor = this.anchorFor(id);
    if (this.memory.collapsed.has(id)) this.memory.collapsed.delete(id);
    else this.memory.collapsed.add(id);
    this.render(undefined, anchor);
  }

  private setAllCollapsed(collapse: boolean): void {
    if (!this.graph) return;
    this.memory.collapsed = collapse ? collapseBelow(this.graph, 1) : new Set();
    this.memory.fitted = false;
    this.render();
  }

  /** Select and reveal the next person whose manager is a former member. */
  private nextStranded(): void {
    if (!this.strandedIds.length) return;
    this.strandedIndex = (this.strandedIndex + 1) % this.strandedIds.length;
    const id = this.strandedIds[this.strandedIndex];
    this.selected = id;
    this.reveal(id);
    this.select(id);
  }

  // ---- Find ----
  private clearFind(): void {
    this.find.setValue("");
    this.find.onChanged(); // updates the clear button and re-runs the search
  }

  private runFind(jump: boolean, step = 1): void {
    this.updateFindHits();
    if (!jump) {
      this.findIndex = -1;
      this.highlight();
      return;
    }
    if (!this.findHits.length) return;
    this.findIndex = (this.findIndex + step + this.findHits.length) % this.findHits.length;
    this.reveal(this.findHits[this.findIndex]);
  }

  /**
   * People matching the find box who are shown, or would be once their
   * collapsed team is expanded (not those hidden as having no links), by name.
   * Keeps the current hit if it still matches.
   */
  private updateFindHits(): void {
    const current = this.findHits[this.findIndex];
    const q = this.find.getValue().trim();
    const graph = this.graph;
    if (!graph || !q) {
      this.findHits = [];
      this.findIndex = -1;
      return;
    }
    // Obsidian's simple search: every word must appear, in any order.
    const matches = prepareSimpleSearch(q);
    const parent = primaryParents(graph);
    const reachable = (id: string) => {
      if (this.layout?.nodes.has(id)) return true;
      for (let p = parent.get(id); p !== undefined; p = parent.get(p)) if (this.memory.collapsed.has(p)) return true;
      return false;
    };
    this.findHits = [...graph.nodes.values()]
      .filter((n) => !n.ghost && reachable(n.id) && matches([n.title, ...n.fields.map((f) => f.value)].join(" ")) !== null)
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((n) => n.id);
    this.findIndex = current === undefined ? -1 : this.findHits.indexOf(current);
  }

  /** Expand any collapsed teams above the node, then centre it. */
  private reveal(id: string): void {
    const parent = this.graph ? primaryParents(this.graph) : new Map<string, string>();
    let changed = false;
    for (let p = parent.get(id); p !== undefined; p = parent.get(p)) {
      if (this.memory.collapsed.delete(p)) changed = true;
    }
    if (changed) this.render();
    const p = this.layout?.nodes.get(id);
    if (!p || !this.layout) return;
    const k = Math.max(this.viewport.t.k, 0.8);
    const w = this.canvasEl.clientWidth, h = this.canvasEl.clientHeight;
    this.viewport.set({ k, x: w / 2 - (p.x + NODE_W / 2) * k, y: h / 2 - (p.y + this.layout.cardH / 2) * k });
    this.highlight();
  }

  private highlight(): void {
    const hits = new Set(this.findHits);
    const current = this.findHits[this.findIndex];
    this.canvasEl.querySelectorAll<SVGGElement>(".org-chart-node").forEach((g) => {
      const id = g.dataset.id ?? "";
      g.toggleClass("is-match", hits.has(id));
      g.toggleClass("is-current", id === current);
    });
    this.canvasEl.toggleClass("is-finding", hits.size > 0);
  }
}

type PropKey = "parentProperty" | "nameProperty" | "colorProperty" | "imageProperty" | "currentProperty" | "formerProperty";

/** Suggests the vault's property names in a text input. */
class PropertySuggest extends AbstractInputSuggest<string> {
  constructor(app: App, private input: HTMLInputElement) {
    super(app, input);
  }

  protected getSuggestions(query: string): string[] {
    const q = query.trim().toLowerCase();
    return propertyNames(this.app)
      .filter((k) => k.toLowerCase().includes(q))
      .sort((a, b) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q)) || a.localeCompare(b));
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value);
  }

  selectSuggestion(value: string): void {
    this.setValue(value);
    this.input.dispatchEvent(new Event("input"));
    this.close();
  }
}

/**
 * Settings, declared with Obsidian's settings definitions (1.13+) so they
 * appear in Obsidian's settings search.
 */
class OrgChartSettingTab extends PluginSettingTab {
  plugin: OrgChartPlugin;

  constructor(app: App, plugin: OrgChartPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // Once editing is done (leaving the tab or closing settings), not on every
  // keystroke, so a half-typed name never gets a property type.
  hide(): void {
    super.hide();
    this.plugin.ensureListProperties();
  }

  /** A text box for a property name, with suggestions. Empty falls back to the default when `required`. */
  private prop(key: PropKey, name: string, desc: string, required = false): SettingDefinition {
    return {
      name,
      desc,
      aliases: ["property", key],
      render: (setting) => {
        setting.addText((t) => {
          t.setPlaceholder(required ? DEFAULT_SETTINGS[key] : "none")
            .setValue(this.plugin.settings[key])
            .onChange((v) => {
              const val = cleanPropertyName(v);
              this.plugin.settings[key] = val || (required ? DEFAULT_SETTINGS[key] : "");
              void this.plugin.saveSettings();
            });
          new PropertySuggest(this.app, t.inputEl);
        });
      },
    };
  }

  /** Save, then rebuild the definitions (for list changes). */
  private saveAndUpdate(): void {
    void this.plugin.saveSettings().then(() => this.update());
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const fields = this.plugin.settings.fields;
    return [
      {
        name: "Which notes appear",
        desc: "Decided by each base's own filters (Bases' Filter button). These settings say which properties to read; they're defaults for every Org Chart view, and most can be overridden per view under Configure view.",
        searchable: false,
      },
      {
        type: "group",
        heading: "Reporting lines",
        items: [
          this.prop("parentProperty", "Parent property", "Links a note to its manager. The first value is the main manager; others are dotted lines. Kept as a List property. Default: reports_to.", true),
        ],
      },
      {
        type: "group",
        heading: "Cards",
        items: [
          this.prop("nameProperty", "Name property", "Shown as the card's name. Leave empty to use the file name."),
          this.prop("colorProperty", "Colour by property", "A colour stripe per distinct value (first value if a list). Leave empty for no stripe."),
          this.prop("imageProperty", "Image property", "Link or URL to an avatar image. Leave empty to hide avatars. Default: image."),
          {
            name: "Allow remote avatar images",
            desc: "Load http(s) avatar URLs from outside the vault. Off by default because loading an image contacts its host.",
            control: { type: "toggle", key: "allowRemoteImages" },
          },
          {
            name: "Note actions on right-click",
            desc: "After the chart's own actions, a card's right-click menu shows Obsidian's usual actions for the note, as on Bases' cards: open, rename, copy path, other plugins' items, and Delete file last. Off: only the chart's actions and Open in new tab.",
            aliases: ["context menu", "menu", "delete", "rename"],
            control: { type: "toggle", key: "noteMenu" },
          },
        ],
      },
      {
        type: "list",
        heading: "Card fields",
        emptyState: "No fields: cards show the name only.",
        addItem: {
          name: `Add field (up to ${MAX_FIELDS})`,
          action: () => {
            if (fields.length >= MAX_FIELDS) {
              new Notice(`Cards can show up to ${MAX_FIELDS} fields.`);
              return;
            }
            fields.push({ property: "", show: true });
            this.saveAndUpdate();
          },
        },
        onReorder: (from, to) => {
          fields.splice(to, 0, fields.splice(from, 1)[0]);
          this.saveAndUpdate();
        },
        onDelete: (index) => {
          fields.splice(index, 1);
          this.saveAndUpdate();
        },
        items: fields.map((field, i) => ({
          name: field.property || `Field ${i + 1}`,
          desc: "Shown on the card when on; hover tooltip only when off.",
          aliases: ["card field", "subtitle", "tooltip"],
          render: (setting) => {
            setting.setClass("org-chart-field-row");
            setting.addText((t) => {
              t.setPlaceholder("Property name")
                .setValue(field.property)
                .onChange((v) => {
                  field.property = cleanPropertyName(v);
                  void this.plugin.saveSettings();
                });
              t.inputEl.setAttribute("aria-label", `Field ${i + 1} property`);
              new PropertySuggest(this.app, t.inputEl);
            });
            setting.addToggle((t) =>
              t
                .setTooltip("Show on card (off: tooltip only)")
                .setValue(field.show)
                .onChange((v) => {
                  field.show = v;
                  void this.plugin.saveSettings();
                })
            );
          },
        })),
      },
      {
        type: "group",
        heading: "Groups and teams",
        items: [
          this.prop("currentProperty", "Current membership property", "Groups a person currently belongs to (e.g. an organisation). Enables right-click \"Remove from …\". Kept as a List property."),
          this.prop("formerProperty", "Former members property", "Where groups a person has left are recorded; used with a view's \"…contains\" value to mark former members. Kept as a List property."),
        ],
      },
      {
        type: "group",
        heading: "Layout",
        items: [
          {
            name: "Large chart warning threshold",
            desc: "Pause before rendering more than this many people. Set to 0 to disable the warning.",
            control: { type: "slider", key: "largeChartWarningThreshold", min: 0, max: MAX_WARNING_THRESHOLD, step: 100 },
          },
          {
            name: "Layout direction",
            desc: "Default direction for new views; each view can override it.",
            control: { type: "dropdown", key: "direction", options: { TB: "Top to bottom", LR: "Left to right" } },
          },
          {
            name: "Restore views when switching back",
            desc: "When you switch back to an Org Chart view in a base, show it with the zoom and collapsed teams it had, instead of re-centred.",
            aliases: ["zoom", "remember", "collapse"],
            control: { type: "toggle", key: "restoreViews" },
          },
        ],
      },
    ];
  }

  // Controls read plugin.settings through PluginSettingTab's default getControlValue.
  async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.settings;
    if (key === "direction" && (value === "TB" || value === "LR")) settings.direction = value;
    if (key === "allowRemoteImages" && typeof value === "boolean") settings.allowRemoteImages = value;
    if (key === "noteMenu" && typeof value === "boolean") settings.noteMenu = value;
    if (key === "restoreViews" && typeof value === "boolean") settings.restoreViews = value;
    if (key === "largeChartWarningThreshold") settings.largeChartWarningThreshold = warningThreshold(value);
    await this.plugin.saveSettings();
  }
}

export default class OrgChartPlugin extends Plugin {
  settings: OrgChartSettings;
  /** Redraws open charts once typing in a settings box pauses, not on every keystroke. */
  private notifySettingsChanged = debounce(() => settingsEvents.trigger(SETTINGS_CHANGED), 300, true);

  async onload(): Promise<void> {
    await this.loadSettings();
    this.register(() => this.notifySettingsChanged.cancel());
    this.registerBasesView(VIEW_TYPE, {
      name: "Org Chart",
      icon: "git-fork",
      factory: (controller, containerEl) =>
        new OrgChartView(controller, containerEl, () => this.settings),
      options: () => viewOptions(this.settings),
    });
    this.registerHoverLinkSource(VIEW_TYPE, { display: "Org Chart", defaultMod: true });
    this.addSettingTab(new OrgChartSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => this.ensureListProperties());
  }

  /**
   * The parent, current membership and former members properties hold lists
   * (a main manager and dotted lines; groups), so give them Obsidian's List
   * type: the Properties view then shows and edits them as lists.
   */
  ensureListProperties(): void {
    const s = this.settings;
    ensureListTypes(this.app, [s.parentProperty, s.currentProperty, s.formerProperty]);
  }

  async loadSettings(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData() as unknown);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.notifySettingsChanged();
  }
}
