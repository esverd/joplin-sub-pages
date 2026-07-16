import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const cdpPort = Number(process.env.JOPLIN_CDP_PORT || 18900);
const NOTE_MODEL_TYPE = 1;
const PARENT_ID_KEY = 'subPages.parentId';
const CHILD_IDS_KEY = 'subPages.childIds';
const EMPTY_WHITEBOARD_BODY = '```jsoncanvas\n{\n\t"nodes": [],\n\t"edges": []\n}\n```';

function getJson(requestPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: cdpPort, path: requestPath }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const callbacks = new Map();
  const eventHandlers = new Map();

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && callbacks.has(msg.id)) {
      const { resolve, reject } = callbacks.get(msg.id);
      callbacks.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }

    if (msg.method && eventHandlers.has(msg.method)) {
      eventHandlers.get(msg.method).forEach((handler) => handler(msg.params));
    }
  });

  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const msgId = ++id;
        ws.send(JSON.stringify({ id: msgId, method, params }));
        return new Promise((resolve, reject) => callbacks.set(msgId, { resolve, reject }));
      },
      on(method, handler) {
        const handlers = eventHandlers.get(method) || [];
        handlers.push(handler);
        eventHandlers.set(method, handlers);
      },
      close() {
        ws.close();
      },
    }));
    ws.addEventListener('error', reject);
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function valueFromResult(result) {
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description
      || result.exceptionDetails.exception?.value
      || result.exceptionDetails.text
      || JSON.stringify(result.exceptionDetails);
    throw new Error(detail);
  }

  return result.result.value;
}

async function evalJs(cdp, expression, contextId) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    ...(contextId ? { contextId } : {}),
  });
  return valueFromResult(result);
}

function assert(condition, message, detail) {
  if (!condition) {
    const suffix = detail === undefined ? '' : `\n${JSON.stringify(detail, null, 2)}`;
    throw new Error(`${message}${suffix}`);
  }
}

function findNode(nodes, noteId) {
  for (const node of nodes || []) {
    if (node.id === noteId) return node;
    const child = findNode(node.children || [], noteId);
    if (child) return child;
  }
  return null;
}

function nodeParentId(state, noteId) {
  return findNode(state.nodes || [], noteId)?.parentId ?? null;
}

function childIdsFor(state, noteId) {
  return (findNode(state.nodes || [], noteId)?.children || []).map(child => child.id);
}

async function locatePanelContext(cdp, contexts) {
  for (let attempt = 0; attempt < 30; attempt++) {
    for (const context of contexts) {
      try {
        const summary = await evalJs(cdp, `(() => ({
          hasPanel: !!document.querySelector('.sub-pages-app, .sub-pages-shell, .sub-pages-list'),
          text: (document.querySelector('#app')?.textContent || '').slice(0, 120),
          hasPostMessage: !!window.webviewApi?.postMessage,
        }))()`, context.id);
        if (summary.hasPanel && summary.hasPostMessage) return context.id;
      } catch {
        // The context can disappear while Joplin is still settling.
      }
    }
    await delay(250);
  }

  throw new Error('Sub-Pages panel context was not found in the Joplin renderer.');
}

