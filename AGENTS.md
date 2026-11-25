# Atlas workspace instructions

Atlas is a local pnpm workspace with three independently runnable TypeScript apps. The approved design and implementation plans are in `docs/superpowers/`.

- `apps/board` owns user interactions. It sends HTTP requests to the API.
- `apps/api` owns HTTP, SQLite and application rules. It dispatches repository commands over a persistent WebSocket.
- `apps/worker` connects to the API as a WebSocket client. It owns local command execution, filesystem checks and its command journal.
- `packages/contracts` owns shared runtime schemas and inferred TypeScript types. Apps import publicly exported contracts.

Run local commands in WSL. Open the Board in a Windows browser. Use Linux paths for Worker operations.

Review shared contract changes with consumers before making them. Document changes to protocol behavior or compatibility, update the respective validators and fixtures in coordination with consumers, and check affected packages plus their integration. Keep app ownership boundaries clear and run the full check before declaring shared work complete.

Use `pnpm dev` for the local stack (the Worker runs in a Docker container), `pnpm dev:web` for the API and Board without a Worker, `pnpm worker:login` for the one-time agent login, `pnpm test:docker` for the Docker tests (not part of `check`) and `pnpm --filter @atlas/<package> <command>` for a package. Root commands are `lint`, `format`, `format:check`, `typecheck`, `test`, `build`, `check`, and `check:commits -- <base>`. Use `pnpm format --list` to inspect the default formatter’s write targets first. The shared configs and [development conventions](docs/development/conventions.md) govern source and commit style.

There is no mandatory TDD. Add useful new tests as needed. Existing tests require explicit user permission to modify. This includes deleting, skipping or disabling tests, weakening assertions, updating snapshots or expected fixtures, and changing configuration to exclude or bypass coverage. Identify the affected files, exact changes, and why they are necessary when requesting permission. A failure alone provides no authorization. Fix production behavior where appropriate and report remaining test failures.

Use read-only lint and format checks. Keep protected tests out of default formatting writes and avoid blanket lint autofix. Commit the finished changes for each user request without waiting to be asked. Before a commit, review the diff and confirm applicable checks. Never amend or rewrite history without authorization.

Test protection also covers startup helpers, test configuration and syntax-only or formatting changes. Permission applies only to the specific files and changes approved; reuse that permission without asking again, but do not extend it to unrelated edits.

When reporting verification, distinguish self-review from independent review. If independent review is unavailable, say so and identify what was actually checked.

Sign-in with GitHub is on by default (`ATLAS_AUTH=github`; `off` disables it, and `buildApp` without an `auth` option runs with it off). Tests never talk to github.com; they use local stand-ins, with `ATLAS_GITHUB_API_URL` and `ATLAS_GITHUB_WEB_URL` pointing at them. The GitHub App's secrets live in `.atlas/github-app.json` (`ATLAS_GITHUB_APP_FILE`), created with mode `0600`. It is a secret: never commit, print, log or copy it into a workspace root, Worker state directory or container. Setup, sessions, members and removal are described in [local setup](docs/development/local-setup.md); routes and access rules are in [protocol](docs/development/protocol.md).

Repository links and clones: the API hands a Worker a short-lived, one-repository, read-only token for a clone over the Worker socket. It belongs to the API and the Worker's Git processes and must never reach the database, the journal, a Git config, a command line, a log or a task agent. Tests clone from the local stand-in Git server, with `ATLAS_GIT_HOST_URL` (Worker; default `https://github.com`) pointing at it. A project path whose first part starts with a dot is refused. Behaviour and limits are in [local setup](docs/development/local-setup.md).

Repository skills provide focused workflows without replacing these rules:

- [Atlas contract changes](.agents/skills/atlas-contract-changes/SKILL.md): shared schemas, HTTP/Worker messages and compatibility across consumers.
- [Atlas feature verification](.agents/skills/atlas-feature-verification/SKILL.md): selecting checks, isolating runtime tests and reporting evidence.
