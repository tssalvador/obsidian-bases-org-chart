import type { EditableField } from "./inline-edit";

/*
 * The panel for editing a card in place: one text box per editable
 * property, placed over the card. Enter saves, Escape cancels, and moving
 * focus out of the panel saves. The chart decides what to do with the text.
 */

export interface CardEditorOptions {
  /** The person's name, for the panel's accessible label. */
  title: string;
  /** The note's file name (without extension): what the card shows when the name property is empty. */
  fileName: string;
  fields: EditableField[];
  /** Called once, with the text in each box by property, when the panel saves. */
  onSave(typed: Map<string, string>): void;
  /** The file name was clicked: open the note (after saving). */
  onOpen(evt: MouseEvent): void;
  /** Called once when the panel closes, saved or not. */
  onClose(): void;
}

const MIN_WIDTH = 240;

export class CardEditor {
  readonly el: HTMLElement;
  private inputs = new Map<string, HTMLInputElement>();
  private closed = false;

  constructor(private host: HTMLElement, private opts: CardEditorOptions) {
    this.el = host.createDiv({ cls: "org-chart-editor", attr: { role: "group", "aria-label": `Edit ${opts.title}`, tabindex: "-1" } });
    // The note being edited, so it's clear which file a name falls back to.
    // Clicking it saves what's typed and opens the note.
    const file = this.el.createEl("a", {
      cls: "org-chart-editor-file",
      text: opts.fileName,
      href: "#",
      attr: { "aria-label": `Save and open ${opts.fileName}` },
    });
    file.addEventListener("click", (e) => {
      e.preventDefault();
      this.close(true);
      opts.onOpen(e);
    });
    for (const f of opts.fields) {
      const row = this.el.createEl("label", { cls: "org-chart-editor-row" });
      row.createSpan({ cls: "org-chart-editor-label", text: f.name ? `${f.property} (name)` : f.property });
      const input = row.createEl("input", {
        cls: f.name ? "org-chart-editor-input is-name" : "org-chart-editor-input",
        // An empty name falls back to the file name, so that's what the box suggests.
        attr: { type: "text", spellcheck: "false", placeholder: f.name ? opts.fileName : f.property },
      });
      input.value = f.value;
      this.inputs.set(f.property, input);
      if (f.name) row.createSpan({ cls: "org-chart-editor-note", text: "Leave empty to use the file name" });
    }
    this.el.createDiv({ cls: "org-chart-editor-hint", text: "Enter to save · Esc to cancel" });

    // The chart underneath pans, zooms, drags and handles keys; none of that
    // applies while typing here.
    for (const type of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu", "wheel"] as const) {
      this.el.addEventListener(type, (e) => e.stopPropagation());
    }
    // Pressing on a label, the hint or the padding would otherwise move focus
    // out of the panel (and so save and close it) before the click lands.
    // The box keeps focus; clicking a label still moves to its box on click.
    this.el.addEventListener("mousedown", (e) => {
      if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
    });
    this.el.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.isComposing) return;
      // Enter on the file name follows the link (save and open) rather than just saving.
      if (e.key === "Enter" && e.target instanceof HTMLAnchorElement) return;
      if (e.key === "Enter") {
        e.preventDefault();
        this.close(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close(false);
      }
    });
    // Leaving the panel (clicking elsewhere, Tab past the last box) saves, as Obsidian's property editor does.
    this.el.addEventListener("focusout", (e) => {
      const next = e.relatedTarget as Node | null;
      if (next && this.el.contains(next)) return;
      this.el.win.setTimeout(() => {
        if (!this.el.contains(this.el.doc.activeElement)) this.close(true);
      }, 0);
    });
  }

  /** Focus the first box, with its text selected. */
  focus(): void {
    const first: HTMLInputElement | undefined = [...this.inputs.values()][0];
    first?.focus();
    first?.select();
  }

  /** Place the panel over `card` (screen rectangle), kept inside the host. */
  place(card: DOMRect): void {
    const host = this.host.getBoundingClientRect();
    const width = Math.max(MIN_WIDTH, card.width);
    let left = card.left - host.left;
    let top = card.top - host.top;
    left = Math.max(4, Math.min(left, host.width - width - 4));
    top = Math.max(4, Math.min(top, host.height - this.el.offsetHeight - 4));
    this.el.setCssStyles({ left: `${left}px`, top: `${top}px`, width: `${width}px` });
  }

  /** Close the panel, saving the text unless `save` is false. Safe to call more than once. */
  close(save: boolean): void {
    if (this.closed) return;
    this.closed = true;
    const typed = new Map([...this.inputs].map(([p, input]) => [p, input.value]));
    this.el.remove();
    if (save) this.opts.onSave(typed);
    this.opts.onClose();
  }

  get isOpen(): boolean {
    return !this.closed;
  }
}
