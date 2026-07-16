export const ALL_NOTES_FILTER_ID = 'c3176726992c11e9ac940492261af972';
export const HYBRID_RRF_K = 60;
export const EMPTY_WHITEBOARD_BODY = '```jsoncanvas\n{\n\t"nodes": [],\n\t"edges": []\n}\n```';

// Mirrors Joplin 3.7.9's hasWhiteboardFence contract.
const WHITEBOARD_FENCE_PATTERN = /^([\s\S]*?)```jsoncanvas[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?:\r?\n|$)([\s\S]*)$/;

export type ViewScope = 'notebook' | 'all';
export type SemanticSearchScope = { type: 'all' } | { type: 'folder'; folderId: string };

export interface ViewClassification {
  viewScope: ViewScope;
  folderId: string | null;
}

export function mainWindowStateFromRoot(rootState: any): any | null {
  if (!rootState || typeof rootState !== 'object') return null;
  if (typeof rootState.windowId !== 'string') return null;
  if (rootState.windowId === 'default') return rootState;
  const mainState = rootState.backgroundWindows?.default;
  return mainState && typeof mainState === 'object' && mainState.windowId === 'default' ? mainState : null;
}

export function classifyJoplinViewState(state: any): ViewClassification | null {
  if (!state || typeof state.notesParentType !== 'string') return null;
  if (state.notesParentType === 'SmartFilter' && state.selectedSmartFilterId === ALL_NOTES_FILTER_ID) {
    return { viewScope: 'all', folderId: null };
  }
  const folderId = state.notesParentType === 'Folder' && typeof state.selectedFolderId === 'string'
    ? state.selectedFolderId
    : null;
  return { viewScope: 'notebook', folderId };
}

export function reciprocalRankScores(keywordIds: string[], semanticIds: string[], k = HYBRID_RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  keywordIds.forEach((id, index) => {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
  });
  semanticIds.forEach((id, index) => {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
  });
  return scores;
}

export function semanticSearchScope(scope: 'all' | 'notebook', folderId: string | null): SemanticSearchScope {
  if (scope === 'all') return { type: 'all' };
  if (!folderId) throw new Error('A folder is required for notebook-scoped semantic search.');
  return { type: 'folder', folderId };
}

export function groupIdsByParent(ids: string[], parentById: ReadonlyMap<string, string | null>): Map<string, string[]> {
  const output = new Map<string, string[]>();
  for (const id of ids) {
    const parentId = parentById.get(id);
    if (!parentId) continue;
    const childIds = output.get(parentId) ?? [];
    childIds.push(id);
    output.set(parentId, childIds);
  }
  return output;
}

export function parentCycleAffectedIds(ids: string[], parentById: ReadonlyMap<string, string | null>): Set<string> {
  const affected = new Set<string>();
  const resolved = new Map<string, boolean>();

  for (const startId of ids) {
    if (resolved.has(startId)) continue;
    const path: string[] = [];
    const pathIds = new Set<string>();
    let currentId: string | null = startId;
    let hasCycle = false;

    while (currentId) {
      if (resolved.has(currentId)) {
        hasCycle = resolved.get(currentId) ?? false;
        break;
      }
      if (pathIds.has(currentId)) {
        hasCycle = true;
        break;
      }

      path.push(currentId);
      pathIds.add(currentId);
      currentId = parentById.get(currentId) ?? null;
    }

    for (const id of path) {
      resolved.set(id, hasCycle);
      if (hasCycle) affected.add(id);
    }
  }

  return affected;
}

export function isWhiteboardBody(body: string): boolean {
  return !!body && WHITEBOARD_FENCE_PATTERN.test(body);
}
