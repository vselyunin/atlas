# Board instructions

Follow the root [workspace instructions](../../AGENTS.md). The Board owns React UI, keyboard interactions, and client state for the HTTP API. Use shared contracts for payloads, TanStack Query for server state, and the Board’s mocks for isolated UI work. Keep Worker credentials and server-side business rules out of the frontend. Verify observable behavior with Board tests and visual changes in a browser preview.
