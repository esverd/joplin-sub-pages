# Joplin Sub-Pages

Sub-Pages adds a notebook-scoped page tree panel to Joplin. Notes can contain child notes at any depth, while the native Joplin note list remains free to use its normal sorting.

## Features

- A dedicated **Sub-Pages** panel shows a collapsible note tree for the current notebook.
- Notes can have children and descendants without changing the native note list order.
- The default panel sort is **Recent groups**, which uses a page's own update time plus direct child updates so recently edited child pages lift their immediate parent group.
- Panel search delegates to Joplin search, so title and note-body matches in the current notebook can surface matching branches.
- Panel actions:
  - Create root page
  - Create child page
  - Move page under another page
  - Promote page to root
  - Unlink page from its parent and direct children
  - Move siblings up/down in manual sort mode
  - Repair stale metadata on demand
- Hierarchy metadata is stored with synced Joplin note user data.
- The panel row menu mirrors common native note-list actions, including open, tags, to-do conversion, move, duplicate, delete, copy links, and note properties, alongside Sub-Pages hierarchy actions.

## Setup in Joplin

1. Build the plugin with `npm run dist`.
2. Open Joplin Desktop and go to **Tools > Options > Plugins**.
3. Use the gear menu and choose **Install from file**, then select `publish/com.codex.subPages.jpl`.
4. Restart Joplin.
5. Open the panel with **View > Toggle Sub-Pages panel** or the Sub-Pages toolbar button.

Plugin settings are available under **Tools > Options > Sub-Pages**.

## Important Limitations

Joplin's public plugin API does not let plugins fully replace the native note list, hide arbitrary native rows, or receive native note-list drag/drop events.

Because of that, this plugin uses these v1 behaviors:

- The panel is the authoritative hierarchy UI; the native note list remains unchanged.
- Drag/drop is deferred; use panel buttons and note context menu commands.
- Collapse state is local to the panel and does not sync.
- Mobile clients without the plugin still show ordinary Joplin notes. The hierarchy is invisible but harmless.
- The plugin does not rewrite `note.order`.
- The panel row menu is a custom webview menu, not Joplin's native note-list context menu. Other plugins can still add entries to Joplin's native note-list context menu, and Sub-Pages adds its own native context-menu entries there, but third-party plugin commands do not automatically appear inside the Sub-Pages panel menu unless explicit support is added for known commands.

## Sync Behavior

The plugin does not create index notes, sidecar files, or per-note metadata for every note in a notebook. It only writes synced `userData` when a note is actually linked into the Sub-Pages hierarchy:

- Child note: `subPages.parentId`
- Parent note with ordered children: `subPages.childIds`

Refreshing the panel is read-only. Repair reads all notes in the selected notebook, but only writes when existing Sub-Pages metadata is stale or inconsistent.

The panel debounces tree refreshes after note edits and sync completion. Use **Refresh Sub-Pages panel** when you want to manually reload the tree from Joplin.

## Development

```bash
cd joplin-sub-pages
npm install
npm run dist
```

The built plugin is written to `publish/com.codex.subPages.jpl`.

For local testing in Joplin Desktop, add this directory to **Options -> Plugins -> Development plugins** and restart Joplin.

## Requirements

- Joplin Desktop 3.3 or later.
