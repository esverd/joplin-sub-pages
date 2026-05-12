import joplin from 'api';
import {
  MenuItemLocation,
  ModelType,
  SettingItemType,
  ToastType,
  ToolbarButtonLocation,
} from 'api/types';

const COMMAND_TOGGLE_PANEL = 'subPages.togglePanel';
const COMMAND_REFRESH_PANEL = 'subPages.refreshPanel';
const COMMAND_CREATE_CHILD_PAGE = 'subPages.createChildPage';
const COMMAND_MOVE_PAGE = 'subPages.movePage';
const COMMAND_PROMOTE_PAGE = 'subPages.promotePage';
const COMMAND_UNLINK_PAGE = 'subPages.unlinkPage';
const COMMAND_REPAIR_METADATA = 'subPages.repairMetadata';

const NOTE_LIST_PARITY_COMMANDS = new Set([
  'openNoteInNewWindow',
  'startExternalEditing',
  'setTags',
  'toggleNoteType',
  'moveToFolder',
  'duplicateNote',
  'deleteNote',
  'showNoteProperties',
]);

const PLUGIN_ID = 'com.codex.subPages';
const PANEL_ID = `${PLUGIN_ID}.panel`;
const DIALOG_MOVE_PARENT = 'subPages.moveParentDialog';

const SETTINGS_SECTION = 'subPages';
const SETTING_PANEL_SORT_MODE = 'subPages.panelSortMode';

const PARENT_ID_KEY = 'subPages.parentId';
const CHILD_IDS_KEY = 'subPages.childIds';

const DEFAULT_ROOT_TITLE = 'Untitled page';
const DEFAULT_CHILD_TITLE = 'Untitled sub-page';
const RECENT_CHANGE_TIME_TTL = 10 * 60 * 1000;
const SETTLED_REFRESH_DELAYS = [1500, 4000];

type PanelSortMode = 'recentGroups' | 'manual' | 'title';
type SearchScope = 'all' | 'notebook';

interface FolderSummary {
  id: string;
  title: string;
}

interface NoteSummary {
  id: string;
  title: string;
  parent_id: string;
  user_updated_time: number;
  updated_time: number;
  is_todo: number;
  todo_completed: number;
  user_data: unknown;
}

interface SearchExternalResult {
  id: string;
  title: string;
  parentId: string;
  notebookTitle: string;
  isTodo: boolean;
  todoCompleted: boolean;
  updatedTime: number;
}

interface HierarchyMeta {
  parentId: string | null;
  childIds: string[];
}

interface TreeNode {
  id: string;
  title: string;
  parentId: string | null;
  updatedTime: number;
  effectiveTime: number;
  isTodo: boolean;
  todoCompleted: boolean;
  repairReason: string | null;
  canMoveUp: boolean;
  canMoveDown: boolean;
  children: TreeNode[];
}

interface TreeBuildResult {
  roots: TreeNode[];
  repairCount: number;
  metadataItemCount: number;
}

interface MoveParentCandidate {
  note: NoteSummary;
  path: string[];
}

interface RepairOperation {
  type: 'clearParentId' | 'setChildIds' | 'clearChildIds';
  noteId: string;
  childIds?: string[];
}

interface PageResponse<T> {
  items?: T[];
  has_more?: boolean;
}

let panelHandle: string | null = null;
let panelReady = false;
let refreshTimer: any = null;
let selectionRefreshTimer: any = null;
let selectionPollTimer: any = null;
let pendingSelectedNoteId: string | null | undefined = undefined;
let knownSelectedNoteId: string | null = null;
let hasKnownSelectedNoteId = false;
let lastPostedSelectedNoteId: string | null = null;
let hasPostedSelectedNoteId = false;
let settledRefreshTimers: any[] = [];
let panelStateRevision = 0;
let lastPanelFolderId: string | null | undefined = undefined;
const recentChangeTimes = new Map<string, number>();

joplin.plugins.register({
  onStart: async () => {
    await registerSettings();
    await registerCommands();
    await registerMenus();
    await registerPanel();
    await registerRefreshEvents();
    await refreshPanel(true);
  },
});

async function registerSettings(): Promise<void> {
  await joplin.settings.registerSection(SETTINGS_SECTION, {
    label: 'Sub-Pages',
    description: 'Settings for the Sub-Pages tree panel.',
  });

  await joplin.settings.registerSettings({
    [SETTING_PANEL_SORT_MODE]: {
      value: 'recentGroups',
      type: SettingItemType.String,
      section: SETTINGS_SECTION,
      public: true,
      label: 'Panel sort mode',
      description: 'Controls sibling ordering in the Sub-Pages panel. Recent groups uses each page update time plus direct child updates.',
      isEnum: true,
      options: {
        recentGroups: 'Recent groups',
        manual: 'Manual',
        title: 'Title',
      },
    },
  });
}

async function registerCommands(): Promise<void> {
  await joplin.commands.register({
    name: COMMAND_TOGGLE_PANEL,
    label: 'Toggle Sub-Pages panel',
    iconName: 'fas fa-sitemap',
    execute: async () => {
      await runCommand(async () => {
        if (!panelHandle) return;
        const visible = await joplin.views.panels.visible(panelHandle);
        await joplin.views.panels.show(panelHandle, !visible);
        if (!visible) await refreshPanel(true);
      });
    },
  });

  await joplin.commands.register({
    name: COMMAND_REFRESH_PANEL,
    label: 'Refresh Sub-Pages panel',
    iconName: 'fas fa-sync',
    execute: async () => {
      await runCommand(async () => {
        await refreshPanel(true);
      });
    },
  });

  await joplin.commands.register({
    name: COMMAND_CREATE_CHILD_PAGE,
    label: 'Create child page',
    iconName: 'fas fa-plus',
    execute: async (...args: any[]) => {
      await runCommand(async () => {
        const note = await resolveContextNote(args);
        if (!note) {
          await notify('Select a note before creating a child page.');
          return;
        }
        await createChildPage(note.id);
        markPanelStateChanged();
        await refreshPanel(true);
      });
    },
  });

  await joplin.commands.register({
    name: COMMAND_MOVE_PAGE,
    label: 'Move page in Sub-Pages...',
    iconName: 'fas fa-level-down-alt',
    execute: async (...args: any[]) => {
      await runCommand(async () => {
        const note = await resolveContextNote(args);
        if (!note) {
          await notify('Select a note to move.');
          return;
        }
        await movePageWithDialog(note.id);
        markPanelStateChanged();
        await refreshPanel(true);
      });
    },
  });

  await joplin.commands.register({
    name: COMMAND_PROMOTE_PAGE,
    label: 'Promote page to Sub-Pages root',
    iconName: 'fas fa-level-up-alt',
    execute: async (...args: any[]) => {
      await runCommand(async () => {
        const note = await resolveContextNote(args);
        if (!note) {
          await notify('Select a page to promote.');
          return;
        }
        await promotePageToRoot(note.id);
        markPanelStateChanged();
        await refreshPanel(true);
      });
    },
  });

  await joplin.commands.register({
    name: COMMAND_UNLINK_PAGE,
    label: 'Unlink page from Sub-Pages hierarchy',
    iconName: 'fas fa-unlink',
    execute: async (...args: any[]) => {
      await runCommand(async () => {
        const note = await resolveContextNote(args);
        if (!note) {
          await notify('Select a page to unlink from the Sub-Pages hierarchy.');
          return;
        }
        await unlinkPageFromHierarchy(note.id);
        markPanelStateChanged();
        await refreshPanel(true);
      });
    },
  });

  await joplin.commands.register({
    name: COMMAND_REPAIR_METADATA,
    label: 'Repair Sub-Pages metadata',
    iconName: 'fas fa-wrench',
    execute: async () => {
        await runCommand(async () => {
          const count = await repairCurrentNotebookMetadata();
          markPanelStateChanged();
          await refreshPanel(true);
          if (count === null) return;
          await showToast(count ? `Repaired ${count} Sub-Pages metadata item${count === 1 ? '' : 's'}.` : 'No Sub-Pages repairs were needed.');
        });
      },
  });
}

