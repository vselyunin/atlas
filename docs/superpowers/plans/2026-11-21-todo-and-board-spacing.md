# To do creation, editing and compact columns

Implement the user's six browser annotations:

- Remove empty-column placeholder messages.
- Show the large Add task action only in empty Backlog/To do columns; retain header plus actions in both columns.
- Create directly in the selected column. Header New task defaults to Backlog.
- Permit all field edits in To do as well as Backlog, enforced by the API. Working remains description-only; Done remains read-only.
- Preserve the current column when changing versions, append to that destination column and compact the source ordering.
- Reduce card content padding to 10px; share an inset, vertically centered chevron across task form selects in both themes.

The optional creation status is backward-compatible for callers omitting it. Board and API require coordinated deployment; older API validators reject the added request field. No persisted schema or Worker protocol changes are needed. See the protocol document.

The user approved updating API and Board field-lock expectations in the two existing test files. A new browser scenario verifies To do creation/editing, empty actions, ordering across versions and rejection of Working/Done creation.

Verification: full `pnpm check` and all ten browser scenarios passed. Independent static review found no actionable issues. Implementer visual inspection covered both themes and narrow layout; all five task-form chevrons were vertically centered with a 12px right inset. The preview was restarted with its existing data to load the updated API.
