# Sub-Pages Panel Design Notes

## Data Model

Hierarchy state is stored with Joplin's synced `userData` API:

- `subPages.parentId`: stored on a child note and points to its parent note.
- `subPages.childIds`: stored on a parent note and preserves child order.

Notes are the only tree nodes. A note can contain content and any number of child notes, including descendants at arbitrary depth. Cross-notebook parent relationships are not supported in v1.

The plugin does not generate extra notes or sidecar files. A note only gets Sub-Pages user data when it is part of a hierarchy relationship: children store `subPages.parentId`, and parents with ordered direct children store `subPages.childIds`.

## Rendering

The plugin renders a custom `joplin.views.panels` webview. The panel is scoped to the currently selected notebook and keeps hierarchy independent from Joplin's native note-list sorting.

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
