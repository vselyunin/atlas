# Whole-card interactions

Follow-up to the Board theme implementation, requested through browser annotations.

- Use the entire card to open a task on click and initiate dragging after a small movement threshold. Remove the separate grip.
- Show a floating card preview and an exact insertion marker based on the pointer's position relative to card midpoints.
- Reuse the existing move API and beforeTaskId ordering; no contract or persistence changes.
- Preserve keyboard access: Enter opens; Space picks up/drops; arrows select a column and position; Escape cancels. Scroll the keyboard destination into view.
- Retain touch scrolling before delayed drag activation and use shared theme colors.

The user approved updating the existing task-card unit test and the drag starting point in the existing browser acceptance test. A new browser scenario covers footer clicks, insertion between cards, reload persistence and keyboard moves. The user also approved reselecting the test project after reload and waiting for move responses before reload.

Independent static review identified horizontal touch scrolling and offscreen keyboard destinations; both were corrected. Visual self-review covered light/dark dragging and narrow layout. The browser scenario additionally caught a keyboard focus race after cross-column moves; focus now follows the card after its updated position renders.

Verification complete: `pnpm check` passed (lint, formatting, types, package/integration tests and builds), and `pnpm test:e2e` passed all eight browser scenarios. The build retains the existing advisory about the Board bundle exceeding 500 kB. Independent review was static; runtime and visual verification were performed by the implementing agent.

A subsequent requested independent review found two keyboard-focus lifecycle defects: rejected cross-column moves lost focus, and no-op drops left a stale focus request. Both were fixed; a read-only follow-up review found no remaining actionable issues. New tests cover delayed rejection with focus restoration and no-op drops followed by refresh. Updated verification passed the full workspace check, all nine browser scenarios, and all 24 Board tests. No existing tests were changed during this review follow-up.
