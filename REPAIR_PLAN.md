# Sub-Pages Repair Plan

This plan captures the deep investigation of the Joplin Sub-Pages plugin and tracks the repair work started from that investigation.

## Implementation Progress

- Fixed: repair count now reflects all pending repair operations, including stale/missing child order metadata.
- Fixed: same-notebook branch moves now no-op instead of detaching a page from its Sub-Pages parent.
- Fixed: recent-group sorting now uses recursive descendant recency.
- Fixed: panel search cache now has a bounded size.
- Fixed: unlink confirmation now uses the Joplin host dialog path instead of `window.confirm`.
- Fixed: panel background polling is less aggressive and resyncs when the panel becomes visible.
- Fixed: Markdown export now shows explicit filesystem save failures.
- Added: npm scripts for typecheck, panel smoke, and live Joplin UAT surfaces.
- Added: panel smoke coverage for host-confirmed unlink and live UAT coverage for stale child-order repair counts.
- Fixed: parent-link metadata changes now use a shared consistency check with best-effort rollback.
- Fixed: native drag and branch-move root detach paths now use the shared parent-link mutation helper.
- Fixed: panel tree rows now support keyboard up/down/home/end navigation plus left/right collapse and parent/child movement.
- Fixed: Joplin command delegation failures now report clearer command-specific messages.
- Fixed: move/export dialogs now use responsive form widths.
- Added: panel smoke coverage for tree keyboard navigation.
- Fixed: hidden panels are skipped by scheduled backend refreshes unless refresh is forced.
- Fixed: all-notebook search now caps external notebook results and tells the user when matches are omitted.
- Fixed: expired native drag move reconciliation now logs a warning instead of disappearing silently.
- Fixed: hierarchy rollback still restores the previous parent even if attempted-parent cleanup fails.

## Current Validation Baseline

- TypeScript passes when run directly with the bundled Node runtime: `tsc --noEmit`.
- Production packaging succeeds when run directly with local webpack: `webpack --env joplin-plugin-config=buildMain` followed by `webpack --env joplin-plugin-config=createArchive`.
- There is no `test` script and no unit/integration test files discovered by filename search.
- Existing UAT assets live in `artifacts/`, but they are not wired into `package.json` or CI-like scripts.

## P0: Data Integrity And Core Behavior

1. Surface all repairable metadata problems in the panel.
   - Current issue: `buildTree` only counts invalid parent links in `repairCount`, while `repairOperationsForCurrentNotebook` also finds stale or missing `childIds`. The panel repair button can stay hidden even when repair would write changes.
   - Source: `src/index.ts` around `buildTree`, `repairCount: repairReasons.size`, and `repairOperationsForCurrentNotebook`.
   - Fix: share one repair-analysis function, return structured repair summaries, and make `repairCount` represent all pending repair operations.
   - Verify: unit tests for missing child order, stale child IDs, orphan parents, cross-notebook parents, self parents, and cycles.

2. Prevent same-notebook "Move to notebook..." from detaching a child.
   - Current issue: `moveBranchesToFolder` lists all folders, including the source notebook. If a child branch is moved to its current notebook, the code clears the root's parent metadata before writing the same `parent_id`, effectively promoting it to root.
   - Source: `src/index.ts` `moveBranchesToFolder`, `folderCandidates`, and the root detach before `joplin.data.put`.
   - Fix: filter out each selected branch root's current notebook when appropriate, or treat same-notebook selection as a no-op with a clear message.
   - Verify: UAT where a child uses Move to notebook and selects the current notebook; parent/child metadata must remain unchanged.

3. Make hierarchy metadata writes safer against partial failure.
   - Current issue: attach, promote, unlink, branch move, and native drag reconciliation perform multiple user-data writes without rollback or a final consistency check.
   - Source: `attachPageToParent`, `promotePageToRoot`, `unlinkPageFromHierarchy`, `moveBranchesToFolder`, and `reconcilePendingNativeDragMoves`.
   - Fix: centralize hierarchy mutation helpers, compute before/after state, write in the least damaging order, and run a targeted consistency repair or rollback when a write fails.
   - Verify: mocked Joplin API tests that force failures at each write step.

4. Resolve recent-group sorting semantics.
   - Current issue: a node's `effectiveTime` uses direct children only (`child.updatedTime`), while the design says descendant group recency should sort the branch.
   - Source: `src/index.ts` `buildNode` effective time calculation.
   - Fix: either use `child.effectiveTime` for recursive bubbling or update docs/UI labels to say direct-child recency only.
   - Verify: tree test where a grandchild update should or should not lift the root, depending on the chosen behavior.

5. Harden native drag reconciliation.
   - Current issue: pending native drags are inferred from later note-change events and only detach the branch root when the notebook changes. This is timing-sensitive and can silently expire.
   - Source: `rememberNativeNoteDrag`, `scheduleNativeDragReconcileChecks`, `reconcilePendingNativeDragMoves`.
   - Fix: add clearer pending-state telemetry, explicit stale cleanup reporting, and tests for multi-root moves, expired moves, same-notebook drops, and deleted roots.
   - Verify: extend `artifacts/joplin-desktop-uat.mjs` to cover notebook-sidebar drops when a live Joplin CDP session is available.

## P1: UI, UX, And Performance

6. Replace webview `window.confirm` with host-consistent confirmation UI.
   - Current issue: unlink confirmation is a browser confirm, while other confirmations use Joplin dialogs. It can look inconsistent or be blocked differently inside webviews.
   - Source: `src/panel.js` `handleActionButton` for `unlink`.
   - Fix: send a confirmation-request action to the backend or use a panel modal with accessible focus management.
   - Verify: keyboard and mouse unlink flow in the panel harness.