async function registerMenus(): Promise<void> {
  await joplin.views.menuItems.create('subPages.togglePanel.view', COMMAND_TOGGLE_PANEL, MenuItemLocation.View);
  await joplin.views.menuItems.create('subPages.refreshPanel.tools', COMMAND_REFRESH_PANEL, MenuItemLocation.Tools);
  await joplin.views.menuItems.create('subPages.repairMetadata.tools', COMMAND_REPAIR_METADATA, MenuItemLocation.Tools);

  await joplin.views.menuItems.create('subPages.createChildPage.context', COMMAND_CREATE_CHILD_PAGE, MenuItemLocation.NoteListContextMenu);
  await joplin.views.menuItems.create('subPages.movePage.context', COMMAND_MOVE_PAGE, MenuItemLocation.NoteListContextMenu);
  await joplin.views.menuItems.create('subPages.promotePage.context', COMMAND_PROMOTE_PAGE, MenuItemLocation.NoteListContextMenu);
  await joplin.views.menuItems.create('subPages.unlinkPage.context', COMMAND_UNLINK_PAGE, MenuItemLocation.NoteListContextMenu);

  await joplin.views.toolbarButtons.create('subPages.togglePanel.toolbar', COMMAND_TOGGLE_PANEL, ToolbarButtonLocation.NoteToolbar);
}

async function registerPanel(): Promise<void> {
  panelReady = false;
  panelHandle = await joplin.views.panels.create(PANEL_ID);
  await joplin.views.panels.setHtml(panelHandle, `
    <div id="app" class="sub-pages-app">
      <div class="sub-pages-loading">Loading Sub-Pages...</div>
    </div>
  `);
  await joplin.views.panels.onMessage(panelHandle, handlePanelMessage);
  await joplin.views.panels.addScript(panelHandle, './panel.css');
  await joplin.views.panels.addScript(panelHandle, './panel.js');
  await joplin.views.panels.show(panelHandle, true);
}

async function registerRefreshEvents(): Promise<void> {
  await joplin.workspace.onNoteSelectionChange(async (event: any) => {
    const eventSelectedNoteId = selectedNoteIdFromEvent(event);
    if (eventSelectedNoteId !== undefined) {
      rememberSelectedNoteId(eventSelectedNoteId);
      scheduleSelectionRefresh(0, eventSelectedNoteId);
    } else {
      scheduleSelectionRefresh();
    }

    refreshPanelIfSelectedFolderChanged().catch((error) => {
      console.error('Sub-Pages folder selection refresh failed', error);
    });
  });

  await joplin.workspace.onNoteChange(async (event: any) => {
    await handleNoteChangeEvent(event);
  });

  await joplin.workspace.onNoteContentChange(async (event: any) => {
    await handleNoteChangeEvent(event);
  });

  await joplin.workspace.onSyncComplete(async () => {
    markPanelStateChanged();
    schedulePanelRefresh(1000);
  });

  await joplin.settings.onChange(async (event) => {
    if (event.keys.includes(SETTING_PANEL_SORT_MODE)) {
      markPanelStateChanged();
      schedulePanelRefresh();
    }
  });

  if (!selectionPollTimer) {
    selectionPollTimer = setInterval(() => {
      scheduleSelectionRefresh();
    }, 1000);
  }
}

async function handlePanelMessage(message: any): Promise<any> {
  try {
    const name = typeof message?.name === 'string' ? message.name : '';
    const noteId = typeof message?.noteId === 'string' ? message.noteId : '';

    if (name === 'ready') {
      panelReady = true;
      return panelStateResponse();
    }

    if (name === 'refresh') {
      return panelStateResponse();
    }

    if (name === 'stateIfChanged') {
      const revision = typeof message?.revision === 'number' ? message.revision : -1;
      if (revision === panelStateRevision) {
        return {
          ok: true,
          revision: panelStateRevision,
        };
      }

      return panelStateResponse();
    }

    if (name === 'selectedNoteState') {
      return {
        ok: true,
        selectedNoteId: await selectedNoteId(),
      };
    }

    if (name === 'search') {
      const scope: SearchScope = message?.scope === 'notebook' ? 'notebook' : 'all';
      return await panelSearchResponse(typeof message?.query === 'string' ? message.query : '', scope);
    }

    if (name === 'createRoot') {
      await createRootPage();
      markPanelStateChanged();
      return panelStateResponse();
    }

    if (name === 'openNote' && noteId) {
      await openNote(noteId);
      scheduleSelectionRefresh();
      return { ok: true };
    }

    if (name === 'commandPalette' && noteId) {
      await openNote(noteId);
      rememberSelectedNoteId(noteId);
      scheduleSelectionRefresh(0, noteId);
      await delay(75);
      const opened = await runCommandPalette();
      return {
        ok: opened,
        message: opened ? undefined : 'Joplin command palette is unavailable in this version.',
      };
    }

    if (NOTE_LIST_PARITY_COMMANDS.has(name) && noteId) {
      // Joplin's real notes-list context menu is built in the desktop React/Electron
      // note-list component (NoteListUtils.makeContextMenu) and is not exposed through
      // the plugin panel/webview API. The panel fallback delegates individual high-value
      // menu items to the same internal commands where possible instead of duplicating
      // Joplin's native Electron menu.
      await runNoteListParityCommand(name, noteId);
      if (name !== 'openNoteInNewWindow' && name !== 'startExternalEditing' && name !== 'showNoteProperties' && name !== 'setTags') {
        markNoteRecentlyChanged(noteId);
        markPanelStateChanged();
        scheduleSettledPanelRefreshes();
        return panelStateResponse();
      }

      schedulePanelRefresh(500);
      return { ok: true };
    }

    if (name === 'copyMarkdownLink' && noteId) {
      await copyMarkdownLink(noteId);
      return { ok: true, message: 'Copied Markdown link.' };
    }

    if (name === 'copyExternalLink' && noteId) {
      await copyExternalLink(noteId);
      return { ok: true, message: 'Copied external link.' };
    }

    if (name === 'createChild' && noteId) {
      await createChildPage(noteId);
      markPanelStateChanged();
      return panelStateResponse();
    }

    if (name === 'move' && noteId) {
      await movePageWithDialog(noteId);
      markPanelStateChanged();
      return panelStateResponse();
    }

    if (name === 'promote' && noteId) {
      await promotePageToRoot(noteId);
      markPanelStateChanged();
      return panelStateResponse();
    }

    if (name === 'unlink' && noteId) {
      await unlinkPageFromHierarchy(noteId);
      markPanelStateChanged();
      return panelStateResponse();
    }

    if (name === 'moveUp' && noteId) {
      await moveSibling(noteId, -1);
      markPanelStateChanged();
      return panelStateResponse();
    }

    if (name === 'moveDown' && noteId) {
      await moveSibling(noteId, 1);
      markPanelStateChanged();
      return panelStateResponse();
    }

    if (name === 'repair') {
      const count = await repairCurrentNotebookMetadata();
      if (count === null) return panelStateResponse('Repair cancelled.');
      markPanelStateChanged();
      return panelStateResponse(count ? `Repaired ${count} metadata item${count === 1 ? '' : 's'}.` : 'No repairs were needed.');
    }

    return { ok: false, message: 'Unsupported Sub-Pages panel action.' };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    console.error('Sub-Pages panel action failed', error);
    await showToast(`Sub-Pages failed: ${messageText}`, ToastType.Error);
    return { ok: false, message: messageText };
  }
}

