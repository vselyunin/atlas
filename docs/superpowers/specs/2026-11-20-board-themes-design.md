# Board themes and compact layout

Status: written design approved by the user on 2026-11-20.

## Intent and scope

Give Atlas a neutral dark theme and more usable board space. Support light and
dark appearance throughout the current UI and make both themes a requirement for
future UI features. This is a Board change; API, Worker, task rules and shared
contracts remain unchanged.

## Approaches

The user chose shared semantic theme colors over component-specific dark-mode
overrides. Named CSS variables for backgrounds, surfaces, text, borders, focus,
actions and semantic statuses provide central light/dark definitions. Overrides
would be quicker initially but make future components easier to miss.

## Approved visual direction

- Neutral black/gray dark backgrounds, gray surfaces and borders, readable text.
  Retain restrained semantic colors for task types, statuses and priorities.
- One compact header: brand, project menu, version menu, Worker availability,
  New task and circular user avatar. Align controls vertically with consistent
  heights, spacing and dropdown chevrons.
- Remove the large Project board heading, subtitle, separate toolbar and board
  metadata strip. Let the board occupy the area directly below the header.
- Project and version menus put their creation action first, followed by a
  divider and existing entries. Highlight selected entries without check icons.
- The avatar dropdown contains user identity and a compact Appearance selector.
  Choices are System, Light and Dark, with no explanatory helper message.
- Cards lead with title and description. Their footer contains the assignee and
  task type beside priority. Priority is text without the mockup's bar symbol.
- Preserve drag handles, keyboard interactions and existing creation/editing
  flows. New task still creates only in Backlog.

The accepted visual reference is the compact-board-polished mockup under
`.superpowers/brainstorm/26964-1795170767/content/`. It contains sample data and
is not production code; this document is the tracked specification.

## Theme behavior

Default to System when no valid preference is stored. In System mode, follow
device theme changes while the app is open. Light and Dark override that choice
until the user selects System again. Remember the choice in this browser using
local storage; do not add an API preference or sync requirement.

Implementation choices: apply the resolved theme at the document root so portal
dialogs and menus inherit it. Initialize before the first visible render to avoid
a flash of the wrong theme. Set native control color scheme and browser theme
color consistently. Handle unavailable storage without preventing startup or
in-session switching; ignore invalid stored values. Use light as the fallback
when system preference detection is unavailable.

## Reusable UI and layout

Centralize shared menu styling and behavior, using accessible primitives rather
than treating creation actions as selectable project/version values. Support
keyboard navigation, visible focus, Escape dismissal and appropriate focus
return after menus/dialogs close. Retain disabled and empty-state behavior when
no project or version is ready.

Cover all surfaces, including forms, dialogs, dropdowns, loading/empty/error
states, disabled controls and drag feedback. Ensure readable contrast in both
themes and do not rely on color alone to communicate state. On narrow screens,
preserve access to header actions and horizontal board scrolling; allow the
single header container to wrap if necessary, without restoring the large title
area. Exact responsive thresholds and primitive selection are builder choices.

## Future UI requirement

Update `apps/board/AGENTS.md` to require shared semantic colors and support for
both themes in every new or changed UI feature, including interaction states.
Extend the existing feature-verification skill to include light/dark browser
inspection for visual work. Keep stable policy in Board instructions and the
verification procedure in the skill, without creating another theme skill.

## Verification and constraints

Verify System default and live changes, persisted overrides, returning to System,
startup behavior and storage failure handling. Check menu creation actions,
avatar appearance controls, task card layout and existing drag/edit flows.
Inspect both themes at desktop and narrow widths, including open menus/dialogs.
Run applicable Board checks and browser acceptance, then the repository check.

There is no mandatory TDD. Add useful new tests. Existing tests, helpers and
configuration remain protected: moving creation controls into menus will likely
require changes to existing browser interactions. Identify the exact files and
changes and obtain permission before editing them; design approval does not
authorize unspecified test modifications. Preserve assertions of business rules.

No task automation, terminal integration, backend changes, user accounts or
unrelated redesign is included.
