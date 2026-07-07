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

  await setViewport(360);
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

  console.log(JSON.stringify({ responsive, search, noResults, bodySearch, notebookScopeSearch, dragPayloads, multiSelect, confirmUnlink, dragDrop, invalidDragDrop, menuKeys, treeKeys }, null, 2));
  cdp.close();
}

main().catch(err => { console.error(err); process.exit(1); });
