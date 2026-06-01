# Future Development Notes

## Drag And Drop Follow-Ups

Implemented drag/drop behavior is documented in `DESIGN.md`.

- Test plugin-created `text/x-jop-note-ids` drops on macOS and Linux, not just Windows.
- Confirm the payload shape remains stable across future Joplin desktop releases.
- Consider accepting native Joplin notes dropped into the Sub-Pages panel to attach them under a page.
- Decide how the UI should prevent accidental hierarchy changes if in-panel attach drops are added later.

## Interaction Follow-Ups

- Continue testing double-click behavior across title text, row whitespace, and search-highlighted titles.
- Confirm Delete/Backspace behavior matches Joplin expectations on Windows, macOS, and Linux.
- Consider a confirmation preference for multi-note deletes if Joplin's native command does not already provide enough friction.
