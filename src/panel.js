(function () {
  const app = document.getElementById('app');
  const api = window.webviewApi;
  const collapsedIds = new Set();
  let currentState = null;
  let statusText = '';
  let busy = false;

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

    if (currentState.error) {
      root.appendChild(element('div', { className: 'sub-pages-empty' }, [currentState.error]));
    } else if (!currentState.nodes.length) {
      root.appendChild(element('div', { className: 'sub-pages-empty' }, ['No notes in this notebook yet.']));
    } else {
      const tree = element('div', { className: 'sub-pages-tree', role: 'tree' });
      currentState.nodes.forEach((node) => renderNode(node, 0, tree));
      root.appendChild(tree);
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

    titleWrap.appendChild(element('div', { className: 'sub-pages-heading' }, [folderTitle]));
    titleWrap.appendChild(element('div', { className: 'sub-pages-subtitle' }, [
      `${currentState.noteCount || 0} notes | ${currentState.metadataItemCount || 0} Sub-Pages metadata items | ${sortLabel(currentState.sortMode)}`,
    ]));
    header.appendChild(titleWrap);

    const actions = element('div', { className: 'sub-pages-header-actions' });
    actions.appendChild(actionButton('createRoot', null, '+', 'Create root page', false, 'sub-pages-icon-button'));
    if (repairCount > 0) {
      actions.appendChild(actionButton('repair', null, 'Fix', `Repair ${repairCount} metadata issue${repairCount === 1 ? '' : 's'}`, false, 'sub-pages-icon-button'));
    }
    actions.appendChild(actionButton('refresh', null, 'R', 'Refresh tree', false, 'sub-pages-icon-button'));
    header.appendChild(actions);

    return header;
  }

  function renderNode(node, depth, container) {
    const row = element('div', {
      className: [
        'sub-pages-row',
        node.id === currentState.selectedNoteId ? 'is-selected' : '',
        node.repairReason ? 'needs-repair' : '',
        depth > 0 ? 'is-child' : 'is-root',
        hasNodeChildren(node) ? 'has-children' : '',
      ].filter(Boolean).join(' '),
      role: 'treeitem',
      style: `--depth: ${depth};`,
    });

    const hasChildren = hasNodeChildren(node);
    const isCollapsed = collapsedIds.has(node.id);
    row.classList.add(isCollapsed ? 'is-collapsed' : 'is-expanded');
    const main = element('div', { className: 'sub-pages-row-main' });

    if (hasChildren) {
      main.appendChild(actionButton('toggle', node.id, isCollapsed ? '>' : 'v', isCollapsed ? 'Expand' : 'Collapse', false, 'sub-pages-icon-button sub-pages-toggle'));
    } else {
      main.appendChild(element('span', { className: 'sub-pages-spacer' }));
    }

    const title = actionButton('openNote', node.id, node.title, 'Open note');
    title.classList.add('sub-pages-note-title');
    if (node.isTodo) title.classList.add(node.todoCompleted ? 'is-done' : 'is-todo');
    main.appendChild(title);

    if (hasChildren) {
      main.appendChild(element('span', { className: 'sub-pages-child-count', title: `${node.children.length} direct child page${node.children.length === 1 ? '' : 's'}` }, [String(node.children.length)]));
    }

    if (node.repairReason) {
      main.appendChild(element('span', { className: 'sub-pages-badge', title: node.repairReason }, ['Needs repair']));
    }
    row.appendChild(main);

    const actions = element('span', { className: 'sub-pages-row-actions' });
    actions.appendChild(actionButton('createChild', node.id, '+', 'Create child page', false, 'sub-pages-icon-button'));
    actions.appendChild(actionButton('move', node.id, '>', 'Move under another page', false, 'sub-pages-icon-button'));
    actions.appendChild(actionButton('promote', node.id, 'R', 'Promote to root', !node.parentId, 'sub-pages-icon-button'));
    actions.appendChild(actionButton('moveUp', node.id, 'Up', 'Move up', !node.canMoveUp, 'sub-pages-mini-button'));
    actions.appendChild(actionButton('moveDown', node.id, 'Dn', 'Move down', !node.canMoveDown, 'sub-pages-mini-button'));
    actions.appendChild(actionButton('unlink', node.id, 'X', 'Unlink parent and direct children', !node.parentId && !hasChildren, 'sub-pages-icon-button'));
    row.appendChild(actions);

    container.appendChild(row);

    if (hasChildren && !isCollapsed) {
      node.children.forEach((child) => renderNode(child, depth + 1, container));
    }
  }

  function hasNodeChildren(node) {
    return !!(node.children && node.children.length);
  }

  function actionButton(action, noteId, text, title, disabled, extraClassName) {
    const button = element('button', {
      className: ['sub-pages-button', extraClassName || ''].filter(Boolean).join(' '),
      type: 'button',
      title: title || '',
      disabled: disabled ? 'disabled' : null,
    }, [text]);
    button.dataset.action = action;
    if (noteId) button.dataset.noteId = noteId;
    return button;
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
      } else if (key === 'disabled') {
        node.disabled = true;
      } else if (key === 'title') {
        node.title = value;
      } else if (key === 'type') {
        node.type = value;
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
    if (!button || button.disabled) return;

    const action = button.dataset.action;
    const noteId = button.dataset.noteId || null;

    if (action === 'toggle' && noteId) {
      if (collapsedIds.has(noteId)) collapsedIds.delete(noteId);
      else collapsedIds.add(noteId);
      render();
      return;
    }

    if (busy && action !== 'toggle') return;

    if (action === 'unlink' && !window.confirm('Unlink this page from its Sub-Pages hierarchy?')) return;

    post(action, noteId ? { noteId } : {});
  });

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

  post('ready');
}());
