# Atlas

Atlas is a local project and task board. The Board uses the API over HTTP, and a separately running Worker connects over WebSocket to initialize local Git repositories on request.

## Development

Use WSL with Git, Node 22 LTS (22.13 or newer) and pnpm 10.34.5.

```sh
nvm install
nvm use
corepack enable
pnpm install --frozen-lockfile
pnpm worker:login   # once, to log the agent in
pnpm dev
```

Open [Atlas](http://localhost:5173) in your Windows browser. `pnpm dev` needs Docker in WSL: it starts the Board and API natively and the Worker in a Docker container, generates a local worker token, and preserves data in the ignored `.atlas/` folder. Run `pnpm worker:login` once before the first session so the agent is logged in. For Board or API work without Docker, `pnpm dev:web` starts only the Board and API. No environment file is required for the default local setup. Ctrl+C stops all three apps. See [local setup](docs/development/local-setup.md) for Docker and the agent sandbox.

Create a project using an existing Git URL or a new local repository, select a version, and add tasks to Backlog. Drag cards between columns or change status in task details. Assignments only record responsibility.

`pnpm check` runs lint, formatting checks, TypeScript checks, unit/integration tests and production builds. `pnpm test:e2e` runs browser acceptance tests with isolated temporary data after installing Playwright Chromium (`pnpm exec playwright install chromium`). The browser also needs its platform runtime libraries.

See [local setup](docs/development/local-setup.md) for configuration and independent app startup. Node apps provide `start` scripts for their built output. Existing tests require permission to modify; mandatory TDD is not used.

`pnpm --filter @atlas/<package> <command>` runs an individual package command. Build `@atlas/contracts` first when working against its workspace exports.

See the [development conventions](docs/development/conventions.md) and [approved design](docs/superpowers/specs/2026-11-19-atlas-local-mvp-design.md).