async function panelStateResponse(message?: string): Promise<any> {
  const response: any = {
    ok: true,
    revision: panelStateRevision,
    state: await buildPanelState(),
  };
  if (message) response.message = message;
  return response;
}

async function panelSearchResponse(query: string, scope: SearchScope): Promise<any> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return {
      ok: true,
      query: '',
      scope,
      noteIds: [],
      externalResults: [],
    };
  }

  const folder = await selectedFolderSummary();
  if (!folder && scope === 'notebook') {
    return {
      ok: false,
      query: trimmedQuery,
      scope,
      noteIds: [],
      externalResults: [],
      message: 'No notebook is selected.',
    };
  }

  try {
    const notes = folder ? await listNotebookNotes(folder.id) : [];
    const notebookNoteIds = new Set(notes.map(note => note.id));
    const searchResults = await searchNotes(trimmedQuery);
    const noteIds: string[] = [];
    const externalResults: SearchExternalResult[] = [];
    const folderTitleCache = new Map<string, string>();
    const seenNoteIds = new Set<string>();

    for (const note of searchResults) {
      if (seenNoteIds.has(note.id)) continue;
      seenNoteIds.add(note.id);

      if (notebookNoteIds.has(note.id)) {
        noteIds.push(note.id);
      } else if (scope === 'all') {
        externalResults.push(await toExternalSearchResult(note, folderTitleCache));
      }
    }

    return {
      ok: true,
      query: trimmedQuery,
      scope,
      noteIds,
      externalResults,
    };
  } catch (error) {
    console.warn('Sub-Pages: Joplin search failed', error);
    return {
      ok: false,
      query: trimmedQuery,
      scope,
      noteIds: [],
      externalResults: [],
      message: 'Search failed. Try Refresh Sub-Pages panel or restart Joplin.',
    };
  }
}

async function searchNotes(query: string): Promise<NoteSummary[]> {
  const output: NoteSummary[] = [];
  let page = 1;

  while (true) {
    const response = await joplin.data.get(['search'], {
      query,
      type: 'note',
      fields: searchNoteFields(),
      page,
      limit: 100,
    }) as PageResponse<any>;

    const items = Array.isArray(response.items) ? response.items : [];
    for (const item of items) {
      const note = normalizeNote(item);
      if (note) output.push(note);
    }

    if (!response.has_more) break;
    page += 1;
  }

  return output;
}

function searchNoteFields(): string[] {
  return ['id', 'title', 'parent_id', 'user_updated_time', 'updated_time', 'is_todo', 'todo_completed'];
}

async function toExternalSearchResult(note: NoteSummary, folderTitleCache: Map<string, string>): Promise<SearchExternalResult> {
  return {
    id: note.id,
    title: displayTitle(note),
    parentId: note.parent_id,
    notebookTitle: await searchResultNotebookTitle(note.parent_id, folderTitleCache),
    isTodo: !!note.is_todo,
    todoCompleted: !!note.todo_completed,
    updatedTime: noteTime(note),
  };
}

async function searchResultNotebookTitle(folderId: string, cache: Map<string, string>): Promise<string> {
  if (!folderId) return 'No notebook';
  if (cache.has(folderId)) return cache.get(folderId) ?? 'Unknown notebook';

  try {
    const folder = await joplin.data.get(['folders', folderId], {
      fields: ['id', 'title'],
    });
    const title = typeof folder?.title === 'string' && folder.title.trim() ? folder.title.trim() : 'Unknown notebook';
    cache.set(folderId, title);
    return title;
  } catch {
    cache.set(folderId, 'Unknown notebook');
    return 'Unknown notebook';
  }
}

function schedulePanelRefresh(delay = 150): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshPanel().catch((error) => {
      console.error('Sub-Pages panel refresh failed', error);
    });
  }, delay);
}

function scheduleSettledPanelRefreshes(): void {
  settledRefreshTimers.forEach((timer) => clearTimeout(timer));
  settledRefreshTimers = SETTLED_REFRESH_DELAYS.map((delay) => {
    return setTimeout(() => {
      schedulePanelRefresh(0);
    }, delay);
  });
}

function scheduleSelectionRefresh(delay = 75, selectedNoteIdOverride?: string | null): void {
  if (selectedNoteIdOverride !== undefined) pendingSelectedNoteId = selectedNoteIdOverride;

  if (selectionRefreshTimer) clearTimeout(selectionRefreshTimer);
  selectionRefreshTimer = setTimeout(() => {
    selectionRefreshTimer = null;
    const selectedNoteId = pendingSelectedNoteId;
    pendingSelectedNoteId = undefined;
    postSelectedNoteState(selectedNoteId).catch((error) => {
      console.error('Sub-Pages selection refresh failed', error);
    });
  }, delay);
}

async function postSelectedNoteState(selectedNoteIdOverride?: string | null): Promise<void> {
  if (!panelHandle) return;
  if (!panelReady) return;

  const selectedId = selectedNoteIdOverride !== undefined ? selectedNoteIdOverride : await selectedNoteId();
  rememberSelectedNoteId(selectedId);

  if (hasPostedSelectedNoteId && selectedId === lastPostedSelectedNoteId) return;

  lastPostedSelectedNoteId = selectedId;
  hasPostedSelectedNoteId = true;

  joplin.views.panels.postMessage(panelHandle, {
    name: 'selection',
    selectedNoteId: selectedId,
  });
}

async function refreshPanel(force = false): Promise<void> {
  if (!panelHandle) return;
  if (!panelReady) return;

  const state = await buildPanelState();
  joplin.views.panels.postMessage(panelHandle, {
    name: 'state',
    revision: panelStateRevision,
    state,
  });
}

