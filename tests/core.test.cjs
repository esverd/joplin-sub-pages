const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const {
  ALL_NOTES_FILTER_ID,
  EMPTY_WHITEBOARD_BODY,
  classifyJoplinViewState,
  groupIdsByParent,
  isWhiteboardBody,
  mainWindowStateFromRoot,
  parentCycleAffectedIds,
  reciprocalRankScores,
  semanticSearchScope,
} = require('../src/core.ts');

test('classifies notebook and All Notes view state', () => {
  assert.deepEqual(classifyJoplinViewState({ notesParentType: 'Folder', selectedFolderId: 'folder-1' }), {
    viewScope: 'notebook', folderId: 'folder-1',
  });
  assert.deepEqual(classifyJoplinViewState({ notesParentType: 'SmartFilter', selectedSmartFilterId: ALL_NOTES_FILTER_ID }), {
    viewScope: 'all', folderId: null,
  });
  assert.deepEqual(classifyJoplinViewState({ notesParentType: 'Tag', selectedFolderId: 'folder-1' }), {
    viewScope: 'notebook', folderId: null,
  });
  assert.equal(classifyJoplinViewState(null), null);
});

test('uses the primary window state when a secondary window is focused', () => {
  const main = { windowId: 'default', notesParentType: 'Folder', selectedFolderId: 'main-folder' };
  assert.equal(mainWindowStateFromRoot(main), main);
  assert.equal(mainWindowStateFromRoot({ windowId: 'secondary', backgroundWindows: { default: main } }), main);
  assert.equal(mainWindowStateFromRoot({ windowId: 'secondary' }), null);
  assert.equal(mainWindowStateFromRoot({ notesParentType: 'Folder' }), null);
  assert.equal(mainWindowStateFromRoot({ windowId: 'secondary', backgroundWindows: { default: { ...main, windowId: 'other' } } }), null);
});

test('reciprocal rank fusion rewards notes found by both searches', () => {
  const scores = reciprocalRankScores(['keyword-only', 'both'], ['both', 'semantic-only']);
  assert.ok(scores.get('both') > scores.get('keyword-only'));
  assert.ok(scores.get('both') > scores.get('semantic-only'));
  assert.equal(scores.size, 3);
});

test('semantic search follows the selected panel scope', () => {
  assert.deepEqual(semanticSearchScope('all', 'folder-1'), { type: 'all' });
  assert.deepEqual(semanticSearchScope('notebook', 'folder-1'), { type: 'folder', folderId: 'folder-1' });
  assert.throws(() => semanticSearchScope('notebook', null), /folder is required/i);
});

test('groups a large flat note set by parent in one pass', () => {
  const ids = Array.from({ length: 10_000 }, (_, index) => `note-${index}`);
  const parentById = new Map(ids.map((id, index) => [id, index % 100 === 0 ? 'parent' : null]));
  const grouped = groupIdsByParent(ids, parentById);

  assert.equal(grouped.size, 1);
  assert.equal(grouped.get('parent').length, 100);
  assert.deepEqual(grouped.get('parent').slice(0, 3), ['note-0', 'note-100', 'note-200']);
});

test('finds cycles and every parent chain that leads into one', () => {
  const ids = ['tail', 'a', 'b', 'root', 'child'];
  const parentById = new Map([
    ['tail', 'a'],
    ['a', 'b'],
    ['b', 'a'],
    ['root', null],
    ['child', 'root'],
  ]);

  assert.deepEqual([...parentCycleAffectedIds(ids, parentById)].sort(), ['a', 'b', 'tail']);
});

test('recognizes only fenced JSONCanvas whiteboards', () => {
  assert.equal(isWhiteboardBody(EMPTY_WHITEBOARD_BODY), true);
  assert.equal(isWhiteboardBody('```jsoncanvas\nnot valid JSON\n```'), true);
  assert.equal(isWhiteboardBody('A note that merely mentions jsoncanvas.'), false);
  assert.equal(isWhiteboardBody('```jsoncanvas\nnot valid yet'), false);
  assert.equal(isWhiteboardBody(`Before\n\n${EMPTY_WHITEBOARD_BODY}\n\nAfter`), true);
});
