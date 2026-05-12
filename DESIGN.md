# Sub-Pages Panel Design Notes

## Data Model

Hierarchy state is stored with Joplin's synced `userData` API:

- `subPages.parentId`: stored on a child note and points to its parent note.
- `subPages.childIds`: stored on a parent note and preserves child order.

Notes are the only tree nodes. A note can contain content and any number of child notes, including descendants at arbitrary depth. Cross-notebook parent relationships are not supported in v1.

The plugin does not generate extra notes or sidecar files. A note only gets Sub-Pages user data when it is part of a hierarchy relationship: children store `subPages.parentId`, and parents with ordered direct children store `subPages.childIds`.

## Rendering

The plugin renders a custom `joplin.views.panels` webview. The panel is scoped to the currently selected notebook and keeps hierarchy independent from Joplin's native note-list sorting.

The panel row menu is also rendered inside this webview. Joplin's desktop note-list context menu is built by the native React/Electron note-list component and is not exposed to plugin webviews as an enumerable or reusable menu. For that reason, the panel menu delegates a curated set of common note-list actions to known Joplin commands, but it does not automatically inherit context-menu entries registered by other plugins. Third-party plugin menu items continue to work in Joplin's native note list, and Sub-Pages registers its own native note-list context-menu actions there. The panel includes a command palette bridge that first selects the target note, then opens Joplin's command palette so native and plugin commands can still be reached without cloning every context-menu item.

Panel search uses Joplin's own search endpoint rather than a local title-only filter. Search can be scoped to the selected notebook or all notebooks. Results from the current notebook are shown in the hierarchy, while matches from other notebooks are shown as a separate flat section that opens the native note when selected.

Panel search keeps the last completed result set visible while a new query is debounced. This avoids replacing the whole tree on every keystroke; the panel only re-renders the result list when Joplin returns the next search response.

Native note-list drag/drop and the native search box are not exposed as movable webview components. For simple note moves, the panel delegates to Joplin's `moveToFolder` command. For hierarchy-aware moves, Sub-Pages uses Joplin's data API to update the selected branch notes' notebook IDs and clears only the moved branch root's old parent link. This keeps descendants in the same notebook as their parent without trying to emulate native drag/drop internals.

The panel supports local multi-selection with Ctrl-click and Shift-click. That selection is passed to native list-style commands where possible, and to Sub-Pages branch commands when hierarchy metadata needs to be preserved.

Collapse state is local panel state. It is not stored in synced note metadata.

Tree refreshes are intentionally coarse-grained. Startup, explicit refresh, settings changes, and Sub-Pages write commands rebuild the tree. Note selection changes only update the highlight, and sync completion does not trigger a full tree rebuild.

## Ordering

The native `note.order` field is not rewritten. Panel sibling ordering is computed in memory from the selected sort mode:

- `recentGroups`: siblings sort by the newest update time in their descendant group.
- `manual`: siblings sort by the parent note's `subPages.childIds`.
- `title`: siblings sort by title.

Parents always render above descendants.

## Cleanup

The plugin does not automatically repair metadata on startup or sync completion. The manual repair command:

- prunes missing children from parent lists
- promotes orphaned children when their parent is gone
- repairs cross-notebook parent references
- breaks circular parent chains by promoting affected notes to the root

Repair is idempotent: it reads existing user data first and only writes or deletes stale metadata.