async function refreshPanelIfSelectedFolderChanged(): Promise<void> {
  const folder = await selectedFolderSummary();
  const selectedFolderId = folder?.id ?? null;
  if (lastPanelFolderId !== undefined && selectedFolderId === lastPanelFolderId) return;

  markPanelStateChanged();
  schedulePanelRefresh(50);
}

async function handleNoteChangeEvent(event: any): Promise<void> {
  const noteId = changedNoteIdFromEvent(event) ?? await selectedNoteId();
  if (noteId) markNoteRecentlyChanged(noteId);
  markPanelStateChanged();

  schedulePanelRefresh(200);
  scheduleSettledPanelRefreshes();
  scheduleSelectionRefresh();
}

async function panelVisible(): Promise<boolean> {
  if (!panelHandle) return false;
  try {
    return await joplin.views.panels.visible(panelHandle);
  } catch {
    return true;
  }
}

async function buildPanelState(): Promise<any> {
  try {
    const folder = await selectedFolderSummary();
    lastPanelFolderId = folder?.id ?? null;
    if (!folder) {
      return {
        folder: null,
        selectedNoteId: await selectedNoteId(),
        sortMode: await panelSortMode(),
        nodes: [],
        noteCount: 0,
        repairCount: 0,
        metadataItemCount: 0,
        error: 'No notebook is selected.',
      };
    }

    const notes = await listNotebookNotes(folder.id);
    const sortMode = await panelSortMode();
    const tree = await buildTree(notes, folder.id, sortMode);

    return {
      folder,
      selectedNoteId: await selectedNoteId(),
      sortMode,
      nodes: tree.roots,
      noteCount: notes.length,
      repairCount: tree.repairCount,
      metadataItemCount: tree.metadataItemCount,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      folder: null,
      selectedNoteId: await selectedNoteId(),
      sortMode: await panelSortMode(),
      nodes: [],
      noteCount: 0,
      repairCount: 0,
      metadataItemCount: 0,
      error: message,
    };
  }
}

async function buildTree(notes: NoteSummary[], notebookId: string, sortMode: PanelSortMode): Promise<TreeBuildResult> {
  const noteMap = toNoteMap(notes);
  const metaMap = await buildMetaMap(notes);
  const metadataItemCount = metadataItemCountFor(metaMap);
  const externalParentReasons = await externalParentRepairReasons(notes, notebookId, noteMap, metaMap);
  const parentByNoteId = new Map<string, string | null>();
  const repairReasons = new Map<string, string>();

  for (const note of notes) {
    const meta = metaMap.get(note.id) ?? emptyMeta();
    const parentId = meta.parentId;

    if (!parentId) {
      parentByNoteId.set(note.id, null);
      continue;
    }

    let repairReason: string | null = null;
    if (parentId === note.id) {
      repairReason = 'Self parent';
    } else if (!noteMap.has(parentId)) {
      repairReason = externalParentReasons.get(note.id) ?? 'Missing parent';
    } else if (hasParentCycle(note.id, metaMap, noteMap)) {
      repairReason = 'Circular parent chain';
    }

    if (repairReason) {
      parentByNoteId.set(note.id, null);
      repairReasons.set(note.id, repairReason);
    } else {
      parentByNoteId.set(note.id, parentId);
    }
  }

  const childrenByParent = new Map<string, NoteSummary[]>();
  const roots: NoteSummary[] = [];

  for (const note of notes) {
    const parentId = parentByNoteId.get(note.id);
    if (parentId) {
      const children = childrenByParent.get(parentId) ?? [];
      children.push(note);
      childrenByParent.set(parentId, children);
    } else {
      roots.push(note);
    }
  }

  const buildNode = (note: NoteSummary): TreeNode => {
    const childNotes = childrenByParent.get(note.id) ?? [];
    const children = childNotes.map(buildNode);
    const updatedTime = noteTime(note);
    const effectiveTime = children.reduce((max, child) => Math.max(max, child.updatedTime), updatedTime);
    return {
      id: note.id,
      title: displayTitle(note),
      parentId: parentByNoteId.get(note.id) ?? null,
      updatedTime,
      effectiveTime,
      isTodo: !!note.is_todo,
      todoCompleted: !!note.todo_completed,
      repairReason: repairReasons.get(note.id) ?? null,
      canMoveUp: false,
      canMoveDown: false,
      children,
    };
  };

  const rootNodes = roots.map(buildNode);
  sortTree(rootNodes, null, sortMode, metaMap);
  applyMoveFlags(rootNodes, sortMode);

  return {
    roots: rootNodes,
    repairCount: repairReasons.size,
    metadataItemCount,
  };
}

function metadataItemCountFor(metaMap: Map<string, HierarchyMeta>): number {
  let count = 0;
  for (const meta of metaMap.values()) {
    if (meta.parentId) count += 1;
    if (meta.childIds.length) count += 1;
  }
  return count;
}

function markNoteRecentlyChanged(noteId: string): void {
  pruneRecentChangeTimes();
  recentChangeTimes.set(noteId, Date.now());
}

function pruneRecentChangeTimes(): void {
  const cutoff = Date.now() - RECENT_CHANGE_TIME_TTL;
  for (const [noteId, changedTime] of recentChangeTimes.entries()) {
    if (changedTime < cutoff) recentChangeTimes.delete(noteId);
  }
}

function markPanelStateChanged(): void {
  panelStateRevision += 1;
}

function sortTree(nodes: TreeNode[], parentId: string | null, sortMode: PanelSortMode, metaMap: Map<string, HierarchyMeta>): void {
  for (const node of nodes) {
    sortTree(node.children, node.id, sortMode, metaMap);
  }

  nodes.sort((a, b) => compareTreeNodes(a, b, parentId, sortMode, metaMap));
}

function compareTreeNodes(a: TreeNode, b: TreeNode, parentId: string | null, sortMode: PanelSortMode, metaMap: Map<string, HierarchyMeta>): number {
  if (sortMode === 'recentGroups') {
    if (a.effectiveTime !== b.effectiveTime) return b.effectiveTime - a.effectiveTime;
    return compareTitles(a.title, b.title);
  }

  if (sortMode === 'manual' && parentId) {
    const childIds = metaMap.get(parentId)?.childIds ?? [];
    const aIndex = childIds.includes(a.id) ? childIds.indexOf(a.id) : Number.MAX_SAFE_INTEGER;
    const bIndex = childIds.includes(b.id) ? childIds.indexOf(b.id) : Number.MAX_SAFE_INTEGER;
    if (aIndex !== bIndex) return aIndex - bIndex;
    return compareTitles(a.title, b.title);
  }

  return compareTitles(a.title, b.title);
}

function applyMoveFlags(nodes: TreeNode[], sortMode: PanelSortMode): void {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    node.canMoveUp = sortMode === 'manual' && !!node.parentId && index > 0;
    node.canMoveDown = sortMode === 'manual' && !!node.parentId && index < nodes.length - 1;
    applyMoveFlags(node.children, sortMode);
  }
}

async function createRootPage(): Promise<void> {
  const folder = await selectedFolderSummary();
  if (!folder) {
    await notify('Select a notebook before creating a root page.');
    return;
  }

  const title = await uniquePageTitle(folder.id, DEFAULT_ROOT_TITLE);
  const created = await joplin.data.post(['notes'], null, {
    parent_id: folder.id,
    title,
    body: '',
  });

  if (created?.id) {
    await openNote(String(created.id));
    await showToast(`Created "${title}".`);
  }
}

