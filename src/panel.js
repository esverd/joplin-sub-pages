(function () {
  const app = document.getElementById('app');
  const api = window.webviewApi;
  const collapsedIds = new Set();
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
  const searchDebounceMs = 380;

  const icons = {
    chevronDown: '<svg viewBox="0 0 16 16"><path d="m4 6 4 4 4-4"/></svg>',
    chevronRight: '<svg viewBox="0 0 16 16"><path d="m6 4 4 4-4 4"/></svg>',
    more: '<svg viewBox="0 0 16 16"><circle cx="3.5" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="12.5" cy="8" r="1.1"/></svg>',
    plus: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>',
    refresh: '<svg viewBox="0 0 16 16"><path d="M13 6A5 5 0 1 0 14 9M13 6V2h-4"/></svg>',
    repair: '<svg viewBox="0 0 16 16"><path d="M10.8 2.3a3.2 3.2 0 0 0-4 4L2.8 10.3a1.7 1.7 0 0 0 2.4 2.4l4-4a3.2 3.2 0 0 0 4-4l-2 2-2-2 2-2Z"/></svg>',
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
      if (typeof response.revision === 'number') stateRevision = response.revision;
      currentState = response.state;
      statusText = response.message || '';
      syncPanelSelectionToSelectedNote();
      prunePanelSelection();
      render();
      if (searchQuery.trim()) scheduleSearch(0);
      return;
    }

    if (response.message) setStatus(response.message);
  }

  function setBusy(value) {
    busy = value;
    app.classList.toggle('is-busy', busy);
  }

  function setStatus(message) {
    statusText = message || '';
    render();
  }

  function syncSelectedNote() {
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

    if (currentState.error) {
      root.appendChild(element('div', { className: 'sub-pages-empty' }, [currentState.error]));
    } else {
      const search = currentSearch();
      const visibleNodes = filteredRootNodes(search);
      const externalResults = search.active ? search.externalResults : [];

      if (currentState.nodes.length && visibleNodes.length) {
        const tree = element('div', { className: 'sub-pages-tree', role: 'tree' });
        visibleNodes.forEach((node) => renderNode(node, 0, tree, search));
        root.appendChild(tree);
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
    const folderTitle = currentState.folder ? currentState.folder.title : 'Sub-Pages';
    const repairCount = Number(currentState.repairCount || 0);
    const header = element('div', { className: 'sub-pages-header' });
    const titleWrap = element('div', { className: 'sub-pages-title-wrap' });

    const actions = element('div', { className: 'sub-pages-header-actions' });
    actions.appendChild(iconButton('createRoot', null, 'plus', 'Create root page', false, 'sub-pages-icon-button'));
    if (repairCount > 0) {
      actions.appendChild(iconButton('repair', null, 'repair', `Repair ${repairCount} metadata issue${repairCount === 1 ? '' : 's'}`, false, 'sub-pages-icon-button'));
    }
    actions.appendChild(iconButton('refresh', null, 'refresh', 'Refresh tree', false, 'sub-pages-icon-button'));
    header.appendChild(actions);

    titleWrap.appendChild(element('div', { className: 'sub-pages-heading' }, [folderTitle]));
    header.appendChild(titleWrap);

    return header;
  }

  function renderSearch() {
    const search = currentSearch();
    const active = search.active;
    const visibleCount = active ? countVisibleSearchNodes(currentState.nodes, search) : countTreeNodes(currentState.nodes);
    const externalCount = active ? search.externalResults.length : 0;
    const wrap = element('div', { className: ['sub-pages-search', active ? 'is-active' : ''].filter(Boolean).join(' ') });

    const input = element('input', {
      className: 'sub-pages-search-input',
      type: 'search',
      value: searchQuery,
      placeholder: searchScope === 'all' ? 'Search all notebooks...' : 'Search this notebook...',
      ariaLabel: 'Search Sub-Pages with Joplin search',
      autocomplete: 'off',
    });
    input.dataset.action = 'search';
    wrap.appendChild(input);

    if (active) {
      wrap.appendChild(actionButton('clearSearch', null, 'Clear', 'Clear search', false, 'sub-pages-clear-search'));
    }

    wrap.appendChild(renderSearchScope());

    if (active) {
      const scopeLabel = search.scope === 'all' ? 'All notebooks' : 'This notebook';
      const shown = visibleCount + externalCount;
      const status = search.loading
        ? `Searching Joplin (${scopeLabel})...`
        : `${scopeLabel}: showing ${shown} row${shown === 1 ? '' : 's'} (${visibleCount} in this notebook${search.scope === 'all' ? `, ${externalCount} elsewhere` : ''}).`;
      wrap.appendChild(element('div', { className: 'sub-pages-filter-status' }, [
        search.message ? `${status} ${search.message}` : status,
      ]));
    }

    return wrap;
  }

  function renderSearchScope() {
    const group = element('div', { className: 'sub-pages-search-scope', role: 'group', ariaLabel: 'Search scope' });
    [
      { value: 'all', label: 'All' },
      { value: 'notebook', label: 'Notebook' },
    ].forEach((scope) => {
      const button = actionButton('setSearchScope', null, scope.label, `Search ${scope.value === 'all' ? 'all notebooks' : 'this notebook'}`, false, 'sub-pages-scope-button');
      button.dataset.scope = scope.value;
      button.setAttribute('aria-pressed', searchScope === scope.value ? 'true' : 'false');
      if (searchScope === scope.value) button.classList.add('is-active');
      group.appendChild(button);
    });
    return group;
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
      ].filter(Boolean).join(' '),
      role: 'treeitem',
      ariaLevel: String(depth + 1),
      ariaSelected: panelSelectedIds.has(node.id) || node.id === currentState.selectedNoteId ? 'true' : 'false',
      style: `--depth: ${depth};`,
    });
    row.dataset.noteId = node.id;

    const hasChildren = hasNodeChildren(node);
    const hasVisibleChildren = visibleChildren.length > 0;
    const isCollapsed = !filtering && collapsedIds.has(node.id);
    if (hasChildren) row.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    row.classList.add(isCollapsed ? 'is-collapsed' : 'is-expanded');
    const main = element('div', { className: 'sub-pages-row-main' });

    if (hasChildren) {
      main.appendChild(iconButton('toggle', node.id, isCollapsed ? 'chevronRight' : 'chevronDown', filtering ? 'Collapse state is preserved while filtering' : (isCollapsed ? 'Expand' : 'Collapse'), false, 'sub-pages-icon-button sub-pages-toggle'));
    } else if (depth > 0) {
      main.appendChild(element('span', { className: 'sub-pages-spacer' }));
    }

    const title = actionButton('openNote', node.id, '', `Open ${node.title || 'Untitled page'}`);
    title.classList.add('sub-pages-note-title');
    appendHighlightedTitle(title, node.title || 'Untitled page', search.normalizedQuery);
    if (node.isTodo) title.classList.add(node.todoCompleted ? 'is-done' : 'is-todo');
    main.appendChild(title);

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
        note.id === currentState.selectedNoteId ? 'is-selected' : '',
        panelSelectedIds.has(note.id) ? 'is-panel-selected' : '',
      ].filter(Boolean).join(' '),
      role: 'listitem',
      style: '--depth: 0;',
    });
    row.dataset.noteId = note.id;

    const main = element('div', { className: 'sub-pages-row-main' });
    main.appendChild(element('span', { className: 'sub-pages-spacer' }));

    const title = actionButton('openNote', note.id, '', `Open ${note.title || 'Untitled page'}`);
    title.classList.add('sub-pages-note-title');
    appendHighlightedTitle(title, note.title || 'Untitled page', search.normalizedQuery);
    if (note.isTodo) title.classList.add(note.todoCompleted ? 'is-done' : 'is-todo');
    main.appendChild(title);

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
    menu.appendChild(menuButton('showNoteProperties', node, 'Note properties'));
    menu.appendChild(element('div', { className: 'sub-pages-menu-separator' }));
    menu.appendChild(menuButton('createChild', node, 'Create child'));
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
      if (collapsedIds.has(noteId)) collapsedIds.delete(noteId);
      else collapsedIds.add(noteId);
      render();
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

    if (action === 'unlink' && !window.confirm('Unlink this page from its Sub-Pages hierarchy?')) return;

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
          message: response && response.ok === false && response.message ? response.message : '',
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
      notebookTitle: typeof value.notebookTitle === 'string' && value.notebookTitle.trim() ? value.notebookTitle : 'Other notebook',
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

  function isPanelInteractionTarget(target) {
    return !!(target && target.closest && (app.contains(target) || target.closest('.sub-pages-menu')));
  }

  if (api && typeof api.onMessage === 'function') {
    api.onMessage((message) => {
      if (!message) return;

      if (message.name === 'selection') {
        if (!currentState) return;
        currentState.selectedNoteId = message.selectedNoteId || null;
        syncPanelSelectionToSelectedNote();
        render();
        return;
      }

      if (message.name !== 'state') return;
      if (typeof message.revision === 'number') stateRevision = message.revision;
      currentState = message.state;
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

  window.setInterval(syncSelectedNote, 1000);
  window.setInterval(syncPanelState, 500);

  post('ready');
}());