async function main() {
  const targetsResponse = await getJson('/json/list');
  const targets = targetsResponse.value || targetsResponse;
  const mainTarget = targets.find(target => target.title === 'Joplin' && target.url.endsWith('/index.html'));
  const pluginTarget = targets.find(target => target.url.includes('pluginId=com.codex.subPages'));
  assert(mainTarget, 'Joplin main target not found.', targets);
  assert(pluginTarget, 'Sub-Pages plugin background target not found.', targets);

  const mainCdp = await connect(mainTarget.webSocketDebuggerUrl);
  const pluginCdp = await connect(pluginTarget.webSocketDebuggerUrl);
  const contexts = [];
  const checks = [];
  let sourceFolderId = null;
  let targetFolderId = null;
  let originalFolderId = null;
  let originalClipboard = null;

  mainCdp.on('Runtime.executionContextCreated', (params) => contexts.push(params.context));
  await mainCdp.send('Page.enable');
  await mainCdp.send('Runtime.enable');
  await pluginCdp.send('Runtime.enable');
  await delay(1000);

  const panelContextId = await locatePanelContext(mainCdp, contexts);

  async function pluginEval(body, arg = {}) {
    return evalJs(pluginCdp, `(async (arg) => { ${body} })(${JSON.stringify(arg)})`);
  }

  async function panelEval(body, arg = {}) {
    return evalJs(mainCdp, `(async (arg) => { ${body} })(${JSON.stringify(arg)})`, panelContextId);
  }

  async function panelPost(message) {
    const response = await panelEval(`return await window.webviewApi.postMessage(arg);`, message);
    assert(response && response.ok !== false, `Panel message failed: ${message.name}`, response);
    return response;
  }

  async function getState() {
    const response = await panelPost({ name: 'refresh' });
    assert(response.state, 'Panel refresh did not return state.', response);
    return response.state;
  }

  async function waitForState(label, predicate, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    let state = null;
    while (Date.now() < deadline) {
      state = await getState();
      if (predicate(state)) return state;
      await delay(300);
    }
    throw new Error(`Timed out waiting for ${label}.\n${JSON.stringify(state, null, 2)}`);
  }

  function record(name, detail = {}) {
    console.error(`[uat] ${name}`);
    checks.push({ name, ...detail });
  }

  async function openFolder(folderId) {
    return pluginEval(`
      const attempts = [
        () => joplin.commands.execute('openFolder', arg.folderId),
        () => joplin.commands.execute('openFolder', { folderId: arg.folderId }),
        () => joplin.commands.execute('openFolder', { id: arg.folderId }),
      ];
      const errors = [];
      for (const attempt of attempts) {
        try {
          await attempt();
          return { ok: true };
        } catch (error) {
          errors.push(error && error.message ? error.message : String(error));
        }
      }
      return { ok: false, errors };
    `, { folderId });
  }

  async function openAllNotes() {
    return evalJs(mainCdp, `(() => {
      const item = document.querySelector('.all-notes .list-item');
      if (!item) return { ok: false, message: 'All Notes sidebar item was not found.' };
      item.click();
      return { ok: true, label: item.textContent.trim() };
    })()`);
  }

  async function renameNote(noteId, title, body) {
    await pluginEval(`
      await joplin.data.put(['notes', arg.noteId], null, {
        title: arg.title,
        body: arg.body,
      });
      return true;
    `, { noteId, title, body });
  }

  async function createRoot(title, body) {
    const response = await panelPost({ name: 'createRoot' });
    const noteId = response.state?.selectedNoteId;
    assert(noteId, 'Create root did not return the created note as selected.', response);
    await renameNote(noteId, title, body);
    await waitForState(`root "${title}"`, state => findNode(state.nodes, noteId)?.title === title);
    return noteId;
  }

  async function createChild(parentId, title, body) {
    const response = await panelPost({ name: 'createChild', noteId: parentId });
    const noteId = response.state?.selectedNoteId;
    assert(noteId, 'Create child did not return the created note as selected.', response);
    await renameNote(noteId, title, body);
    await waitForState(`child "${title}"`, state => nodeParentId(state, noteId) === parentId && findNode(state.nodes, noteId)?.title === title);
    return noteId;
  }

  async function createWhiteboard(action, title, parentId = null) {
    const response = await panelPost({ name: action, ...(parentId ? { noteId: parentId } : {}) });
    const noteId = response.state?.selectedNoteId;
    assert(noteId, `${action} did not return the created whiteboard as selected.`, response);
    const note = await pluginEval(`
      await joplin.data.put(['notes', arg.noteId], null, { title: arg.title });
      return await joplin.data.get(['notes', arg.noteId], { fields: ['id', 'title', 'body', 'parent_id'] });
    `, { noteId, title });
    assert(note.body === EMPTY_WHITEBOARD_BODY, `${action} did not create Joplin's canonical empty whiteboard body.`, note);
    await waitForState(`whiteboard "${title}"`, state => {
      const node = findNode(state.nodes, noteId);
      return node?.title === title && node.pageType === 'whiteboard' && (!parentId || node.parentId === parentId);
    });
    return noteId;
  }

  async function userData(noteId, key) {
    return pluginEval(`
      try {
        const value = await joplin.data.userDataGet(${NOTE_MODEL_TYPE}, arg.noteId, arg.key);
        return value === undefined ? null : value;
      } catch {
        return null;
      }
    `, { noteId, key });
  }

  async function cleanupOldUatFolders() {
    return pluginEval(`
      const output = [];
      const folders = [];
      let page = 1;
      while (true) {
        const response = await joplin.data.get(['folders'], {
          fields: ['id', 'title', 'parent_id'],
          page,
          limit: 100,
        });
        const items = Array.isArray(response.items) ? response.items : [];
        const collect = (folder) => {
          if (!folder || !folder.id) return;
          folders.push({ id: folder.id, title: folder.title || '', parent_id: folder.parent_id || '' });
          (folder.children || []).forEach(collect);
        };
        items.forEach(collect);
        if (!response.has_more) break;
        page += 1;
      }

      const staleFolders = folders.filter((folder) => folder.title.startsWith('Codex Sub-Pages UAT'));
      for (const folder of staleFolders) {
        try {
          await joplin.data.delete(['folders', folder.id]);
          output.push(folder.id);
        } catch (error) {
          output.push({ id: folder.id, error: error && error.message ? error.message : String(error) });
        }
      }

      return {
        deleted: output,
        fallbackFolderId: folders.find((folder) => !folder.title.startsWith('Codex Sub-Pages UAT'))?.id || null,
      };
    `);
  }

  try {
    const original = await pluginEval(`
      const selectedFolder = await joplin.workspace.selectedFolder();
      let clipboard = null;
      try { clipboard = await joplin.clipboard.readText(); } catch {}
      return {
        version: await joplin.versionInfo(),
        selectedFolder,
        clipboard,
        showSaveDialogType: typeof joplin.views.dialogs.showSaveDialog,
      };
    `);
    originalFolderId = original.selectedFolder?.id || null;
    originalClipboard = original.clipboard;
    record('connected to Joplin plugin API', { version: original.version?.version });
    assert(original.showSaveDialogType === 'function', 'Joplin runtime does not expose a native save dialog API.', original);
    record('verified native save dialog API is available');

    const installedPluginDir = path.join(os.homedir(), '.config', 'joplin-desktop', 'cache', 'com.codex.subPages');
    const installedPluginEntry = await Promise.any([
      fs.readFile(path.join(installedPluginDir, 'index.js'), 'utf8'),
      fs.readFile(path.join(installedPluginDir, 'main.js'), 'utf8'),
    ]);
    const installedPluginSource = installedPluginEntry;
    assert(!installedPluginSource.includes('showOpenDialog') && !installedPluginSource.includes('openFile'), 'Installed plugin still contains the invalid open-file save fallback.');
    assert(installedPluginSource.includes('subPages.markdownExportDialog'), 'Installed plugin is missing the Markdown export form fallback.');
    record('verified installed Markdown export avoids open-file save fallback');

    const staleCleanup = await cleanupOldUatFolders();
    if (staleCleanup.deleted.length) {
      record('removed stale temporary UAT notebooks', { deleted: staleCleanup.deleted.length });
      if (!originalFolderId || staleCleanup.deleted.includes(originalFolderId)) {
        originalFolderId = staleCleanup.fallbackFolderId;
        if (originalFolderId) await openFolder(originalFolderId);
      }
    }

    const initialState = await getState();
    const indexedSearchCandidate = (initialState.nodes || []).find(node => (node.title || '').trim().length >= 3);
    if (indexedSearchCandidate) {
      const searchResult = await panelPost({ name: 'search', query: indexedSearchCandidate.title, scope: 'notebook' });
      assert((searchResult.noteIds || []).includes(indexedSearchCandidate.id), 'Notebook-scoped Joplin search did not find an indexed visible note.', {
        candidate: indexedSearchCandidate,
        searchResult,
      });
      record('verified notebook-scoped Joplin search', { query: indexedSearchCandidate.title });
    } else {
      record('skipped notebook-scoped Joplin search because the starting notebook had no searchable rows');
    }

    const suffix = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const setup = await pluginEval(`
      const source = await joplin.data.post(['folders'], null, { title: arg.sourceTitle });
      const target = await joplin.data.post(['folders'], null, { title: arg.targetTitle });
      return { source, target };
    `, {
      sourceTitle: `Codex Sub-Pages UAT ${suffix}`,
      targetTitle: `Codex Sub-Pages UAT Target ${suffix}`,
    });
    sourceFolderId = setup.source.id;
    targetFolderId = setup.target.id;
    assert(sourceFolderId && targetFolderId, 'Temporary UAT folders were not created.', setup);

    const openResult = await openFolder(sourceFolderId);
    assert(openResult.ok, 'Could not select the temporary UAT notebook.', openResult);
    let state = await waitForState('temporary notebook selection', current => current.folder?.id === sourceFolderId);
    record('selected temporary notebook', { folderTitle: state.folder?.title });

    const token = `codex-uat-${suffix}`;
    const parentA = await createRoot(`Codex UAT Parent A ${suffix}`, `Parent A body ${token}`);
    const parentB = await createRoot(`Codex UAT Parent B ${suffix}`, `Parent B body ${token}`);
    const childOne = await createChild(parentA, `Codex UAT Child One ${suffix}`, `Child one body ${token}`);
    const childTwo = await createChild(parentA, `Codex UAT Child Two ${suffix}`, `Child two body ${token}`);
    const rootWhiteboard = await createWhiteboard('createRootWhiteboard', `Codex UAT Whiteboard ${suffix}`);
    const childWhiteboard = await createWhiteboard('createChildWhiteboard', `Codex UAT Child Whiteboard ${suffix}`, rootWhiteboard);
    state = await getState();
    assert(nodeParentId(state, childOne) === parentA && nodeParentId(state, childTwo) === parentA, 'Child creation did not link both notes under Parent A.', state);
    assert(nodeParentId(state, childWhiteboard) === rootWhiteboard && findNode(state.nodes, rootWhiteboard)?.pageType === 'whiteboard', 'Whiteboard hierarchy state was not preserved.', state);
    record('created roots, children, and whiteboards through panel actions', { parentA, parentB, childOne, childTwo, rootWhiteboard, childWhiteboard });

    const targetNoteTitle = `Codex UAT Other Notebook ${suffix}`;
    const targetNote = await pluginEval(`
      return await joplin.data.post(['notes'], null, {
        parent_id: arg.folderId,
        title: arg.title,
        body: arg.body,
      });
    `, {
      folderId: targetFolderId,
      title: targetNoteTitle,
      body: `Other notebook body ${token}`,
    });
    assert(targetNote?.id, 'Could not create the cross-notebook All Notes fixture.', targetNote);
    const allNotesOpen = await openAllNotes();
    assert(allNotesOpen.ok, 'Could not select All Notes in Joplin.', allNotesOpen);
    state = await waitForState('All Notes view', current => (
      current.viewScope === 'all'
      && current.folder === null
      && !!findNode(current.nodes, parentA)
      && !!findNode(current.nodes, targetNote.id)
    ), 20000);
    assert(findNode(state.nodes, parentA)?.notebookId === sourceFolderId, 'All Notes did not retain the source root notebook identity.', state);
    assert(findNode(state.nodes, targetNote.id)?.notebookId === targetFolderId, 'All Notes did not retain the target root notebook identity.', state);
    const searchDeadline = Date.now() + 15000;
    let allNotesSearch = null;
    while (Date.now() < searchDeadline) {
      await panelPost({ name: 'refresh' });
      allNotesSearch = await panelPost({ name: 'search', query: targetNoteTitle, scope: 'notebook' });
      if ((allNotesSearch.noteIds || []).includes(targetNote.id)) break;
      await delay(400);
    }
    assert(allNotesSearch.scope === 'all' && (allNotesSearch.noteIds || []).includes(targetNote.id), 'All Notes search did not force the combined all-notes scope.', allNotesSearch);
    record('verified native All Notes mirroring and combined search', { itemCount: state.noteCount });

    const reopenSource = await openFolder(sourceFolderId);
    assert(reopenSource.ok, 'Could not restore the temporary source notebook after All Notes.', reopenSource);
    state = await waitForState('source notebook after All Notes', current => current.viewScope === 'notebook' && current.folder?.id === sourceFolderId);

    await pluginEval(`
      await joplin.data.userDataSet(${NOTE_MODEL_TYPE}, arg.parentId, '${CHILD_IDS_KEY}', [arg.childOne]);
      return true;
    `, { parentId: parentA, childOne });
    state = await waitForState('repair-needed stale child order metadata', current => current.repairCount > 0);
    assert(state.repairCount > 0, 'Stale child order metadata was not counted as repairable.', state);
    await pluginEval(`
      await joplin.data.userDataSet(${NOTE_MODEL_TYPE}, arg.parentId, '${CHILD_IDS_KEY}', [arg.childOne, arg.childTwo]);
      return true;
    `, { parentId: parentA, childOne, childTwo });
    state = await waitForState('restored child order metadata', current => current.repairCount === 0);
    record('verified stale child order metadata contributes to repair count');

    const menuItems = await panelEval(`
      const row = document.querySelector(\`.sub-pages-row[data-note-id="\${arg.noteId}"]\`);
      const menu = row?.querySelector('.sub-pages-row-menu');
      if (menu) menu.open = true;
      return [...(menu?.querySelectorAll('.sub-pages-menu-item') || [])].map(item => item.textContent.trim());
    `, { noteId: parentA });
    ['Save as Markdown...', 'Move to notebook...', 'Copy Markdown link', 'Promote to root', 'Unlink'].forEach((label) => {
      assert(menuItems.includes(label), `Panel row menu is missing "${label}".`, menuItems);
    });
    record('verified live panel row menu items', { itemCount: menuItems.length });

    await panelPost({ name: 'dropOnNote', noteId: childOne, targetNoteId: parentB });
    state = await waitForState('drop child onto another parent', current => nodeParentId(current, childOne) === parentB);
    assert(childIdsFor(state, parentB).includes(childOne), 'Dropped child was not visible under Parent B.', state);
    record('moved child under another page through panel drop action');

    await panelPost({ name: 'dropToRoot', noteId: childOne });
    state = await waitForState('promote child to root through panel message', current => nodeParentId(current, childOne) === null);
    record('promoted child to root through panel action');

    const dragResult = await panelEval(`
      const child = document.querySelector(\`.sub-pages-row[data-note-id="\${arg.noteId}"]\`);
      const zone = document.querySelector('.sub-pages-list.sub-pages-root-drop-zone');
      const explicitTarget = document.querySelector('.sub-pages-root-drop-target');
      const tree = document.querySelector('.sub-pages-tree');
      if (!child || !zone || !explicitTarget || !tree) {
        return { ok: false, childFound: !!child, zoneFound: !!zone, explicitTargetFound: !!explicitTarget, treeFound: !!tree };
      }
      const data = new DataTransfer();
      child.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
      const visibleDuringDrag = zone.classList.contains('is-visible');
      const immediateStyle = getComputedStyle(zone);
      const immediateRect = zone.getBoundingClientRect();
      const immediateOffsetHeight = zone.offsetHeight;
      const immediateTreeRect = tree.getBoundingClientRect();
      const immediateExplicitRect = explicitTarget.getBoundingClientRect();
      await new Promise(requestAnimationFrame);
      await new Promise((resolve) => setTimeout(resolve, 160));
      const settledStyle = getComputedStyle(zone);
      const settledRect = zone.getBoundingClientRect();
      const settledOffsetHeight = zone.offsetHeight;
      const settledTreeRect = tree.getBoundingClientRect();
      const settledExplicitRect = explicitTarget.getBoundingClientRect();
      zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
      zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
      child.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: data }));
      return {
        ok: true,
        visibleDuringDrag,
        rootDropSurfaceHeight: settledRect.height,
        clearListHeight: settledRect.height - settledTreeRect.height - settledExplicitRect.height,
        immediate: {
          height: immediateRect.height,
          offsetHeight: immediateOffsetHeight,
          treeHeight: immediateTreeRect.height,
          explicitTargetHeight: immediateExplicitRect.height,
          minHeight: immediateStyle.minHeight,
          display: immediateStyle.display,
          flex: immediateStyle.flex,
          transition: immediateStyle.transition,
          marginTop: immediateStyle.marginTop,
        },
        settled: {
          height: settledRect.height,
          offsetHeight: settledOffsetHeight,
          treeHeight: settledTreeRect.height,
          explicitTargetHeight: settledExplicitRect.height,
          minHeight: settledStyle.minHeight,
          display: settledStyle.display,
          flex: settledStyle.flex,
          transition: settledStyle.transition,
          marginTop: settledStyle.marginTop,
        },
        className: zone.className,
        explicitTargetClassName: explicitTarget.className,
      };
    `, { noteId: childTwo });
    assert(dragResult.ok && dragResult.visibleDuringDrag && dragResult.clearListHeight > 40, 'Live drag-to-root list surface did not behave correctly.', dragResult);
    state = await waitForState('promote child to root through real drag/drop', current => nodeParentId(current, childTwo) === null);
    record('promoted child to root through real DOM drag/drop', dragResult);

    await panelPost({ name: 'dropOnNote', noteId: childTwo, targetNoteId: parentB });
    state = await waitForState('prepare unlink test', current => nodeParentId(current, childTwo) === parentB);
    await panelPost({ name: 'unlink', noteId: parentB });
    state = await waitForState('unlink parent and direct child', current => nodeParentId(current, childTwo) === null && childIdsFor(current, parentB).length === 0);
    assert(await userData(childTwo, PARENT_ID_KEY) === null, 'Unlink did not clear child parent userData.');
    record('unlinked a parent and direct child hierarchy');

    const orderOne = await createChild(parentA, `Codex UAT Order One ${suffix}`, `Order one body ${token}`);
    const orderTwo = await createChild(parentA, `Codex UAT Order Two ${suffix}`, `Order two body ${token}`);
    let orderedIds = await userData(parentA, CHILD_IDS_KEY);
    assert(JSON.stringify(orderedIds) === JSON.stringify([orderOne, orderTwo]), 'Initial child order metadata was not as expected.', orderedIds);
    await panelPost({ name: 'moveDown', noteId: orderOne });
    orderedIds = await userData(parentA, CHILD_IDS_KEY);
    assert(JSON.stringify(orderedIds) === JSON.stringify([orderTwo, orderOne]), 'Move down did not update manual child order metadata.', orderedIds);
    await panelPost({ name: 'moveUp', noteId: orderOne });
    orderedIds = await userData(parentA, CHILD_IDS_KEY);
    assert(JSON.stringify(orderedIds) === JSON.stringify([orderOne, orderTwo]), 'Move up did not restore manual child order metadata.', orderedIds);
    record('verified manual sibling order commands update metadata');

    await panelPost({ name: 'copyMarkdownLink', noteId: orderOne });
    let clipboard = await pluginEval(`return await joplin.clipboard.readText();`);
    assert(clipboard === `[Codex UAT Order One ${suffix}](:/${orderOne})`, 'Copy Markdown link wrote the wrong clipboard text.', clipboard);
    await panelPost({ name: 'copyExternalLink', noteId: orderOne });
    clipboard = await pluginEval(`return await joplin.clipboard.readText();`);
    assert(clipboard === `joplin://x-callback-url/openNote?id=${encodeURIComponent(orderOne)}`, 'Copy external link wrote the wrong clipboard text.', clipboard);
    record('verified copy-link panel actions');

    await pluginEval(`
      await joplin.data.userDataSet(${NOTE_MODEL_TYPE}, arg.noteId, '${PARENT_ID_KEY}', arg.noteId);
      return true;
    `, { noteId: childOne });
    state = await waitForState('repair-needed state', current => current.repairCount > 0);
    assert(findNode(state.nodes, childOne)?.repairReason === 'Self parent', 'Corrupt self-parent metadata was not surfaced as repair-needed.', state);
    await pluginEval(`
      await joplin.data.userDataDelete(${NOTE_MODEL_TYPE}, arg.noteId, '${PARENT_ID_KEY}');
      return true;
    `, { noteId: childOne });
    record('verified metadata repair-needed detection');

    console.log(JSON.stringify({ ok: true, checks }, null, 2));
  } finally {
    if (originalFolderId) await openFolder(originalFolderId).catch(() => {});
    if (originalClipboard !== null && originalClipboard !== undefined) {
      await pluginEval(`await joplin.clipboard.writeText(arg.text); return true;`, { text: originalClipboard }).catch(() => {});
    }
    if (targetFolderId) await pluginEval(`await joplin.data.delete(['folders', arg.folderId]); return true;`, { folderId: targetFolderId }).catch(() => {});
    if (sourceFolderId) await pluginEval(`await joplin.data.delete(['folders', arg.folderId]); return true;`, { folderId: sourceFolderId }).catch(() => {});
    mainCdp.close();
    pluginCdp.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
