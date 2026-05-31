# Future Development Notes

## Drag And Drop Research

The `benji300/joplin-favorites` plugin is a useful reference for drag and drop into a Joplin plugin panel.

Findings:

- Favorites uses plain HTML5 drag/drop events inside its panel webview.
- Native Joplin drag payloads can be read from the webview drop event:
  - `text/x-jop-note-ids`
  - `text/x-jop-folder-ids`
- This suggests Sub-Pages can likely accept notes dragged from Joplin's native note list into the Sub-Pages panel.
- This does not prove that dragging from the Sub-Pages panel into Joplin's native notebook sidebar is feasible. That would require the native sidebar to accept plugin-created drag payloads, and the public plugin API does not appear to expose native sidebar drop targets.

Potential first implementation:

1. Make Sub-Pages rows and/or notebook drop zones use HTML5 drag/drop.
2. Accept `text/x-jop-note-ids` drops in the panel.
3. On drop onto a page row, attach the dropped note as a child of that page.
4. On drop onto an in-panel notebook target, call the existing branch-aware notebook move logic.
5. Keep native sidebar drag/drop out of scope until verified in a Joplin runtime.

Open questions:

- What exact payloads does current Joplin desktop provide across supported versions?
- Can a plugin-created drag payload be dropped onto Joplin's native notebook sidebar?
- Should drag/drop attach individual notes, full selected branches, or prompt when multiple notes are dropped?
- How should the UI prevent accidental hierarchy changes?

## Interaction Follow-Ups

- Continue testing double-click behavior across title text, row whitespace, and search-highlighted titles.
- Confirm Delete/Backspace behavior matches Joplin expectations on Windows, macOS, and Linux.
- Consider a confirmation preference for multi-note deletes if Joplin's native command does not already provide enough friction.
