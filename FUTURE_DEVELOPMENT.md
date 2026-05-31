# Future Development Notes

## Drag And Drop Research

The `benji300/joplin-favorites`, `benji300/joplin-note-tabs`, `joplin/plugin-yesyoukan`, and Joplin desktop source are useful references for drag and drop with plugin panels and native note targets.

Findings:

- Favorites uses plain HTML5 drag/drop events inside its panel webview.
- Native Joplin note drags use a JSON array of note IDs on:
  - `text/x-jop-note-ids`
- Joplin's native sidebar notebook tree accepts `text/x-jop-note-ids` drops and delegates the move to Joplin's native folder-drop logic.
- Note Tabs and YesYouKan confirm plugin webviews can read native `text/x-jop-note-ids` payloads on drop, which makes the MIME type a stable integration point.
- The lowest-brittleness implementation is for Sub-Pages rows to create the same payload on `dragstart` and let the native notebook sidebar perform the folder move.
- Sub-Pages still needs a reconciliation step after the native move: if a dragged branch root changes notebooks, remove only that root's old Sub-Pages parent link. Descendants should keep their internal links and move with the branch.

Implemented direction:

1. Make current-notebook Sub-Pages rows HTML5 draggable.
2. Set `text/x-jop-note-ids` to the dragged note IDs, including descendants for Sub-Pages branches.
3. Track pending drag roots in the plugin backend.
4. Reconcile parent metadata when Joplin note-change events show a dragged root moved notebooks.
5. Keep custom notebook drop zones out of scope unless native sidebar drops prove impossible in live UAT.

Open questions:

- What exact payloads does current Joplin desktop provide across supported versions?
- Can a plugin-created drag payload be dropped onto Joplin's native notebook sidebar on every supported desktop platform?
- Should a future version also accept native notes dropped into the Sub-Pages panel to attach them under a page?
- How should the UI prevent accidental hierarchy changes if in-panel attach drops are added later?

## Interaction Follow-Ups

- Continue testing double-click behavior across title text, row whitespace, and search-highlighted titles.
- Confirm Delete/Backspace behavior matches Joplin expectations on Windows, macOS, and Linux.
- Consider a confirmation preference for multi-note deletes if Joplin's native command does not already provide enough friction.