async function createChildPage(parentId: string): Promise<void> {
  const parent = await getNote(parentId);
  if (!parent) {
    await notify('The parent page could not be loaded.');
    return;
  }

  const title = await uniquePageTitle(parent.parent_id, DEFAULT_CHILD_TITLE);
  const created = await joplin.data.post(['notes'], null, {
    parent_id: parent.parent_id,
    title,
    body: '',
  });

  const child = created?.id ? await getNote(String(created.id)) : null;
  if (!child) {
    await notify('The child page was created, but could not be loaded.');
    return;
  }

  const attached = await attachPageToParent(child, parent);
  if (!attached) return;

  await openNote(child.id);
  await showToast(`Created child page under "${displayTitle(parent)}".`);
}

async function attachPageToParent(child: NoteSummary, parent: NoteSummary): Promise<boolean> {
  if (child.id === parent.id) {
    await notify('A page cannot be moved under itself.');
    return false;
  }

  if (child.parent_id !== parent.parent_id) {
    await notify('Sub-Pages only supports moving pages within the current notebook.');
    return false;
  }

  if (await isDescendant(parent.id, child.id, child.parent_id)) {
    await notify('A page cannot be moved under one of its descendants.');
    return false;
  }

  const childMeta = await getMeta(child.id);
  const parentMeta = await getMeta(parent.id);
  if (childMeta.parentId === parent.id && parentMeta.childIds.includes(child.id)) {
    await notify(`"${displayTitle(child)}" is already under "${displayTitle(parent)}".`);
    return false;
  }

  if (childMeta.parentId && childMeta.parentId !== parent.id) {
    await removeChildFromParent(childMeta.parentId, child.id);
  }

  await setParentId(child.id, parent.id);
  await appendChildId(parent.id, child.id);
  return true;
}

async function movePageWithDialog(noteId: string): Promise<void> {
  const note = await getNote(noteId);
  if (!note) {
    await notify('The page to move could not be loaded.');
    return;
  }

  const moveContext = await moveParentContext(note);
  const candidates = moveContext.candidates;
  if (!candidates.length) {
    await notify('No eligible parent pages were found in this notebook.');
    return;
  }

  const options = candidates.map((candidate) => {
    return `<option value="${escapeHtml(candidate.note.id)}">${escapeHtml(moveCandidateLabel(candidate))}</option>`;
  }).join('');

  const handle = await joplin.views.dialogs.create(DIALOG_MOVE_PARENT);
  await joplin.views.dialogs.setHtml(handle, `
    <!doctype html>
    <html>
      <head>
        <style>
          html, body {
            box-sizing: border-box;
            color: var(--joplin-color, #222);
            font-family: var(--joplin-font-family, sans-serif);
            font-size: var(--joplin-font-size, 13px);
            margin: 0;
            min-height: 180px;
          }
          *, *::before, *::after { box-sizing: inherit; }
          form { min-width: 360px; padding: 16px; }
          p { margin: 0 0 12px; }
          .path { color: var(--joplin-color-faded, #666); font-size: 12px; margin-bottom: 16px; }
          label { display: block; font-weight: 600; }
          select {
            background: var(--joplin-background-color, #fff);
            color: var(--joplin-color, #222);
            display: block;
            font: inherit;
            font-weight: normal;
            margin-top: 8px;
            width: 100%;
          }
        </style>
      </head>
      <body>
        <form name="movePage">
          <p>Choose where this page should appear in the Sub-Pages tree.</p>
          <p class="path">Moving: ${escapeHtml(moveContext.currentPath.join(' / '))}</p>
          <label>
            Parent page
            <select name="parentId">
              ${options}
            </select>
          </label>
        </form>
      </body>
    </html>
  `);
  await joplin.views.dialogs.setButtons(handle, [
    { id: 'ok', title: 'Move' },
    { id: 'cancel', title: 'Cancel' },
  ]);
  await joplin.views.dialogs.setFitToContent(handle, false);

  const result = await joplin.views.dialogs.open(handle);
  if (result.id !== 'ok') return;

  const parentId = result.formData?.movePage?.parentId;
  if (!parentId || typeof parentId !== 'string') return;

  const parent = await getNote(parentId);
  if (!parent) {
    await notify('The selected parent page could not be loaded.');
    return;
  }

  const changed = await attachPageToParent(note, parent);
  if (changed) {
    await showToast(`Moved "${displayTitle(note)}" under "${displayTitle(parent)}".`);
  }
}

async function promotePageToRoot(noteId: string): Promise<void> {
  const note = await getNote(noteId);
  if (!note) {
    await notify('The page to promote could not be loaded.');
    return;
  }

  const meta = await getMeta(note.id);
  if (!meta.parentId) {
    await notify('This page is already at the Sub-Pages root.');
    return;
  }

  await removeChildFromParent(meta.parentId, note.id);
  await clearParentId(note.id);
  await showToast(`Promoted "${displayTitle(note)}" to the Sub-Pages root.`);
}

async function unlinkPageFromHierarchy(noteId: string): Promise<void> {
  const note = await getNote(noteId);
  if (!note) {
    await notify('The page could not be loaded.');
    return;
  }

  const meta = await getMeta(note.id);
  const directChildIds = await directChildIdsForParent(note);

  if (!meta.parentId && !directChildIds.length) {
    await notify('This page is already a Sub-Pages root and has no child links to unlink.');
    return;
  }

  if (meta.parentId) {
    await removeChildFromParent(meta.parentId, note.id);
    await clearParentId(note.id);
  }

  if (directChildIds.length) {
    await clearChildIds(note.id);
    for (const childId of directChildIds) {
      const childMeta = await getMeta(childId);
      if (childMeta.parentId === note.id) {
        await clearParentId(childId);
      }
    }
  }

  await showToast(`Unlinked "${displayTitle(note)}" from the Sub-Pages hierarchy.`);
}

async function directChildIdsForParent(parent: NoteSummary): Promise<string[]> {
  const childIds = await getChildIds(parent.id);
  const notes = await listNotebookNotes(parent.parent_id);
  const metaMap = await buildMetaMap(notes);
  const output = new Set(childIds);

  for (const note of notes) {
    if (metaMap.get(note.id)?.parentId === parent.id) output.add(note.id);
  }

  return [...output];
}

async function moveSibling(noteId: string, direction: -1 | 1): Promise<void> {
  const note = await getNote(noteId);
  if (!note) return;

  const meta = await getMeta(note.id);
  if (!meta.parentId) {
    await notify('Root pages cannot be manually reordered in this version.');
    return;
  }

  const notebookNotes = await listNotebookNotes(note.parent_id);
  const noteMap = toNoteMap(notebookNotes);
  const metaMap = await buildMetaMap(notebookNotes);
  const parentMeta = metaMap.get(meta.parentId) ?? emptyMeta();
  const actualSiblingIds = notebookNotes
    .filter((candidate) => metaMap.get(candidate.id)?.parentId === meta.parentId)
    .map((candidate) => candidate.id);
  const siblingIds = orderChildIdsForRepair(parentMeta.childIds, actualSiblingIds, noteMap);

  const index = siblingIds.indexOf(note.id);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= siblingIds.length) return;

  const nextIds = [...siblingIds];
  const [moved] = nextIds.splice(index, 1);
  nextIds.splice(nextIndex, 0, moved);
  await setChildIds(meta.parentId, nextIds);
}

