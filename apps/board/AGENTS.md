# Board instructions

Follow the root [workspace instructions](../../AGENTS.md). The Board owns React UI, keyboard interactions, and client state for the HTTP API. Use shared contracts for payloads, TanStack Query for server state, and fixtures or mocks where appropriate for isolated UI work. Keep Worker credentials and server-side business rules out of the frontend. Verify observable behavior with Board tests and visual changes in a browser preview.

Every new or changed UI feature must support light and dark themes, including hover, focus, disabled, loading, empty, error and drag states. Use the shared semantic color variables in `src/styles.css`; keep palette values centralized rather than hardcoding colors in components. Define both theme values when adding a token. Portal menus and dialogs must inherit the root theme. Preserve the System default and saved browser preference through the shared theme store.

Inspect visual changes in both themes at desktop and narrow widths, including open menus/dialogs and keyboard focus. Follow the repository feature-verification skill for the checking procedure. Theme support is part of completing a UI feature, not a later optional polish step.
