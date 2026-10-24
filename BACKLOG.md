# Backlog

Ideas not yet built, roughly in priority order.

- [ ] **Team markers**: coloured pills per team on each card; hover or click a team to highlight its members.
- [ ] **Focus mode**: right-click "Focus on this person" to show only their chain of managers and their own team.
- [ ] **Team size**: show direct and total reports on the manager pill (e.g. "3 · 14").
- [ ] **Export**: save the chart as SVG (then PNG) for documents and slides.
- [ ] **Colour from notes**: take a card's stripe colour from a colour property on the linked note (e.g. the company note), falling back to the calculated colour.
- [ ] **Add people from the chart**: right-click "Add report…" and "Create note" on placeholders, with configurable folder and template.
- [ ] **Data-quality panel**: list people with no manager, a missing or departed manager, or a circular link, and jump to each.
- [ ] **Keyboard navigation**: arrow keys move between manager, reports and peers; Enter opens; menu key opens the card menu.
- [ ] **Mobile support**: the plugin is desktop-only for now (`isDesktopOnly: true`). To support phones and tablets: two-finger pinch to zoom (touch screens send separate pointers, not the Ctrl+wheel a trackpad pinch produces), a second finger cancelling a card drag, a touch lock that makes dragging always pan, and long-press for the card menu. Test on real devices before turning `isDesktopOnly` off.
- [ ] **Read properties through Bases values**: once Obsidian makes a link value's resolved file and display text public API. See "Decisions" in CONTRIBUTING.md.
