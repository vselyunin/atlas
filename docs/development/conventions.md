# Development conventions

Use TypeScript with strict mode and `noUncheckedIndexedAccess`. Use ESM and `import type` for type-only dependencies. In NodeNext projects use the emitted `.js` extension in relative ESM imports. Prefer named exports, explicit public API types, small focused modules, PascalCase React components and descriptive camelCase functions and variables.

Validate external HTTP, WebSocket and configuration values at runtime. Derive contract types from schemas. Handle optional and nullable values explicitly. Use validation or narrowing in place of non-null assertions. Explain justified suppressions and avoid `any`. Keep changes focused on the relevant behavior.

Prettier applies two spaces, single quotes, semicolons, trailing commas where supported and a 100-character print width. Run `pnpm format --list` to inspect default write targets. The formatter protects tests, snapshots and fixtures in write mode and still checks their formatting in read-only mode. ESLint checks project code with type information. See the root [agent instructions](../../AGENTS.md) for the existing-test permission rule.

Use `type(scope): short imperative summary` for commits. Allowed types are `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `build`, `ci`, `style`, and `perf`. Allowed scopes are `board`, `api`, `worker`, `contracts`, and `repo`.

- `feat(board): add backlog task creation`
- `fix(worker): preserve repository on retry`
- `docs(api): describe worker registration`

Describe material reasons in the commit body when relevant. Run `pnpm check:commits -- <base>` to check commits after a base revision or provide `<base>..<tip>` for an explicit range.
