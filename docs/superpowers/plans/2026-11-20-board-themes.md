# Board Themes and Compact Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for inline execution or superpowers:subagent-driven-development if the user chooses delegation. Steps use checkbox syntax for tracking.

**Goal:** Deliver the approved compact Board with complete light/dark support and a persistent System/Light/Dark preference.

**Architecture:** A small theme store owns browser preference and resolves it against the device setting before React renders. CSS semantic tokens supply both palettes, including portaled content. A reusable accessible dropdown supports project/version actions and the avatar menu; App retains query and dialog state.

**Tech Stack:** React, TypeScript, Vite, CSS variables, Lucide, Radix UI, Vitest and Playwright.

**Spec:** [Approved design](../specs/2026-11-20-board-themes-design.md).

## Global constraints

- Board only; no API, Worker, shared contract or business-rule changes.
- System is the default. Light/Dark overrides persist in this browser.
- Neutral black/gray backgrounds; one compact header and the board below it.
- Creation actions first in menus; circular avatar; compact appearance control.
- Existing tests, helpers and test configuration require explicit permission to modify.
- No mandatory TDD. Add new tests that prove behavior; do not create tests mirroring CSS declarations.
- Follow root and Board instructions and the atlas-feature-verification skill. Keep personal `.atlas` data out of automated checks.

## Review focus

1. Storage unavailable or corrupt: startup and in-session theme changes still work (Task 1).
2. Device theme changes after an explicit override: only System follows those changes (Task 1).
3. Empty/pending project or no versions: creation remains discoverable; New task remains appropriately disabled (Task 2).
4. Portaled menus/dialogs and keyboard focus: theme and dismissal work outside the main app subtree (Tasks 2–3).
5. Long names and narrow screens: header controls stay accessible and the board scrolls horizontally (Tasks 2–4).

## Task 1: Theme lifecycle and semantic palettes

**Files:** Create `apps/board/src/lib/theme.ts`, `apps/board/src/lib/useTheme.ts`, `apps/board/tests/theme.test.ts`; modify `apps/board/src/main.tsx`, `apps/board/index.html`, `apps/board/src/styles.css`.

**Interfaces:** Export `ThemePreference = 'system' | 'light' | 'dark'`, `ResolvedTheme = 'light' | 'dark'`, `initializeTheme(): void`, `getThemePreference(): ThemePreference`, `setThemePreference(value: ThemePreference): void`, and `subscribeTheme(listener: () => void): () => void`. `useTheme(): { preference: ThemePreference; setPreference: (value: ThemePreference) => void }` uses the external store subscription.

- [ ] Implement safe preference loading under `atlas.theme`, using System for missing/invalid values. Resolve against `matchMedia('(prefers-color-scheme: dark)')`, with light fallback if unavailable. Storage read/write errors must not break the UI.
- [ ] Apply `data-theme` and `color-scheme` to the root and update the existing theme-color meta tag. Initialize before `createRoot` and keep a minimal early initialization in the HTML head to prevent a flash before the application module loads. Use the same storage key and resolution semantics in both paths.
- [ ] Register the system-change listener once, notify subscribers on preference changes, and follow system changes only when preference is System. Keep the browser-only lifecycle outside React StrictMode effects.
- [ ] Replace component-level literal colors in `styles.css` with named tokens for page/surface/column, text/muted text, borders, actions, focus, shadows and semantic states. Define all light and dark values centrally; cover forms, errors, provisioning, disabled states and drag feedback.
- [ ] Add new tests asserting: missing/invalid storage gives System; dark system resolves dark; explicit Light remains light after a system event; selecting System resumes device tracking; explicit preference survives reinitialization; throwing storage getters/setters do not prevent application; missing matchMedia resolves light.
- [ ] Run contracts build, Board typecheck and the new theme test. Review that every token has both palette definitions. Commit as `feat(board): add persistent system-aware themes` once checks pass.

## Task 2: Compact header and accessible menus

**Files:** Create `apps/board/src/components/ui/dropdown-menu.tsx`, `apps/board/src/features/layout/BoardHeader.tsx`, `apps/board/tests/header.test.tsx`; modify `apps/board/src/App.tsx`, `apps/board/src/styles.css`, `apps/board/package.json`, `pnpm-lock.yaml`.

**Interfaces:** `BoardHeader` consumes `projects: Project[]`, `projectId: string`, `versions: Version[]`, `versionId: string`, `ready: boolean`, `taskCreationDisabled: boolean`, `workerStatus: string`, `onSelectProject(id: string)`, `onSelectVersion(id: string)`, `onCreateProject()`, `onCreateVersion()`, `onCreateTask()`. It consumes `useTheme()` from Task 1. Query ownership and selected-task resets remain in App.

