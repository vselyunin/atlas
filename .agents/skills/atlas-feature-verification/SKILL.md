---
name: atlas-feature-verification
description: Use when verifying an Atlas feature or fix across Board, API and Worker, choosing regression checks, or preparing a completion report.
---

# Atlas feature verification

Work from the repository root. Read `AGENTS.md` for test permissions and
`docs/development/local-setup.md` for runtime setup. Use the current package
scripts rather than copying temporary commands from an earlier session.

## Select evidence for the change

Trace the user-visible behavior to its owning apps and choose relevant checks:

| Change                              | Useful evidence                                                       |
| ----------------------------------- | --------------------------------------------------------------------- |
| Documentation or skills only        | Formatting, links, referenced commands and skill validation           |
| Shared schema or protocol           | Contracts and affected consumers, real integration, full `pnpm check` |
| API business rules                  | API tests, persistence/error paths, full check for shared behavior    |
| Worker execution or reconnect       | Temporary filesystem tests and real API/Worker integration            |
| Board interaction or cross-app flow | Board tests and browser acceptance for the affected workflow          |

Build contracts first when running package tests directly. `pnpm check` includes
lint, formatting, TypeScript, package/integration tests and builds; it does not
include browser tests. Run `pnpm test:e2e` when browser acceptance is needed.
Do not run application suites for prose-only changes without a relevant reason.

## Keep runtime checks isolated

Use the existing browser startup helper through `pnpm test:e2e`. It allocates
temporary data and separate ports. Read the helper and Playwright config before
assuming their current settings. Do not use the personal `.atlas` database,
repository root or Worker journal for automated acceptance tests.

For a new harness, require API readiness and the intended registered Worker to
be online before opening the Board. An available Board page alone is insufficient.
Use bounded waits, surface startup errors, and clean up owned child processes and
temporary state on success, failure and interruption. Never kill unrelated dev
servers or delete personal data to free a port.

For command/recovery changes, exercise reconnect or duplicate delivery and check
that work is not repeated. For optimistic UI changes, verify rejected actions
restore the displayed state. Choose scenarios relevant to the change rather
than adding a fixed checklist to every task.

## Verify themed UI changes

Follow `apps/board/AGENTS.md` for the theme-support policy. Inspect the affected
workflow in light and dark modes, including open portal menus/dialogs, keyboard
focus, hover, disabled controls and relevant loading/error/empty states. Check a
narrow viewport and long labels as well as the desktop layout. Confirm new
semantic color tokens have both palette values.

When theme behavior changes, exercise System with live device preference changes,
manual overrides, reload persistence and returning to System. Check that blocked
browser storage does not prevent startup or in-session switching. Use the actual
appearance control for acceptance; setting storage directly alone does not prove
the user interaction works.

## Handle failures and report honestly

Distinguish an application failure from unavailable browser libraries, occupied
ports or other environment blockers. Follow the root test-permission rule for
helpers, configuration, formatting and assertions alike. A failing check grants
no permission to change a test; previously granted permission remains valid only
for its stated scope.

Report commands actually run, outcomes and unverified behavior. An earlier green
run does not verify later code changes. Once applicable checks pass, repeat them
only for new changes or unresolved concerns. If independent review is unavailable,
state that explicitly and distinguish self-review from independent review.
