(function () {
  const app = document.getElementById('app');
  const api = window.webviewApi;
  const collapsedIds = new Set();
  let collapsedStateLoaded = false;
  let collapsedStateDirty = false;
  let collapsedStateSaveQueue = Promise.resolve();
  const panelSelectedIds = new Set();
  let currentState = null;
  let searchQuery = '';
  let searchScope = 'all';
  let lastPanelSelectedId = null;
  let statusText = '';
  let busy = false;
  let selectionSyncInFlight = false;
  let stateRevision = 0;
  let stateSyncInFlight = false;
  let searchState = emptySearchState();
  let searchDebounceTimer = null;
  let searchRequestSerial = 0;
  let dragSourceRow = null;
  let dragStatusElement = null;
  let draggedNoteId = null;
  let dropTargetNoteId = null;
  let dropToRootActive = false;
  const searchDebounceMs = 380;
  const selectionPollMs = 1500;
  const statePollMs = 1000;
  const defaultPanelAppearance = Object.freeze({ noteTextSize: 12, rowSpacing: 3, rowVerticalPadding: 0, textInset: 4, noteIndent: 16 });
  const minimumPanelNoteTextSize = 10;
  const maximumPanelNoteTextSize = 24;
  const minimumPanelRowSpacing = 0;
  const maximumPanelRowSpacing = 16;
  const minimumPanelRowVerticalPadding = 0;
  const maximumPanelRowVerticalPadding = 12;
  const minimumPanelTextInset = 0;
  const maximumPanelTextInset = 24;
  const minimumPanelNoteIndent = 0;
  const maximumPanelNoteIndent = 40;
  const joplinNoteDragType = 'text/x-jop-note-ids';

  const icons = {
    chevronDown: '<svg viewBox="0 0 16 16"><path d="m4 6 4 4 4-4"/></svg>',
    chevronRight: '<svg viewBox="0 0 16 16"><path d="m6 4 4 4-4 4"/></svg>',
    more: '<svg viewBox="0 0 16 16"><circle cx="3.5" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="12.5" cy="8" r="1.1"/></svg>',
    plus: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>',
    refresh: '<svg viewBox="0 0 16 16"><path d="M13 6A5 5 0 1 0 14 9M13 6V2h-4"/></svg>',
    repair: '<svg viewBox="0 0 16 16"><path d="M10.8 2.3a3.2 3.2 0 0 0-4 4L2.8 10.3a1.7 1.7 0 0 0 2.4 2.4l4-4a3.2 3.2 0 0 0 4-4l-2 2-2-2 2-2Z"/></svg>',
    whiteboard: '<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="1"/><circle cx="5.5" cy="6" r="1"/><circle cx="10.5" cy="10" r="1"/><path d="m6.4 6.8 3.2 2.4"/></svg>',
    whiteboardPlus: '<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M8 5v6M5 8h6"/></svg>',
  };

  function post(name, payload) {
    if (!api || typeof api.postMessage !== 'function') {
      setStatus('Joplin webview API is unavailable. Restart Joplin and reload the plugin.');
      return Promise.resolve({ ok: false });
    }

    setBusy(true);
    return Promise.resolve(api.postMessage(Object.assign({ name }, payload || {})))
      .then((response) => {
        applyResponse(response);
        return response;
      })
      .catch((error) => {
        setStatus(error && error.message ? error.message : String(error));
      })
      .finally(() => {
        setBusy(false);
      });
  }

  function applyResponse(response) {
    if (!response) return;

    if (response.state) {
      if (!acceptStateRevision(response.revision)) return;
      if (!collapsedStateLoaded && Array.isArray(response.collapsedNoteIds)) {
        if (!collapsedStateDirty) {
          collapsedIds.clear();
          response.collapsedNoteIds.forEach((noteId) => {
            if (typeof noteId === 'string' && noteId) collapsedIds.add(noteId);
          });
        }
        collapsedStateLoaded = true;
      }
      currentState = response.state;
      applyPanelAppearance();
      normalizeSearchScopeForView();
      statusText = response.message || '';
      syncPanelSelectionToSelectedNote();
      prunePanelSelection();
      render();
      if (searchQuery.trim()) scheduleSearch(0);
      return;
    }

    if (response.message) setStatus(response.message);
  }

  function acceptStateRevision(revision) {
    if (!Number.isFinite(revision)) return true;
    if (revision < stateRevision) return false;
    stateRevision = revision;
    return true;
  }

  function boundedInteger(value, fallback, minimum, maximum) {
    const parsed = typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
  }

  function panelAppearanceFromState() {
    const appearance = currentState && currentState.appearance;
    return {
      noteTextSize: boundedInteger(
        appearance && appearance.noteTextSize,
        defaultPanelAppearance.noteTextSize,
        minimumPanelNoteTextSize,
        maximumPanelNoteTextSize,
      ),
      rowSpacing: boundedInteger(
        appearance && appearance.rowSpacing,
        defaultPanelAppearance.rowSpacing,
        minimumPanelRowSpacing,
        maximumPanelRowSpacing,
      ),
      rowVerticalPadding: boundedInteger(
        appearance && appearance.rowVerticalPadding,
        defaultPanelAppearance.rowVerticalPadding,
        minimumPanelRowVerticalPadding,
        maximumPanelRowVerticalPadding,
      ),
      textInset: boundedInteger(
        appearance && appearance.textInset,
        defaultPanelAppearance.textInset,
        minimumPanelTextInset,
        maximumPanelTextInset,
      ),
      noteIndent: boundedInteger(
        appearance && appearance.noteIndent,
        defaultPanelAppearance.noteIndent,
        minimumPanelNoteIndent,
        maximumPanelNoteIndent,
      ),
    };
  }

  function applyPanelAppearance() {
    const appearance = panelAppearanceFromState();
    app.style.setProperty('--sub-pages-note-font-size', `${appearance.noteTextSize}px`);
    app.style.setProperty('--sub-pages-row-spacing', `${appearance.rowSpacing}px`);
    app.style.setProperty('--sub-pages-row-vertical-padding', `${appearance.rowVerticalPadding}px`);
    app.style.setProperty('--sub-pages-text-inset', `${appearance.textInset}px`);
    app.style.setProperty('--sub-pages-note-indent', `${appearance.noteIndent}px`);
  }

  function setBusy(value) {
    busy = value;
    app.classList.toggle('is-busy', busy);
  }

  function setStatus(message) {
    statusText = message || '';
    render();
  }

  function postQuiet(name, payload) {
    if (!api || typeof api.postMessage !== 'function') return;
    Promise.resolve(api.postMessage(Object.assign({ name }, payload || {}))).catch(() => {});
  }

  function persistCollapsedState() {
    if (!api || typeof api.postMessage !== 'function') return;
    const collapsedNoteIds = [...collapsedIds];
    collapsedStateSaveQueue = collapsedStateSaveQueue
      .catch(() => {})
      .then(() => api.postMessage({ name: 'saveCollapsedNoteIds', collapsedNoteIds }))
      .catch(() => {});
  }

  function setCollapsed(noteId, isCollapsed) {
    if (!noteId || collapsedIds.has(noteId) === isCollapsed) return false;
    collapsedStateDirty = true;
    if (isCollapsed) collapsedIds.add(noteId);
    else collapsedIds.delete(noteId);
    render();
    persistCollapsedState();
    return true;
  }

  function toggleCollapsed(noteId) {
    setCollapsed(noteId, !collapsedIds.has(noteId));
  }

  function isRowDragActive() {
    return !!(dragSourceRow || draggedNoteId);
  }

  function syncSelectedNote() {
    if (document.hidden) return;
    if (isRowDragActive()) return;
    if (!currentState || selectionSyncInFlight) return;
    if (!api || typeof api.postMessage !== 'function') return;

    selectionSyncInFlight = true;
    Promise.resolve(api.postMessage({ name: 'selectedNoteState' }))
      .then((response) => {
        if (!response || response.selectedNoteId === undefined || !currentState) return;
        const nextSelectedNoteId = response.selectedNoteId || null;
        if (currentState.selectedNoteId === nextSelectedNoteId) return;

        currentState.selectedNoteId = nextSelectedNoteId;
        syncPanelSelectionToSelectedNote();
        render();
      })
      .catch(() => {
        // The event-driven path still handles selection changes when available.
      })
      .finally(() => {
        selectionSyncInFlight = false;
      });
  }

  function syncPanelState() {
    if (document.hidden) return;
    if (isRowDragActive()) return;
    if (!currentState || stateSyncInFlight) return;
    if (!api || typeof api.postMessage !== 'function') return;

    stateSyncInFlight = true;
    Promise.resolve(api.postMessage({ name: 'stateIfChanged', revision: stateRevision }))
      .then((response) => {
        applyResponse(response);
      })
      .catch(() => {
        // Manual refresh remains available if the host rejects a background check.
      })
      .finally(() => {
        stateSyncInFlight = false;
      });
  }

  function render() {
    closeOpenMenus();
    cleanupDetachedMenus();

    if (!currentState) {
      const loading = element('div', { className: 'sub-pages-shell' });
      loading.appendChild(element('div', { className: 'sub-pages-loading' }, ['Loading Sub-Pages...']));
      if (statusText) loading.appendChild(element('div', { className: 'sub-pages-status' }, [statusText]));
      app.replaceChildren(loading);
      return;
    }

    const root = element('div', { className: 'sub-pages-shell' });
    root.appendChild(renderHeader());
    root.appendChild(renderSearch());

    if (currentState.compatibilityError && !currentState.error) {
      const warning = element('div', { className: 'sub-pages-compatibility-warning', role: 'status' }, [
        `Compatibility warning: ${currentState.compatibilityError}`,
      ]);
      warning.setAttribute('aria-live', 'polite');
      root.appendChild(warning);
    }

    if (currentState.error) {
      root.appendChild(element('div', { className: 'sub-pages-empty' }, [currentState.error]));
    } else {
      const search = currentSearch();
      const visibleNodes = filteredRootNodes(search);
      const externalResults = search.active && !isAllNotesView() ? search.externalResults : [];
      const showRootDropArea = !search.active && currentState.nodes.length;

      if (currentState.nodes.length && visibleNodes.length) {
        const list = element('div', {
          className: [
            'sub-pages-list',
            search.active ? 'is-search-results' : '',
            showRootDropArea ? 'sub-pages-root-drop-zone' : '',
            draggedNoteId && showRootDropArea ? 'is-visible' : '',
            dropToRootActive && showRootDropArea ? 'is-drop-target' : '',
          ].filter(Boolean).join(' '),
          role: 'presentation',
          ariaLabel: showRootDropArea ? 'Drop on blank list space to promote to root' : null,
        });
        const tree = element('div', { className: 'sub-pages-tree', role: 'tree' });
        visibleNodes.forEach((node) => renderNode(node, 0, tree, search));
        list.appendChild(tree);
        if (showRootDropArea) {
          list.appendChild(element('div', {
            className: 'sub-pages-root-drop-target sub-pages-root-drop-zone',
            role: 'presentation',
            ariaLabel: 'Drop here to promote to root',
          }));
        }
        root.appendChild(list);
      }

      if (externalResults.length) {
        root.appendChild(renderExternalSearchResults(search));
      }

      if (search.active && !visibleNodes.length && !externalResults.length) {
        if (search.loading) {
          root.appendChild(element('div', { className: 'sub-pages-empty' }, ['Searching Joplin...']));
        } else {
          root.appendChild(element('div', { className: 'sub-pages-empty' }, [`No pages match "${search.displayQuery || search.query}".`]));
        }
      }
    }

    if (statusText) {
      root.appendChild(element('div', { className: 'sub-pages-status' }, [statusText]));
    }

    app.replaceChildren(root);
  }

  function renderHeader() {
    const allNotes = isAllNotesView();
    const folderTitle = allNotes ? 'All Notes' : (currentState.folder ? currentState.folder.title : 'Sub-Pages');
    const repairCount = Number(currentState.repairCount || 0);
    const header = element('div', { className: 'sub-pages-header' });
    const titleWrap = element('div', { className: 'sub-pages-title-wrap' });

    const actions = element('div', { className: 'sub-pages-header-actions' });
    actions.appendChild(iconButton('createRoot', null, 'plus', 'Create root page', false, 'sub-pages-icon-button'));
    actions.appendChild(iconButton('createRootWhiteboard', null, 'whiteboardPlus', 'Create root whiteboard', false, 'sub-pages-icon-button'));
    if (repairCount > 0) {
      actions.appendChild(iconButton('repair', null, 'repair', `Repair ${repairCount} metadata issue${repairCount === 1 ? '' : 's'}`, false, 'sub-pages-icon-button'));
    }
    actions.appendChild(iconButton('refresh', null, 'refresh', 'Refresh tree', false, 'sub-pages-icon-button'));
    header.appendChild(actions);

    titleWrap.appendChild(element('div', { className: 'sub-pages-heading', title: folderTitle }, [folderTitle]));
    if (allNotes) {
      const itemCount = Number.isFinite(Number(currentState.noteCount))
        ? Number(currentState.noteCount)
        : countTreeNodes(currentState.nodes);
      titleWrap.appendChild(element('div', { className: 'sub-pages-context' }, [
        `${itemCount} item${itemCount === 1 ? '' : 's'} across notebooks`,
      ]));
    }
    header.appendChild(titleWrap);

    return header;
  }

  function renderSearch() {
    const search = currentSearch();
    const active = search.active;
    const visibleCount = active ? countVisibleSearchNodes(currentState.nodes, search) : countTreeNodes(currentState.nodes);
    const externalCount = active && !isAllNotesView() ? search.externalResults.length : 0;
    const wrap = element('div', { className: ['sub-pages-search', active ? 'is-active' : ''].filter(Boolean).join(' ') });

    const input = element('input', {
      className: 'sub-pages-search-input',
      type: 'search',
      value: searchQuery,
      placeholder: isAllNotesView() || searchScope === 'all' ? 'Search all notes...' : 'Search this notebook...',
      ariaLabel: isAllNotesView() ? 'Search all notes' : 'Search Sub-Pages with Joplin search',
      autocomplete: 'off',
    });
    input.dataset.action = 'search';
    wrap.appendChild(input);

    if (active) {
      wrap.appendChild(actionButton('clearSearch', null, 'Clear', 'Clear search', false, 'sub-pages-clear-search'));
    }

    wrap.appendChild(renderSearchScope());

    if (active) {
      const allNotes = isAllNotesView();
      const scopeLabel = allNotes ? 'All Notes' : (search.scope === 'all' ? 'All notebooks' : 'This notebook');
      const shown = visibleCount + externalCount;
      const status = search.loading
        ? `Searching ${scopeLabel}...`
        : allNotes
          ? `${scopeLabel}: showing ${shown} row${shown === 1 ? '' : 's'} across notebooks.`
          : `${scopeLabel}: showing ${shown} row${shown === 1 ? '' : 's'} (${visibleCount} in this notebook${search.scope === 'all' ? `, ${externalCount} elsewhere` : ''}).`;
      const semanticMessage = search.message || semanticIndexMessage(currentState.aiIndexStatus);
      wrap.appendChild(element('div', { className: 'sub-pages-filter-status' }, [
        semanticMessage ? `${status} ${semanticMessage}` : status,
      ]));
    }

    return wrap;
  }

  function renderSearchScope() {
    const group = element('div', { className: 'sub-pages-search-scope', role: 'group', ariaLabel: 'Search scope' });
    const scopes = isAllNotesView()
      ? [{ value: 'all', label: 'All Notes' }]
      : [
        { value: 'all', label: 'All' },
        { value: 'notebook', label: 'Notebook' },
      ];
    scopes.forEach((scope) => {
      const scopeTitle = isAllNotesView()
        ? 'Search all notes'
        : `Search ${scope.value === 'all' ? 'all notebooks' : 'this notebook'}`;
      const button = actionButton('setSearchScope', null, scope.label, scopeTitle, false, 'sub-pages-scope-button');
      button.dataset.scope = scope.value;
      button.setAttribute('aria-pressed', searchScope === scope.value ? 'true' : 'false');
      if (searchScope === scope.value) button.classList.add('is-active');
      group.appendChild(button);
    });
    return group;
  }

  function isAllNotesView() {
    return !!(currentState && currentState.viewScope === 'all');
  }

  function normalizeSearchScopeForView() {
    if (!isAllNotesView() || searchScope === 'all') return;
    searchScope = 'all';
    resetSearchState();
  }

  function semanticIndexMessage(status) {
    if (!status || status.ready === true || status.state === 'ready') return '';

    const state = String(status.state || '').toLocaleLowerCase();
    const indexed = Number(status.notesIndexed);
    const total = Number(status.totalNotes);
    const hasProgress = Number.isFinite(indexed) && Number.isFinite(total) && total > 0;

    if (state === 'indexing' || (hasProgress && indexed < total)) {
      const progress = hasProgress ? ` (${indexed} of ${total} notes)` : '';
      return `Semantic index is building${progress}; results may be incomplete.`;
    }
    if (state === 'preparing') return 'Semantic search is preparing; showing keyword results for now.';
    if (state === 'disabled') return 'Semantic search is off; showing keyword results.';
    if (state === 'unavailable' || state === 'error' || status.ready === false) {
      return 'Semantic search is unavailable; showing keyword results.';
    }

    return '';
  }

  function renderPageTitle(note, search) {
    const whiteboard = note.pageType === 'whiteboard';
    const displayTitle = note.title || (whiteboard ? 'Untitled whiteboard' : 'Untitled page');
    const title = actionButton('openNote', note.id, '', displayTitle);
    title.classList.add('sub-pages-note-title');
    title.setAttribute('aria-label', `Open ${whiteboard ? 'whiteboard' : 'page'} ${displayTitle}`);

    if (whiteboard) {
      const typeIcon = iconElement('whiteboard');
      typeIcon.classList.add('sub-pages-page-type-icon');
      title.appendChild(typeIcon);
    }

    const titleText = element('span', { className: 'sub-pages-note-title-text' });
    appendHighlightedTitle(titleText, displayTitle, search.normalizedQuery);
    title.appendChild(titleText);
    if (note.isTodo) title.classList.add(note.todoCompleted ? 'is-done' : 'is-todo');
    return title;
  }

  function renderNode(node, depth, container, search) {
    const visibleChildren = search.active
      ? (node.children || []).filter((child) => nodeMatchesSearch(child, search))
      : (node.children || []);
    const filtering = search.active;
    const row = element('div', {
      className: [
        'sub-pages-row',
        node.id === currentState.selectedNoteId ? 'is-selected' : '',
        panelSelectedIds.has(node.id) ? 'is-panel-selected' : '',
        node.repairReason ? 'needs-repair' : '',
        depth > 0 ? 'is-child' : 'is-root',
        hasNodeChildren(node) ? 'has-children' : '',
        node.pageType === 'whiteboard' ? 'is-whiteboard' : '',
        isAllNotesView() && depth === 0 ? 'has-notebook-label' : '',
      ].filter(Boolean).join(' '),
      role: 'treeitem',
      ariaLevel: String(depth + 1),
      ariaSelected: panelSelectedIds.has(node.id) || node.id === currentState.selectedNoteId ? 'true' : 'false',
      style: `--depth: ${depth};`,
    });
    row.dataset.noteId = node.id;
    row.dataset.dragScope = 'tree';
    row.draggable = true;

    const hasChildren = hasNodeChildren(node);
    const hasVisibleChildren = visibleChildren.length > 0;
    // Filtering reveals matching notes and their ancestors without changing the saved collapse set.
    const isCollapsed = !filtering && collapsedIds.has(node.id);
    if (hasChildren) row.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    row.classList.add(isCollapsed ? 'is-collapsed' : 'is-expanded');
    const main = element('div', { className: 'sub-pages-row-main' });

    if (hasChildren) {
      main.appendChild(iconButton('toggle', node.id, isCollapsed ? 'chevronRight' : 'chevronDown', filtering ? 'Collapse state is preserved while filtering' : (isCollapsed ? 'Expand' : 'Collapse'), false, 'sub-pages-icon-button sub-pages-toggle'));
    }

    main.appendChild(renderPageTitle(node, search));

    if (isAllNotesView() && depth === 0) {
      const notebookTitle = node.notebookTitle || 'Unknown notebook';
      main.appendChild(element('span', {
        className: 'sub-pages-notebook-label sub-pages-root-notebook-label',
        title: `Notebook: ${notebookTitle}`,
      }, [notebookTitle]));
    }

    if (node.repairReason) {
      main.appendChild(element('span', { className: 'sub-pages-badge', title: node.repairReason }, ['Needs repair']));
    }

    const trailing = element('span', { className: 'sub-pages-row-trailing' });
    const actions = element('span', { className: 'sub-pages-row-actions' });
    actions.appendChild(iconButton('createChild', node.id, 'plus', 'Create child page', false, 'sub-pages-icon-button'));
    actions.appendChild(renderNodeMenu(node, hasChildren, depth));
    trailing.appendChild(actions);

    if (hasChildren) {
      const hiddenChildCount = filtering ? node.children.length - visibleChildren.length : 0;
      const titleSuffix = hiddenChildCount > 0 ? ` (${hiddenChildCount} hidden by search)` : '';
      trailing.appendChild(element('span', { className: 'sub-pages-child-count', title: `${node.children.length} direct child page${node.children.length === 1 ? '' : 's'}${titleSuffix}` }, [String(node.children.length)]));
    }

    main.appendChild(trailing);

    row.appendChild(main);

    container.appendChild(row);

    if (hasVisibleChildren && !isCollapsed) {
      visibleChildren.forEach((child) => renderNode(child, depth + 1, container, search));
    }
  }

  function renderExternalSearchResults(search) {
    const section = element('div', { className: 'sub-pages-search-results' });
    section.appendChild(element('div', { className: 'sub-pages-section-heading' }, ['Other notebooks']));

    const list = element('div', { className: 'sub-pages-tree sub-pages-external-results', role: 'list' });
    search.externalResults.forEach((result) => renderExternalResult(result, list, search));
    section.appendChild(list);
    return section;
  }

  function renderExternalResult(note, container, search) {
    const row = element('div', {
      className: [
        'sub-pages-row',
        'sub-pages-external-row',
        note.pageType === 'whiteboard' ? 'is-whiteboard' : '',
        note.id === currentState.selectedNoteId ? 'is-selected' : '',
        panelSelectedIds.has(note.id) ? 'is-panel-selected' : '',
      ].filter(Boolean).join(' '),
      role: 'listitem',
      style: '--depth: 0;',
    });
    row.dataset.noteId = note.id;
    row.dataset.dragScope = 'external';
    row.draggable = true;

    const main = element('div', { className: 'sub-pages-row-main' });
    main.appendChild(element('span', { className: 'sub-pages-spacer' }));

    main.appendChild(renderPageTitle(note, search));

    main.appendChild(element('span', {
      className: 'sub-pages-notebook-label',
      title: note.notebookTitle || 'Other notebook',
    }, [note.notebookTitle || 'Other notebook']));

    const trailing = element('span', { className: 'sub-pages-row-trailing' });
    const actions = element('span', { className: 'sub-pages-row-actions' });
    actions.appendChild(renderExternalNoteMenu(note));
    trailing.appendChild(actions);
    main.appendChild(trailing);

    row.appendChild(main);
    container.appendChild(row);
  }

  function normalizedSearchQuery() {
    return searchQuery.trim().toLocaleLowerCase();
  }

  function currentSearch() {
    const query = searchQuery.trim();
    if (!query) {
      return {
        active: false,
        query: '',
        scope: searchScope,
        normalizedQuery: '',
        loading: false,
        message: '',
        deferred: false,
        matchIds: new Set(),
        externalResults: [],
      };
    }

    const ready = searchState.query === query && searchState.scope === searchScope;
    const canUsePreviousResults = !ready && searchState.query && searchState.scope === searchScope;
    return {
      active: true,
      query: ready ? query : (canUsePreviousResults ? searchState.query : query),
      displayQuery: query,
      scope: searchScope,
      normalizedQuery: ready ? normalizedSearchQuery() : (canUsePreviousResults ? String(searchState.query).toLocaleLowerCase() : ''),
      loading: !ready || !!searchState.loading,
      message: ready ? (searchState.message || '') : '',
      deferred: !ready && !canUsePreviousResults,
      matchIds: new Set((ready || canUsePreviousResults) ? (searchState.noteIds || []) : []),
      externalResults: (ready || canUsePreviousResults) ? (searchState.externalResults || []) : [],
    };
  }

  function filteredRootNodes(search) {
    const nodes = currentState && currentState.nodes ? currentState.nodes : [];
    if (!search.active) return nodes;
    return nodes.filter((node) => nodeMatchesSearch(node, search));
  }

  function nodeMatchesSearch(node, search) {
    if (!search.active) return true;
    if (search.deferred) return true;
    if (search.matchIds.has(node.id)) return true;
    return (node.children || []).some((child) => nodeMatchesSearch(child, search));
  }

  function countVisibleSearchNodes(nodes, search) {
    return (nodes || []).reduce((count, node) => {
      if (!nodeMatchesSearch(node, search)) return count;
      return count + 1 + countVisibleSearchNodes(node.children, search);
    }, 0);
  }

  function countTreeNodes(nodes) {
    return (nodes || []).reduce((count, node) => count + 1 + countTreeNodes(node.children), 0);
  }

  function hasNodeChildren(node) {
    return !!(node.children && node.children.length);
  }

  function findNodeById(nodes, noteId) {
    if (!noteId) return null;

    for (const node of nodes || []) {
      if (node.id === noteId) return node;

      const child = findNodeById(node.children, noteId);
      if (child) return child;
    }

    return null;
  }

  function collectNodeIds(node, output) {
    if (!node || !node.id || output.has(node.id)) return;
    output.add(node.id);
    (node.children || []).forEach((child) => collectNodeIds(child, output));
  }

  function treeParentMap() {
    const output = new Map();

    function visit(nodes, parentId) {
      (nodes || []).forEach((node) => {
        output.set(node.id, parentId || null);
        visit(node.children || [], node.id);
      });
    }

    visit(currentState && currentState.nodes ? currentState.nodes : [], null);
    return output;
  }

  function hasSelectedTreeAncestor(noteId, selectedIds, parentById) {
    let parentId = parentById.get(noteId) || null;
    const seen = new Set();

    while (parentId && !seen.has(parentId)) {
      if (selectedIds.has(parentId)) return true;
      seen.add(parentId);
      parentId = parentById.get(parentId) || null;
    }

    return false;
  }

  function dragPayloadForRow(row) {
    if (!currentState || !row) return null;

    const noteId = row.dataset.noteId;
    if (!noteId) return null;

    if (row.dataset.dragScope === 'external') {
      const externalResult = findExternalSearchResult(noteId);
      return {
        noteId,
        sourceFolderId: externalResult?.notebookId || externalResult?.parentId || null,
        branchRoots: [{ id: noteId }],
        branchRootIds: [noteId],
        noteIds: [noteId],
      };
    }

    const candidateIds = selectedActionNoteIds(noteId);
    const parentById = treeParentMap();
    const selectedIds = new Set(candidateIds.filter((id) => parentById.has(id)));
    if (!selectedIds.size) selectedIds.add(noteId);

    const branchRootIds = [...selectedIds].filter((id) => !hasSelectedTreeAncestor(id, selectedIds, parentById));
    const noteIds = new Set();

    branchRootIds.forEach((rootId) => {
      const rootNode = findNodeById(currentState.nodes, rootId);
      if (rootNode) collectNodeIds(rootNode, noteIds);
    });

    if (!noteIds.size) noteIds.add(noteId);

    const branchNotebookIds = new Set();
    let hasUnknownBranchNotebook = false;
    branchRootIds.forEach((rootId) => {
      const rootNode = findNodeById(currentState.nodes, rootId);
      const notebookId = rootNode?.notebookId || (currentState.folder ? currentState.folder.id : null);
      if (notebookId) branchNotebookIds.add(notebookId);
      else hasUnknownBranchNotebook = true;
    });
    const sourceFolderId = !hasUnknownBranchNotebook && branchNotebookIds.size === 1
      ? [...branchNotebookIds][0]
      : null;

    return {
      noteId,
      sourceFolderId,
      branchRoots: branchRootIds.map((rootId) => ({
        id: rootId,
        parentId: parentById.get(rootId) || null,
      })),
      branchRootIds,
      noteIds: [...noteIds],
    };
  }

  function findExternalSearchResult(noteId) {
    return (searchState.externalResults || []).find((note) => note.id === noteId) || null;
  }

  function nodeContains(node, noteId) {
    if (!node || !noteId) return false;
    if (node.id === noteId) return true;
    return (node.children || []).some((child) => nodeContains(child, noteId));
  }

  function canDropOnRow(draggedId, targetId) {
    if (!draggedId || !targetId || draggedId === targetId) return false;
    const draggedNode = findNodeById(currentState && currentState.nodes ? currentState.nodes : [], draggedId);
    const targetNode = findNodeById(currentState && currentState.nodes ? currentState.nodes : [], targetId);
    if (!draggedNode || !targetNode) return false;
    if (draggedNode.notebookId && targetNode.notebookId && draggedNode.notebookId !== targetNode.notebookId) return false;
    return !nodeContains(draggedNode, targetId);
  }

  function canDropToRoot(noteId) {
    const node = findNodeById(currentState && currentState.nodes ? currentState.nodes : [], noteId);
    return !!(node && node.parentId);
  }

  function rootDropTargetForEventTarget(target) {
    if (!target || !target.closest) return null;
    if (target.closest('.sub-pages-row[data-note-id]')) return null;
    if (target.closest('.sub-pages-header, .sub-pages-search, .sub-pages-menu')) return null;

    const explicitZone = target.closest('.sub-pages-root-drop-zone');
    if (explicitZone) return explicitZone;

    const shell = target.closest('.sub-pages-shell');
    if (!shell) return null;
    return shell.querySelector('.sub-pages-list.sub-pages-root-drop-zone');
  }

  function selectedActionNoteIds(anchorNoteId) {
    if (!anchorNoteId) return [];
    if (panelSelectedIds.has(anchorNoteId) && panelSelectedIds.size) return [...panelSelectedIds];
    return [anchorNoteId];
  }

  function visibleRowNoteIds() {
    return [...app.querySelectorAll('.sub-pages-row[data-note-id]')]
      .map((row) => row.dataset.noteId)
      .filter(Boolean);
  }

  function allStateNoteIds() {
    const output = new Set();
    walkNodes(currentState && currentState.nodes ? currentState.nodes : [], (node) => output.add(node.id));
    (searchState.externalResults || []).forEach((note) => output.add(note.id));
    return output;
  }

  function walkNodes(nodes, visitor) {
    (nodes || []).forEach((node) => {
      visitor(node);
      walkNodes(node.children || [], visitor);
    });
  }

  function prunePanelSelection() {
    if (!currentState) return;
    const validIds = allStateNoteIds();
    for (const noteId of [...panelSelectedIds]) {
      if (!validIds.has(noteId)) panelSelectedIds.delete(noteId);
    }
    if (lastPanelSelectedId && !validIds.has(lastPanelSelectedId)) lastPanelSelectedId = null;
  }

  function syncPanelSelectionToSelectedNote() {
    if (!currentState) return;

    const noteId = currentState.selectedNoteId || null;
    panelSelectedIds.clear();
    if (noteId) {
      panelSelectedIds.add(noteId);
      lastPanelSelectedId = noteId;
    } else {
      lastPanelSelectedId = null;
    }
  }

  function updatePanelSelection(noteId, event) {
    if (!noteId) return;
    const additive = !!(event && (event.ctrlKey || event.metaKey));
    const range = !!(event && event.shiftKey);

    if (range && lastPanelSelectedId) {
      const visibleIds = visibleRowNoteIds();
      const start = visibleIds.indexOf(lastPanelSelectedId);
      const end = visibleIds.indexOf(noteId);
      if (start >= 0 && end >= 0) {
        if (!additive) panelSelectedIds.clear();
        const [from, to] = start < end ? [start, end] : [end, start];
        visibleIds.slice(from, to + 1).forEach((id) => panelSelectedIds.add(id));
      } else {
        panelSelectedIds.add(noteId);
      }
    } else if (additive) {
      if (panelSelectedIds.has(noteId) && panelSelectedIds.size > 1) panelSelectedIds.delete(noteId);
      else panelSelectedIds.add(noteId);
      lastPanelSelectedId = noteId;
    } else {
      panelSelectedIds.clear();
      panelSelectedIds.add(noteId);
      lastPanelSelectedId = noteId;
    }

    if (!panelSelectedIds.size) {
      panelSelectedIds.add(noteId);
      lastPanelSelectedId = noteId;
    }
  }

  function appendHighlightedTitle(container, title, filterText) {
    const text = String(title || 'Untitled page');
    if (!filterText) {
      container.appendChild(document.createTextNode(text));
      return;
    }

    const lowerText = text.toLocaleLowerCase();
    let start = 0;
    let matchIndex = lowerText.indexOf(filterText);

    while (matchIndex >= 0) {
      if (matchIndex > start) {
        container.appendChild(document.createTextNode(text.slice(start, matchIndex)));
      }

      container.appendChild(element('mark', { className: 'sub-pages-search-match' }, [
        text.slice(matchIndex, matchIndex + filterText.length),
      ]));

      start = matchIndex + filterText.length;
      matchIndex = lowerText.indexOf(filterText, start);
    }

    if (start < text.length) container.appendChild(document.createTextNode(text.slice(start)));
  }

  function renderNodeMenu(node, hasChildren, depth) {
    const details = element('details', { className: 'sub-pages-row-menu' });
    const menuLabel = `More actions for ${node.title || 'Untitled page'}`;
    const selectionCount = selectedActionNoteIds(node.id).length;
    const summary = element('summary', {
      className: 'sub-pages-button sub-pages-icon-button sub-pages-menu-trigger',
      title: menuLabel,
      role: 'button',
      ariaLabel: menuLabel,
    }, [iconElement('more')]);
    summary.setAttribute('aria-haspopup', 'menu');
    summary.setAttribute('aria-expanded', 'false');
    details.appendChild(summary);

    const menu = element('div', { className: 'sub-pages-menu', role: 'menu' });
    menu.appendChild(menuButton('openNote', node, 'Open'));
    menu.appendChild(menuButton('openNoteInNewWindow', node, 'Open in new window'));
    menu.appendChild(menuButton('startExternalEditing', node, 'Edit in external editor'));
    menu.appendChild(menuButton('commandPalette', node, 'Command palette...'));
    menu.appendChild(element('div', { className: 'sub-pages-menu-separator' }));
    menu.appendChild(menuButton('setTags', node, 'Tags...'));
    menu.appendChild(menuButton('toggleNoteType', node, node.isTodo ? 'Switch to note' : 'Switch to to-do'));
    menu.appendChild(menuButton('moveBranchToFolder', node, selectionCount > 1 ? `Move ${selectionCount} pages to notebook...` : 'Move to notebook...'));
    menu.appendChild(menuButton('duplicateNote', node, 'Duplicate'));
    menu.appendChild(menuButton('deleteNote', node, 'Delete'));
    menu.appendChild(element('div', { className: 'sub-pages-menu-separator' }));
    menu.appendChild(menuButton('copyMarkdownLink', node, 'Copy Markdown link'));
    menu.appendChild(menuButton('copyExternalLink', node, 'Copy external link'));
    menu.appendChild(menuButton('saveNoteAsMarkdown', node, 'Save as Markdown...'));
    menu.appendChild(menuButton('showNoteProperties', node, 'Note properties'));
    menu.appendChild(element('div', { className: 'sub-pages-menu-separator' }));
    menu.appendChild(menuButton('createChild', node, 'Create child page'));
    menu.appendChild(menuButton('createChildWhiteboard', node, 'Create child whiteboard'));
    menu.appendChild(menuButton('move', node, 'Move under...'));
    menu.appendChild(menuButton('promote', node, 'Promote to root', depth <= 0));
    menu.appendChild(menuButton('moveUp', node, 'Move up', !node.canMoveUp));
    menu.appendChild(menuButton('moveDown', node, 'Move down', !node.canMoveDown));
    menu.appendChild(element('div', { className: 'sub-pages-menu-separator' }));
    menu.appendChild(menuButton('unlink', node, 'Unlink', depth <= 0 && !hasChildren));

    details.appendChild(menu);
    return details;
  }

  function renderExternalNoteMenu(note) {
    const details = element('details', { className: 'sub-pages-row-menu' });
    const menuLabel = `More actions for ${note.title || 'Untitled page'}`;
    const selectionCount = selectedActionNoteIds(note.id).length;
    const summary = element('summary', {
      className: 'sub-pages-button sub-pages-icon-button sub-pages-menu-trigger',
      title: menuLabel,
      role: 'button',
      ariaLabel: menuLabel,
    }, [iconElement('more')]);
    summary.setAttribute('aria-haspopup', 'menu');
    summary.setAttribute('aria-expanded', 'false');
    details.appendChild(summary);

    const menu = element('div', { className: 'sub-pages-menu', role: 'menu' });
    menu.appendChild(menuButton('openNote', note, 'Open'));
    menu.appendChild(menuButton('openNoteInNewWindow', note, 'Open in new window'));
    menu.appendChild(menuButton('startExternalEditing', note, 'Edit in external editor'));
    menu.appendChild(menuButton('commandPalette', note, 'Command palette...'));
    menu.appendChild(element('div', { className: 'sub-pages-menu-separator' }));
    menu.appendChild(menuButton('setTags', note, 'Tags...'));
    menu.appendChild(menuButton('toggleNoteType', note, note.isTodo ? 'Switch to note' : 'Switch to to-do'));
    menu.appendChild(menuButton('moveBranchToFolder', note, selectionCount > 1 ? `Move ${selectionCount} pages to notebook...` : 'Move to notebook...'));
    menu.appendChild(menuButton('duplicateNote', note, 'Duplicate'));
    menu.appendChild(menuButton('deleteNote', note, 'Delete'));
    menu.appendChild(element('div', { className: 'sub-pages-menu-separator' }));
    menu.appendChild(menuButton('copyMarkdownLink', note, 'Copy Markdown link'));
    menu.appendChild(menuButton('copyExternalLink', note, 'Copy external link'));
    menu.appendChild(menuButton('saveNoteAsMarkdown', note, 'Save as Markdown...'));
    menu.appendChild(menuButton('showNoteProperties', note, 'Note properties'));

    details.appendChild(menu);
    return details;
  }

  function menuButton(action, node, text, disabled) {
    const button = actionButton(action, node.id, text, text, disabled, 'sub-pages-menu-item');
    button.setAttribute('role', 'menuitem');
    return button;
  }

  function actionButton(action, noteId, text, title, disabled, extraClassName) {
    const button = element('button', {
      className: ['sub-pages-button', extraClassName || ''].filter(Boolean).join(' '),
      type: 'button',
      title: title || '',
      ariaLabel: title || text || action,
      disabled: disabled ? 'disabled' : null,
    }, [text]);
    button.dataset.action = action;
    if (noteId) button.dataset.noteId = noteId;
    return button;
  }

  function iconButton(action, noteId, iconName, title, disabled, extraClassName) {
    const button = actionButton(action, noteId, '', title, disabled, extraClassName);
    button.replaceChildren(iconElement(iconName));
    return button;
  }

  function iconElement(iconName) {
    const icon = element('span', { className: 'sub-pages-icon', ariaHidden: 'true' });
    icon.innerHTML = icons[iconName] || '';
    return icon;
  }

  function element(tagName, props, children) {
    const node = document.createElement(tagName);
    Object.entries(props || {}).forEach(([key, value]) => {
      if (value === null || value === undefined) return;
      if (key === 'className') {
        node.className = value;
      } else if (key === 'style') {
        node.setAttribute('style', value);
      } else if (key === 'role') {
        node.setAttribute('role', value);
      } else if (key === 'ariaLabel') {
        node.setAttribute('aria-label', value);
      } else if (key === 'ariaHidden') {
        node.setAttribute('aria-hidden', value);
      } else if (key === 'ariaLevel') {
        node.setAttribute('aria-level', value);
      } else if (key === 'ariaSelected') {
        node.setAttribute('aria-selected', value);
      } else if (key === 'disabled') {
        node.disabled = true;
      } else if (key === 'title') {
        node.title = value;
      } else if (key === 'type') {
        node.type = value;
      } else if (key === 'value') {
        node.value = value;
      } else if (key === 'placeholder') {
        node.placeholder = value;
      } else if (key === 'autocomplete') {
        node.setAttribute('autocomplete', value);
      }
    });

    (children || []).forEach((child) => {
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });

    return node;
  }

  app.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) {
      const rowMenu = event.target.closest('.sub-pages-row-menu');
      if (event.target.closest('.sub-pages-menu-trigger')) {
        event.preventDefault();
        const shouldOpen = rowMenu && !rowMenu.open;
        if (rowMenu && shouldOpen) openMenu(rowMenu, { focusFirst: event.detail === 0 });
        else closeOpenMenus();
      } else if (!rowMenu) {
        closeOpenMenus();
      }
      return;
    }

    if (!button || button.disabled) return;

    handleActionButton(button, event);
  });

  document.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) {
      if (!isPanelInteractionTarget(event.target)) closeOpenMenus();
      return;
    }
    if (button.disabled || app.contains(button) || !button.closest('.sub-pages-menu')) return;

    event.preventDefault();
    handleActionButton(button, event);
  });

  function handleActionButton(button, event) {
    const action = button.dataset.action;
    const noteId = button.dataset.noteId || null;

    if (action === 'setSearchScope') {
      const nextScope = button.dataset.scope === 'notebook' ? 'notebook' : 'all';
      if (nextScope !== searchScope) {
        searchScope = nextScope;
        if (searchQuery.trim()) scheduleSearch(0);
        else resetSearchState();
        closeOpenMenus();
        render();
        focusSearchInput();
      }
      return;
    }

    if (action === 'clearSearch') {
      searchQuery = '';
      resetSearchState();
      closeOpenMenus();
      render();
      focusSearchInput();
      return;
    }

    if (action === 'toggle' && noteId) {
      closeOpenMenus();
      if (normalizedSearchQuery()) {
        setStatus('Clear search to change collapse state.');
        return;
      }
      toggleCollapsed(noteId);
      return;
    }

    if (action === 'openNote' && noteId && currentState) {
      updatePanelSelection(noteId, event);
      if (event.detail >= 2) {
        currentState.selectedNoteId = noteId;
        render();
        closeOpenMenus();
        post('openNoteInNewWindow', { noteId, noteIds: [noteId] });
        return;
      }

      if (event.ctrlKey || event.metaKey || event.shiftKey) {
        render();
        return;
      }
      if (busy) return;

      currentState.selectedNoteId = noteId;
      render();
      closeOpenMenus();
      post(action, { noteId, noteIds: selectedActionNoteIds(noteId) });
      return;
    }

    if (busy && action !== 'toggle') return;

    if (action === 'unlink') {
      closeOpenMenus();
      post('confirm', { message: 'Unlink this page from its Sub-Pages hierarchy?' })
        .then((response) => {
          if (response && response.confirmed) {
            post(action, noteId ? { noteId, noteIds: selectedActionNoteIds(noteId) } : {});
          }
        });
      return;
    }

    closeOpenMenus();
    post(action, noteId ? { noteId, noteIds: selectedActionNoteIds(noteId) } : {});
  }

  app.addEventListener('dblclick', (event) => {
    const row = event.target.closest('.sub-pages-row[data-note-id]');
    if (!row || event.target.closest('.sub-pages-row-menu') || event.target.closest('button[data-action="openNote"]')) return;
    const noteId = row.dataset.noteId;
    if (!noteId) return;

    event.preventDefault();
    updatePanelSelection(noteId, event);
    render();
    post('openNoteInNewWindow', { noteId, noteIds: [noteId] });
  });

  app.addEventListener('dragstart', (event) => {
    const row = event.target.closest('.sub-pages-row[data-note-id]');
    if (!row || !event.dataTransfer) return;
    if (event.target.closest('input, textarea, select, .sub-pages-row-actions, .sub-pages-row-menu, .sub-pages-menu')) {
      event.preventDefault();
      return;
    }

    const payload = dragPayloadForRow(row);
    if (!payload || !payload.noteIds.length) {
      event.preventDefault();
      return;
    }

    event.dataTransfer.clearData();
    event.dataTransfer.setData(joplinNoteDragType, JSON.stringify(payload.noteIds));
    event.dataTransfer.setData('text/plain', payload.noteIds.join('\n'));
    if (payload.noteId) event.dataTransfer.setData('application/x-joplin-sub-pages-note-id', payload.noteId);
    event.dataTransfer.effectAllowed = 'move';

    draggedNoteId = null;
    dropTargetNoteId = null;
    dropToRootActive = false;
    dragSourceRow = row;
    dragSourceRow.classList.add('is-dragging');
    showDragStatus(payload.noteIds.length === 1
      ? 'Drop on a Joplin notebook to move this page.'
      : `Drop on a Joplin notebook to move ${payload.noteIds.length} pages.`);
    closeOpenMenus();
    postQuiet('noteDragStarted', payload);

    if (!busy && !normalizedSearchQuery() && row.dataset.dragScope === 'tree') {
      draggedNoteId = payload.noteId;
      updatePanelSelection(payload.noteId, event);
      setDragVisuals(row, null, false);
    }
  });

  app.addEventListener('dragover', (event) => {
    if (!draggedNoteId || busy || normalizedSearchQuery()) return;

    const row = event.target.closest('.sub-pages-row[data-note-id]');
    const rootDropZone = rootDropTargetForEventTarget(event.target);
    const canDropOnTargetRow = !!row && !row.classList.contains('sub-pages-external-row') && canDropOnRow(draggedNoteId, row.dataset.noteId);
    const canDropOnRootZone = !!rootDropZone && canDropToRoot(draggedNoteId);

    if (!canDropOnTargetRow && !canDropOnRootZone) return;

    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';

    const nextDropTargetNoteId = canDropOnTargetRow ? row.dataset.noteId : null;
    const nextDropToRootActive = !canDropOnTargetRow && canDropOnRootZone;
    if (dropTargetNoteId !== nextDropTargetNoteId || dropToRootActive !== nextDropToRootActive) {
      dropTargetNoteId = nextDropTargetNoteId;
      dropToRootActive = nextDropToRootActive;
      setDragVisuals(app.querySelector(`.sub-pages-row[data-note-id="${cssEscape(draggedNoteId)}"]`), canDropOnTargetRow ? row : null, dropToRootActive);
    }
  });

  app.addEventListener('dragleave', (event) => {
    if (!draggedNoteId) return;
    if (event.relatedTarget && app.contains(event.relatedTarget)) return;
    dropTargetNoteId = null;
    dropToRootActive = false;
    setDragVisuals(app.querySelector(`.sub-pages-row[data-note-id="${cssEscape(draggedNoteId)}"]`), null, false);
  });

  app.addEventListener('drop', (event) => {
    if (!draggedNoteId || busy || normalizedSearchQuery()) return;

    const row = event.target.closest('.sub-pages-row[data-note-id]');
    const rootDropZone = rootDropTargetForEventTarget(event.target);
    const targetNoteId = row && !row.classList.contains('sub-pages-external-row') && canDropOnRow(draggedNoteId, row.dataset.noteId) ? row.dataset.noteId : null;
    const dropToRoot = !targetNoteId && !!rootDropZone && canDropToRoot(draggedNoteId);
    const noteId = draggedNoteId;

    if (!targetNoteId && !dropToRoot) return;

    event.preventDefault();
    draggedNoteId = null;
    dropTargetNoteId = null;
    dropToRootActive = false;
    clearDragVisuals();

    if (targetNoteId && targetNoteId !== noteId) {
      post('dropOnNote', { noteId, targetNoteId });
    } else if (dropToRoot) {
      post('dropToRoot', { noteId });
    }
  });

  app.addEventListener('dragend', () => {
    draggedNoteId = null;
    dropTargetNoteId = null;
    dropToRootActive = false;
    clearDragState();
  });

  app.addEventListener('input', (event) => {
    const input = event.target.closest('input[data-action="search"]');
    if (!input) return;

    const cursorPosition = input.selectionStart;
    const wasEmpty = !searchQuery.trim();
    searchQuery = input.value;
    scheduleSearch();
    closeOpenMenus();
    if (wasEmpty !== !searchQuery.trim()) {
      render();
      focusSearchInput(cursorPosition);
    }
  });

  app.addEventListener('contextmenu', (event) => {
    const row = event.target.closest('.sub-pages-row[data-note-id]');
    if (!row) return;
    event.preventDefault();
    const details = row.querySelector('.sub-pages-row-menu');
    if (!details) return;
    openMenu(details, { focusFirst: true });
  });

  app.addEventListener('focusout', () => {
    window.setTimeout(() => {
      if (!isPanelInteractionTarget(document.activeElement)) closeOpenMenus();
    }, 0);
  });

  window.addEventListener('blur', () => {
    closeOpenMenus();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    syncSelectedNote();
    syncPanelState();
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Delete' || event.key === 'Backspace') {
      deleteSelectedNotes(event);
      return;
    }

    if (event.key !== 'Escape') return;

    const openMenu = app.querySelector('.sub-pages-row-menu[open]');
    if (openMenu) {
      event.preventDefault();
      closeOpenMenus(null, true);
      return;
    }

    if (searchQuery) {
      event.preventDefault();
      searchQuery = '';
      resetSearchState();
      render();
      focusSearchInput();
    }
  });

  app.addEventListener('keydown', (event) => {
    if (handleTreeNavigationKeydown(event)) return;

    const trigger = event.target.closest('.sub-pages-menu-trigger');
    if (trigger) {
      const rowMenu = trigger.closest('.sub-pages-row-menu');
      if (!rowMenu) return;

      if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        openMenu(rowMenu, { focusFirst: event.key !== 'ArrowUp', focusLast: event.key === 'ArrowUp' });
      }
      return;
    }

    const menu = event.target.closest('.sub-pages-menu');
    if (menu) handleMenuKeydown(event, menu);
  });

  function deleteSelectedNotes(event) {
    if (!currentState || busy) return;
    if (isTextInputTarget(event.target) || event.target.closest('.sub-pages-menu')) return;

    const noteIds = selectedActionNoteIds(lastPanelSelectedId || currentState.selectedNoteId);
    if (!noteIds.length) return;

    event.preventDefault();
    closeOpenMenus();
    post('deleteNote', { noteId: noteIds[0], noteIds });
  }

  function isTextInputTarget(target) {
    if (!target || !target.closest) return false;
    return !!target.closest('input, textarea, select, [contenteditable="true"]');
  }

  function handleTreeNavigationKeydown(event) {
    if (isTextInputTarget(event.target)) return false;
    if (event.target.closest('.sub-pages-menu, .sub-pages-menu-trigger')) return false;

    const row = event.target.closest('.sub-pages-row[data-note-id]');
    if (!row) return false;

    const rows = visibleTreeRows();
    const index = rows.indexOf(row);
    if (index < 0) return false;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusRowTitle(rows[Math.min(index + 1, rows.length - 1)]);
      return true;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusRowTitle(rows[Math.max(index - 1, 0)]);
      return true;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      focusRowTitle(rows[0]);
      return true;
    }

    if (event.key === 'End') {
      event.preventDefault();
      focusRowTitle(rows[rows.length - 1]);
      return true;
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      expandOrFocusChild(row);
      return true;
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      collapseOrFocusParent(row);
      return true;
    }

    return false;
  }

  function visibleTreeRows() {
    return [...app.querySelectorAll('.sub-pages-row[data-note-id]')];
  }

  function focusRowTitle(row) {
    const title = row && row.querySelector('.sub-pages-note-title');
    if (title) title.focus();
  }

  function focusRowByNoteId(noteId) {
    if (!noteId) return;
    window.requestAnimationFrame(() => {
      focusRowTitle(app.querySelector(`.sub-pages-row[data-note-id="${cssEscape(noteId)}"]`));
    });
  }

  function expandOrFocusChild(row) {
    const noteId = row.dataset.noteId;
    if (!noteId) return;

    if (!normalizedSearchQuery() && row.getAttribute('aria-expanded') === 'false' && collapsedIds.has(noteId)) {
      setCollapsed(noteId, false);
      focusRowByNoteId(noteId);
      return;
    }

    const rows = visibleTreeRows();
    const index = rows.indexOf(row);
    const next = rows[index + 1];
    if (next && Number(next.getAttribute('aria-level') || '1') > Number(row.getAttribute('aria-level') || '1')) {
      focusRowTitle(next);
    }
  }

  function collapseOrFocusParent(row) {
    const noteId = row.dataset.noteId;
    if (!noteId) return;

    if (!normalizedSearchQuery() && row.getAttribute('aria-expanded') === 'true') {
      setCollapsed(noteId, true);
      focusRowByNoteId(noteId);
      return;
    }

    const parentId = treeParentMap().get(noteId);
    if (parentId) focusRowByNoteId(parentId);
  }

  document.addEventListener('keydown', (event) => {
    if (app.contains(event.target)) return;

    const menu = event.target.closest('.sub-pages-menu');
    if (menu) handleMenuKeydown(event, menu);
  });

  function handleMenuKeydown(event, menuPanel) {
    const rowMenu = menuPanel.__subPagesHome || menuPanel.closest('.sub-pages-row-menu');
    if (event.key === 'Escape') {
      event.preventDefault();
      if (rowMenu) closeMenu(rowMenu, true);
      return;
    }

    const items = [...menuPanel.querySelectorAll('.sub-pages-menu-item:not(:disabled)')];
    const currentIndex = items.indexOf(document.activeElement);
    let nextIndex = -1;

    if (event.key === 'ArrowDown') nextIndex = currentIndex < items.length - 1 ? currentIndex + 1 : 0;
    else if (event.key === 'ArrowUp') nextIndex = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = items.length - 1;
    else return;

    if (nextIndex >= 0 && items[nextIndex]) {
      event.preventDefault();
      items[nextIndex].focus();
    }
  }

  function focusSearchInput(cursorPosition) {
    const input = app.querySelector('input[data-action="search"]');
    if (!input) return;

    input.focus();
    const position = typeof cursorPosition === 'number' ? cursorPosition : input.value.length;
    if (typeof input.setSelectionRange === 'function') input.setSelectionRange(position, position);
  }

  function resetSearchState() {
    if (searchDebounceTimer) {
      window.clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
    searchRequestSerial += 1;
    searchState = emptySearchState();
  }

  function setDragVisuals(draggedRow, targetRow, rootTarget) {
    clearDragVisuals();
    if (draggedRow) draggedRow.classList.add('is-dragging');
    if (targetRow) targetRow.classList.add('is-drop-target');
    app.querySelectorAll('.sub-pages-root-drop-zone').forEach((zone) => {
      zone.classList.add('is-visible');
      zone.classList.toggle('is-drop-target', !!rootTarget);
    });
  }

  function clearDragVisuals() {
    app.querySelectorAll('.sub-pages-row.is-dragging').forEach((row) => row.classList.remove('is-dragging'));
    app.querySelectorAll('.sub-pages-row.is-drop-target').forEach((row) => row.classList.remove('is-drop-target'));
    app.querySelectorAll('.sub-pages-root-drop-zone').forEach((zone) => {
      zone.classList.remove('is-visible', 'is-drop-target');
    });
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value || '').replace(/["\\]/g, '\\$&');
  }

  function scheduleSearch(delay) {
    if (searchDebounceTimer) window.clearTimeout(searchDebounceTimer);

    const query = searchQuery.trim();
    const scope = searchScope;
    searchRequestSerial += 1;
    const requestId = searchRequestSerial;

    if (!query) {
      searchDebounceTimer = null;
      searchState = emptySearchState();
      return;
    }

    const keepPrevious = !!searchState.query && searchState.scope === scope;
    searchState = {
      query: keepPrevious ? searchState.query : '',
      scope,
      noteIds: keepPrevious ? (searchState.noteIds || []) : [],
      externalResults: keepPrevious ? (searchState.externalResults || []) : [],
      loading: true,
      message: '',
    };

    searchDebounceTimer = window.setTimeout(() => {
      searchDebounceTimer = null;
      runSearch(query, scope, requestId);
    }, typeof delay === 'number' ? delay : searchDebounceMs);
  }

  function runSearch(query, scope, requestId) {
    if (!api || typeof api.postMessage !== 'function') {
      if (requestId !== searchRequestSerial) return;
      searchState = {
        query,
        scope,
        noteIds: [],
        externalResults: [],
        loading: false,
        message: 'Joplin search is unavailable.',
      };
      render();
      return;
    }

    Promise.resolve(api.postMessage({ name: 'search', query, scope }))
      .then((response) => {
        if (requestId !== searchRequestSerial || query !== searchQuery.trim() || scope !== searchScope) return;
        const noteIds = response && Array.isArray(response.noteIds)
          ? response.noteIds.filter((id) => typeof id === 'string')
          : [];
        const externalResults = response && Array.isArray(response.externalResults)
          ? response.externalResults.map(normalizeExternalResult).filter(Boolean)
          : [];
        searchState = {
          query: response && typeof response.query === 'string' ? response.query : query,
          scope,
          noteIds,
          externalResults,
          loading: false,
          message: response && typeof response.message === 'string' ? response.message : '',
        };
        renderPreservingSearchFocus();
      })
      .catch((error) => {
        if (requestId !== searchRequestSerial || query !== searchQuery.trim() || scope !== searchScope) return;
        searchState = {
          query,
          scope,
          noteIds: [],
          externalResults: [],
          loading: false,
          message: error && error.message ? error.message : String(error),
        };
        renderPreservingSearchFocus();
      });
  }

  function renderPreservingSearchFocus() {
    const activeElement = document.activeElement;
    const keepFocus = !!(activeElement && activeElement.closest && activeElement.closest('input[data-action="search"]'));
    const cursorPosition = keepFocus ? activeElement.selectionStart : null;

    render();
    if (keepFocus) focusSearchInput(cursorPosition);
  }

  function emptySearchState() {
    return { query: '', scope: searchScope, noteIds: [], externalResults: [], loading: false, message: '' };
  }

  function normalizeExternalResult(value) {
    if (!value || typeof value.id !== 'string') return null;
    return {
      id: value.id,
      title: typeof value.title === 'string' && value.title.trim() ? value.title : 'Untitled page',
      parentId: typeof value.parentId === 'string' ? value.parentId : '',
      notebookId: typeof value.notebookId === 'string' ? value.notebookId : (typeof value.parentId === 'string' ? value.parentId : ''),
      notebookTitle: typeof value.notebookTitle === 'string' && value.notebookTitle.trim() ? value.notebookTitle : 'Other notebook',
      pageType: value.pageType === 'whiteboard' ? 'whiteboard' : 'note',
      isTodo: !!value.isTodo,
      todoCompleted: !!value.todoCompleted,
      updatedTime: typeof value.updatedTime === 'number' ? value.updatedTime : 0,
    };
  }

  function openMenu(menu, options) {
    closeOpenMenus(menu);
    menu.open = true;
    portalMenuPanel(menu);
    syncOpenMenuClass(menu);

    if (options && (options.focusFirst || options.focusLast)) {
      window.requestAnimationFrame(() => {
        const menuPanel = menuPanelFor(menu);
        const items = menuPanel ? [...menuPanel.querySelectorAll('.sub-pages-menu-item:not(:disabled)')] : [];
        const item = options.focusLast ? items[items.length - 1] : items[0];
        if (item) item.focus();
      });
    }
  }

  function closeMenu(menu, returnFocus) {
    menu.open = false;
    syncOpenMenuClass(menu);
    restoreMenuPanel(menu);

    if (returnFocus) {
      const trigger = menu.querySelector('.sub-pages-menu-trigger');
      if (trigger) trigger.focus();
    }
  }

  function closeOpenMenus(except, returnFocus) {
    app.querySelectorAll('.sub-pages-row-menu[open]').forEach((menu) => {
      if (menu !== except) closeMenu(menu, returnFocus);
    });
  }

  function cleanupDetachedMenus() {
    document.body.querySelectorAll('.sub-pages-menu').forEach((menuPanel) => {
      const home = menuPanel.__subPagesHome;
      if (!home || !app.contains(home)) menuPanel.remove();
    });
  }

  function syncOpenMenuClass(menu) {
    const row = menu.closest('.sub-pages-row');
    if (row) row.classList.toggle('has-open-menu', !!menu.open);
    const trigger = menu.querySelector('.sub-pages-menu-trigger');
    if (trigger) trigger.setAttribute('aria-expanded', menu.open ? 'true' : 'false');
    menu.classList.remove('opens-up');

    const menuPanel = menuPanelFor(menu);
    if (menuPanel) resetMenuPanelPosition(menuPanel);

    if (!menu.open) return;

    window.requestAnimationFrame(() => {
      if (!menu.open) return;

      const menuPanel = menuPanelFor(menu);
      if (!menuPanel) return;

      const margin = 8;
      const triggerRect = menu.getBoundingClientRect();
      const viewportWidth = Math.max(80, window.innerWidth);
      const viewportHeight = Math.max(80, window.innerHeight);
      const panelRect = menuPanel.getBoundingClientRect();
      const menuWidth = Math.min(panelRect.width || 240, viewportWidth - margin * 2);
      const naturalHeight = menuPanel.scrollHeight || panelRect.height || 260;
      const targetHeight = Math.min(naturalHeight, 420);
      const availableBelow = window.innerHeight - triggerRect.bottom - margin;
      const availableAbove = triggerRect.top - margin;
      const openUp = availableBelow < targetHeight && availableAbove > availableBelow;
      const availableHeight = Math.max(80, openUp ? availableAbove : availableBelow);
      const menuHeight = Math.min(targetHeight, availableHeight, viewportHeight - margin * 2);
      const left = Math.max(margin, Math.min(triggerRect.right - menuWidth, viewportWidth - menuWidth - margin));
      const top = openUp
        ? Math.max(margin, triggerRect.top - menuHeight - 4)
        : Math.min(triggerRect.bottom + 4, viewportHeight - menuHeight - margin);

      menu.classList.toggle('opens-up', openUp);
      menuPanel.style.position = 'fixed';
      menuPanel.style.right = 'auto';
      menuPanel.style.bottom = 'auto';
      menuPanel.style.left = `${left}px`;
      menuPanel.style.top = `${top}px`;
      menuPanel.style.setProperty('--sub-pages-menu-max-height', `${menuHeight}px`);
    });
  }

  function portalMenuPanel(menu) {
    const menuPanel = menuPanelFor(menu);
    if (!menuPanel || menuPanel.parentElement === document.body) return;

    menuPanel.__subPagesHome = menu;
    document.body.appendChild(menuPanel);
  }

  function restoreMenuPanel(menu) {
    const menuPanel = menuPanelFor(menu);
    if (!menuPanel || menuPanel.__subPagesHome !== menu) return;

    resetMenuPanelPosition(menuPanel);
    menu.appendChild(menuPanel);
    delete menuPanel.__subPagesHome;
  }

  function menuPanelFor(menu) {
    const localPanel = menu.querySelector('.sub-pages-menu');
    if (localPanel) return localPanel;

    return [...document.body.querySelectorAll('.sub-pages-menu')]
      .find((panel) => panel.__subPagesHome === menu) || null;
  }

  function resetMenuPanelPosition(menuPanel) {
    menuPanel.style.removeProperty('--sub-pages-menu-max-height');
    menuPanel.style.removeProperty('position');
    menuPanel.style.removeProperty('right');
    menuPanel.style.removeProperty('bottom');
    menuPanel.style.removeProperty('left');
    menuPanel.style.removeProperty('top');
  }

  function showDragStatus(message) {
    if (!dragStatusElement) {
      dragStatusElement = element('div', {
        className: 'sub-pages-drag-status',
        role: 'status',
      });
    }

    if (!app.contains(dragStatusElement)) {
      app.appendChild(dragStatusElement);
    }

    dragStatusElement.textContent = message || '';
    dragStatusElement.hidden = !message;
  }

  function clearDragState() {
    if (dragSourceRow) dragSourceRow.classList.remove('is-dragging');
    dragSourceRow = null;
    clearDragVisuals();
    if (dragStatusElement) dragStatusElement.hidden = true;
  }

  function isPanelInteractionTarget(target) {
    return !!(target && target.closest && (app.contains(target) || target.closest('.sub-pages-menu')));
  }

  if (api && typeof api.onMessage === 'function') {
    api.onMessage((message) => {
      if (!message) return;

      if (message.name === 'selection') {
        if (isRowDragActive()) return;
        if (!currentState) return;
        currentState.selectedNoteId = message.selectedNoteId || null;
        syncPanelSelectionToSelectedNote();
        render();
        return;
      }

      if (message.name !== 'state') return;
      if (isRowDragActive()) return;
      if (!acceptStateRevision(message.revision)) return;
      currentState = message.state;
      applyPanelAppearance();
      normalizeSearchScopeForView();
      statusText = '';
      syncPanelSelectionToSelectedNote();
      prunePanelSelection();
      render();
      if (searchQuery.trim()) scheduleSearch(0);
    });
  }

  window.addEventListener('error', (event) => {
    setStatus(event.message || 'Sub-Pages panel script failed.');
  });

  window.setTimeout(() => {
    if (!currentState) setStatus('Still loading. The plugin is waiting for note data from Joplin.');
  }, 5000);

  window.setInterval(syncSelectedNote, selectionPollMs);
  window.setInterval(syncPanelState, statePollMs);

  post('ready');
}());