- [ ] Add the compatible `@radix-ui/react-dropdown-menu` dependency; inspect existing Radix versions and available package exports before writing the wrapper. Export styled Root/Trigger/Content/Item/Separator primitives used by this feature. Use Lucide ChevronDown consistently. Keep focus management provided by the primitive.
- [ ] Implement project/version menu buttons with accessible names `Project` and `Version`, current values visible, and creation items `Create project` / `Create version` first. Show selection with background/weight and accessible selected semantics, without visible checkmarks. Preserve existing dialog submit labels.
- [ ] Implement the circular `User settings` trigger, identity and a compact native Appearance select with System/Light/Dark values. Remove explanatory helper text. Ensure interacting with the select does not unexpectedly dismiss the menu; use suitable Radix composition and verify keyboard behavior.
- [ ] Move New task into the header, retaining its disabled conditions. Move Worker availability into the same header. Remove old toolbar, oversized title, metadata strip and decorative footer; retain useful errors, provisioning and the first-project empty state.
- [ ] Apply consistent 36px header control heights and aligned chevrons, with a 64px desktop header. Truncate long trigger labels, keep full names available in menus, permit wrapping at narrow widths and prevent menu clipping. Board should fill remaining available height without hiding overflow.
- [ ] Add tests for creation callbacks and menu order, current project/version selection, disabled task creation, empty/pending projects, avatar theme changes, Escape and focus return. Use distinct sample project/version names to prove the selected callback receives the correct ID.
- [ ] Run Board typecheck, package tests and targeted lint. Commit as `feat(board): consolidate navigation into compact menus` after passing checks.

## Task 3: Card layout and theme coverage

**Files:** Modify `apps/board/src/features/board/BoardDnd.tsx`, `apps/board/src/styles.css`; create `apps/board/tests/task-card.test.tsx`.

**Interfaces:** Preserve `BoardDnd` props and existing task/Worker contracts. No new mutation or drag/drop API.

- [ ] Move the type chip into the footer beside priority. Remove priority icon imports/selection logic. Keep the named drag handle accessible near the title without an empty top row; preserve its listeners, touch behavior and keyboard sensor.
- [ ] Keep assignee labels readable with long names and wrap footer metadata if needed. Preserve offline indicators and textual priority labels. Check all four task types and priorities against both palettes.
- [ ] Add an observable card rendering test that verifies type and priority appear in the footer, title remains a button and the named drag handle remains available. Retain existing drag logic and status rules.
- [ ] Inspect light/dark dialogs, menus, fields, empty/error/loading/disabled states and drag feedback in a browser, correcting production styles where needed. Verify readable text and visible focus, including portaled elements.
- [ ] Run Board tests/typecheck and production build. Commit as `feat(board): streamline task cards for both themes`.

## Task 4: Acceptance and persistent UI conventions

**Files:** Create `tests/e2e/themes.spec.ts`; modify `apps/board/AGENTS.md`, `.agents/skills/atlas-feature-verification/SKILL.md`; subject to permission, modify `tests/e2e/atlas.spec.ts` and `tests/e2e/rollback.spec.ts`.

**Interfaces:** Browser assertions use root `data-theme`, header menu names from Task 2, and the existing isolated e2e startup helper. No test runner or helper changes are planned.

- [ ] Request permission for these exact existing-test edits: in `atlas.spec.ts`, open Version then choose Create version instead of clicking the old Add version header button; open Project then choose Create project instead of the old header button. In `rollback.spec.ts`, replace native project `selectOption(project.id)` with Project menu selection by the unique name Rollback checks. Preserve all assertions, task interactions and repository checks. Do not edit until authorized.
- [ ] Add browser coverage for first-load system dark/light, live system switching, manual override persistence after reload, returning to System, and theme inheritance on open menus/dialogs. Exercise the actual avatar selector, not only storage injection. Separately simulate unavailable storage and assert startup and selection remain functional.
- [ ] Check keyboard open/dismiss/focus return and creation from both header menus. At desktop and narrow viewport sizes inspect long names, menu bounds, header reachability, card footer wrapping and horizontal board scrolling. Use temporary projects, not the personal workspace.
- [ ] Document the requirement in Board AGENTS: every new/changed UI feature uses shared semantic tokens, supports both themes including interaction states, and receives browser checks in both. Replace the stale reference to nonexistent Board mocks with guidance to use fixtures/mocks where applicable. Extend the verification skill with the procedure, referencing the Board policy rather than duplicating it.
- [ ] Run `pnpm check` and `pnpm test:e2e`; record exact results and any limits. Validate the changed skill and check documentation formatting. If tests need further edits, ask for their precise scope rather than broadening approval.
- [ ] Review the full diff against the approved mockup/spec. Report review availability honestly. Commit as `test(board): verify themes and compact navigation` with documentation in the same feature commit or a separate `docs(board)` commit.

## Execution and completion

The tasks share theme/menu interfaces and are intended to run sequentially.
Recommend inline execution with a final independent review if available. Before
implementation, use the worktree skill to establish an isolated feature branch;
do not modify the approved main branch directly. Preserve unrelated work.

Self-review: each design section maps to a task; all five review conditions have
checks assigned above. Test permissions are limited to the two named browser
files and the described interaction updates. API/Worker tests remain unchanged.
Do not merge or push without user direction.