async function repairCurrentNotebookMetadata(): Promise<number | null> {
  const operations = await repairOperationsForCurrentNotebook();
  if (!operations.length) return 0;

  const confirmed = await joplin.views.dialogs.showMessageBox(
    `Repair will write ${operations.length} Sub-Pages metadata item${operations.length === 1 ? '' : 's'} in the selected notebook. Continue?`
  );
  if (confirmed !== 0) return null;

  let changes = 0;
  for (const operation of operations) {
    if (operation.type === 'clearParentId') {
      if (await clearParentIdIfExists(operation.noteId)) changes += 1;
    } else if (operation.type === 'clearChildIds') {
      if (await clearChildIds(operation.noteId)) changes += 1;
    } else if (operation.type === 'setChildIds' && operation.childIds) {
      await setChildIds(operation.noteId, operation.childIds);
      changes += 1;
    }
  }

  return changes;
}

async function repairOperationsForCurrentNotebook(): Promise<RepairOperation[]> {
  const folder = await selectedFolderSummary();
  if (!folder) {
    await notify('Select a notebook before repairing Sub-Pages metadata.');
    return [];
  }

  const notes = await listNotebookNotes(folder.id);
  const noteMap = toNoteMap(notes);
  const metaMap = await buildMetaMap(notes);
  const externalReasons = await externalParentRepairReasons(notes, folder.id, noteMap, metaMap);
  const effectiveParentIds = new Map<string, string | null>();
  const operations: RepairOperation[] = [];

  for (const note of notes) {
    const meta = metaMap.get(note.id) ?? emptyMeta();
    const parentId = meta.parentId;
    const invalidParent = !!parentId && (
      parentId === note.id
      || !noteMap.has(parentId)
      || hasParentCycle(note.id, metaMap, noteMap)
      || externalReasons.has(note.id)
    );

    if (invalidParent) {
      operations.push({ type: 'clearParentId', noteId: note.id });
      effectiveParentIds.set(note.id, null);
    } else {
      effectiveParentIds.set(note.id, parentId);
    }
  }

  for (const parent of notes) {
    const meta = metaMap.get(parent.id) ?? emptyMeta();
    const childIds = notes
      .filter((note) => effectiveParentIds.get(note.id) === parent.id)
      .map((note) => note.id);

    const orderedChildIds = orderChildIdsForRepair(meta.childIds, childIds, noteMap);
    if (orderedChildIds.length) {
      if (!sameIds(meta.childIds, orderedChildIds)) {
        operations.push({ type: 'setChildIds', noteId: parent.id, childIds: orderedChildIds });
      }
    } else if (meta.childIds.length) {
      operations.push({ type: 'clearChildIds', noteId: parent.id });
    }
  }

  return operations;
}

async function moveParentContext(note: NoteSummary): Promise<{ currentPath: string[]; candidates: MoveParentCandidate[] }> {
  const notes = await listNotebookNotes(note.parent_id);
  const metaMap = await buildMetaMap(notes);
  const noteMap = toNoteMap(notes);
  const currentParentId = metaMap.get(note.id)?.parentId ?? null;
  const candidates = notes
    .filter((candidate) => candidate.id !== note.id)
    .filter((candidate) => candidate.id !== currentParentId)
    .filter((candidate) => !isDescendantFromMeta(candidate.id, note.id, metaMap, noteMap))
    .map((candidate) => {
      const path = hierarchyPathFor(candidate, metaMap, noteMap);
      return {
        note: candidate,
        path,
      };
    })
    .sort(compareMoveCandidates);

  return {
    currentPath: hierarchyPathFor(note, metaMap, noteMap),
    candidates,
  };
}

function hierarchyPathFor(note: NoteSummary, metaMap: Map<string, HierarchyMeta>, noteMap: Map<string, NoteSummary>): string[] {
  const path = [displayTitle(note)];
  const seen = new Set<string>([note.id]);
  let currentId: string | null = note.id;

  while (currentId) {
    const parentId = metaMap.get(currentId)?.parentId ?? null;
    if (!parentId || seen.has(parentId)) break;

    const parent = noteMap.get(parentId);
    if (!parent) break;

    seen.add(parentId);
    path.unshift(displayTitle(parent));
    currentId = parentId;
  }

  return path;
}

function compareMoveCandidates(a: MoveParentCandidate, b: MoveParentCandidate): number {
  const maxLength = Math.max(a.path.length, b.path.length);
  for (let index = 0; index < maxLength; index++) {
    const aPart = a.path[index];
    const bPart = b.path[index];
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;

    const titleComparison = compareTitles(aPart, bPart);
    if (titleComparison) return titleComparison;
  }

  return compareNotesByTitle(a.note, b.note);
}

function moveCandidateLabel(candidate: MoveParentCandidate): string {
  if (candidate.path.length <= 1) return displayTitle(candidate.note);
  return candidate.path.join(' / ');
}

async function isDescendant(candidateId: string, ancestorId: string, notebookId: string): Promise<boolean> {
  const notes = await listNotebookNotes(notebookId);
  const metaMap = await buildMetaMap(notes);
  return isDescendantFromMeta(candidateId, ancestorId, metaMap, toNoteMap(notes));
}

function isDescendantFromMeta(candidateId: string, ancestorId: string, metaMap: Map<string, HierarchyMeta>, noteMap: Map<string, NoteSummary>): boolean {
  let currentId: string | null = candidateId;
  const seen = new Set<string>();

  while (currentId) {
    if (currentId === ancestorId) return true;
    if (seen.has(currentId)) return false;
    seen.add(currentId);

    const parentId = metaMap.get(currentId)?.parentId ?? null;
    currentId = parentId && noteMap.has(parentId) ? parentId : null;
  }

  return false;
}

async function resolveContextNote(args: any[]): Promise<NoteSummary | null> {
  const noteId = await resolveContextNoteId(args);
  if (!noteId) return null;
  return getNote(noteId);
}

async function resolveContextNoteId(args: any[]): Promise<string | null> {
  if (Array.isArray(args) && args.length) {
    const context = args[0];
    if (context && Array.isArray(context.noteIds) && context.noteIds.length) {
      return context.noteIds[0];
    }
  }

  const note = await joplin.workspace.selectedNote();
  return note?.id ?? null;
}

async function selectedFolderSummary(): Promise<FolderSummary | null> {
  try {
    const folder = await joplin.workspace.selectedFolder();
    if (!folder?.id) return null;
    return {
      id: String(folder.id),
      title: typeof folder.title === 'string' && folder.title.trim() ? folder.title : 'Selected notebook',
    };
  } catch {
    return null;
  }
}

