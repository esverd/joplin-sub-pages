import joplin from 'api';
import * as os from 'os';
import * as path from 'path';
import {
  ALL_NOTES_FILTER_ID,
  EMPTY_WHITEBOARD_BODY,
  PANEL_APPEARANCE_DEFAULTS,
  PANEL_APPEARANCE_LIMITS,
  PanelAppearance,
  ViewScope,
  classifyJoplinViewState,
  groupIdsByParent,
  isWhiteboardBody,
  mainWindowStateFromRoot,
  normalizePanelAppearance,
  parentCycleAffectedIds,
  reciprocalRankScores,
  semanticSearchScope,
} from './core';
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
const COMMAND_CREATE_CHILD_WHITEBOARD = 'subPages.createChildWhiteboard';
const COMMAND_MOVE_PAGE = 'subPages.movePage';
const COMMAND_MOVE_BRANCH_TO_FOLDER = 'subPages.moveBranchToFolder';
const COMMAND_PROMOTE_PAGE = 'subPages.promotePage';
const COMMAND_UNLINK_PAGE = 'subPages.unlinkPage';
const COMMAND_SAVE_NOTE_AS_MARKDOWN = 'subPages.saveNoteAsMarkdown';
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
const DIALOG_MOVE_PARENT_PREFIX = 'subPages.moveParentDialog';
const DIALOG_MOVE_BRANCH_TO_FOLDER_PREFIX = 'subPages.moveBranchToFolderDialog';
const DIALOG_MARKDOWN_EXPORT_PREFIX = 'subPages.markdownExportDialog';
const DIALOG_CREATE_IN_FOLDER_PREFIX = 'subPages.createInFolderDialog';

const SETTINGS_SECTION = 'subPages';
const SETTING_PANEL_SORT_MODE = 'subPages.panelSortMode';
const SETTING_PANEL_NOTE_TEXT_SIZE = 'subPages.panelNoteTextSize';
const SETTING_PANEL_ROW_SPACING = 'subPages.panelRowSpacing';
const SETTING_PANEL_ROW_VERTICAL_PADDING = 'subPages.panelRowVerticalPadding';
const SETTING_PANEL_TEXT_INSET = 'subPages.panelTextInset';
const SETTING_PANEL_NOTE_INDENT = 'subPages.panelNoteIndent';
const SETTING_PANEL_COLLAPSED_NOTE_IDS = 'subPages.panelCollapsedNoteIds';

const PARENT_ID_KEY = 'subPages.parentId';
const CHILD_IDS_KEY = 'subPages.childIds';

const DEFAULT_ROOT_TITLE = 'Untitled page';
const DEFAULT_CHILD_TITLE = 'Untitled sub-page';
const DEFAULT_ROOT_WHITEBOARD_TITLE = 'Untitled whiteboard';
const DEFAULT_CHILD_WHITEBOARD_TITLE = 'Untitled sub-page whiteboard';
const DEFAULT_EXPORT_TITLE = 'Untitled note';
const NOTE_LIST_PAGE_LIMIT = 100;
const RECENT_CHANGE_TIME_TTL = 10 * 60 * 1000;
const SETTLED_REFRESH_DELAYS = [1500, 4000];
const NATIVE_DRAG_MOVE_TTL = 2 * 60 * 1000;
const NATIVE_DRAG_RECONCILE_DELAYS = [400, 1200, 3000, 7000, 12000];
const MAX_PANEL_SEARCH_CACHE_ENTRIES = 50;
const MAX_EXTERNAL_SEARCH_RESULTS = 50;
const PRIVATE_VIEW_VERIFY_INTERVAL = 10_000;

type PanelSortMode = 'recentGroups' | 'manual' | 'title';
type SearchScope = 'all' | 'notebook';
type PageType = 'note' | 'whiteboard';

interface JoplinViewContext {
  viewScope: ViewScope;
  folder: FolderSummary | null;
  key: string;
  compatibilityError: string | null;
}

interface AiIndexStatus {
  ready: boolean;
  state: 'unavailable' | 'disabled' | 'preparing' | 'indexing' | 'ready';
  modelId: string | null;
  notesIndexed: number;
  totalNotes: number;
}

interface FolderSummary {
  id: string;
  title: string;
}

interface FolderNode {
  id: string;
  title: string;
  parent_id: string;
  children: FolderNode[];
}

interface NoteSummary {
  id: string;
  title: string;
  parent_id: string;
  user_updated_time: number;
  updated_time: number;
  is_todo: number;
  todo_completed: number;
  deleted_time: number;
  is_conflict: number;
  user_data: unknown;
  notebookTitle: string;
  pageType: PageType;
}

interface NoteExportData {
  id: string;
  title: string;
  body: string;
}

interface MarkdownExportPathSelection {
  filePath: string;
  overwriteHandled: boolean;
}

