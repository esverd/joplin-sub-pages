# Joplin Sub-Pages

Sub-Pages adds a hierarchical page tree panel to Joplin. The panel follows the active notebook or Joplin's **All Notes** view, while the native note list remains free to use its normal sorting.

## Features

- A dedicated **Sub-Pages** panel shows a collapsible page tree for the current notebook.
- Selecting **All Notes** shows one combined forest containing pages from every notebook. Root rows identify their notebook; relationships never cross notebook boundaries.
- Notes and Joplin whiteboards can have children and descendants without changing the native note list order.
- The default panel sort is **Recent groups**, which uses a page's own update time plus descendant updates so recently edited child pages lift their parent group.
- Panel search combines Joplin keyword results with semantic results when Joplin's AI index is available. It falls back to keyword results when semantic search is disabled, unavailable, preparing, or fails.
- In a notebook view, search can target that notebook or all notebooks, with external notebook matches shown separately. In **All Notes**, search always covers all notes.
- Search reveals matching pages and their ancestor rows even when those ancestors are collapsed. Clearing search restores the saved collapse state.
- Panel actions:
  - Create root page
  - Create root whiteboard
  - Create child page
  - Create child whiteboard
  - Move page under another page
  - Promote page to root
  - Unlink page from its parent and direct children
  - Move siblings up/down in manual sort mode
  - Repair stale metadata on demand
  - Save a note as a local `.md` file
- Hierarchy metadata is stored with synced Joplin note user data.
- The panel row menu mirrors common native note-list actions, including open, tags, to-do conversion, move, duplicate, delete, copy links, note properties, and a command palette bridge, alongside Sub-Pages hierarchy actions.
- Double-clicking a panel row opens the note in a new window.
- Ctrl-click and Shift-click select multiple panel rows. Multi-selection is used by panel actions such as moving several notes or branches to a notebook.
- Drag a Sub-Pages row onto another row to make it a child, onto the blank root drop area to promote a child to root, or onto Joplin's native notebook sidebar to move that page or branch to another notebook.
- **Move branch to notebook...** moves selected pages and their Sub-Pages descendants together so parent/child links stay valid after a cross-notebook move.

Root creation from **All Notes** prompts for the destination notebook. Child pages and child whiteboards are created in their parent's notebook.

Semantic search uses the index managed by Joplin. The panel reports when that index is building or unavailable; no semantic-search setup or model data is stored by this plugin.

## Setup in Joplin

1. Open Joplin Desktop and go to **Tools > Options > Plugins**.
2. Use the gear menu and choose **Install from file**, then select the checked-in `publish/net.sverd.subPages.jpl` archive.
3. Restart Joplin.
4. Open the panel with **View > Toggle Sub-Pages panel** or the Sub-Pages toolbar button.

The validated development build (`dist/`) and installable package (`publish/net.sverd.subPages.jpl`) are versioned in this repository, so installing the checked-in archive does not require a build. To build from source, run `npm run dist`. On a computer already configured to load this repository's `dist/` directory as a Joplin development plugin, `git pull` followed by a Joplin restart loads the current build. A plugin installed from the `.jpl` is copied into Joplin's plugin directory, so reinstall it from the updated file after pulling.

The plugin ID changed from `com.codex.subPages` to `net.sverd.subPages`. Joplin treats this as a new plugin: uninstall the old Sub-Pages entry before enabling this one. Hierarchy links are stored on notes and remain intact; plugin settings do not automatically transfer.

## Appearance settings

In **Tools > Options > Sub-Pages**, you can set the note-title text size (10-24 px), spacing between note rows (0-16 px), vertical padding within note cards (0-12 px), text inset within each note card (0-24 px), and card indentation per hierarchy level (0-40 px). These settings apply immediately to normal panel rows and search results.

## Important Limitations

Joplin's public plugin API does not let plugins fully replace the native note list, hide arbitrary native rows, or receive native note-list drag/drop events.

Because of that, this plugin uses these v1 behaviors:

- The panel is the authoritative hierarchy UI; the native note list remains unchanged.
- The custom panel supports hierarchy drag/drop within the panel and native note-drag payloads from the panel to Joplin's notebook sidebar. Dragging from Joplin's native note list into Sub-Pages to create hierarchy links is not implemented.
- Collapse state is remembered between Joplin launches in local plugin settings and does not sync to other devices.
- Parent and child links are notebook-local. **All Notes** combines each notebook's hierarchy into one display but does not permit cross-notebook parent links.
- Mobile clients without the plugin still show ordinary Joplin notes. The hierarchy is invisible but harmless.
- The plugin does not rewrite `note.order`.
- The panel row menu is a custom webview menu, not Joplin's native note-list context menu. Other plugins can still add entries to Joplin's native note-list context menu, and Sub-Pages adds its own native context-menu entries there, but third-party plugin commands do not automatically appear inside the Sub-Pages panel menu. Use **Command palette...** from a panel row to select the note and open Joplin's command palette for native and plugin commands.
- Joplin 3.7.9 does not expose the active **All Notes**/notebook note-list parent through its public plugin API. Sub-Pages isolates a version-specific adapter for this state and shows a compatibility warning if it cannot mirror the current Joplin view.

## Privacy

Sub-Pages runs inside Joplin and reads note IDs, titles, notebook membership, timestamps, to-do state, and Sub-Pages hierarchy metadata through Joplin's plugin APIs to build and sort the panel. Keyword searches use Joplin's data API. When Joplin reports its AI index as ready or indexing, Sub-Pages also submits the search query and selected scope to Joplin's AI search API; AI processing follows your Joplin AI configuration.

The plugin may read candidate note bodies to validate JSONCanvas whiteboards; an explicit Markdown export reads the selected note body and writes it to the local file path you choose. Linking pages writes the synced Sub-Pages hierarchy metadata described below. Other note changes happen when you use actions such as creating or moving notes. The plugin code makes no direct HTTP requests, and note content is not included in the plugin package.

## Sync Behavior

The plugin does not create index notes, sidecar files, or per-note metadata for every note in a notebook. It only writes synced `userData` when a note is actually linked into the Sub-Pages hierarchy:

- Child note: `subPages.parentId`
- Parent note with ordered children: `subPages.childIds`

Refreshing the panel is read-only. Repair reads the current notebook, or every notebook in **All Notes**, but only writes when existing Sub-Pages metadata is stale or inconsistent.

Whiteboards remain ordinary Joplin notes whose bodies contain Joplin's fenced `jsoncanvas` data. Sub-Pages only adds the same hierarchy `userData` used for regular notes.

The panel debounces tree refreshes after note edits and sync completion. Use **Refresh Sub-Pages panel** when you want to manually reload the tree from Joplin.

## Development

```bash
cd joplin-sub-pages
npm install
npm run dist
```

The built plugin is written to `publish/net.sverd.subPages.jpl`.

For local testing in Joplin Desktop, add this repository's `dist/` directory to **Options -> Plugins -> Development plugins** and restart Joplin.

## Requirements

- Joplin Desktop 3.7.9 or later.