async function selectedNoteId(): Promise<string | null> {
  try {
    const noteIds = await joplin.workspace.selectedNoteIds();
    if (Array.isArray(noteIds)) {
      const noteId = typeof noteIds[0] === 'string' && noteIds[0] ? noteIds[0] : null;
      rememberSelectedNoteId(noteId);
      return noteId;
    }
  } catch {
    // Fall back to selectedNote below.
  }

  try {
    const note = await joplin.workspace.selectedNote();
    const noteId = note?.id ? String(note.id) : null;
    rememberSelectedNoteId(noteId);
    return noteId;
  } catch {
    return hasKnownSelectedNoteId ? knownSelectedNoteId : null;
  }
}

function selectedNoteIdFromEvent(event: any): string | null | undefined {
  const value = event?.value;
  if (Array.isArray(value)) return typeof value[0] === 'string' && value[0] ? value[0] : null;
  if (typeof value === 'string') return value || null;
  return undefined;
}

function changedNoteIdFromEvent(event: any): string | null {
  const id = event?.id ?? event?.noteId ?? event?.note?.id;
  return typeof id === 'string' && id ? id : null;
}

function rememberSelectedNoteId(noteId: string | null): void {
  knownSelectedNoteId = noteId;
  hasKnownSelectedNoteId = true;
}

async function getNote(noteId: string): Promise<NoteSummary | null> {
  try {
    const note = await joplin.data.get(['notes', noteId], {
      fields: noteFields(),
    });
    return normalizeNote(note);
  } catch (error) {
    console.warn('Sub-Pages: unable to load note', noteId, error);
    return null;
  }
}

async function listNotebookNotes(notebookId: string): Promise<NoteSummary[]> {
  const output: NoteSummary[] = [];
  let page = 1;

  while (true) {
    const response = await joplin.data.get(['folders', notebookId, 'notes'], {
      fields: noteFields(),
      order_by: 'user_updated_time',
      order_dir: 'DESC',
      page,
      limit: 100,
    }) as PageResponse<any>;

    const items = Array.isArray(response.items) ? response.items : [];
    for (const item of items) {
      const note = normalizeNote(item);
      if (note) output.push(note);
    }

    if (!response.has_more) break;
    page += 1;
  }

  return output;
}

function noteFields(): string[] {
  return ['id', 'title', 'parent_id', 'user_updated_time', 'updated_time', 'is_todo', 'todo_completed', 'user_data'];
}

function normalizeNote(value: any): NoteSummary | null {
  if (!value || typeof value.id !== 'string') return null;
  return {
    id: value.id,
    title: typeof value.title === 'string' ? value.title : '',
    parent_id: typeof value.parent_id === 'string' ? value.parent_id : '',
    user_updated_time: numberValue(value.user_updated_time),
    updated_time: numberValue(value.updated_time),
    is_todo: numberValue(value.is_todo),
    todo_completed: numberValue(value.todo_completed),
    user_data: value.user_data ?? value.userData,
  };
}

async function uniquePageTitle(notebookId: string, baseTitle: string): Promise<string> {
  const notes = await listNotebookNotes(notebookId);
  const titles = new Set(notes.map((note) => note.title));
  let title = baseTitle;
  let suffix = 1;

  while (titles.has(title)) {
    suffix += 1;
    title = `${baseTitle} ${suffix}`;
  }

  return title;
}

async function buildMetaMap(notes: NoteSummary[]): Promise<Map<string, HierarchyMeta>> {
  const output = new Map<string, HierarchyMeta>();
  for (const note of notes) {
    output.set(note.id, metaFromNote(note));
  }
  return output;
}

function metaFromNote(note: NoteSummary): HierarchyMeta {
  return {
    parentId: inlineParentId(note),
    childIds: inlineChildIds(note),
  };
}

function inlineParentId(note: NoteSummary): string | null {
  const value = inlineUserDataValue(note.user_data, PARENT_ID_KEY);
  return typeof value === 'string' && value ? value : null;
}

function inlineChildIds(note: NoteSummary): string[] {
  return normalizeIds(inlineUserDataValue(note.user_data, CHILD_IDS_KEY));
}

function inlineUserDataValue(userData: unknown, key: string): unknown {
  const data = parseInlineUserData(userData);
  if (!data) return undefined;

  const pluginData = parseInlineUserData(data[PLUGIN_ID]);
  if (pluginData) {
    const pluginValue = inlineUserDataEntryValue(pluginData[key]);
    if (pluginValue !== undefined) return pluginValue;
  }

  return inlineUserDataEntryValue(data[key]);
}

function inlineUserDataEntryValue(value: unknown): unknown {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, 'value')) return record.value;
    if (Object.prototype.hasOwnProperty.call(record, 'v')) return record.v;
  }

  return value;
}

function parseInlineUserData(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  return null;
}

async function getMeta(noteId: string): Promise<HierarchyMeta> {
  const parentId = await getParentId(noteId);
  const childIds = await getChildIds(noteId);
  return { parentId, childIds };
}

function emptyMeta(): HierarchyMeta {
  return {
    parentId: null,
    childIds: [],
  };
}

async function getParentId(noteId: string): Promise<string | null> {
  const value = await userDataGet<string | null>(noteId, PARENT_ID_KEY, null);
  return typeof value === 'string' && value ? value : null;
}

async function setParentId(noteId: string, parentId: string): Promise<void> {
  if ((await userDataRaw(noteId, PARENT_ID_KEY)) === parentId) return;
  await joplin.data.userDataSet(ModelType.Note, noteId, PARENT_ID_KEY, parentId);
}

async function clearParentId(noteId: string): Promise<boolean> {
  return clearParentIdIfExists(noteId);
}

async function clearParentIdIfExists(noteId: string): Promise<boolean> {
  if (!(await userDataExists(noteId, PARENT_ID_KEY))) return false;
  try {
    await joplin.data.userDataDelete(ModelType.Note, noteId, PARENT_ID_KEY);
    return true;
  } catch (error) {
    console.warn('Sub-Pages: unable to clear parent metadata', noteId, error);
    return false;
  }
}

async function getChildIds(noteId: string): Promise<string[]> {
  const value = await userDataGet<string[]>(noteId, CHILD_IDS_KEY, []);
  return normalizeIds(value);
}

async function setChildIds(noteId: string, childIds: string[]): Promise<void> {
  const normalized = normalizeIds(childIds);
  if (!normalized.length) {
    await clearChildIds(noteId);
    return;
  }

  if (rawIdsEqual(await userDataRaw(noteId, CHILD_IDS_KEY), normalized)) return;
  await joplin.data.userDataSet(ModelType.Note, noteId, CHILD_IDS_KEY, normalized);
}

async function clearChildIds(noteId: string): Promise<boolean> {
  if (!(await userDataExists(noteId, CHILD_IDS_KEY))) return false;
  try {
    await joplin.data.userDataDelete(ModelType.Note, noteId, CHILD_IDS_KEY);
    return true;
  } catch (error) {
    console.warn('Sub-Pages: unable to clear child metadata', noteId, error);
    return false;
  }
}