interface SearchExternalResult {
  id: string;
  title: string;
  parentId: string;
  notebookId: string;
  notebookTitle: string;
  pageType: PageType;
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
  notebookId: string;
  notebookTitle: string;
  pageType: PageType;
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

interface FolderCandidate {
  id: string;
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

interface PendingNativeDragMove {
  oldNotebookId: string;
  oldParentId: string | null;
  createdAt: number;
  noteIds: string[];
}

interface NativeDragBranchRoot {
  id: string;
  parentId?: string | null;
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
let collapsedNoteIds: string[] = [];
let collapsedNoteIdsWriteQueue: Promise<void> = Promise.resolve();
let lastPanelFolderId: string | null | undefined = undefined;
let lastPanelViewKey: string | undefined = undefined;
let lastValidViewContext: JoplinViewContext | null = null;
let lastValidNotebookContext: JoplinViewContext | null = null;
let lastNotesParentSetting: string | null = null;
let lastPrivateViewVerificationAt = 0;
let dialogSerial = 0;
const recentChangeTimes = new Map<string, number>();
const panelSearchCache = new Map<string, any>();
const pendingNativeDragMoves = new Map<string, PendingNativeDragMove>();
const whiteboardTypeCache = new Map<string, { updatedTime: number; isWhiteboard: boolean }>();
const whiteboardProbeIds = new Set<string>();
let whiteboardCandidateRevision = -1;
let whiteboardCandidateIds = new Set<string>();
let nativeDragReconcileTimers: any[] = [];

joplin.plugins.register({
  onStart: async () => {
    await registerSettings();
    await loadCollapsedNoteIds();
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
      description: 'Controls sibling ordering in the Sub-Pages panel. Recent groups uses each page update time plus descendant updates.',
      isEnum: true,
      options: {
        recentGroups: 'Recent groups',
        manual: 'Manual',
        title: 'Title',
      },
    },
    [SETTING_PANEL_NOTE_TEXT_SIZE]: {
      value: PANEL_APPEARANCE_DEFAULTS.noteTextSize,
      type: SettingItemType.Int,
      section: SETTINGS_SECTION,
      public: true,
      label: 'Note text size (px)',
      description: 'Sets the text size of note titles in the Sub-Pages panel.',
      minimum: PANEL_APPEARANCE_LIMITS.noteTextSize.minimum,
      maximum: PANEL_APPEARANCE_LIMITS.noteTextSize.maximum,
      step: 1,
    },
    [SETTING_PANEL_ROW_SPACING]: {
      value: PANEL_APPEARANCE_DEFAULTS.rowSpacing,
      type: SettingItemType.Int,
      section: SETTINGS_SECTION,
      public: true,
      label: 'Spacing between note rows (px)',
      description: 'Sets the vertical gap between note cards in the Sub-Pages panel, including search results.',
      minimum: PANEL_APPEARANCE_LIMITS.rowSpacing.minimum,
      maximum: PANEL_APPEARANCE_LIMITS.rowSpacing.maximum,
      step: 1,
    },
    [SETTING_PANEL_ROW_VERTICAL_PADDING]: {
      value: PANEL_APPEARANCE_DEFAULTS.rowVerticalPadding,
      type: SettingItemType.Int,
      section: SETTINGS_SECTION,
      public: true,
      label: 'Vertical padding within note cards (px)',
      description: 'Adds equal space above and below each note title. This increases card height without changing the gap between cards.',
      minimum: PANEL_APPEARANCE_LIMITS.rowVerticalPadding.minimum,
      maximum: PANEL_APPEARANCE_LIMITS.rowVerticalPadding.maximum,
      step: 1,
    },
    [SETTING_PANEL_TEXT_INSET]: {
      value: PANEL_APPEARANCE_DEFAULTS.textInset,
      type: SettingItemType.Int,
      section: SETTINGS_SECTION,
      public: true,
      label: 'Text inset within note rows (px)',
      description: 'Sets the left space between each note card edge and its title. Hierarchy is controlled by note indentation.',
      minimum: PANEL_APPEARANCE_LIMITS.textInset.minimum,
      maximum: PANEL_APPEARANCE_LIMITS.textInset.maximum,
      step: 1,
    },
    [SETTING_PANEL_NOTE_INDENT]: {
      value: PANEL_APPEARANCE_DEFAULTS.noteIndent,
      type: SettingItemType.Int,
      section: SETTINGS_SECTION,
      public: true,
      label: 'Note indentation per level (px)',
      description: 'Sets how far each child note card is inset from its parent card.',
      minimum: PANEL_APPEARANCE_LIMITS.noteIndent.minimum,
      maximum: PANEL_APPEARANCE_LIMITS.noteIndent.maximum,
      step: 1,
    },
    [SETTING_PANEL_COLLAPSED_NOTE_IDS]: {
      value: [],
      type: SettingItemType.Array,
      public: false,
      label: 'Collapsed note IDs',
      description: 'Internal state for restoring collapsed notes in the Sub-Pages panel.',
    },
  });
}

async function loadCollapsedNoteIds(): Promise<void> {
  try {
    const values = await joplin.settings.values([SETTING_PANEL_COLLAPSED_NOTE_IDS]);
    collapsedNoteIds = normalizeIdArray(values[SETTING_PANEL_COLLAPSED_NOTE_IDS]);
  } catch (error) {
    collapsedNoteIds = [];
    console.error('Sub-Pages could not load collapsed note state', error);
  }
}

async function saveCollapsedNoteIds(value: any): Promise<void> {
  collapsedNoteIds = normalizeIdArray(value);
  const snapshot = [...collapsedNoteIds];
  const write = collapsedNoteIdsWriteQueue
    .catch(() => undefined)
    .then(() => joplin.settings.setValue(SETTING_PANEL_COLLAPSED_NOTE_IDS, snapshot));
  collapsedNoteIdsWriteQueue = write;
  await write;
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
        lastPrivateViewVerificationAt = 0;
        invalidateWhiteboardCandidates();
        markPanelStateChanged();
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
        const createdId = await createChildPage(note.id);
        if (createdId) rememberSelectedNoteId(createdId);
        markPanelStateChanged();
        await refreshPanel(true);
      });
    },
  });

  await joplin.commands.register({
    name: COMMAND_CREATE_CHILD_WHITEBOARD,
    label: 'Create child whiteboard',
    iconName: 'fas fa-th',
    execute: async (...args: any[]) => {
      await runCommand(async () => {
        const note = await resolveContextNote(args);
        if (!note) {
          await notify('Select a page before creating a child whiteboard.');
          return;
        }
        const createdId = await createChildPage(note.id, 'whiteboard');
        if (createdId) rememberSelectedNoteId(createdId);
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
    name: COMMAND_MOVE_BRANCH_TO_FOLDER,
    label: 'Move page to notebook...',
    iconName: 'fas fa-folder-open',
    execute: async (...args: any[]) => {
      await runCommand(async () => {
        const noteIds = await resolveContextNoteIds(args);
        if (!noteIds.length) {
          await notify('Select one or more pages to move.');
          return;
        }
        await moveBranchesToFolder(noteIds);
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
    name: COMMAND_SAVE_NOTE_AS_MARKDOWN,
    label: 'Save note as Markdown...',
    iconName: 'fas fa-file-export',
    execute: async (...args: any[]) => {
      await runCommand(async () => {
        const note = await resolveContextNote(args);
        if (!note) {
          await notify('Select a note before saving it as Markdown.');
          return;
        }
        await saveNoteAsMarkdown(note.id);
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
  await joplin.views.menuItems.create('subPages.createChildWhiteboard.context', COMMAND_CREATE_CHILD_WHITEBOARD, MenuItemLocation.NoteListContextMenu);
  await joplin.views.menuItems.create('subPages.movePage.context', COMMAND_MOVE_PAGE, MenuItemLocation.NoteListContextMenu);
  await joplin.views.menuItems.create('subPages.moveBranchToFolder.context', COMMAND_MOVE_BRANCH_TO_FOLDER, MenuItemLocation.NoteListContextMenu);
  await joplin.views.menuItems.create('subPages.promotePage.context', COMMAND_PROMOTE_PAGE, MenuItemLocation.NoteListContextMenu);
  await joplin.views.menuItems.create('subPages.unlinkPage.context', COMMAND_UNLINK_PAGE, MenuItemLocation.NoteListContextMenu);
  await joplin.views.menuItems.create('subPages.saveNoteAsMarkdown.context', COMMAND_SAVE_NOTE_AS_MARKDOWN, MenuItemLocation.NoteListContextMenu);
  await joplin.views.menuItems.create('subPages.saveNoteAsMarkdown.note', COMMAND_SAVE_NOTE_AS_MARKDOWN, MenuItemLocation.Note);

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
    if (event.keys.some((key) => [
      SETTING_PANEL_SORT_MODE,
      SETTING_PANEL_NOTE_TEXT_SIZE,
      SETTING_PANEL_ROW_SPACING,
      SETTING_PANEL_ROW_VERTICAL_PADDING,
      SETTING_PANEL_TEXT_INSET,
      SETTING_PANEL_NOTE_INDENT,
    ].includes(key))) {
      markPanelStateChanged();
      schedulePanelRefresh(0);
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
    const noteIds = panelMessageNoteIds(message, noteId);

    if (name === 'ready') {
      panelReady = true;
      return panelStateResponse();
    }

    if (name === 'saveCollapsedNoteIds') {
      await saveCollapsedNoteIds(message?.collapsedNoteIds);
      return { ok: true };
    }

    if (name === 'refresh') {
      lastPrivateViewVerificationAt = 0;
      invalidateWhiteboardCandidates();
      markPanelStateChanged();
      return panelStateResponse();
    }

    if (name === 'stateIfChanged') {
      const revision = typeof message?.revision === 'number' ? message.revision : -1;
      const context = await activeJoplinViewContext();
      if (revision === panelStateRevision && context.key === lastPanelViewKey) {
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

    if (name === 'noteDragStarted') {
      await rememberNativeNoteDrag(message);
      return { ok: true };
    }

    if (name === 'createRoot') {
      const createdId = await createRootPage('note');
      if (createdId) rememberSelectedNoteId(createdId);
      markPanelStateChanged();
      return panelStateResponse(undefined, createdId || undefined);
    }

    if (name === 'createRootWhiteboard') {
      const createdId = await createRootPage('whiteboard');
      if (createdId) rememberSelectedNoteId(createdId);
      markPanelStateChanged();
      return panelStateResponse(undefined, createdId || undefined);
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
      await runNoteListParityCommand(name, noteIds.length ? noteIds : [noteId]);
      if (name !== 'openNoteInNewWindow' && name !== 'startExternalEditing' && name !== 'showNoteProperties' && name !== 'setTags') {
        for (const changedNoteId of noteIds.length ? noteIds : [noteId]) markNoteRecentlyChanged(changedNoteId);
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

    if (name === 'saveNoteAsMarkdown' && noteId) {
      const savedPath = await saveNoteAsMarkdown(noteId);
      return {
        ok: !!savedPath,
        message: savedPath ? `Saved Markdown to ${savedPath}.` : undefined,
      };
    }

    if (name === 'createChild' && noteId) {
      const createdId = await createChildPage(noteId, 'note');
      if (createdId) rememberSelectedNoteId(createdId);
      markPanelStateChanged();
      return panelStateResponse(undefined, createdId || undefined);
    }

    if (name === 'createChildWhiteboard' && noteId) {
      const createdId = await createChildPage(noteId, 'whiteboard');
      if (createdId) rememberSelectedNoteId(createdId);
      markPanelStateChanged();
      return panelStateResponse(undefined, createdId || undefined);
    }

    if (name === 'move' && noteId) {
      await movePageWithDialog(noteId);
      markPanelStateChanged();
      return panelStateResponse();
    }

    if (name === 'dropOnNote' && noteId) {
      const targetNoteId = typeof message?.targetNoteId === 'string' ? message.targetNoteId : '';
      if (!targetNoteId) return { ok: false, message: 'Drop target is missing.' };
      await movePageUnderParent(noteId, targetNoteId);
      markPanelStateChanged();
      return panelStateResponse();
    }

    if (name === 'dropToRoot' && noteId) {
      await promotePageToRoot(noteId);
      markPanelStateChanged();
      return panelStateResponse();
    }

    if (name === 'moveBranchToFolder' && noteId) {
      await moveBranchesToFolder(noteIds.length ? noteIds : [noteId]);
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

    if (name === 'confirm') {
      const prompt = typeof message?.message === 'string' && message.message.trim()
        ? message.message.trim()
        : 'Continue?';
      const confirmed = await joplin.views.dialogs.showMessageBox(prompt);
      return { ok: true, confirmed: confirmed === 0 };
    }

    return { ok: false, message: 'Unsupported Sub-Pages panel action.' };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    console.error('Sub-Pages panel action failed', error);
    await showToast(`Sub-Pages failed: ${messageText}`, ToastType.Error);
    return { ok: false, message: messageText };
  }
}

async function panelStateResponse(message?: string, selectedNoteIdOverride?: string): Promise<any> {
  const response: any = {
    ok: true,
    revision: panelStateRevision,
    collapsedNoteIds: [...collapsedNoteIds],
    state: await buildPanelState(selectedNoteIdOverride),
  };
  if (message) response.message = message;
  return response;
}

function panelMessageNoteIds(message: any, fallbackNoteId: string): string[] {
  const noteIds: string[] = Array.isArray(message?.noteIds)
    ? message.noteIds.filter((id: any) => typeof id === 'string' && id)
    : [];
  if (fallbackNoteId && !noteIds.includes(fallbackNoteId)) noteIds.unshift(fallbackNoteId);
  return [...new Set<string>(noteIds)];
}

function normalizeIdArray(value: any): string[] {
  return Array.isArray(value)
    ? [...new Set<string>(value.filter((id: any) => typeof id === 'string' && id))]
    : [];
}

async function panelSearchResponse(query: string, scope: SearchScope): Promise<any> {
  const trimmedQuery = query.trim();
  const context = await activeJoplinViewContext();
  const effectiveScope: SearchScope = context.viewScope === 'all' ? 'all' : scope;
  if (!trimmedQuery) {
    return {
      ok: true,
      query: '',
      scope: effectiveScope,
      noteIds: [],
      externalResults: [],
    };
  }

  const folder = context.folder;
  const aiIndexStatus = await getAiIndexStatusSafe();
  const aiCacheKey = aiIndexStatus
    ? `${aiIndexStatus.state}:${aiIndexStatus.modelId ?? ''}:${aiIndexStatus.notesIndexed}:${aiIndexStatus.totalNotes}`
    : 'unknown';
  const cacheKey = `${panelStateRevision}:${context.key}:${effectiveScope}:${aiCacheKey}:${trimmedQuery.toLocaleLowerCase()}`;
  const cached = panelSearchCache.get(cacheKey);
  if (cached) return cached;

  if (!folder && context.viewScope === 'notebook') {
    return {
      ok: false,
      query: trimmedQuery,
      scope: effectiveScope,
      noteIds: [],
      externalResults: [],
      message: 'No notebook is selected.',
    };
  }

  try {
    const viewNotes = context.viewScope === 'all' ? await listAllNotes() : await listNotebookNotes(folder!.id);
    const viewNoteIds = new Set(viewNotes.map(note => note.id));
    const keywordResults = (await searchNotes(trimmedQuery))
      .filter((note) => !note.deleted_time && !note.is_conflict)
      .filter((note) => effectiveScope === 'all' || viewNoteIds.has(note.id));
    const semanticNoteIds: string[] = [];
    let semanticMessage = semanticStatusMessage(aiIndexStatus);

    if (aiIndexStatus && (aiIndexStatus.state === 'ready' || aiIndexStatus.state === 'indexing')) {
      try {
        const results = await joplin.ai.search({
          query: { text: trimmedQuery },
          scope: semanticSearchScope(effectiveScope, folder?.id ?? null),
          relevance: 'normal',
        });
        const seenSemanticIds = new Set<string>();
        for (const result of Array.isArray(results) ? results : []) {
          const resultNoteId = nonEmptyString(result?.noteId);
          if (!resultNoteId || seenSemanticIds.has(resultNoteId)) continue;
          seenSemanticIds.add(resultNoteId);
          semanticNoteIds.push(resultNoteId);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        semanticMessage = `Semantic search was unavailable (${detail}); showing keyword matches.`;
        console.warn('Sub-Pages: semantic search failed; using keyword results', error);
      }
    }

    const noteById = new Map<string, NoteSummary>();
    for (const note of viewNotes) noteById.set(note.id, note);
    for (const note of keywordResults) noteById.set(note.id, note);
    const missingSemanticIds = semanticNoteIds.filter((noteId) => !noteById.has(noteId));
    const missingSemanticNotes = await Promise.all(missingSemanticIds.map((noteId) => getNote(noteId)));
    for (const note of missingSemanticNotes) {
      if (note && !note.deleted_time && !note.is_conflict) noteById.set(note.id, note);
    }

    const rankedResults = mergeHybridSearchResults(keywordResults, semanticNoteIds, noteById)
      .filter((note) => effectiveScope === 'all' || viewNoteIds.has(note.id));
    await decorateNotes(rankedResults);
    const noteIds: string[] = [];
    const externalResults: SearchExternalResult[] = [];
    const folderTitleCache = new Map<string, string>();
    const seenNoteIds = new Set<string>();
    let omittedExternalResultCount = 0;

    for (const note of rankedResults) {
      if (seenNoteIds.has(note.id)) continue;
      seenNoteIds.add(note.id);

      if (viewNoteIds.has(note.id)) {
        noteIds.push(note.id);
      } else if (effectiveScope === 'all' && context.viewScope === 'notebook') {
        if (externalResults.length < MAX_EXTERNAL_SEARCH_RESULTS) {
          externalResults.push(await toExternalSearchResult(note, folderTitleCache));
        } else {
          omittedExternalResultCount += 1;
        }
      }
    }

    const response = {
      ok: true,
      query: trimmedQuery,
      scope: effectiveScope,
      noteIds,
      externalResults,
      aiIndexStatus,
      message: [
        semanticMessage,
        omittedExternalResultCount
          ? `Showing first ${MAX_EXTERNAL_SEARCH_RESULTS} external notebook matches. Narrow the search to see more.`
          : '',
      ].filter(Boolean).join(' ') || undefined,
    };
    setPanelSearchCache(cacheKey, response);
    return response;
  } catch (error) {
    console.warn('Sub-Pages: Joplin search failed', error);
    return {
      ok: false,
      query: trimmedQuery,
      scope: effectiveScope,
      noteIds: [],
      externalResults: [],
      aiIndexStatus,
      message: 'Search failed. Try Refresh Sub-Pages panel or restart Joplin.',
    };
  }
}

function mergeHybridSearchResults(
  keywordResults: NoteSummary[],
  semanticNoteIds: string[],
  noteById: Map<string, NoteSummary>
): NoteSummary[] {
  const scores = reciprocalRankScores(keywordResults.map((note) => note.id), semanticNoteIds);

  return [...scores.keys()]
    .map((noteId) => noteById.get(noteId))
    .filter((note): note is NoteSummary => !!note)
    .sort((a, b) => {
      const scoreDelta = (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0);
      if (scoreDelta) return scoreDelta;
      const timeDelta = noteTime(b) - noteTime(a);
      return timeDelta || compareTitles(displayTitle(a), displayTitle(b));
    });
}

function semanticStatusMessage(status: AiIndexStatus | null): string {
  if (!status) return 'Semantic search status is unavailable; showing keyword matches.';
  if (status.state === 'indexing') {
    return `Semantic index is still building (${status.notesIndexed}/${status.totalNotes} notes); results may be incomplete.`;
  }
  if (status.state === 'disabled') return 'Semantic search is disabled in Joplin AI settings; showing keyword matches.';
  if (status.state === 'preparing') return 'Semantic search is preparing its model; showing keyword matches.';
  if (status.state === 'unavailable') return 'Semantic search is unavailable on this platform; showing keyword matches.';
  return '';
}

function setPanelSearchCache(cacheKey: string, response: any): void {
  if (panelSearchCache.has(cacheKey)) panelSearchCache.delete(cacheKey);
  panelSearchCache.set(cacheKey, response);

  while (panelSearchCache.size > MAX_PANEL_SEARCH_CACHE_ENTRIES) {
    const oldestKey = panelSearchCache.keys().next().value;
    if (oldestKey === undefined) break;
    panelSearchCache.delete(oldestKey);
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
  return ['id', 'title', 'parent_id', 'user_updated_time', 'updated_time', 'is_todo', 'todo_completed', 'deleted_time', 'is_conflict'];
}

async function toExternalSearchResult(note: NoteSummary, folderTitleCache: Map<string, string>): Promise<SearchExternalResult> {
  return {
    id: note.id,
    title: displayTitle(note),
    parentId: note.parent_id,
    notebookId: note.parent_id,
    notebookTitle: note.notebookTitle || await searchResultNotebookTitle(note.parent_id, folderTitleCache),
    pageType: note.pageType,
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
      invalidateWhiteboardCandidates();
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
  if (!force && !(await panelVisible())) return;

  const state = await buildPanelState();
  joplin.views.panels.postMessage(panelHandle, {
    name: 'state',
    revision: panelStateRevision,
    state,
  });
}

async function refreshPanelIfSelectedFolderChanged(): Promise<void> {
  const context = await activeJoplinViewContext();
  if (lastPanelViewKey !== undefined && context.key === lastPanelViewKey) return;

  markPanelStateChanged();
  schedulePanelRefresh(50);
}

async function handleNoteChangeEvent(event: any): Promise<void> {
  const noteId = changedNoteIdFromEvent(event) ?? await selectedNoteId();
  if (noteId) {
    markNoteRecentlyChanged(noteId);
    whiteboardProbeIds.add(noteId);
    whiteboardTypeCache.delete(noteId);
  }
  await reconcilePendingNativeDragMoves(noteId || undefined);
  markPanelStateChanged();

  schedulePanelRefresh(200);
  scheduleSettledPanelRefreshes();
  scheduleSelectionRefresh();
}

async function rememberNativeNoteDrag(message: any): Promise<void> {
  const branchRootIds = normalizeIdArray(message?.branchRootIds);
  const noteIds = normalizeIdArray(message?.noteIds);
  if (!branchRootIds.length || !noteIds.length) return;

  const now = Date.now();
  const sourceFolderId = nonEmptyString(message?.sourceFolderId);
  const branchRootById = nativeDragBranchRootMap(message);
  for (const rootId of branchRootIds) {
    let oldNotebookId = sourceFolderId;
    let oldParentId = branchRootById.has(rootId) ? branchRootById.get(rootId)!.parentId : undefined;

    if (!oldNotebookId || oldParentId === undefined) {
      const note = await getNote(rootId);
      if (!note) continue;

      if (!oldNotebookId) oldNotebookId = note.parent_id;
      if (oldParentId === undefined) {
        const meta = await getMeta(rootId);
        oldParentId = meta.parentId;
      }
    }

    pendingNativeDragMoves.set(rootId, {
      oldNotebookId,
      oldParentId: oldParentId ?? null,
      createdAt: now,
      noteIds,
    });
  }

  scheduleNativeDragReconcileChecks();
}

function nativeDragBranchRootMap(message: any): Map<string, NativeDragBranchRoot> {
  const output = new Map<string, NativeDragBranchRoot>();
  const roots = Array.isArray(message?.branchRoots) ? message.branchRoots : [];

  for (const root of roots) {
    const id = nonEmptyString(root?.id);
    if (!id) continue;

    const value: NativeDragBranchRoot = { id };
    if (Object.prototype.hasOwnProperty.call(root, 'parentId')) {
      value.parentId = nonEmptyString(root.parentId);
    }

    output.set(id, value);
  }

  return output;
}

function nonEmptyString(value: any): string | null {
  return typeof value === 'string' && value ? value : null;
}

function scheduleNativeDragReconcileChecks(): void {
  for (const timer of nativeDragReconcileTimers) clearTimeout(timer);
  nativeDragReconcileTimers = NATIVE_DRAG_RECONCILE_DELAYS.map((delay) => setTimeout(() => {
    reconcilePendingNativeDragMoves().catch((error) => {
      console.error('Sub-Pages native drag reconciliation failed', error);
    });
  }, delay));
}

function clearNativeDragReconcileTimers(): void {
  for (const timer of nativeDragReconcileTimers) clearTimeout(timer);
  nativeDragReconcileTimers = [];
}

async function reconcilePendingNativeDragMoves(changedNoteId?: string): Promise<void> {
  if (!pendingNativeDragMoves.size) {
    clearNativeDragReconcileTimers();
    return;
  }

  const now = Date.now();
  let changed = false;

  for (const [rootId, pending] of [...pendingNativeDragMoves.entries()]) {
    if (now - pending.createdAt > NATIVE_DRAG_MOVE_TTL) {
      console.warn('Sub-Pages: native drag move expired before notebook change was observed', rootId);
      pendingNativeDragMoves.delete(rootId);
      continue;
    }

    if (changedNoteId && changedNoteId !== rootId) continue;

    const note = await getNote(rootId);
    if (!note) continue;
    if (note.parent_id === pending.oldNotebookId) continue;

    pendingNativeDragMoves.delete(rootId);
    if (pending.oldParentId) {
      await setPageParentLink(rootId, null);
    }

    for (const noteId of pending.noteIds) markNoteRecentlyChanged(noteId);
    changed = true;
  }

  if (changed) {
    markPanelStateChanged();
    schedulePanelRefresh(100);
    scheduleSettledPanelRefreshes();
    scheduleSelectionRefresh();
  }

  if (!pendingNativeDragMoves.size) clearNativeDragReconcileTimers();
}

async function panelVisible(): Promise<boolean> {
  if (!panelHandle) return false;
  try {
    return await joplin.views.panels.visible(panelHandle);
  } catch {
    return true;
  }
}

async function buildPanelState(selectedNoteIdOverride?: string): Promise<any> {
  const appearance = await panelAppearance();
  try {
    const context = await activeJoplinViewContext();
    const folder = context.folder;
    lastPanelFolderId = folder?.id ?? null;
    lastPanelViewKey = context.key;
    const currentSelectedNoteId = selectedNoteIdOverride !== undefined ? selectedNoteIdOverride : await selectedNoteId();
    if (context.viewScope === 'notebook' && !folder) {
      return {
        folder: null,
        viewScope: context.viewScope,
        compatibilityError: context.compatibilityError,
        selectedNoteId: currentSelectedNoteId,
        sortMode: await panelSortMode(),
        appearance,
        nodes: [],
        noteCount: 0,
        repairCount: 0,
        metadataItemCount: 0,
        aiIndexStatus: await getAiIndexStatusSafe(),
        error: context.compatibilityError || 'No notebook is selected.',
      };
    }

    const notes = context.viewScope === 'all' ? await listAllNotes() : await listNotebookNotes(folder!.id);
    await decorateNotes(notes);
    const sortMode = await panelSortMode();
    const tree = await buildTree(notes, sortMode);

    return {
      folder,
      viewScope: context.viewScope,
      compatibilityError: context.compatibilityError,
      selectedNoteId: currentSelectedNoteId,
      sortMode,
      appearance,
      nodes: tree.roots,
      noteCount: notes.length,
      repairCount: tree.repairCount,
      metadataItemCount: tree.metadataItemCount,
      aiIndexStatus: await getAiIndexStatusSafe(),
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      folder: null,
      viewScope: lastValidViewContext?.viewScope ?? 'notebook',
      compatibilityError: lastValidViewContext?.compatibilityError ?? null,
      selectedNoteId: selectedNoteIdOverride !== undefined ? selectedNoteIdOverride : await selectedNoteId(),
      sortMode: await panelSortMode(),
      appearance,
      nodes: [],
      noteCount: 0,
      repairCount: 0,
      metadataItemCount: 0,
      aiIndexStatus: await getAiIndexStatusSafe(),
      error: message,
    };
  }
}

async function panelAppearance(): Promise<PanelAppearance> {
  try {
    const values = await joplin.settings.values([
      SETTING_PANEL_NOTE_TEXT_SIZE,
      SETTING_PANEL_ROW_SPACING,
      SETTING_PANEL_ROW_VERTICAL_PADDING,
      SETTING_PANEL_TEXT_INSET,
      SETTING_PANEL_NOTE_INDENT,
    ]);
    return normalizePanelAppearance({
      noteTextSize: values[SETTING_PANEL_NOTE_TEXT_SIZE],
      rowSpacing: values[SETTING_PANEL_ROW_SPACING],
      rowVerticalPadding: values[SETTING_PANEL_ROW_VERTICAL_PADDING],
      textInset: values[SETTING_PANEL_TEXT_INSET],
      noteIndent: values[SETTING_PANEL_NOTE_INDENT],
    });
  } catch {
    return { ...PANEL_APPEARANCE_DEFAULTS };
  }
}

async function buildTree(notes: NoteSummary[], sortMode: PanelSortMode): Promise<TreeBuildResult> {
  const noteMap = toNoteMap(notes);
  const metaMap = await buildMetaMap(notes);
  const cycleAffectedIds = cycleAffectedNoteIds(notes, metaMap, noteMap);
  const metadataItemCount = metadataItemCountFor(metaMap);
  const externalParentReasons = await externalParentRepairReasons(notes, noteMap, metaMap);
  const repairOperations = repairOperationsForNotes(notes, noteMap, metaMap, externalParentReasons, cycleAffectedIds);
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
    } else if (noteMap.get(parentId)!.parent_id !== note.parent_id) {
      repairReason = 'Parent is in another notebook';
    } else if (cycleAffectedIds.has(note.id)) {
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
    const effectiveTime = children.reduce((max, child) => Math.max(max, child.effectiveTime), updatedTime);
    return {
      id: note.id,
      title: displayTitle(note),
      parentId: parentByNoteId.get(note.id) ?? null,
      notebookId: note.parent_id,
      notebookTitle: note.notebookTitle,
      pageType: note.pageType,
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
    repairCount: repairOperations.length,
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
  panelSearchCache.clear();
}

function invalidateWhiteboardCandidates(): void {
  whiteboardCandidateRevision = -1;
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

async function createRootPage(pageType: PageType = 'note'): Promise<string | null> {
  const context = await activeJoplinViewContext();
  const folder = context.viewScope === 'all'
    ? await chooseNotebookForCreation(pageType)
    : context.folder;
  if (!folder) {
    if (context.viewScope !== 'all') await notify('Select a notebook before creating a root page.');
    return null;
  }

  const baseTitle = pageType === 'whiteboard' ? DEFAULT_ROOT_WHITEBOARD_TITLE : DEFAULT_ROOT_TITLE;
  const title = await uniquePageTitle(folder.id, baseTitle);
  const created = await joplin.data.post(['notes'], null, {
    parent_id: folder.id,
    title,
    body: pageType === 'whiteboard' ? EMPTY_WHITEBOARD_BODY : '',
  });

  if (created?.id) {
    const noteId = String(created.id);
    if (pageType === 'whiteboard') whiteboardTypeCache.set(noteId, { updatedTime: numberValue(created.updated_time), isWhiteboard: true });
    await openNote(noteId);
    await showToast(`Created "${title}".`);
    return noteId;
  }

  return null;
}

async function createChildPage(parentId: string, pageType: PageType = 'note'): Promise<string | null> {
  const parent = await getNote(parentId);
  if (!parent) {
    await notify('The parent page could not be loaded.');
    return null;
  }

  const baseTitle = pageType === 'whiteboard' ? DEFAULT_CHILD_WHITEBOARD_TITLE : DEFAULT_CHILD_TITLE;
  const title = await uniquePageTitle(parent.parent_id, baseTitle);
  const created = await joplin.data.post(['notes'], null, {
    parent_id: parent.parent_id,
    title,
    body: pageType === 'whiteboard' ? EMPTY_WHITEBOARD_BODY : '',
  });

  const child = created?.id ? await getNote(String(created.id)) : null;
  if (!child) {
    await notify('The child page was created, but could not be loaded.');
    return null;
  }

  const attached = await attachPageToParent(child, parent);
  if (!attached) return null;

  if (pageType === 'whiteboard') {
    child.pageType = 'whiteboard';
    whiteboardTypeCache.set(child.id, { updatedTime: child.updated_time, isWhiteboard: true });
  }
  await openNote(child.id);
  await showToast(`Created child ${pageType === 'whiteboard' ? 'whiteboard' : 'page'} under "${displayTitle(parent)}".`);
  return child.id;
}

async function chooseNotebookForCreation(pageType: PageType): Promise<FolderSummary | null> {
  const folders = await folderCandidates();
  if (!folders.length) {
    await notify('No notebooks were found.');
    return null;
  }

  const options = folders.map((folder) => {
    return `<option value="${escapeHtml(folder.id)}">${escapeHtml(folder.path.join(' / '))}</option>`;
  }).join('');
  const handle = await createDialog(DIALOG_CREATE_IN_FOLDER_PREFIX);
  const itemLabel = pageType === 'whiteboard' ? 'whiteboard' : 'page';
  await joplin.views.dialogs.setHtml(handle, `
    <!doctype html>
    <html>
      <head>
        <style>
          html, body { box-sizing: border-box; color: var(--joplin-color, #222); font-family: var(--joplin-font-family, sans-serif); font-size: var(--joplin-font-size, 13px); margin: 0; }
          *, *::before, *::after { box-sizing: inherit; }
          form { min-width: 0; padding: 16px; width: min(380px, calc(100vw - 32px)); }
          p { margin: 0 0 12px; }
          label { display: block; font-weight: 600; }
          select { background: var(--joplin-background-color, #fff); color: var(--joplin-color, #222); display: block; font: inherit; font-weight: normal; margin-top: 8px; width: 100%; }
        </style>
      </head>
      <body>
        <form name="createInFolder">
          <p>Choose a notebook for the new root ${itemLabel}.</p>
          <label>Notebook<select name="folderId">${options}</select></label>
        </form>
      </body>
    </html>
  `);
  await joplin.views.dialogs.setButtons(handle, [
    { id: 'ok', title: 'Create' },
    { id: 'cancel', title: 'Cancel' },
  ]);
  await joplin.views.dialogs.setFitToContent(handle, true);

  const result = await joplin.views.dialogs.open(handle);
  const folderId = result.id === 'ok' ? result.formData?.createInFolder?.folderId : null;
  if (typeof folderId !== 'string' || !folderId) return null;
  const candidate = folders.find((folder) => folder.id === folderId);
  return candidate ? { id: candidate.id, title: candidate.path[candidate.path.length - 1] || 'Selected notebook' } : null;
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

  await setPageParentLink(child.id, parent.id);
  return true;
}

async function movePageUnderParent(childId: string, parentId: string): Promise<void> {
  const child = await getNote(childId);
  if (!child) {
    await notify('The dragged page could not be loaded.');
    return;
  }

  const parent = await getNote(parentId);
  if (!parent) {
    await notify('The drop target page could not be loaded.');
    return;
  }

  const attached = await attachPageToParent(child, parent);
  if (!attached) return;

  await openNote(child.id);
  await showToast(`Moved "${displayTitle(child)}" under "${displayTitle(parent)}".`);
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

  const handle = await createDialog(DIALOG_MOVE_PARENT_PREFIX);
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
          form { min-width: 0; padding: 16px; width: min(360px, calc(100vw - 32px)); }
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

async function moveBranchesToFolder(noteIds: string[]): Promise<void> {
  const rootIds = [...new Set(noteIds)].filter(Boolean);
  if (!rootIds.length) return;

  const folders = await folderCandidates();
  if (!folders.length) {
    await notify('No notebooks were found.');
    return;
  }

  const branchInfo = await branchMoveInfo(rootIds);
  if (!branchInfo.branchRootIds.length || !branchInfo.noteIds.length) {
    await notify('The selected pages could not be loaded.');
    return;
  }

  const options = folders.map((folder) => {
    return `<option value="${escapeHtml(folder.id)}">${escapeHtml(folder.path.join(' / '))}</option>`;
  }).join('');
  const selectedLabel = branchInfo.branchRootTitles.length === 1
    ? `"${branchInfo.branchRootTitles[0]}"`
    : `${branchInfo.branchRootTitles.length} selected pages`;

  const handle = await createDialog(DIALOG_MOVE_BRANCH_TO_FOLDER_PREFIX);
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
          form { min-width: 0; padding: 16px; width: min(380px, calc(100vw - 32px)); }
          p { margin: 0 0 12px; }
          .detail { color: var(--joplin-color-faded, #666); font-size: 12px; margin-bottom: 16px; }
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
        <form name="moveBranch">
          <p>Choose a notebook for ${escapeHtml(selectedLabel)}.</p>
          <p class="detail">${branchInfo.noteIds.length} page${branchInfo.noteIds.length === 1 ? '' : 's'} will move. Child pages stay linked to their parents.</p>
          <label>
            Notebook
            <select name="folderId">
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

  const folderId = result.formData?.moveBranch?.folderId;
  if (!folderId || typeof folderId !== 'string') return;

  const branchRootsToDetach: string[] = [];
  for (const branchRootId of branchInfo.branchRootIds) {
    const root = await getNote(branchRootId);
    if (root && root.parent_id !== folderId) branchRootsToDetach.push(branchRootId);
  }

  const movingNoteIds: string[] = [];
  for (const movingNoteId of branchInfo.noteIds) {
    const movingNote = await getNote(movingNoteId);
    if (movingNote && movingNote.parent_id !== folderId) movingNoteIds.push(movingNoteId);
  }

  if (!branchRootsToDetach.length && !movingNoteIds.length) {
    await showToast(branchInfo.branchRootIds.length === 1
      ? 'That page is already in the selected notebook.'
      : 'Those pages are already in the selected notebook.');
    return;
  }

  for (const movingNoteId of movingNoteIds) {
    await joplin.data.put(['notes', movingNoteId], null, {
      parent_id: folderId,
    });
    markNoteRecentlyChanged(movingNoteId);
  }

  for (const branchRootId of branchRootsToDetach) {
    await setPageParentLink(branchRootId, null);
  }

  await showToast(`Moved ${movingNoteIds.length} page${movingNoteIds.length === 1 ? '' : 's'} to notebook.`);
}

async function branchMoveInfo(selectedNoteIds: string[]): Promise<{ branchRootIds: string[]; branchRootTitles: string[]; noteIds: string[] }> {
  const selected = new Set(selectedNoteIds);
  const selectedNotes = (await Promise.all([...selected].map((noteId) => getNote(noteId))))
    .filter((note): note is NoteSummary => !!note);
  const selectedNoteMap = toNoteMap(selectedNotes);
  const notesByNotebook = new Map<string, NoteSummary[]>();
  const metaByNotebook = new Map<string, Map<string, HierarchyMeta>>();

  for (const note of selectedNotes) {
    if (!notesByNotebook.has(note.parent_id)) {
      const notes = await listNotebookNotes(note.parent_id);
      notesByNotebook.set(note.parent_id, notes);
      metaByNotebook.set(note.parent_id, await buildMetaMap(notes));
    }
  }

  const branchRootIds = selectedNotes
    .filter((note) => !hasSelectedAncestor(note, selected, selectedNoteMap, metaByNotebook.get(note.parent_id) ?? new Map()))
    .map((note) => note.id);
  const branchRootTitles = branchRootIds.map((id) => displayTitle(selectedNoteMap.get(id)));
  const output = new Set<string>();

  for (const branchRootId of branchRootIds) {
    const root = selectedNoteMap.get(branchRootId);
    if (!root) continue;
    const notes = notesByNotebook.get(root.parent_id) ?? [];
    const metaMap = metaByNotebook.get(root.parent_id) ?? new Map();
    collectBranchIds(branchRootId, notes, metaMap, output);
  }

  return {
    branchRootIds,
    branchRootTitles,
    noteIds: [...output],
  };
}

function hasSelectedAncestor(note: NoteSummary, selectedIds: Set<string>, selectedNoteMap: Map<string, NoteSummary>, metaMap: Map<string, HierarchyMeta>): boolean {
  let parentId = metaMap.get(note.id)?.parentId ?? null;
  const seen = new Set<string>();

  while (parentId && !seen.has(parentId)) {
    if (selectedIds.has(parentId)) return true;
    seen.add(parentId);
    const selectedParent = selectedNoteMap.get(parentId);
    if (selectedParent && selectedParent.parent_id !== note.parent_id) return false;
    parentId = metaMap.get(parentId)?.parentId ?? null;
  }

  return false;
}

function collectBranchIds(rootId: string, notes: NoteSummary[], metaMap: Map<string, HierarchyMeta>, output: Set<string>): void {
  if (output.has(rootId)) return;
  output.add(rootId);

  for (const note of notes) {
    if (metaMap.get(note.id)?.parentId === rootId) collectBranchIds(note.id, notes, metaMap, output);
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

  await setPageParentLink(note.id, null);
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
    await setPageParentLink(note.id, null);
  }

  if (directChildIds.length) {
    await clearChildIds(note.id);
    for (const childId of directChildIds) {
      const childMeta = await getMeta(childId);
      if (childMeta.parentId === note.id) {
        await setPageParentLink(childId, null);
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
  const context = await activeJoplinViewContext();
  const operations = await repairOperationsForCurrentView(context);
  if (!operations.length) return 0;

  const confirmed = await joplin.views.dialogs.showMessageBox(
    `Repair will write ${operations.length} Sub-Pages metadata item${operations.length === 1 ? '' : 's'} in ${context.viewScope === 'all' ? 'All Notes' : 'the selected notebook'}. Continue?`
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

async function repairOperationsForCurrentView(context?: JoplinViewContext): Promise<RepairOperation[]> {
  context = context ?? await activeJoplinViewContext();
  if (context.viewScope === 'notebook' && !context.folder) {
    await notify('Select a notebook before repairing Sub-Pages metadata.');
    return [];
  }

  const notes = context.viewScope === 'all' ? await listAllNotes() : await listNotebookNotes(context.folder!.id);
  const noteMap = toNoteMap(notes);
  const metaMap = await buildMetaMap(notes);
  const cycleAffectedIds = cycleAffectedNoteIds(notes, metaMap, noteMap);
  const externalReasons = await externalParentRepairReasons(notes, noteMap, metaMap);
  return repairOperationsForNotes(notes, noteMap, metaMap, externalReasons, cycleAffectedIds);
}

function repairOperationsForNotes(
  notes: NoteSummary[],
  noteMap: Map<string, NoteSummary>,
  metaMap: Map<string, HierarchyMeta>,
  externalReasons: Map<string, string>,
  cycleAffectedIds: Set<string>
): RepairOperation[] {
  const effectiveParentIds = new Map<string, string | null>();
  const operations: RepairOperation[] = [];

  for (const note of notes) {
    const meta = metaMap.get(note.id) ?? emptyMeta();
    const parentId = meta.parentId;
    const invalidParent = !!parentId && (
      parentId === note.id
      || !noteMap.has(parentId)
      || noteMap.get(parentId)?.parent_id !== note.parent_id
      || cycleAffectedIds.has(note.id)
      || externalReasons.has(note.id)
    );

    if (invalidParent) {
      operations.push({ type: 'clearParentId', noteId: note.id });
      effectiveParentIds.set(note.id, null);
    } else {
      effectiveParentIds.set(note.id, parentId);
    }
  }

  const childIdsByParent = groupIdsByParent(notes.map((note) => note.id), effectiveParentIds);

  for (const parent of notes) {
    const meta = metaMap.get(parent.id) ?? emptyMeta();
    const childIds = childIdsByParent.get(parent.id) ?? [];

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

async function resolveContextNoteIds(args: any[]): Promise<string[]> {
  if (Array.isArray(args) && args.length) {
    const context = args[0];
    if (context && Array.isArray(context.noteIds) && context.noteIds.length) {
      return [...new Set<string>(context.noteIds.filter((noteId: any) => typeof noteId === 'string' && noteId))];
    }
  }

  try {
    const noteIds = await joplin.workspace.selectedNoteIds();
    if (Array.isArray(noteIds)) {
      return [...new Set<string>(noteIds.filter((noteId: any) => typeof noteId === 'string' && noteId))];
    }
  } catch {
    // Fall back to selectedNote below.
  }

  const noteId = await resolveContextNoteId([]);
  return noteId ? [noteId] : [];
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

async function folderSummaryById(folderId: string): Promise<FolderSummary | null> {
  if (!folderId) return null;
  try {
    const folder = await joplin.data.get(['folders', folderId], { fields: ['id', 'title'] });
    if (!folder?.id) return null;
    return {
      id: String(folder.id),
      title: typeof folder.title === 'string' && folder.title.trim() ? folder.title.trim() : 'Selected notebook',
    };
  } catch {
    return null;
  }
}

async function activeJoplinViewContext(): Promise<JoplinViewContext> {
  let notesParentSetting: string | null = null;
  try {
    const [value] = await joplin.settings.globalValues(['notesParent']);
    notesParentSetting = typeof value === 'string' ? value : null;
    const privateStateIsFresh = Date.now() - lastPrivateViewVerificationAt < PRIVATE_VIEW_VERIFY_INTERVAL;
    if (lastValidViewContext && privateStateIsFresh && notesParentSetting !== null && notesParentSetting === lastNotesParentSetting) {
      return lastValidViewContext;
    }
  } catch {
    // The private store path below remains the authoritative fallback.
  }

  try {
    // Joplin 3.7.9 does not expose the active note-list parent publicly. The
    // sandbox proxy can reach the workspace's Redux store, so isolate that
    // version-specific access here and keep the rest of the plugin on public APIs.
    lastPrivateViewVerificationAt = Date.now();
    const rootState = await withTimeout((joplin.workspace as any).store.getState(), 2500, 'Joplin view context');
    const state = mainWindowStateFromRoot(rootState);
    const classification = classifyJoplinViewState(state);
    if (!state || !classification) {
      throw new Error('Joplin main-window note-list state is unavailable.');
    }

    if (classification.viewScope === 'all') {
      const context: JoplinViewContext = {
        viewScope: 'all',
        folder: null,
        key: `all:${ALL_NOTES_FILTER_ID}`,
        compatibilityError: null,
      };
      lastNotesParentSetting = notesParentSetting;
      lastValidViewContext = context;
      return context;
    }

    if (!classification.folderId && lastValidNotebookContext) {
      const context = { ...lastValidNotebookContext, compatibilityError: null };
      lastNotesParentSetting = notesParentSetting;
      lastValidViewContext = context;
      return context;
    }

    const stateFolderId = classification.folderId ?? '';
    const folder = stateFolderId ? await folderSummaryById(stateFolderId) : await selectedFolderSummary();
    const context: JoplinViewContext = {
      viewScope: 'notebook',
      folder,
      key: `notebook:${folder?.id ?? ''}`,
      compatibilityError: null,
    };
    lastNotesParentSetting = notesParentSetting;
    lastValidViewContext = context;
    if (folder) lastValidNotebookContext = context;
    return context;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const compatibilityError = `Unable to mirror Joplin's notebook/All Notes selection on this build. ${detail}`;
    console.warn('Sub-Pages: private Joplin view context adapter failed', error);
    const settingContext = await viewContextFromNotesParentSetting(notesParentSetting);
    if (settingContext) {
      lastNotesParentSetting = notesParentSetting;
      lastValidViewContext = { ...settingContext, key: `${settingContext.key}:adapter-error`, compatibilityError };
      return lastValidViewContext;
    }
    if (lastValidViewContext?.viewScope === 'notebook') {
      lastValidViewContext = {
        ...lastValidViewContext,
        key: lastValidViewContext.key.endsWith(':adapter-error') ? lastValidViewContext.key : `${lastValidViewContext.key}:adapter-error`,
        compatibilityError,
      };
      return lastValidViewContext;
    }

    const folder = await selectedFolderSummary();
    return {
      viewScope: 'notebook',
      folder,
      key: `unsupported:${folder?.id ?? ''}`,
      compatibilityError,
    };
  }
}

async function viewContextFromNotesParentSetting(raw: string | null): Promise<JoplinViewContext | null> {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (value?.type === 'SmartFilter' && value?.selectedItemId === ALL_NOTES_FILTER_ID) {
      return {
        viewScope: 'all',
        folder: null,
        key: `all:${ALL_NOTES_FILTER_ID}`,
        compatibilityError: null,
      };
    }
    if (value?.type === 'Folder' && typeof value.selectedItemId === 'string') {
      const folder = await folderSummaryById(value.selectedItemId);
      const context: JoplinViewContext = {
        viewScope: 'notebook',
        folder,
        key: `notebook:${folder?.id ?? ''}`,
        compatibilityError: null,
      };
      if (folder) lastValidNotebookContext = context;
      return context;
    }
    if (lastValidNotebookContext) return { ...lastValidNotebookContext, compatibilityError: null };
    const folder = await selectedFolderSummary();
    if (folder) {
      const context: JoplinViewContext = {
        viewScope: 'notebook',
        folder,
        key: `notebook:${folder.id}`,
        compatibilityError: null,
      };
      lastValidNotebookContext = context;
      return context;
    }
  } catch {
    // Ignore malformed internal settings and use the public folder fallback.
  }
  return null;
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

async function createDialog(prefix: string): Promise<string> {
  dialogSerial += 1;
  return await joplin.views.dialogs.create(`${prefix}.${Date.now()}.${dialogSerial}`);
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
      limit: NOTE_LIST_PAGE_LIMIT,
    }) as PageResponse<any>;

    const items = Array.isArray(response.items) ? response.items : [];
    for (const item of items) {
      const note = normalizeNote(item);
      if (note && !note.deleted_time && !note.is_conflict) output.push(note);
    }

    if (!response.has_more) break;
    page += 1;
  }

  return output;
}

async function listAllNotes(): Promise<NoteSummary[]> {
  const output: NoteSummary[] = [];
  let page = 1;

  while (true) {
    const response = await joplin.data.get(['notes'], {
      fields: noteFields(),
      order_by: 'user_updated_time',
      order_dir: 'DESC',
      page,
      limit: NOTE_LIST_PAGE_LIMIT,
    }) as PageResponse<any>;

    const items = Array.isArray(response.items) ? response.items : [];
    for (const item of items) {
      const note = normalizeNote(item);
      if (note && !note.deleted_time && !note.is_conflict) output.push(note);
    }

    if (!response.has_more) break;
    page += 1;
  }

  return output;
}

async function listFolders(): Promise<FolderNode[]> {
  const output: FolderNode[] = [];
  let page = 1;

  while (true) {
    const response = await joplin.data.get(['folders'], {
      fields: ['id', 'title', 'parent_id'],
      page,
      limit: 100,
    }) as PageResponse<any>;

    const items = Array.isArray(response.items) ? response.items : [];
    for (const item of items) collectFolderNodes(item, output);

    if (!response.has_more) break;
    page += 1;
  }

  return output;
}

function collectFolderNodes(value: any, output: FolderNode[]): void {
  if (!value || typeof value.id !== 'string') return;
  const children = Array.isArray(value.children) ? value.children : [];
  const folder: FolderNode = {
    id: value.id,
    title: typeof value.title === 'string' && value.title.trim() ? value.title.trim() : 'Untitled notebook',
    parent_id: typeof value.parent_id === 'string' ? value.parent_id : '',
    children: [],
  };
  output.push(folder);
  for (const child of children) collectFolderNodes(child, output);
}

async function folderCandidates(): Promise<FolderCandidate[]> {
  const folders = await listFolders();
  const byParent = new Map<string, FolderNode[]>();
  for (const folder of folders) {
    const siblings = byParent.get(folder.parent_id) ?? [];
    siblings.push(folder);
    byParent.set(folder.parent_id, siblings);
  }
  for (const siblings of byParent.values()) siblings.sort((a, b) => compareTitles(a.title, b.title));

  const output: FolderCandidate[] = [];
  const visit = (folder: FolderNode, path: string[]) => {
    const nextPath = [...path, folder.title];
    output.push({ id: folder.id, path: nextPath });
    for (const child of byParent.get(folder.id) ?? []) visit(child, nextPath);
  };

  const folderIds = new Set(folders.map((folder) => folder.id));
  const roots = folders.filter((folder) => !folder.parent_id || !folderIds.has(folder.parent_id));
  for (const root of roots) visit(root, []);

  return output;
}

function noteFields(): string[] {
  return ['id', 'title', 'parent_id', 'user_updated_time', 'updated_time', 'is_todo', 'todo_completed', 'deleted_time', 'is_conflict', 'user_data'];
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
    deleted_time: numberValue(value.deleted_time),
    is_conflict: numberValue(value.is_conflict),
    user_data: value.user_data ?? value.userData,
    notebookTitle: '',
    pageType: 'note',
  };
}

async function decorateNotes(notes: NoteSummary[]): Promise<void> {
  const folders = await listFolders();
  const folderTitles = new Map(folders.map((folder) => [folder.id, folder.title]));
  for (const note of notes) note.notebookTitle = folderTitles.get(note.parent_id) ?? 'Unknown notebook';

  const candidateIds = await currentWhiteboardCandidateIds();
  await Promise.all(notes.map(async (note) => {
    if (!candidateIds.has(note.id)) {
      note.pageType = 'note';
      return;
    }

    const cached = whiteboardTypeCache.get(note.id);
    if (cached && cached.updatedTime === note.updated_time) {
      note.pageType = cached.isWhiteboard ? 'whiteboard' : 'note';
      return;
    }

    const body = await getNoteBody(note.id);
    if (body === null) return;
    const isWhiteboard = isWhiteboardBody(body);
    whiteboardTypeCache.set(note.id, { updatedTime: note.updated_time, isWhiteboard });
    whiteboardProbeIds.delete(note.id);
    note.pageType = isWhiteboard ? 'whiteboard' : 'note';
  }));
}

async function currentWhiteboardCandidateIds(): Promise<Set<string>> {
  if (whiteboardCandidateRevision === panelStateRevision) return whiteboardCandidateIds;
  try {
    const candidates = await searchNotes('jsoncanvas');
    whiteboardCandidateIds = new Set(candidates.map((note) => note.id));
  } catch (error) {
    console.warn('Sub-Pages: unable to discover whiteboard notes', error);
  }
  for (const [noteId, cached] of whiteboardTypeCache.entries()) {
    if (cached.isWhiteboard) whiteboardCandidateIds.add(noteId);
  }
  for (const noteId of whiteboardProbeIds) whiteboardCandidateIds.add(noteId);
  whiteboardCandidateRevision = panelStateRevision;
  return whiteboardCandidateIds;
}

async function getNoteBody(noteId: string): Promise<string | null> {
  try {
    const note = await joplin.data.get(['notes', noteId], { fields: ['id', 'body'] });
    return typeof note?.body === 'string' ? note.body : null;
  } catch {
    return null;
  }
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

async function setPageParentLink(noteId: string, nextParentId: string | null): Promise<void> {
  const previousParentId = await getParentId(noteId);

  if (previousParentId === nextParentId) {
    if (nextParentId) await appendChildId(nextParentId, noteId);
    return;
  }

  try {
    if (nextParentId) {
      await setParentId(noteId, nextParentId);
      await appendChildId(nextParentId, noteId);
    } else {
      await clearParentId(noteId);
    }

    if (previousParentId && previousParentId !== nextParentId) {
      await removeChildFromParent(previousParentId, noteId);
    }

    if (!(await parentLinkConsistent(noteId, previousParentId, nextParentId))) {
      throw new Error('Sub-Pages metadata did not settle into a consistent parent link.');
    }
  } catch (error) {
    await restorePageParentLink(noteId, previousParentId, nextParentId);
    throw error;
  }
}

async function parentLinkConsistent(noteId: string, previousParentId: string | null, nextParentId: string | null): Promise<boolean> {
  if (await getParentId(noteId) !== nextParentId) return false;

  if (nextParentId) {
    const nextChildIds = await getChildIds(nextParentId);
    if (!nextChildIds.includes(noteId)) return false;
  }

  if (previousParentId && previousParentId !== nextParentId) {
    const previousChildIds = await getChildIds(previousParentId);
    if (previousChildIds.includes(noteId)) return false;
  }

  return true;
}

async function restorePageParentLink(noteId: string, previousParentId: string | null, attemptedParentId: string | null): Promise<void> {
  if (attemptedParentId && attemptedParentId !== previousParentId) {
    try {
      await removeChildFromParent(attemptedParentId, noteId);
    } catch (rollbackError) {
      console.warn('Sub-Pages: unable to remove attempted parent link during rollback', noteId, rollbackError);
    }
  }

  try {
    if (previousParentId) {
      await setParentId(noteId, previousParentId);
      await appendChildId(previousParentId, noteId);
    } else {
      await clearParentId(noteId);
    }
  } catch (rollbackError) {
    console.warn('Sub-Pages: unable to roll back hierarchy metadata change', noteId, rollbackError);
  }
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
    } else if (parent.parent_id !== note.parent_id) {
      output.set(note.id, 'Parent is in another notebook');
    } else {
      output.set(note.id, 'Parent is unavailable');
    }
  }

  return output;
}

function cycleAffectedNoteIds(
  notes: NoteSummary[],
  metaMap: Map<string, HierarchyMeta>,
  noteMap: Map<string, NoteSummary>
): Set<string> {
  const parentById = new Map<string, string | null>();
  for (const note of notes) {
    const parentId = metaMap.get(note.id)?.parentId ?? null;
    parentById.set(note.id, parentId && noteMap.has(parentId) ? parentId : null);
  }
  return parentCycleAffectedIds(notes.map((note) => note.id), parentById);
}

function orderChildIdsForRepair(storedChildIds: string[], actualChildIds: string[], noteMap: Map<string, NoteSummary>): string[] {
  const actualSet = new Set(actualChildIds);
  const output = storedChildIds.filter((id) => actualSet.has(id));
  const outputSet = new Set(output);
  const missing = actualChildIds
    .filter((id) => !outputSet.has(id))
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

async function getAiIndexStatusSafe(): Promise<AiIndexStatus | null> {
  try {
    const status = await joplin.ai.getIndexStatus();
    const state = status?.state;
    if (!['unavailable', 'disabled', 'preparing', 'indexing', 'ready'].includes(state)) return null;
    return {
      ready: !!status.ready,
      state,
      modelId: typeof status.modelId === 'string' ? status.modelId : null,
      notesIndexed: numberValue(status.notesIndexed),
      totalNotes: numberValue(status.totalNotes),
    };
  } catch (error) {
    console.warn('Sub-Pages: unable to read semantic index status', error);
    return null;
  }
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

async function runNoteListParityCommand(commandName: string, noteIds: string[]): Promise<void> {
  const noteId = noteIds[0];
  if (!noteId) return;

  const listArgCommands = new Set(['setTags', 'toggleNoteType', 'moveToFolder', 'duplicateNote', 'deleteNote']);
  const primaryArg = listArgCommands.has(commandName) ? noteIds : noteId;
  const fallbackArg = listArgCommands.has(commandName) ? noteId : noteIds;

  try {
    await joplin.commands.execute(commandName, primaryArg);
  } catch (primaryError) {
    try {
      await joplin.commands.execute(commandName, fallbackArg);
    } catch (fallbackError) {
      const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`Joplin command "${commandName}" failed or is unavailable. ${fallbackMessage || primaryMessage}`);
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

async function saveNoteAsMarkdown(noteId: string): Promise<string | null> {
  const note = await getNoteExportData(noteId);
  if (!note) {
    await notify('The note to save could not be loaded.');
    return null;
  }

  const selection = await chooseMarkdownExportPath(note);
  if (!selection) return null;
  const filePath = selection.filePath;

  const fs = joplin.require('fs-extra');
  if (!selection.overwriteHandled && await fs.pathExists(filePath)) {
    const confirmed = await joplin.views.dialogs.showMessageBox(`"${path.basename(filePath)}" already exists. Replace it?`);
    if (confirmed !== 0) return null;
  }

  try {
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, note.body || '', 'utf8');
    await showToast(`Saved "${displayTitleText(note.title)}" as Markdown.`);
    return filePath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('Sub-Pages: unable to save Markdown export', filePath, error);
    await notify(`Could not save Markdown file: ${message}`);
    return null;
  }
}

async function getNoteExportData(noteId: string): Promise<NoteExportData | null> {
  try {
    const note = await joplin.data.get(['notes', noteId], {
      fields: ['id', 'title', 'body'],
    });
    if (!note?.id) return null;

    return {
      id: String(note.id),
      title: typeof note.title === 'string' ? note.title : '',
      body: typeof note.body === 'string' ? note.body : '',
    };
  } catch (error) {
    console.warn('Sub-Pages: unable to load note for Markdown export', noteId, error);
    return null;
  }
}

async function chooseMarkdownExportPath(note: NoteExportData): Promise<MarkdownExportPathSelection | null> {
  const saveSelection = await chooseMarkdownExportPathWithSaveDialog(note);
  if (saveSelection !== undefined) return saveSelection;

  return await chooseMarkdownExportPathWithFormDialog(note);
}

async function chooseMarkdownExportPathWithSaveDialog(note: NoteExportData): Promise<MarkdownExportPathSelection | null | undefined> {
  const dialogs = joplin.views.dialogs as any;
  if (typeof dialogs.showSaveDialog !== 'function') return undefined;

  try {
    const result = await dialogs.showSaveDialog({
      title: 'Save note as Markdown',
      buttonLabel: 'Save',
      defaultPath: defaultMarkdownExportPath(note),
      filters: [
        { name: 'Markdown files', extensions: ['md', 'markdown'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });

    if (result?.canceled) return null;
    const selectedPath = typeof result === 'string' ? result : (typeof result?.filePath === 'string' ? result.filePath : '');
    return selectedPath ? { filePath: ensureMarkdownExtension(selectedPath), overwriteHandled: true } : null;
  } catch (error) {
    console.warn('Sub-Pages: native save dialog failed; falling back to Markdown export form', error);
    return undefined;
  }
}

async function chooseMarkdownExportPathWithFormDialog(note: NoteExportData): Promise<MarkdownExportPathSelection | null> {
  const handle = await createDialog(DIALOG_MARKDOWN_EXPORT_PREFIX);
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
            min-height: 200px;
          }
          *, *::before, *::after { box-sizing: inherit; }
          form { min-width: 0; padding: 16px; width: min(420px, calc(100vw - 32px)); }
          p { color: var(--joplin-color-faded, #666); font-size: 12px; margin: 0 0 16px; }
          label { display: block; font-weight: 600; margin-bottom: 14px; }
          input {
            background: var(--joplin-background-color, #fff);
            border: 1px solid var(--joplin-divider-color, #c7c7c7);
            border-radius: 4px;
            color: var(--joplin-color, #222);
            display: block;
            font: inherit;
            font-weight: normal;
            margin-top: 8px;
            padding: 6px 8px;
            width: 100%;
          }
        </style>
      </head>
      <body>
        <form name="markdownExport">
          <p>Choose a folder and file name for the Markdown export.</p>
          <label>
            Folder
            <input name="directory" type="text" value="${escapeHtml(defaultExportDirectory())}" />
          </label>
          <label>
            File name
            <input name="fileName" type="text" value="${escapeHtml(markdownFileName(note.title))}" />
          </label>
        </form>
      </body>
    </html>
  `);
  await joplin.views.dialogs.setButtons(handle, [
    { id: 'ok', title: 'Save' },
    { id: 'cancel', title: 'Cancel' },
  ]);
  await joplin.views.dialogs.setFitToContent(handle, false);

  const result = await joplin.views.dialogs.open(handle);
  if (result.id !== 'ok') return null;

  const formData = result.formData?.markdownExport;
  const directory = typeof formData?.directory === 'string' ? formData.directory.trim() : '';
  const fileName = typeof formData?.fileName === 'string' ? formData.fileName.trim() : '';
  const filePath = markdownExportPathFromForm(directory, fileName);
  if (!filePath) {
    await notify('Enter both a folder and file name to save Markdown.');
    return null;
  }

  return { filePath, overwriteHandled: false };
}

function markdownExportPathFromForm(directory: string, fileName: string): string | null {
  const trimmedFileName = fileName.trim();
  if (!trimmedFileName) return null;

  const selectedPath = path.isAbsolute(trimmedFileName)
    ? trimmedFileName
    : (directory.trim() ? path.join(directory.trim(), trimmedFileName) : '');

  return selectedPath ? ensureMarkdownExtension(selectedPath) : null;
}

function defaultMarkdownExportPath(note: NoteExportData): string {
  return path.join(defaultExportDirectory(), markdownFileName(note.title));
}

function defaultExportDirectory(): string {
  const home = os.homedir();
  if (!home) return process.cwd();
  return path.join(home, 'Documents');
}

function markdownFileName(title: string): string {
  const rawTitle = title.trim() || DEFAULT_EXPORT_TITLE;
  let sanitizedTitle = rawTitle
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, 120)
    .trim() || DEFAULT_EXPORT_TITLE;

  if (isReservedWindowsFileName(sanitizedTitle)) {
    sanitizedTitle = `_${sanitizedTitle}`;
  }

  return hasMarkdownExtension(sanitizedTitle) ? sanitizedTitle : `${sanitizedTitle}.md`;
}

function isReservedWindowsFileName(fileName: string): boolean {
  const baseName = fileName.split('.')[0];
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(baseName);
}

function ensureMarkdownExtension(filePath: string): string {
  return hasMarkdownExtension(filePath) ? filePath : `${filePath}.md`;
}

function hasMarkdownExtension(value: string): boolean {
  const extension = path.extname(value).toLocaleLowerCase();
  return extension === '.md' || extension === '.markdown';
}

function displayTitleText(title: string | null | undefined): string {
  return title?.trim() || '(untitled)';
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: any = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
