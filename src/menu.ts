/*
 * A card's right-click menu, written against the small part of Obsidian's
 * Menu API it uses, so it can be tested without Obsidian.
 */

/** The parts of Obsidian's MenuItem used here. */
export interface MenuItemLike {
  setSection(section: string): this;
  setTitle(title: string): this;
  setIcon(icon: string): this;
  setWarning(warning: boolean): this;
  onClick(callback: () => unknown): this;
}

/** The parts of Obsidian's Menu used here. */
export interface MenuLike {
  addItem(cb: (item: MenuItemLike) => unknown): unknown;
  addSeparator(): unknown;
}

/** Section of the chart's own items. Obsidian lists sections in the order they first appear, so these come first. */
export const MENU_SECTION = "org-chart";

export interface CardMenuActions {
  /** Add a dotted-line manager; offered only to someone with a main manager. */
  addDotted?: () => void;
  /** "Remove from …", one per value of the current membership property. */
  leave: { label: string; run: () => void }[];
  /** Open in a new tab; used when the note's own menu is off. */
  open: () => void;
  /**
   * With "Note actions on right-click": `add` puts Obsidian's usual menu for
   * the note in (workspace.handleLinkContextMenu), and `deleteFile` ends it.
   */
  noteMenu?: { add: () => void; deleteFile: () => void };
}

/** The chart's actions first, then either Open in new tab or the note's own menu with Delete file last. */
export function fillCardMenu(menu: MenuLike, actions: CardMenuActions): void {
  const { addDotted, noteMenu } = actions;
  if (addDotted) {
    menu.addItem((i) => i.setSection(MENU_SECTION).setTitle("Add dotted-line manager…").setIcon("git-branch-plus").onClick(addDotted));
  }
  for (const leave of actions.leave) {
    menu.addItem((i) => i.setSection(MENU_SECTION).setTitle(`Remove from ${leave.label}`).setIcon("user-minus").onClick(leave.run));
  }
  if (!noteMenu) {
    menu.addItem((i) => i.setSection("open").setTitle("Open in new tab").setIcon("file-plus").onClick(actions.open));
    return;
  }
  noteMenu.add();
  // Items without a section are listed after all the others, so Delete ends the menu.
  menu.addSeparator();
  menu.addItem((i) => i.setTitle("Delete file").setIcon("trash-2").setWarning(true).onClick(noteMenu.deleteFile));
}
