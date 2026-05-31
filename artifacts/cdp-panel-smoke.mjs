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
      const status = document.querySelector('.sub-pages-drag-status')?.textContent || '';
      row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
      const message = [...window.messages].reverse().find(item => item.name === 'noteDragStarted');
      return {
        draggable: row.draggable,
        data: JSON.parse(data || '[]'),
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
  if (JSON.stringify(dragPayloads.multi.data) !== JSON.stringify(['parent1', 'child1', 'grandchild1', 'child2'])) {
    throw new Error(`Multi-select branch drag payload was wrong: ${JSON.stringify(dragPayloads.multi)}`);
  }
  if (JSON.stringify(dragPayloads.external.data) !== JSON.stringify(['external1'])) {
    throw new Error(`External result drag should include only itself: ${JSON.stringify(dragPayloads.external)}`);
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

  console.log(JSON.stringify({ responsive, search, noResults, bodySearch, notebookScopeSearch, dragPayloads, multiSelect, menuKeys }, null, 2));
  cdp.close();
}

main().catch(err => { console.error(err); process.exit(1); });
