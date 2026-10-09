import http from 'node:http';

const cdpPort = 18800;
const pageUrl = 'http://127.0.0.1:8765/artifacts/panel-harness.html';

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: cdpPort, path }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const callbacks = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && callbacks.has(msg.id)) {
      const { resolve, reject } = callbacks.get(msg.id);
      callbacks.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const msgId = ++id;
        ws.send(JSON.stringify({ id: msgId, method, params }));
        return new Promise((resolve, reject) => callbacks.set(msgId, { resolve, reject }));
      },
      close() { ws.close(); },
    }));
    ws.addEventListener('error', reject);
  });
}

async function main() {
  const pages = await getJson('/json/list');
  const page = pages.find(p => p.url === pageUrl) || pages.find(p => p.url.includes('panel-harness'));
  if (!page) throw new Error('Harness page not found');
  const cdp = await connect(page.webSocketDebuggerUrl);
  try {
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Page.navigate', { url: pageUrl + '?v=' + Date.now() });
  await new Promise(r => setTimeout(r, 300));

  async function evalJs(expression) {
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }

  async function setViewport(width, height = 520) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await new Promise(r => setTimeout(r, 50));
  }

  async function setHarnessSearch(query, scope = 'all') {
    const started = await evalJs(`(async () => {
      const requestedScope = ${JSON.stringify(scope)};
      const scopeButton = [...document.querySelectorAll('button[data-action="setSearchScope"]')]
        .find((button) => button.dataset.scope === requestedScope);
      if (!scopeButton) return { ok: false, message: 'Search scope button was not found.' };
      if (scopeButton.getAttribute('aria-pressed') !== 'true') {
        scopeButton.click();
        await new Promise(requestAnimationFrame);
      }
      const input = document.querySelector('.sub-pages-search-input');
      if (!input) return { ok: false, message: 'Search input was not found.' };
      input.focus();
      input.value = ${JSON.stringify(query)};
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(query)} }));
      return { ok: true };
    })()`);
    if (!started?.ok) throw new Error(`Could not start harness search for "${query}": ${JSON.stringify(started)}`);
  }

  async function waitForHarnessSearch(label, query, predicate, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    let snapshot = null;
    while (Date.now() < deadline) {
      snapshot = await evalJs(`(() => {
        const input = document.querySelector('.sub-pages-search-input');
        const list = document.querySelector('.sub-pages-list.is-search-results');
        const external = document.querySelector('.sub-pages-search-results');
        return {
          inputValue: input?.value || '',
          status: document.querySelector('.sub-pages-filter-status')?.textContent || '',
          localRows: list ? list.querySelectorAll('.sub-pages-row').length : 0,
          externalRows: external ? external.querySelectorAll('.sub-pages-row').length : 0,
        };
      })()`);
      if (snapshot.inputValue === query && !snapshot.status.startsWith('Searching ') && predicate(snapshot)) return snapshot;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(snapshot)}`);
  }

  async function readSearchLayout() {
    return evalJs(`(() => {
      const shell = document.querySelector('.sub-pages-shell');
      const list = document.querySelector('.sub-pages-list.is-search-results');
      const localTree = list?.querySelector('.sub-pages-tree');
      const external = document.querySelector('.sub-pages-search-results');
      const externalTree = external?.querySelector('.sub-pages-external-results');
      const externalHeading = external?.querySelector('.sub-pages-section-heading');
      const localRows = list ? [...list.querySelectorAll('.sub-pages-row')] : [];
      const externalRows = external ? [...external.querySelectorAll('.sub-pages-row')] : [];
      const listRect = list?.getBoundingClientRect();
      const localTreeRect = localTree?.getBoundingClientRect();
      const externalRect = external?.getBoundingClientRect();
      const externalTreeRect = externalTree?.getBoundingClientRect();
      const externalHeadingRect = externalHeading?.getBoundingClientRect();
      const lastLocalRowRect = localRows[localRows.length - 1]?.getBoundingClientRect();
      const rowAppearance = (row) => {
        const title = row?.querySelector('.sub-pages-note-title');
        return row ? {
          fontSize: title ? getComputedStyle(title).fontSize : null,
          paddingTop: getComputedStyle(row).paddingTop,
          paddingBottom: getComputedStyle(row).paddingBottom,
        } : null;
      };
      const rowsAreOrdered = (rows) => rows.every((row, index) => {
        const rect = row.getBoundingClientRect();
        return rect.height >= 19 && (!index || rect.top >= rows[index - 1].getBoundingClientRect().bottom - 1);
      });
      const minimumRowHeight = (rows) => rows.length
        ? Math.min(...rows.map((row) => row.getBoundingClientRect().height))
        : null;
      return {
        width: innerWidth,
        inputValue: document.querySelector('.sub-pages-search-input')?.value || '',
        status: document.querySelector('.sub-pages-filter-status')?.textContent || '',
        hasSearchList: !!list,
        localRows: localRows.length,
        externalRows: externalRows.length,
        localRowsInOrder: rowsAreOrdered(localRows),
        externalRowsInOrder: rowsAreOrdered(externalRows),
        localRowMinHeight: minimumRowHeight(localRows),
        externalRowMinHeight: minimumRowHeight(externalRows),
        localRowAppearance: rowAppearance(localRows[0]),
        externalRowAppearance: rowAppearance(externalRows[0]),
        listHeight: listRect?.height,
        localTreeHeight: localTreeRect?.height,
        treeToExternalGap: externalRect && localTreeRect ? externalRect.top - localTreeRect.bottom : null,
        lastLocalRowBottom: lastLocalRowRect?.bottom,
        externalHeadingTop: externalHeadingRect?.top,
        lastLocalRowToExternalHeadingGap: lastLocalRowRect && externalHeadingRect
          ? externalHeadingRect.top - lastLocalRowRect.bottom
          : null,
        externalTreeHeight: externalTreeRect?.height,
        shellScrollHeight: shell?.scrollHeight,
        shellClientHeight: shell?.clientHeight,
        shellOverflowY: shell ? getComputedStyle(shell).overflowY : null,
      };
    })()`);
  }

  async function scrollSearchResultToEnd(kind) {
    return evalJs(`(async () => {
      const shell = document.querySelector('.sub-pages-shell');
      const selector = ${JSON.stringify(kind === 'local' ? '.sub-pages-list.is-search-results .sub-pages-row' : '.sub-pages-search-results .sub-pages-row')};
      const rows = [...document.querySelectorAll(selector)];
      const lastRow = rows[rows.length - 1];
      if (!shell || !lastRow) return { ok: false, shell: !!shell, rowCount: rows.length };
      shell.scrollTop = shell.scrollHeight;
      await new Promise(requestAnimationFrame);
      const shellRect = shell.getBoundingClientRect();
      const rowRect = lastRow.getBoundingClientRect();
      return {
        ok: true,
        scrollTop: shell.scrollTop,
        shellScrollHeight: shell.scrollHeight,
        shellClientHeight: shell.clientHeight,
        lastRowVisible: rowRect.top >= shellRect.top - 1 && rowRect.bottom <= shellRect.bottom + 1,
      };
    })()`);
  }

  function hasCompactLocalAndExternalLayout(layout, expectedLocalRows, expectedExternalRows) {
    return (
      layout.hasSearchList
      && layout.localRows === expectedLocalRows
      && layout.externalRows === expectedExternalRows
      && layout.localRowsInOrder
      && layout.externalRowsInOrder
      && Number.isFinite(layout.localRowMinHeight)
      && Number.isFinite(layout.externalRowMinHeight)
      && layout.localRowMinHeight >= 19
      && layout.externalRowMinHeight >= 19
      && Number.isFinite(layout.listHeight)
      && Number.isFinite(layout.localTreeHeight)
      && Math.abs(layout.listHeight - layout.localTreeHeight) <= 1
      && Number.isFinite(layout.lastLocalRowBottom)
      && Number.isFinite(layout.externalHeadingTop)
      && Number.isFinite(layout.lastLocalRowToExternalHeadingGap)
      && layout.lastLocalRowToExternalHeadingGap >= 0
      && layout.lastLocalRowToExternalHeadingGap <= 16
      && Number.isFinite(layout.externalTreeHeight)
      && layout.externalTreeHeight > 0
      && Number.isFinite(layout.shellScrollHeight)
      && Number.isFinite(layout.shellClientHeight)
      && layout.shellScrollHeight > layout.shellClientHeight
      && ['auto', 'scroll'].includes(layout.shellOverflowY)
    );
  }

  const widths = [360, 240, 180, 140];
  const responsive = [];
  for (const width of widths) {
    await setViewport(width);
    responsive.push(await evalJs(`(() => {
      const over = [...document.querySelectorAll('*')].filter(el => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible').slice(0,5).map(el => ({ cls: el.className, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
      const row = document.querySelector('.sub-pages-row.is-selected');
      const title = row && row.querySelector('.sub-pages-note-title').getBoundingClientRect();
      const actions = row && row.querySelector('.sub-pages-row-actions').getBoundingClientRect();
      const menu = row && row.querySelector('.sub-pages-row-menu');
      menu.open = true; menu.classList.add('opens-up');
      const panel = row && row.querySelector('.sub-pages-menu').getBoundingClientRect();
      menu.open = false; menu.classList.remove('opens-up');
      return { width: innerWidth, docClient: document.documentElement.clientWidth, bodyScroll: document.body.scrollWidth, titleWidth: title && title.width, actionsLeft: actions && actions.left, actionsRight: actions && actions.right, titleRight: title && title.right, menuLeft: panel && panel.left, menuRight: panel && panel.right, overflow: over };
    })()`));
  }

  const layoutFailures = responsive.filter(result => (
    result.bodyScroll > result.docClient + 1
    || result.actionsLeft < 0
    || result.actionsRight > result.docClient + 1
  ));
  if (layoutFailures.length) {
    throw new Error(`Responsive row action layout failed: ${JSON.stringify(layoutFailures)}`);
  }

  const appearanceUpdate = await evalJs(`(async () => {
    const originalState = window.mockNotebookState;
    const baselineState = {
      ...originalState,
      appearance: { noteTextSize: 18, rowSpacing: 0, rowVerticalPadding: 0, textInset: 4, noteIndent: 16 },
    };
    const updatedState = {
      ...originalState,
      appearance: { noteTextSize: 18, rowSpacing: 12, rowVerticalPadding: 6, textInset: 9, noteIndent: 24 },
    };
    const staleState = {
      ...originalState,
      appearance: { noteTextSize: 10, rowSpacing: 0, rowVerticalPadding: 0, textInset: 0, noteIndent: 0 },
    };
    const originalPostMessage = window.webviewApi.postMessage;
    const readAppearance = () => {
      const row = document.querySelector('.sub-pages-row[data-note-id="child1"]');
      const grandchild = document.querySelector('.sub-pages-row[data-note-id="grandchild1"]');
      const title = row?.querySelector('.sub-pages-note-title');
      const app = document.getElementById('app');
      const tree = document.querySelector('.sub-pages-tree');
      return {
        noteFontSize: title ? getComputedStyle(title).fontSize : null,
        rowHeight: row?.getBoundingClientRect().height ?? null,
        rowPaddingTop: row ? getComputedStyle(row).paddingTop : null,
        rowPaddingBottom: row ? getComputedStyle(row).paddingBottom : null,
        appNoteFontSize: app?.style.getPropertyValue('--sub-pages-note-font-size') || null,
        appRowSpacing: app?.style.getPropertyValue('--sub-pages-row-spacing') || null,
        appRowVerticalPadding: app?.style.getPropertyValue('--sub-pages-row-vertical-padding') || null,
        appTextInset: app?.style.getPropertyValue('--sub-pages-text-inset') || null,
        appNoteIndent: app?.style.getPropertyValue('--sub-pages-note-indent') || null,
        treeGap: tree ? getComputedStyle(tree).rowGap : null,
        childMarginLeft: row ? getComputedStyle(row).marginLeft : null,
        grandchildMarginLeft: grandchild ? getComputedStyle(grandchild).marginLeft : null,
        childConnectorTop: row ? getComputedStyle(row, '::after').top : null,
      };
    };
    let snapshot;
    try {
      window.mockState = baselineState;
      window.receive({ name: 'state', revision: 10, state: baselineState });
      await new Promise(requestAnimationFrame);
      const baseline = readAppearance();

      window.mockState = updatedState;
      window.receive({ name: 'state', revision: 11, state: updatedState });
      await new Promise(requestAnimationFrame);
      const updated = readAppearance();

      window.receive({ name: 'state', revision: 10, state: staleState });
      await new Promise(requestAnimationFrame);
      const afterStaleMessage = readAppearance();

      window.webviewApi.postMessage = async (message) => {
        if (message.name === 'refresh') return { ok: true, revision: 10, state: staleState };
        return originalPostMessage(message);
      };
      const refreshButton = document.querySelector('[data-action="refresh"]');
      if (!refreshButton) throw new Error('Missing panel refresh button');
      refreshButton.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const afterStaleResponse = readAppearance();

      snapshot = {
        baseline,
        updated,
        afterStaleMessage,
        afterStaleResponse,
      };
    } finally {
      window.webviewApi.postMessage = originalPostMessage;
      window.mockState = originalState;
      window.receive({ name: 'state', revision: 12, state: originalState });
      await new Promise(requestAnimationFrame);
      if (snapshot) snapshot.restored = readAppearance();
    }
    return snapshot;
  })()`);
  if (appearanceUpdate.updated.noteFontSize !== '18px'
    || appearanceUpdate.updated.appNoteFontSize !== '18px'
    || appearanceUpdate.updated.appRowSpacing !== '12px'
    || appearanceUpdate.updated.appRowVerticalPadding !== '6px'
    || appearanceUpdate.updated.appTextInset !== '9px'
    || appearanceUpdate.updated.appNoteIndent !== '24px'
    || appearanceUpdate.updated.treeGap !== '12px'
    || appearanceUpdate.updated.rowPaddingTop !== '6px'
    || appearanceUpdate.updated.rowPaddingBottom !== '6px'
    || appearanceUpdate.updated.childMarginLeft !== '24px'
    || appearanceUpdate.updated.grandchildMarginLeft !== '48px'
    || !Number.isFinite(appearanceUpdate.baseline.rowHeight)
    || !Number.isFinite(appearanceUpdate.updated.rowHeight)
    || appearanceUpdate.updated.rowHeight - appearanceUpdate.baseline.rowHeight < 11
    || appearanceUpdate.updated.childConnectorTop !== '50%'
    || appearanceUpdate.afterStaleMessage.appNoteFontSize !== '18px'
    || appearanceUpdate.afterStaleMessage.appRowSpacing !== '12px'
    || appearanceUpdate.afterStaleMessage.appNoteIndent !== '24px'
    || appearanceUpdate.afterStaleResponse.appNoteFontSize !== '18px'
    || appearanceUpdate.afterStaleResponse.appRowSpacing !== '12px'
    || appearanceUpdate.afterStaleResponse.appNoteIndent !== '24px'
    || appearanceUpdate.restored.appNoteFontSize !== '12px'
    || appearanceUpdate.restored.appRowSpacing !== '0px'
    || appearanceUpdate.restored.appRowVerticalPadding !== '0px'
    || appearanceUpdate.restored.appTextInset !== '4px'
    || appearanceUpdate.restored.appNoteIndent !== '16px') {
    throw new Error(`Panel appearance settings did not update safely: ${JSON.stringify(appearanceUpdate)}`);
  }

  await setViewport(360, 220);
  const longTreeAppearance = await evalJs(`(async () => {
    const originalState = window.mockNotebookState;
    const makeNode = (id, title, parentId, children = []) => ({
      id, title, parentId, notebookId: 'f1', notebookTitle: 'Harness', pageType: 'note',
      isTodo: false, todoCompleted: false, repairReason: null, canMoveUp: false, canMoveDown: false, children,
    });
    const nodes = Array.from({ length: 18 }, (_, index) => {
      const rootId = 'long-root-' + index;
      const childId = 'long-child-' + index;
      const grandchildId = 'long-grandchild-' + index;
      return makeNode(rootId, 'Long root ' + index, null, [
        makeNode(childId, 'Long child ' + index, rootId, [
          makeNode(grandchildId, 'Long grandchild ' + index, childId),
        ]),
      ]);
    });
    const state = {
      ...originalState,
      selectedNoteId: 'long-grandchild-0',
      noteCount: 54,
      appearance: { noteTextSize: 12, rowSpacing: 3, rowVerticalPadding: 1, textInset: 4, noteIndent: 20 },
      nodes,
    };
    window.mockNotebookState = state;
    window.mockState = state;
    window.receive({ name: 'state', revision: 13, state });
    await new Promise(requestAnimationFrame);

    const shell = document.querySelector('.sub-pages-shell');
    const list = document.querySelector('.sub-pages-list');
    const tree = list?.querySelector('.sub-pages-tree');
    const row = (id) => document.querySelector('.sub-pages-row[data-note-id="' + id + '"]');
    const treeBackground = tree ? getComputedStyle(tree).backgroundColor : null;
    const listBackground = list ? getComputedStyle(list).backgroundColor : null;
    const shellBackground = shell ? getComputedStyle(shell).backgroundColor : null;
    const rootIndent = row('long-root-0') ? getComputedStyle(row('long-root-0')).marginLeft : null;
    const childIndent = row('long-child-0') ? getComputedStyle(row('long-child-0')).marginLeft : null;
    const grandchildIndent = row('long-grandchild-0') ? getComputedStyle(row('long-grandchild-0')).marginLeft : null;
    const shellClientHeight = shell?.clientHeight ?? 0;
    const treeHeight = tree?.getBoundingClientRect().height ?? 0;

    if (shell) {
      shell.scrollTop = shell.scrollHeight;
      await new Promise(requestAnimationFrame);
    }

    const shellRect = shell?.getBoundingClientRect();
    const lastRowRect = row('long-grandchild-' + 17)?.getBoundingClientRect();
    const result = {
      rowCount: list?.querySelectorAll('.sub-pages-row').length ?? 0,
      shellScrollHeight: shell?.scrollHeight ?? 0,
      shellClientHeight,
      scrollTop: shell?.scrollTop ?? 0,
      treeHeight,
      treeBackground,
      listBackground,
      shellBackground,
      rootIndent,
      childIndent,
      grandchildIndent,
      lastRowVisible: !!(shellRect && lastRowRect
        && lastRowRect.top >= shellRect.top - 1
        && lastRowRect.bottom <= shellRect.bottom + 1),
    };
    window.mockNotebookState = originalState;
    window.mockState = originalState;
    window.receive({ name: 'state', revision: 14, state: originalState });
    await new Promise(requestAnimationFrame);
    return result;
  })()`);
  if (longTreeAppearance.rowCount !== 54
    || longTreeAppearance.shellScrollHeight <= longTreeAppearance.shellClientHeight
    || longTreeAppearance.scrollTop <= 0
    || longTreeAppearance.treeHeight <= longTreeAppearance.shellClientHeight
    || longTreeAppearance.treeBackground !== longTreeAppearance.listBackground
    || longTreeAppearance.treeBackground === longTreeAppearance.shellBackground
    || longTreeAppearance.rootIndent !== '0px'
    || longTreeAppearance.childIndent !== '20px'
    || longTreeAppearance.grandchildIndent !== '40px'
    || !longTreeAppearance.lastRowVisible) {
    throw new Error(`Long-list background, scrolling, or hierarchy indentation failed: ${JSON.stringify(longTreeAppearance)}`);
  }

  await setViewport(360);
  const collapsedSearch = await evalJs(`(async () => {
    window.messages.length = 0;
    const parent = document.querySelector('.sub-pages-row[data-note-id="parent1"]');
    const toggle = parent?.querySelector('[data-action="toggle"]');
    if (!toggle) throw new Error('Parent fixture is missing its collapse control.');
    toggle.click();
    await new Promise(resolve => setTimeout(resolve, 20));
    const collapsedBeforeSearch = document.querySelector('.sub-pages-row[data-note-id="parent1"]')?.getAttribute('aria-expanded') === 'false'
      && !document.querySelector('.sub-pages-row[data-note-id="child1"]');
    const savedCollapse = window.messages.find(message => message.name === 'saveCollapsedNoteIds');

    const input = document.querySelector('.sub-pages-search-input');
    input.focus();
    input.value = 'Nested Child';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Nested Child' }));
    await new Promise(resolve => setTimeout(resolve, 650));
    const searchRows = [...document.querySelectorAll('.sub-pages-row')].map(row => row.dataset.noteId);
    const ancestorsRevealed = JSON.stringify(searchRows) === JSON.stringify(['parent1', 'child1', 'grandchild1']);

    document.querySelector('.sub-pages-clear-search').click();
    await new Promise(requestAnimationFrame);
    const collapseRestoredAfterSearch = document.querySelector('.sub-pages-row[data-note-id="parent1"]')?.getAttribute('aria-expanded') === 'false'
      && !document.querySelector('.sub-pages-row[data-note-id="child1"]');

    document.querySelector('.sub-pages-row[data-note-id="parent1"] [data-action="toggle"]').click();
    await new Promise(requestAnimationFrame);
    return {
      collapsedBeforeSearch,
      savedCollapseIds: savedCollapse?.collapsedNoteIds || [],
      searchRows,
      ancestorsRevealed,
      collapseRestoredAfterSearch,
      fixtureRestored: !!document.querySelector('.sub-pages-row[data-note-id="grandchild1"]'),
    };
  })()`);
  if (!collapsedSearch.collapsedBeforeSearch
    || !collapsedSearch.savedCollapseIds.includes('parent1')
    || !collapsedSearch.ancestorsRevealed
    || !collapsedSearch.collapseRestoredAfterSearch
    || !collapsedSearch.fixtureRestored) {
    throw new Error(`Search did not reveal a hidden descendant while preserving collapse state: ${JSON.stringify(collapsedSearch)}`);
  }

  const search = await evalJs(`(async () => {
    const input = document.querySelector('.sub-pages-search-input');
    input.focus(); input.value = 'child'; input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'child' }));
    await new Promise(r => setTimeout(r, 650));
    const filteredText = document.querySelector('.sub-pages-filter-status')?.textContent;
    const rows = [...document.querySelectorAll('.sub-pages-row')].map(row => row.textContent.trim());
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(requestAnimationFrame);
    return { filteredText, rows, afterEscapeValue: document.querySelector('.sub-pages-search-input').value, activeClass: document.activeElement.className };
  })()`);

  const noResults = await evalJs(`(async () => {
    const input = document.querySelector('.sub-pages-search-input');
    input.focus(); input.value = 'zzzzz'; input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'zzzzz' }));
    await new Promise(r => setTimeout(r, 650));
    const empty = document.querySelector('.sub-pages-empty')?.textContent;
    document.querySelector('.sub-pages-clear-search').click();
    await new Promise(requestAnimationFrame);
    return { empty, afterClearValue: document.querySelector('.sub-pages-search-input').value, activeClass: document.activeElement.className };
  })()`);

  const bodySearch = await evalJs(`(async () => {
    const input = document.querySelector('.sub-pages-search-input');
    input.focus(); input.value = 'web'; input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'web' }));
    await new Promise(r => setTimeout(r, 650));
    const filteredText = document.querySelector('.sub-pages-filter-status')?.textContent;
    const rows = [...document.querySelectorAll('.sub-pages-row')].map(row => row.textContent.trim());
    document.querySelector('.sub-pages-clear-search').click();
    await new Promise(requestAnimationFrame);
    return { filteredText, rows };
  })()`);
  if (!bodySearch.rows.some(row => row.includes('Delta Root'))) {
    throw new Error(`Joplin-backed body search did not surface the body-only match: ${JSON.stringify(bodySearch)}`);
  }
  if (!bodySearch.rows.some(row => row.includes('Archive Web Capture') && row.includes('Archive'))) {
    throw new Error(`All-notebooks search did not surface external notebook matches: ${JSON.stringify(bodySearch)}`);
  }

  let searchFixture;
  let childTransition;
  let pendingChildTransition;
  let externalOnlyTransition;
  let mixedTransition;
  let mixedSearchLayouts;
  let mixedSearchEnd;
  let localOnlyTransition;
  let localOnlyLayout;
  let localOnlyEnd;
  let denseExternalOnlyTransition;
  let externalOnlyLayout;
  let externalOnlyEnd;
  let searchLayoutFixtureActive = false;

  async function restoreSearchLayoutFixture() {
    await evalJs(`(async () => {
      document.querySelector('.sub-pages-clear-search')?.click();
      const allScope = document.querySelector('button[data-action="setSearchScope"][data-scope="all"]');
      if (allScope && allScope.getAttribute('aria-pressed') !== 'true') allScope.click();
      await new Promise(requestAnimationFrame);
       const hasOriginalNodes = Array.isArray(window.__searchLayoutOriginalNodes);
       const hasOriginalExternalNotes = Array.isArray(window.__searchLayoutOriginalExternalNotes);
       const hasOriginalAppearance = !!window.__searchLayoutOriginalAppearance;
       if (hasOriginalNodes) window.mockNotebookState.nodes = window.__searchLayoutOriginalNodes;
       if (hasOriginalExternalNotes) window.mockExternalNotes = window.__searchLayoutOriginalExternalNotes;
       if (hasOriginalAppearance) window.mockNotebookState.appearance = window.__searchLayoutOriginalAppearance;
       if (hasOriginalNodes || hasOriginalExternalNotes || hasOriginalAppearance) {
         window.mockState = window.mockNotebookState;
         window.receive({ name: 'state', revision: 14, state: window.mockNotebookState });
       }
       delete window.__searchLayoutOriginalNodes;
       delete window.__searchLayoutOriginalExternalNotes;
       delete window.__searchLayoutOriginalAppearance;
      await new Promise(requestAnimationFrame);
    })()`);
  }

  try {
  await setViewport(360, 220);
  searchLayoutFixtureActive = true;
   searchFixture = await evalJs(`(async () => {
     window.__searchLayoutOriginalNodes = window.mockNotebookState.nodes;
     window.__searchLayoutOriginalExternalNotes = window.mockExternalNotes;
     window.__searchLayoutOriginalAppearance = window.mockNotebookState.appearance;
     window.mockNotebookState.nodes = [
      ...window.__searchLayoutOriginalNodes,
      ...Array.from({ length: 18 }, (_, index) => ({
        id: 'local-layout-' + index,
        title: 'local-layout result ' + index,
        parentId: null,
        notebookId: 'f1',
        notebookTitle: 'Harness',
        pageType: 'note',
        isTodo: false,
        todoCompleted: false,
        repairReason: null,
        canMoveUp: false,
        canMoveDown: false,
        children: [],
      })),
    ];
     window.mockExternalNotes = [
      ...window.__searchLayoutOriginalExternalNotes,
      ...Array.from({ length: 12 }, (_, index) => ({
        id: 'external-layout-' + index,
        title: 'external-layout web result ' + index,
        parentId: 'archive',
        notebookId: 'archive',
        notebookTitle: 'Archive',
        pageType: 'note',
        isTodo: false,
        todoCompleted: false,
        updatedTime: 100 + index,
        body: 'external-layout web result',
      })),
     ];
     window.mockNotebookState.appearance = { noteTextSize: 18, rowSpacing: 12 };
     window.mockState = window.mockNotebookState;
     window.receive({ name: 'state', revision: 13, state: window.mockNotebookState });
    await new Promise(requestAnimationFrame);
    return {
      localFixtureCount: window.mockNotebookState.nodes.length,
      externalFixtureCount: window.mockExternalNotes.length,
    };
  })()`);
  if (searchFixture.localFixtureCount !== 21 || searchFixture.externalFixtureCount !== 13) {
    throw new Error(`Search layout fixture setup failed: ${JSON.stringify(searchFixture)}`);
  }

  // Start with a mixed result set, then replace it while the search debounce
  // keeps the prior rows onscreen. That is the transition that previously
  // exposed stretched or overlapping search sections.
  await setHarnessSearch('web');
  mixedTransition = await waitForHarnessSearch('mixed local and external results', 'web', (snapshot) => (
    snapshot.localRows === 1 && snapshot.externalRows === 13
  ));
  await setHarnessSearch('child');
  pendingChildTransition = await readSearchLayout();
  if (!hasCompactLocalAndExternalLayout(pendingChildTransition, 1, 13)
    || pendingChildTransition.inputValue !== 'child') {
    throw new Error(`Changing a mixed search left squished rows or a phantom gap before replacement: ${JSON.stringify(pendingChildTransition)}`);
  }
  childTransition = await waitForHarnessSearch('current-notebook-only child results', 'child', (snapshot) => (
    snapshot.localRows >= 3 && snapshot.externalRows === 0
  ));
  await setHarnessSearch('canvas');
  externalOnlyTransition = await waitForHarnessSearch('single external-only result', 'canvas', (snapshot) => (
    snapshot.localRows === 0 && snapshot.externalRows === 1
  ));
  await setHarnessSearch('web');
  mixedTransition = await waitForHarnessSearch('mixed local and external results after replacement', 'web', (snapshot) => (
    snapshot.localRows === 1 && snapshot.externalRows === 13
  ));

  mixedSearchLayouts = [];
  for (const width of widths) {
    await setViewport(width, 220);
    mixedSearchLayouts.push(await readSearchLayout());
  }
  const mixedSearchLayoutFailures = mixedSearchLayouts.filter((searchLayout) => (
    !hasCompactLocalAndExternalLayout(searchLayout, 1, 13)
  ));
  if (mixedSearchLayoutFailures.length) {
    throw new Error(`Mixed search results were stretched, squished, or separated from Other notebooks: ${JSON.stringify(mixedSearchLayoutFailures)}`);
  }
  const mixedSearchAppearanceFailures = mixedSearchLayouts.filter((searchLayout) => (
    searchLayout.localRowAppearance?.fontSize !== '18px'
    || searchLayout.externalRowAppearance?.fontSize !== '18px'
    || searchLayout.localRowAppearance?.paddingTop !== '6px'
    || searchLayout.localRowAppearance?.paddingBottom !== '6px'
    || searchLayout.externalRowAppearance?.paddingTop !== '6px'
    || searchLayout.externalRowAppearance?.paddingBottom !== '6px'
  ));
  if (mixedSearchAppearanceFailures.length) {
    throw new Error(`Appearance settings did not apply to mixed search results: ${JSON.stringify(mixedSearchAppearanceFailures)}`);
  }
  mixedSearchEnd = await scrollSearchResultToEnd('external');
  if (!mixedSearchEnd.ok || mixedSearchEnd.scrollTop <= 0 || !mixedSearchEnd.lastRowVisible) {
    throw new Error(`The final mixed-search external row was not reachable: ${JSON.stringify(mixedSearchEnd)}`);
  }

  await setHarnessSearch('local-layout', 'notebook');
  localOnlyTransition = await waitForHarnessSearch('dense local-only results', 'local-layout', (snapshot) => (
    snapshot.localRows === 18 && snapshot.externalRows === 0
  ));
  localOnlyLayout = await readSearchLayout();
  if (!localOnlyLayout.hasSearchList
    || !localOnlyLayout.localRowsInOrder
    || !Number.isFinite(localOnlyLayout.localRowMinHeight)
    || localOnlyLayout.localRowMinHeight < 19
    || localOnlyLayout.externalRows !== 0
    || !Number.isFinite(localOnlyLayout.listHeight)
    || !Number.isFinite(localOnlyLayout.localTreeHeight)
    || Math.abs(localOnlyLayout.listHeight - localOnlyLayout.localTreeHeight) > 1
    || !Number.isFinite(localOnlyLayout.shellScrollHeight)
    || !Number.isFinite(localOnlyLayout.shellClientHeight)
    || localOnlyLayout.shellScrollHeight <= localOnlyLayout.shellClientHeight
    || !['auto', 'scroll'].includes(localOnlyLayout.shellOverflowY)) {
    throw new Error(`Dense local-only search results were compressed or clipped: ${JSON.stringify(localOnlyLayout)}`);
  }
  localOnlyEnd = await scrollSearchResultToEnd('local');
  if (!localOnlyEnd.ok || localOnlyEnd.scrollTop <= 0 || !localOnlyEnd.lastRowVisible) {
    throw new Error(`The final local-only search row was not reachable: ${JSON.stringify(localOnlyEnd)}`);
  }

  await setHarnessSearch('external-layout');
  denseExternalOnlyTransition = await waitForHarnessSearch('dense external-only results', 'external-layout', (snapshot) => (
    snapshot.localRows === 0 && snapshot.externalRows === 12
  ));
  externalOnlyLayout = await readSearchLayout();
  if (externalOnlyLayout.hasSearchList
    || !externalOnlyLayout.externalRowsInOrder
    || !Number.isFinite(externalOnlyLayout.externalRowMinHeight)
    || externalOnlyLayout.externalRowMinHeight < 19
    || externalOnlyLayout.externalRows !== 12
    || !Number.isFinite(externalOnlyLayout.externalTreeHeight)
    || externalOnlyLayout.externalTreeHeight <= 0
    || !Number.isFinite(externalOnlyLayout.shellScrollHeight)
    || !Number.isFinite(externalOnlyLayout.shellClientHeight)
    || externalOnlyLayout.shellScrollHeight <= externalOnlyLayout.shellClientHeight
    || !['auto', 'scroll'].includes(externalOnlyLayout.shellOverflowY)) {
    throw new Error(`Dense external-only search results were compressed or left a phantom local gap: ${JSON.stringify(externalOnlyLayout)}`);
  }
  externalOnlyEnd = await scrollSearchResultToEnd('external');
  if (!externalOnlyEnd.ok || externalOnlyEnd.scrollTop <= 0 || !externalOnlyEnd.lastRowVisible) {
    throw new Error(`The final external-only search row was not reachable: ${JSON.stringify(externalOnlyEnd)}`);
  }

  } finally {
    if (searchLayoutFixtureActive) {
      await restoreSearchLayoutFixture();
      searchLayoutFixtureActive = false;
    }
    await setViewport(360);
  }

  const notebookScopeSearch = await evalJs(`(async () => {
    document.querySelector('button[data-action="setSearchScope"][data-scope="notebook"]').click();
    await new Promise(requestAnimationFrame);
    const input = document.querySelector('.sub-pages-search-input');
    input.focus(); input.value = 'web'; input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'web' }));
    await new Promise(r => setTimeout(r, 650));
    const filteredText = document.querySelector('.sub-pages-filter-status')?.textContent;
    const rows = [...document.querySelectorAll('.sub-pages-row')].map(row => row.textContent.trim());
    const messages = window.messages.filter(message => message.name === 'search').map(message => ({ query: message.query, scope: message.scope }));
    document.querySelector('.sub-pages-clear-search').click();
    document.querySelector('button[data-action="setSearchScope"][data-scope="all"]').click();
    await new Promise(requestAnimationFrame);
    return { filteredText, rows, messages };
  })()`);
  if (notebookScopeSearch.rows.some(row => row.includes('Archive Web Capture'))) {
    throw new Error(`Notebook-scoped search leaked external matches: ${JSON.stringify(notebookScopeSearch)}`);
  }
  if (!notebookScopeSearch.messages.some(message => message.query === 'web' && message.scope === 'notebook')) {
    throw new Error(`Notebook search did not send the expected scope: ${JSON.stringify(notebookScopeSearch)}`);
  }

  const dragPayloads = await evalJs(`(async () => {
    function dragRow(noteId) {
      const row = document.querySelector(\`.sub-pages-row[data-note-id="\${noteId}"]\`);
      if (!row) throw new Error('Missing row: ' + noteId);
      const dataTransfer = new DataTransfer();
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
      const data = dataTransfer.getData('text/x-jop-note-ids');
      const plainText = dataTransfer.getData('text/plain');
      const status = document.querySelector('.sub-pages-drag-status')?.textContent || '';
      row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
      const message = [...window.messages].reverse().find(item => item.name === 'noteDragStarted');
      return {
        draggable: row.draggable,
        data: JSON.parse(data || '[]'),
        plainText,
        status,
        message,
        draggingAfterEnd: row.classList.contains('is-dragging'),
      };
    }

    window.messages = [];
    const parent = dragRow('parent1');

    document.querySelector('.sub-pages-row[data-note-id="parent1"] .sub-pages-note-title').click();
    document.querySelector('.sub-pages-row[data-note-id="child1"] .sub-pages-note-title')
      .dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    window.messages = [];
    const multi = dragRow('child1');

    const input = document.querySelector('.sub-pages-search-input');
    input.focus(); input.value = 'web'; input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'web' }));
    await new Promise(r => setTimeout(r, 650));
    window.messages = [];
    const external = dragRow('external1');
    document.querySelector('.sub-pages-clear-search').click();
    await new Promise(requestAnimationFrame);

    return { parent, multi, external };
  })()`);

  const parentPayload = JSON.stringify(dragPayloads.parent.data);
  if (parentPayload !== JSON.stringify(['parent1', 'child1', 'grandchild1', 'child2'])) {
    throw new Error(`Parent branch drag payload was wrong: ${JSON.stringify(dragPayloads.parent)}`);
  }
  if (JSON.stringify(dragPayloads.multi.message?.branchRootIds) !== JSON.stringify(['parent1'])) {
    throw new Error(`Multi-select drag did not de-dupe child under selected parent: ${JSON.stringify(dragPayloads.multi)}`);
  }
  if (dragPayloads.multi.message?.sourceFolderId !== 'f1') {
    throw new Error(`Tree drag did not send source notebook: ${JSON.stringify(dragPayloads.multi)}`);
  }
  if (JSON.stringify(dragPayloads.multi.message?.branchRoots) !== JSON.stringify([{ id: 'parent1', parentId: null }])) {
    throw new Error(`Multi-select drag did not send de-duped source branch roots: ${JSON.stringify(dragPayloads.multi)}`);
  }
  if (JSON.stringify(dragPayloads.multi.data) !== JSON.stringify(['parent1', 'child1', 'grandchild1', 'child2'])) {
    throw new Error(`Multi-select branch drag payload was wrong: ${JSON.stringify(dragPayloads.multi)}`);
  }
  if (JSON.stringify(dragPayloads.external.data) !== JSON.stringify(['external1'])) {
    throw new Error(`External result drag should include only itself: ${JSON.stringify(dragPayloads.external)}`);
  }
  if (dragPayloads.external.message?.sourceFolderId !== 'archive') {
    throw new Error(`External drag did not send source notebook: ${JSON.stringify(dragPayloads.external)}`);
  }
  if (JSON.stringify(dragPayloads.external.message?.branchRoots) !== JSON.stringify([{ id: 'external1' }])) {
    throw new Error(`External drag should send one root with unknown hierarchy parent: ${JSON.stringify(dragPayloads.external)}`);
  }
  if (dragPayloads.parent.plainText !== dragPayloads.parent.data.join('\n')) {
    throw new Error(`Plain text drag fallback did not match note IDs: ${JSON.stringify(dragPayloads.parent)}`);
  }
  if (!dragPayloads.parent.status.includes('Joplin notebook') || dragPayloads.parent.draggingAfterEnd) {
    throw new Error(`Drag status/source state did not behave: ${JSON.stringify(dragPayloads.parent)}`);
  }

  const multiSelect = await evalJs(`(() => {
    let rows = [...document.querySelectorAll('.sub-pages-row[data-note-id]')];
    rows[0].querySelector('.sub-pages-note-title').click();
    rows = [...document.querySelectorAll('.sub-pages-row[data-note-id]')];
    rows[1].querySelector('.sub-pages-note-title').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    rows = [...document.querySelectorAll('.sub-pages-row[data-note-id]')];
    const selected = [...document.querySelectorAll('.sub-pages-row.is-panel-selected')].map(row => row.dataset.noteId);
    const menu = rows[1].querySelector('.sub-pages-row-menu');
    menu.open = true;
    const menuItems = [...menu.querySelectorAll('.sub-pages-menu-item')].map(item => item.textContent.trim());
    return { selected, menuItems };
  })()`);
  if (multiSelect.selected.length < 2 || !multiSelect.menuItems.some(item => item.includes('Move 2 pages to notebook'))) {
    throw new Error(`Multi-select branch move menu did not render: ${JSON.stringify(multiSelect)}`);
  }
  if (!multiSelect.menuItems.includes('Save as Markdown...')) {
    throw new Error(`Markdown save menu item did not render: ${JSON.stringify(multiSelect)}`);
  }

  const confirmUnlink = await evalJs(`(async () => {
    window.messages = [];
    const row = document.querySelector('.sub-pages-row[data-note-id="child1"]');
    const unlinkButton = [...row.querySelectorAll('.sub-pages-menu-item')]
      .find(item => item.textContent.trim() === 'Unlink');
    if (!unlinkButton) throw new Error('Missing unlink menu item');
    unlinkButton.click();
    await new Promise(r => setTimeout(r, 120));
    return window.messages.map(message => ({
      name: message.name,
      message: message.message,
      noteId: message.noteId,
    }));
  })()`);
  if (!confirmUnlink.some(message => message.name === 'confirm' && message.message.includes('Unlink this page'))) {
    throw new Error(`Unlink did not ask the host for confirmation: ${JSON.stringify(confirmUnlink)}`);
  }
  if (!confirmUnlink.some(message => message.name === 'unlink' && message.noteId === 'child1')) {
    throw new Error(`Confirmed unlink did not send the unlink action: ${JSON.stringify(confirmUnlink)}`);
  }

  const dragDrop = await evalJs(`(async () => {
    window.messages.length = 0;
    const data = new DataTransfer();
    const child = document.querySelector('.sub-pages-row[data-note-id="child1"]');
    const target = document.querySelector('.sub-pages-row[data-note-id="root2"]');
    child.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    child.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: data }));
    await new Promise(r => setTimeout(r, 150));

    const childToRoot = document.querySelector('.sub-pages-row[data-note-id="child2"]');
    const rootDropZone = document.querySelector('.sub-pages-list.sub-pages-root-drop-zone');
    const explicitRootTarget = document.querySelector('.sub-pages-root-drop-target');
    const tree = document.querySelector('.sub-pages-tree');
    if (!rootDropZone || !explicitRootTarget || !tree) throw new Error('Missing root drop surface');
    const rootData = new DataTransfer();
    childToRoot.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: rootData }));
    if (!rootDropZone.classList.contains('is-visible')) throw new Error('Root drop target did not become visible during child drag');
    const listRect = rootDropZone.getBoundingClientRect();
    const treeRect = tree.getBoundingClientRect();
    const explicitRect = explicitRootTarget.getBoundingClientRect();
    if (listRect.height <= treeRect.height + explicitRect.height + 40) throw new Error('Root drop surface did not expand across the clear list area');
    if (explicitRect.height < 24) throw new Error('Root drop target did not expose a usable fallback hit area during child drag');
    rootDropZone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: rootData }));
    rootDropZone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: rootData }));
    childToRoot.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: rootData }));
    await new Promise(r => setTimeout(r, 150));

    return window.messages.filter(message => message.name === 'dropOnNote' || message.name === 'dropToRoot');
  })()`);
  if (!dragDrop.some(message => message.name === 'dropOnNote' && message.noteId === 'child1' && message.targetNoteId === 'root2')) {
    throw new Error(`Drag onto row did not send the expected hierarchy move: ${JSON.stringify(dragDrop)}`);
  }
  if (!dragDrop.some(message => message.name === 'dropToRoot' && message.noteId === 'child2')) {
    throw new Error(`Drag to blank root area did not send the expected promote move: ${JSON.stringify(dragDrop)}`);
  }

  const invalidDragDrop = await evalJs(`(async () => {
    window.messages.length = 0;
    const selfData = new DataTransfer();
    const parent = document.querySelector('.sub-pages-row[data-note-id="parent1"]');
    parent.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: selfData }));
    parent.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: selfData }));
    parent.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: selfData }));
    parent.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: selfData }));

    const descendantData = new DataTransfer();
    const child = document.querySelector('.sub-pages-row[data-note-id="child1"]');
    parent.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: descendantData }));
    child.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: descendantData }));
    child.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: descendantData }));
    parent.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: descendantData }));

    const rootData = new DataTransfer();
    const root = document.querySelector('.sub-pages-row[data-note-id="root2"]');
    const rootDropZone = document.querySelector('.sub-pages-root-drop-target');
    root.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: rootData }));
    rootDropZone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: rootData }));
    rootDropZone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: rootData }));
    root.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: rootData }));
    await new Promise(r => setTimeout(r, 150));

    return window.messages.filter(message => message.name === 'dropOnNote' || message.name === 'dropToRoot');
  })()`);
  if (invalidDragDrop.length) {
    throw new Error(`Invalid drag/drop operations sent messages: ${JSON.stringify(invalidDragDrop)}`);
  }

  const menuKeys = await evalJs(`(async () => {
    const trigger = document.querySelector('.sub-pages-row.is-selected .sub-pages-menu-trigger');
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await new Promise(requestAnimationFrame);
    const first = document.activeElement?.textContent?.trim();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const second = document.activeElement?.textContent?.trim();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(requestAnimationFrame);
    return { first, second, openAfterEscape: document.querySelector('.sub-pages-row-menu[open]') !== null };
  })()`);

  const treeKeys = await evalJs(`(async () => {
    const noteId = () => document.activeElement?.closest?.('.sub-pages-row[data-note-id]')?.dataset.noteId || null;
    const parentTitle = document.querySelector('.sub-pages-row[data-note-id="parent1"] .sub-pages-note-title');
    parentTitle.focus();
    parentTitle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const afterDown = noteId();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    const afterEnd = noteId();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    const afterHome = noteId();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await new Promise(requestAnimationFrame);
    const collapsed = document.querySelector('.sub-pages-row[data-note-id="parent1"]')?.getAttribute('aria-expanded') === 'false';
    document.querySelector('.sub-pages-row[data-note-id="parent1"] .sub-pages-note-title')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await new Promise(requestAnimationFrame);
    const expanded = document.querySelector('.sub-pages-row[data-note-id="parent1"]')?.getAttribute('aria-expanded') === 'true';
    return { afterDown, afterEnd, afterHome, collapsed, expanded };
  })()`);
  if (treeKeys.afterDown !== 'child1' || treeKeys.afterEnd !== 'root3' || treeKeys.afterHome !== 'parent1' || !treeKeys.collapsed || !treeKeys.expanded) {
    throw new Error(`Tree keyboard navigation failed: ${JSON.stringify(treeKeys)}`);
  }

  const allNotes = await evalJs(`(async () => {
    const notebookScope = document.querySelector('button[data-action="setSearchScope"][data-scope="notebook"]');
    if (!notebookScope) throw new Error('Missing notebook scope before All Notes transition');
    notebookScope.click();
    await new Promise(requestAnimationFrame);

    window.mockState = window.mockAllNotesState;
    window.receive({ name: 'state', revision: 15, state: window.mockAllNotesState });
    await new Promise(requestAnimationFrame);

    const heading = document.querySelector('.sub-pages-heading')?.textContent?.trim();
    const context = document.querySelector('.sub-pages-context')?.textContent?.trim();
    const scopeButtons = [...document.querySelectorAll('.sub-pages-scope-button')].map(button => ({
      label: button.textContent.trim(),
      scope: button.dataset.scope,
      pressed: button.getAttribute('aria-pressed'),
    }));
    const notebookLabels = [...document.querySelectorAll('.sub-pages-root-notebook-label')].map(label => label.textContent.trim());
    const whiteboard = document.querySelector('.sub-pages-row[data-note-id="allboard1"]');
    const whiteboardTitle = whiteboard?.querySelector('.sub-pages-note-title');
    const childWhiteboardAction = document.querySelector('.sub-pages-row[data-note-id="allparent1"] [data-action="createChildWhiteboard"]');
    const rootWhiteboardAction = document.querySelector('.sub-pages-header [data-action="createRootWhiteboard"]');
    const compatibilityWarning = document.querySelector('.sub-pages-compatibility-warning')?.textContent?.trim();

    window.messages = [];
    const crossNotebookSource = document.querySelector('.sub-pages-row[data-note-id="allparent1"]');
    const crossNotebookTarget = document.querySelector('.sub-pages-row[data-note-id="allboard1"]');
    const crossNotebookData = new DataTransfer();
    crossNotebookSource?.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: crossNotebookData }));
    const crossNotebookDragOver = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: crossNotebookData });
    crossNotebookTarget?.dispatchEvent(crossNotebookDragOver);
    crossNotebookTarget?.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: crossNotebookData }));
    crossNotebookSource?.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: crossNotebookData }));
    await new Promise(requestAnimationFrame);
    const crossNotebookDropMessages = window.messages.filter(message => message.name === 'dropOnNote');

    rootWhiteboardAction?.click();
    await new Promise(r => setTimeout(r, 50));

    const input = document.querySelector('.sub-pages-search-input');
    input.focus();
    input.value = 'canvas';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'canvas' }));
    await new Promise(r => setTimeout(r, 650));
    const searchStatus = document.querySelector('.sub-pages-filter-status')?.textContent?.trim();
    const searchRows = [...document.querySelectorAll('.sub-pages-row')].map(row => row.dataset.noteId);
    const externalSection = document.querySelector('.sub-pages-search-results');
    const searchMessages = window.messages.filter(message => message.name === 'search').map(message => ({
      query: message.query,
      scope: message.scope,
    }));
    const actionMessages = window.messages.filter(message => message.name === 'createRootWhiteboard');

    return {
      heading,
      context,
      scopeButtons,
      notebookLabels,
      whiteboardClass: whiteboard?.classList.contains('is-whiteboard'),
      whiteboardIcon: !!whiteboard?.querySelector('.sub-pages-page-type-icon'),
      whiteboardAriaLabel: whiteboardTitle?.getAttribute('aria-label'),
      whiteboardTooltip: whiteboardTitle?.getAttribute('title'),
      childWhiteboardAction: !!childWhiteboardAction,
      rootWhiteboardAction: !!rootWhiteboardAction,
      compatibilityWarning,
      crossNotebookDragAccepted: crossNotebookDragOver.defaultPrevented,
      crossNotebookDropMessages,
      searchStatus,
      searchRows,
      externalSection: !!externalSection,
      searchMessages,
      actionMessages,
      placeholder: document.querySelector('.sub-pages-search-input')?.getAttribute('placeholder'),
    };
  })()`);

  if (allNotes.heading !== 'All Notes' || allNotes.context !== '4 items across notebooks') {
    throw new Error(`All Notes heading/context did not render: ${JSON.stringify(allNotes)}`);
  }
  if (JSON.stringify(allNotes.scopeButtons) !== JSON.stringify([{ label: 'All Notes', scope: 'all', pressed: 'true' }])) {
    throw new Error(`All Notes did not force its single search scope: ${JSON.stringify(allNotes)}`);
  }
  if (JSON.stringify(allNotes.notebookLabels) !== JSON.stringify(['Harness', 'Archive', 'Projects'])) {
    throw new Error(`All Notes roots did not identify their notebooks: ${JSON.stringify(allNotes)}`);
  }
  if (!allNotes.whiteboardClass || !allNotes.whiteboardIcon || !allNotes.whiteboardAriaLabel?.includes('whiteboard Archive Canvas') || allNotes.whiteboardTooltip !== 'Archive Canvas') {
    throw new Error(`Whiteboard row affordance did not render: ${JSON.stringify(allNotes)}`);
  }
  if (!allNotes.rootWhiteboardAction || !allNotes.childWhiteboardAction || allNotes.actionMessages.length !== 1) {
    throw new Error(`Whiteboard creation actions did not render or dispatch: ${JSON.stringify(allNotes)}`);
  }
  if (!allNotes.compatibilityWarning?.includes('private sidebar adapter')) {
    throw new Error(`All Notes compatibility warning did not render: ${JSON.stringify(allNotes)}`);
  }
  if (allNotes.crossNotebookDragAccepted || allNotes.crossNotebookDropMessages.length) {
    throw new Error(`All Notes accepted a cross-notebook hierarchy drop: ${JSON.stringify(allNotes)}`);
  }
  if (!allNotes.searchRows.includes('allboard1') || allNotes.searchRows.length !== 1 || allNotes.externalSection) {
    throw new Error(`All Notes search did not stay within the combined forest: ${JSON.stringify(allNotes)}`);
  }
  if (!allNotes.searchStatus?.includes('Semantic search is off; showing keyword results.')) {
    throw new Error(`Semantic keyword-fallback status did not render: ${JSON.stringify(allNotes)}`);
  }
  if (!allNotes.searchMessages.some(message => message.query === 'canvas' && message.scope === 'all') || allNotes.placeholder !== 'Search all notes...') {
    throw new Error(`All Notes search did not use the all-notes contract: ${JSON.stringify(allNotes)}`);
  }

  await evalJs(`(() => {
    document.querySelector('.sub-pages-clear-search')?.click();
  })()`);
  await new Promise(r => setTimeout(r, 50));

  const allNotesResponsive = [];
  for (const width of widths) {
    await setViewport(width);
    allNotesResponsive.push(await evalJs(`(() => {
      const actionRects = [...document.querySelectorAll('.sub-pages-header-actions .sub-pages-icon-button')]
        .map(button => button.getBoundingClientRect());
      return {
        width: innerWidth,
        docClient: document.documentElement.clientWidth,
        bodyScroll: document.body.scrollWidth,
        actionsLeft: actionRects.length ? Math.min(...actionRects.map(rect => rect.left)) : null,
        actionsRight: actionRects.length ? Math.max(...actionRects.map(rect => rect.right)) : null,
      };
    })()`));
  }
  const allNotesLayoutFailures = allNotesResponsive.filter(result => (
    result.bodyScroll > result.docClient + 1
    || result.actionsLeft < 0
    || result.actionsRight > result.docClient + 1
  ));
  if (allNotesLayoutFailures.length) {
    throw new Error(`Responsive All Notes header layout failed: ${JSON.stringify(allNotesLayoutFailures)}`);
  }

  console.log(JSON.stringify({ responsive, appearanceUpdate, longTreeAppearance, collapsedSearch, search, noResults, bodySearch, searchFixture, childTransition, pendingChildTransition, externalOnlyTransition, mixedTransition, mixedSearchLayouts, mixedSearchEnd, localOnlyTransition, localOnlyLayout, localOnlyEnd, denseExternalOnlyTransition, externalOnlyLayout, externalOnlyEnd, notebookScopeSearch, dragPayloads, multiSelect, confirmUnlink, dragDrop, invalidDragDrop, menuKeys, treeKeys, allNotes, allNotesResponsive }, null, 2));
  } finally {
    try {
      await cdp.send('Emulation.clearDeviceMetricsOverride');
    } catch {
      // The CDP target may have gone away while a failing test was unwinding.
    }
    cdp.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