async function appendChildId(parentId: string, childId: string): Promise<void> {
  const childIds = await getChildIds(parentId);
  await setChildIds(parentId, appendUnique(childIds, childId));
}

async function removeChildFromParent(parentId: string, childId: string): Promise<void> {
  const childIds = await getChildIds(parentId);
  await setChildIds(parentId, childIds.filter((id) => id !== childId));
}

async function userDataGet<T>(noteId: string, key: string, fallback: T): Promise<T> {
  const value = await userDataRaw<T>(noteId, key);
  return value === undefined || value === null ? fallback : value;
}

async function userDataRaw<T = unknown>(noteId: string, key: string): Promise<T | null | undefined> {
  try {
    return await joplin.data.userDataGet<T>(ModelType.Note, noteId, key);
  } catch {
    return undefined;
  }
}

async function userDataExists(noteId: string, key: string): Promise<boolean> {
  const value = await userDataRaw(noteId, key);
  return value !== undefined && value !== null;
}

async function externalParentRepairReasons(
  notes: NoteSummary[],
  notebookId: string,
  noteMap: Map<string, NoteSummary>,
  metaMap: Map<string, HierarchyMeta>
): Promise<Map<string, string>> {
  const output = new Map<string, string>();
  const parentCache = new Map<string, NoteSummary | null>();

  for (const note of notes) {
    const parentId = metaMap.get(note.id)?.parentId;
    if (!parentId || noteMap.has(parentId)) continue;

    if (!parentCache.has(parentId)) {
      parentCache.set(parentId, await getNote(parentId));
    }

    const parent = parentCache.get(parentId);
    if (!parent) {
      output.set(note.id, 'Missing parent');
    } else if (parent.parent_id !== notebookId) {
      output.set(note.id, 'Parent is in another notebook');
    } else {
      output.set(note.id, 'Parent is unavailable');
    }
  }

  return output;
}

function hasParentCycle(noteId: string, metaMap: Map<string, HierarchyMeta>, noteMap: Map<string, NoteSummary>): boolean {
  const seen = new Set<string>();
  let currentId: string | null = noteId;

  while (currentId) {
    const parentId = metaMap.get(currentId)?.parentId ?? null;
    if (!parentId || !noteMap.has(parentId)) return false;
    if (parentId === noteId || seen.has(parentId)) return true;
    seen.add(parentId);
    currentId = parentId;
  }

  return false;
}

function orderChildIdsForRepair(storedChildIds: string[], actualChildIds: string[], noteMap: Map<string, NoteSummary>): string[] {
  const actualSet = new Set(actualChildIds);
  const output = storedChildIds.filter((id) => actualSet.has(id));
  const missing = actualChildIds
    .filter((id) => !output.includes(id))
    .sort((a, b) => compareNotesByTitle(noteMap.get(a), noteMap.get(b)));

  return [...output, ...missing];
}

async function panelSortMode(): Promise<PanelSortMode> {
  try {
    const value = await joplin.settings.value(SETTING_PANEL_SORT_MODE);
    if (value === 'manual' || value === 'title' || value === 'recentGroups') return value;
  } catch {
    // Use default below.
  }
  return 'recentGroups';
}

async function openNote(noteId: string): Promise<void> {
  const attempts: any[][] = [
    ['openNote', noteId],
    ['openNote', { noteId }],
    ['openNote', { id: noteId }],
  ];

  for (const [command, arg] of attempts) {
    try {
      await joplin.commands.execute(command, arg);
      return;
    } catch {
      // Keep trying; openNote is an internal desktop command and its shape can vary.
    }
  }
}

async function runNoteListParityCommand(commandName: string, noteId: string): Promise<void> {
  const listArgCommands = new Set(['setTags', 'toggleNoteType', 'moveToFolder', 'duplicateNote', 'deleteNote']);
  const primaryArg = listArgCommands.has(commandName) ? [noteId] : noteId;
  const fallbackArg = listArgCommands.has(commandName) ? noteId : [noteId];

  try {
    await joplin.commands.execute(commandName, primaryArg);
  } catch (primaryError) {
    try {
      await joplin.commands.execute(commandName, fallbackArg);
    } catch {
      throw primaryError;
    }
  }
}

async function runCommandPalette(): Promise<boolean> {
  try {
    await joplin.commands.execute('commandPalette');
    return true;
  } catch (error) {
    console.warn('Sub-Pages: command palette command failed', error);
    await showToast('Joplin command palette is unavailable in this version.', ToastType.Error);
    return false;
  }
}

async function copyMarkdownLink(noteId: string): Promise<void> {
  const note = await getNote(noteId);
  const title = escapeMarkdownLinkTitle(note?.title || 'Untitled');
  await joplin.clipboard.writeText(`[${title}](:/${noteId})`);
}

async function copyExternalLink(noteId: string): Promise<void> {
  await joplin.clipboard.writeText(`joplin://x-callback-url/openNote?id=${encodeURIComponent(noteId)}`);
}

function escapeMarkdownLinkTitle(title: string): string {
  return title.replace(/\\/g, '\\\\').replace(/]/g, '\\]');
}

async function runCommand(callback: () => Promise<void>): Promise<void> {
  try {
    await callback();
  } catch (error) {
    console.error('Sub-Pages command failed', error);
    await notify(`Sub-Pages failed: ${(error as Error).message}`);
  }
}

async function notify(message: string): Promise<void> {
  await joplin.views.dialogs.showMessageBox(message);
}

async function showToast(message: string, type: ToastType = ToastType.Info): Promise<void> {
  try {
    await joplin.views.dialogs.showToast({
      message,
      type,
      duration: 4000,
    });
  } catch (error) {
    console.warn('Sub-Pages: unable to display toast', error);
  }
}

function toNoteMap(notes: NoteSummary[]): Map<string, NoteSummary> {
  const map = new Map<string, NoteSummary>();
  for (const note of notes) {
    map.set(note.id, note);
  }
  return map;
}

function normalizeIds(value: any): string[] {
  if (!Array.isArray(value)) return [];
  const output: string[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (typeof item !== 'string' || !item || seen.has(item)) continue;
    seen.add(item);
    output.push(item);
  }

  return output;
}

function rawIdsEqual(value: any, ids: string[]): boolean {
  if (!Array.isArray(value) || value.length !== ids.length) return false;
  for (let index = 0; index < ids.length; index++) {
    if (value[index] !== ids[index]) return false;
  }
  return true;
}

function appendUnique(values: string[], value: string): string[] {
  const next = values.filter((item) => item !== value);
  next.push(value);
  return next;
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function noteTime(note: NoteSummary): number {
  const persistedTime = note.user_updated_time || note.updated_time || 0;
  const recentChangeTime = recentChangeTimes.get(note.id) ?? 0;
  return Math.max(persistedTime, recentChangeTime);
}

function numberValue(value: any): number {
  return typeof value === 'number' ? value : 0;
}

function displayTitle(note: NoteSummary | null | undefined): string {
  return note?.title?.trim() || '(untitled)';
}

function compareNotesByTitle(a: NoteSummary | null | undefined, b: NoteSummary | null | undefined): number {
  return compareTitles(displayTitle(a), displayTitle(b));
}

function compareTitles(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
