(function () {
  const app = document.getElementById('app');
  const api = window.webviewApi;
  const collapsedIds = new Set();
  let currentState = null;
  let searchQuery = '';
  let statusText = '';
  let busy = false;
  let selectionSyncInFlight = false;
  let stateRevision = 0;
  let stateSyncInFlight = false;

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
      render();
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
      const filterText = normalizedSearchQuery();
      const visibleNodes = filteredRootNodes(filterText);

      if (!filterText && shouldShowOnboarding()) root.appendChild(renderOnboarding());

      if (currentState.nodes.length && visibleNodes.length) {
        const tree = element('div', { className: 'sub-pages-tree', role: 'tree' });
        visibleNodes.forEach((node) => renderNode(node, 0, tree, filterText));
        root.appendChild(tree);
      } else if (filterText) {
        root.appendChild(element('div', { className: 'sub-pages-empty' }, [`No pages match “${searchQuery.trim()}”.`]));
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
    titleWrap.appendChild(element('div', { className: 'sub-pages-subtitle' }, [
      `${currentState.noteCount || 0} notes | ${currentState.metadataItemCount || 0} Sub-Pages metadata items | ${sortLabel(currentState.sortMode)}`,
    ]));
    header.appendChild(titleWrap);

    return header;
  }

  function renderSearch() {
    const filterText = normalizedSearchQuery();
    const active = !!filterText;
    const visibleCount = active ? countVisibleFilterNodes(currentState.nodes, filterText) : countTreeNodes(currentState.nodes);
    const totalCount = countTreeNodes(currentState.nodes);
    const wrap = element('div', { className: ['sub-pages-search', active ? 'is-active' : ''].filter(Boolean).join(' ') });

    const input = element('input', {
      className: 'sub-pages-search-input',
      type: 'search',
      value: searchQuery,
      placeholder: 'Search pages...',
      ariaLabel: 'Search Sub-Pages by title',
      autocomplete: 'off',
    });
    input.dataset.action = 'search';
    wrap.appendChild(input);

    if (active) {
      wrap.appendChild(actionButton('clearSearch', null, 'Clear', 'Clear search', false, 'sub-pages-clear-search'));
      wrap.appendChild(element('div', { className: 'sub-pages-filter-status' }, [
        `Filtering: showing ${visibleCount} of ${totalCount} page${totalCount === 1 ? '' : 's'}. Matching branches are expanded temporarily.`,
      ]));
    }

    return wrap;
  }

  function shouldShowOnboarding() {
    return Number(currentState.noteCount || 0) === 0 || Number(currentState.metadataItemCount || 0) === 0;
  }

  function renderOnboarding() {
    const noteCount = Number(currentState.noteCount || 0);
    const selectedNode = findNodeById(currentState.nodes, currentState.selectedNoteId);
    const empty = noteCount === 0;
    const wrap = element('div', { className: 'sub-pages-onboarding' });

    wrap.appendChild(element('div', { className: 'sub-pages-onboarding-title' }, [
      empty ? 'Start a Sub-Pages notebook' : 'No linked sub-pages yet',
    ]));
    wrap.appendChild(element('div', { className: 'sub-pages-onboarding-copy' }, [
      empty
        ? 'Create the first page here, then add child pages from its row menu.'
        : 'Your notebook is still a flat list. Create a child under the selected page, or use a row menu to begin a hierarchy.',
    ]));

    const actions = element('div', { className: 'sub-pages-onboarding-actions' });
    if (selectedNode) {
      actions.appendChild(actionButton('createChild', selectedNode.id, 'Create child under selected', 'Create child under selected page'));
    }
    actions.appendChild(actionButton('createRoot', null, empty ? 'Create first page' : 'Create root page', empty ? 'Create first page' : 'Create root page'));
    wrap.appendChild(actions);

    return wrap;
  }

  function renderNode(node, depth, container, filterText) {
    const visibleChildren = filterText
      ? (node.children || []).filter((child) => nodeMatchesFilter(child, filterText))
      : (node.children || []);
    const filtering = !!filterText;
    const row = element('div', {
      className: [
        'sub-pages-row',
        node.id === currentState.selectedNoteId ? 'is-selected' : '',
        node.repairReason ? 'needs-repair' : '',
        depth > 0 ? 'is-child' : 'is-root',
        hasNodeChildren(node) ? 'has-children' : '',
      ].filter(Boolean).join(' '),
      role: 'treeitem',
      ariaLevel: String(depth + 1),
      ariaSelected: node.id === currentState.selectedNoteId ? 'true' : 'false',
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
    } else {
      main.appendChild(element('span', { className: 'sub-pages-spacer' }));
    }

    const title = actionButton('openNote', node.id, '', `Open ${node.title || 'Untitled page'}`);
    title.classList.add('sub-pages-note-title');
    appendHighlightedTitle(title, node.title || 'Untitled page', filterText);
    if (node.isTodo) title.classList.add(node.todoCompleted ? 'is-done' : 'is-todo');
    main.appendChild(title);

    if (hasChildren) {
      const hiddenChildCount = filtering ? node.children.length - visibleChildren.length : 0;
      const titleSuffix = hiddenChildCount > 0 ? ` (${hiddenChildCount} hidden by search)` : '';
      main.appendChild(element('span', { className: 'sub-pages-child-count', title: `${node.children.length} direct child page${node.children.length === 1 ? '' : 's'}${titleSuffix}` }, [String(node.children.length)]));
    }

    if (node.repairReason) {
      main.appendChild(element('span', { className: 'sub-pages-badge', title: node.repairReason }, ['Needs repair']));
    }
    row.appendChild(main);

    const actions = element('span', { className: 'sub-pages-row-actions' });
    actions.appendChild(iconButton('createChild', node.id, 'plus', 'Create child page', false, 'sub-pages-icon-button'));
    actions.appendChild(renderNodeMenu(node, hasChildren, depth));
    row.appendChild(actions);

    container.appendChild(row);

    if (hasVisibleChildren && !isCollapsed) {
      visibleChildren.forEach((child) => renderNode(child, depth + 1, container, filterText));
    }
  }

  function normalizedSearchQuery() {
    return searchQuery.trim().toLocaleLowerCase();
  }

  function filteredRootNodes(filterText) {
    const nodes = currentState && currentState.nodes ? currentState.nodes : [];
    if (!filterText) return nodes;
    return nodes.filter((node) => nodeMatchesFilter(node, filterText));
  }

  function nodeMatchesFilter(node, filterText) {
    if (!filterText) return true;
    if (String(node.title || '').toLocaleLowerCase().includes(filterText)) return true;
    return (node.children || []).some((child) => nodeMatchesFilter(child, filterText));
  }

  function countVisibleFilterNodes(nodes, filterText) {
    return (nodes || []).reduce((count, node) => {
      if (!nodeMatchesFilter(node, filterText)) return count;
      return count + 1 + countVisibleFilterNodes(node.children, filterText);
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
    menu.appendChild(element('div', { className: 'sub-pages-menu-separator' }));
    menu.appendChild(menuButton('setTags', node, 'Tags...'));
    menu.appendChild(menuButton('toggleNoteType', node, node.isTodo ? 'Switch to note' : 'Switch to to-do'));
    menu.appendChild(menuButton('moveToFolder', node, 'Move to notebook...'));
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

  function sortLabel(value) {
    if (value === 'manual') return 'Manual';
    if (value === 'title') return 'Title';
    return 'Recent groups';
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

    const action = button.dataset.action;
    const noteId = button.dataset.noteId || null;

    if (action === 'clearSearch') {
      searchQuery = '';
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

    if (busy && action !== 'toggle') return;

    if (action === 'unlink' && !window.confirm('Unlink this page from its Sub-Pages hierarchy?')) return;

    closeOpenMenus();
    if (action === 'openNote' && noteId && currentState) {
      currentState.selectedNoteId = noteId;
      render();
    }
    post(action, noteId ? { noteId } : {});
  });

  app.addEventListener('input', (event) => {
    const input = event.target.closest('input[data-action="search"]');
    if (!input) return;

    const cursorPosition = input.selectionStart;
    searchQuery = input.value;
    closeOpenMenus();
    render();
    focusSearchInput(cursorPosition);
  });

  app.addEventListener('contextmenu', (event) => {
    const row = event.target.closest('.sub-pages-row[data-note-id]');
    if (!row) return;
    event.preventDefault();
    const details = row.querySelector('.sub-pages-row-menu');
    if (!details) return;
    openMenu(details, { focusFirst: true });
  });

  window.addEventListener('keydown', (event) => {
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
    if (!menu) return;

    const rowMenu = menu.closest('.sub-pages-row-menu');
    if (event.key === 'Escape') {
      event.preventDefault();
      if (rowMenu) closeMenu(rowMenu, true);
      return;
    }

    const items = [...menu.querySelectorAll('.sub-pages-menu-item:not(:disabled)')];
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
  });

  function focusSearchInput(cursorPosition) {
    const input = app.querySelector('input[data-action="search"]');
    if (!input) return;

    input.focus();
    const position = typeof cursorPosition === 'number' ? cursorPosition : input.value.length;
    if (typeof input.setSelectionRange === 'function') input.setSelectionRange(position, position);
  }

  function openMenu(menu, options) {
    closeOpenMenus(menu);
    menu.open = true;
    syncOpenMenuClass(menu);

    if (options && (options.focusFirst || options.focusLast)) {
      window.requestAnimationFrame(() => {
        const items = [...menu.querySelectorAll('.sub-pages-menu-item:not(:disabled)')];
        const item = options.focusLast ? items[items.length - 1] : items[0];
        if (item) item.focus();
      });
    }
  }

  function closeMenu(menu, returnFocus) {
    menu.open = false;
    syncOpenMenuClass(menu);

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

  function syncOpenMenuClass(menu) {
    const row = menu.closest('.sub-pages-row');
    if (row) row.classList.toggle('has-open-menu', !!menu.open);
    const trigger = menu.querySelector('.sub-pages-menu-trigger');
    if (trigger) trigger.setAttribute('aria-expanded', menu.open ? 'true' : 'false');
    menu.classList.remove('opens-up');

    const menuPanel = menu.querySelector('.sub-pages-menu');
    if (menuPanel) resetMenuPanelPosition(menuPanel);

    if (!menu.open) return;

    window.requestAnimationFrame(() => {
      if (!menu.open) return;

      const menuPanel = menu.querySelector('.sub-pages-menu');
      if (!menuPanel) return;

      const margin = 8;
      const triggerRect = menu.getBoundingClientRect();
      const viewportWidth = Math.max(80, window.innerWidth);
      const viewportHeight = Math.max(80, window.innerHeight);
      const panelRect = menuPanel.getBoundingClientRect();
      const menuWidth = Math.min(panelRect.width || 188, viewportWidth - margin * 2);
      const naturalHeight = menuPanel.scrollHeight || panelRect.height || 260;
      const targetHeight = Math.min(naturalHeight, 260);
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

  function resetMenuPanelPosition(menuPanel) {
    menuPanel.style.removeProperty('--sub-pages-menu-max-height');
    menuPanel.style.removeProperty('position');
    menuPanel.style.removeProperty('right');
    menuPanel.style.removeProperty('bottom');
    menuPanel.style.removeProperty('left');
    menuPanel.style.removeProperty('top');
  }

  if (api && typeof api.onMessage === 'function') {
    api.onMessage((message) => {
      if (!message) return;

      if (message.name === 'selection') {
        if (!currentState) return;
        currentState.selectedNoteId = message.selectedNoteId || null;
        render();
        return;
      }

      if (message.name !== 'state') return;
      if (typeof message.revision === 'number') stateRevision = message.revision;
      currentState = message.state;
      statusText = '';
      render();
    });
  }

  window.addEventListener('error', (event) => {
    setStatus(event.message || 'Sub-Pages panel script failed.');
  });

  window.setTimeout(() => {
    if (!currentState) setStatus('Still loading. The plugin is waiting for note data from Joplin.');
  }, 5000);

  window.setInterval(syncSelectedNote, 1000);
  window.setInterval(syncPanelState, 1500);

  post('ready');
}());