7. Improve search caching and query performance.
   - Current issue: panel search caches by revision/query without a size cap, and each search can also load all notes in the selected notebook.
   - Source: `panelSearchCache`, `panelSearchResponse`, `searchNotes`, `listNotebookNotes`.
   - Fix: add a small LRU or TTL cache, cap external results, avoid redundant notebook loads when possible, and clear cache on all relevant note/folder changes.
   - Verify: search tests for rapid typing, repeated queries, large notebooks, and external notebook updates.

8. Reduce polling and refresh churn.
   - Current issue: the panel polls selected note state every second and panel state every 500 ms; the backend also schedules refreshes after many events. `panelVisible` exists but is not used.
   - Source: `src/panel.js` intervals near the end of the file; `src/index.ts` refresh scheduling and unused `panelVisible`.
   - Fix: gate polling on panel visibility/focus, back off when idle, use revision pushes where possible, and remove or use the ignored `force` parameter.
   - Verify: manual Joplin session with performance logging during idle, sync, editing, search, and drag/drop.

9. Strengthen accessibility and keyboard navigation.
   - Current issue: the panel uses `tree`/`treeitem` roles but does not implement full tree keyboard behavior, roving focus, or arrow navigation.
   - Source: `src/panel.js` `renderNode`, menu keyboard handlers, and selection handlers.
   - Fix: add predictable focus targets, arrow-key navigation, Enter/Space behavior, and screen-reader labels for status/repair/search result counts.
   - Verify: keyboard-only harness tests and a screen-reader smoke pass.

10. Audit responsive layout in real Joplin themes.
   - Current issue: row trailing actions are absolutely positioned over title rows; the harness checks narrow widths, but not real theme combinations or long localized titles.
   - Source: `src/panel.css` row title/action/menu layout.
   - Fix: add visual regression screenshots for light/dark/high-contrast-like variables, long titles, long notebook names, and narrow panels.
   - Verify: automated panel harness screenshots plus manual Joplin checks.

11. Improve Markdown export error handling.
   - Current issue: save failures bubble to generic action errors, form fallback has fixed minimum width, and native save dialog handling assumes overwrite behavior is already handled.
   - Source: `saveNoteAsMarkdown`, `chooseMarkdownExportPathWithSaveDialog`, `chooseMarkdownExportPathWithFormDialog`.
   - Fix: show explicit file-system errors, verify overwrite semantics in supported Joplin versions, improve small-panel dialog layout, and add tests for invalid paths/reserved names.
   - Verify: mocked fs tests and manual save/cancel/overwrite checks.

12. Clarify native command delegation behavior.
   - Current issue: panel menu actions call internal Joplin command names with fallback argument shapes. Unsupported or changed command behavior can fail late.
   - Source: `NOTE_LIST_PARITY_COMMANDS`, `runNoteListParityCommand`, `openNote`, `runCommandPalette`.
   - Fix: add command capability checks where possible, better user messages for unsupported commands, and tests around multi-select command payloads.
   - Verify: live UAT across the supported Joplin version range.

## P2: Maintainability, Tests, And Release Readiness

13. Split large files into testable modules.
   - Current issue: `src/index.ts` and `src/panel.js` contain most of the plugin behavior in large monolithic files.
   - Fix: extract pure tree/repair/sort logic, Joplin data access, hierarchy mutations, panel message contracts, and panel DOM helpers.
   - Verify: unit tests import pure modules without a Joplin runtime.

14. Tighten typing and message schemas.
   - Current issue: many host boundaries use `any`, `panel.js` is not type-checked meaningfully, and message payloads are implicit.
   - Source: TypeScript declarations in `src/index.ts`, plain JS panel code, and `tsconfig.json`.
   - Fix: introduce shared message types, enable stricter TypeScript settings incrementally, or migrate panel code to TypeScript with DOM-safe helpers.
   - Verify: strict typecheck in CI after staged migration.

15. Add real automated test scripts.
   - Current issue: `package.json` only exposes `dist`, `typecheck`, `prepare`, and `updateVersion`.
   - Fix: add `test`, `test:unit`, `test:panel`, and documented `test:uat` scripts. Wire existing `artifacts/cdp-panel-smoke.mjs` and `artifacts/joplin-desktop-uat.mjs` into repeatable commands.
   - Verify: one command runs unit tests and panel harness locally; UAT command clearly documents Joplin/CDP prerequisites.

16. Build regression coverage for core scenarios.
   - Required cases: create root, create child, attach/move, promote, unlink, manual reorder, search all/notebook, external result actions, same-notebook move guard, markdown export, repair operations, native drag tracking, and large-notebook pagination.

17. Improve release metadata.
   - Current issue: manifest has no screenshots/icons/promo tile and author is generic.
   - Source: `src/manifest.json`.
   - Fix: add plugin store assets and real ownership metadata when ready to publish.

## Suggested Work Order

1. Add pure unit tests around tree building and repair analysis.
2. Fix repair counting and same-notebook branch move behavior.
3. Centralize hierarchy mutations and add failure-path tests.
4. Decide and implement recursive versus direct recent-group sorting.
5. Wire panel harness and unit tests into package scripts.
6. Address polling/search performance and UI/accessibility polish.
7. Expand live Joplin UAT for native drag/drop, markdown export, and command delegation.
