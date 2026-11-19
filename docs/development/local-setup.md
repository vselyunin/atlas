# Run Atlas locally

Run commands inside WSL from the Atlas repository. Use the Node version in
`.nvmrc`, pnpm version in `package.json`, and Git available on PATH.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://localhost:5173> in your Windows browser. The combined launcher builds
shared contracts and starts the API, Worker and Board. It generates a local Worker
token if one is not configured, without printing it. The API listens on port 4310.
The Worker reconnects if it starts before the API is ready.

Default local state is in the ignored `.atlas/` directory:

- `atlas.sqlite`: projects, versions, tasks and operations.
- `projects/`: new project repositories created by the Worker.
- `worker/`: Worker lock and durable command journal.
- `worker-token`: secret shared by the local API and Worker.

Ctrl+C stops all services; it does not erase data or repositories. Restart with
`pnpm dev`. Do not run two copies of the same Worker identity/state directory.

## Configuration

Optionally copy `.env.example` to `.env` and customize values. The combined
launcher resolves relative database/workspace/state paths from the repository
root. Worker state must remain outside project repository targets. A new local
repository path is relative to the displayed workspace; its parent must already
exist and the final folder must not exist. Existing Git URL mode only records a
URL and never clones it.

For independently started apps, export the same `ATLAS_WORKER_TOKEN` to API and
Worker, use absolute filesystem paths, and run:

```sh
pnpm --filter @atlas/contracts build
pnpm --filter @atlas/api dev
pnpm --filter @atlas/worker dev
pnpm --filter @atlas/board dev
```

Use three terminals for these commands. Package-specific `.env` files can hold
the independent settings; the combined launcher reads the repository-root `.env`.
Never put the Worker token into Vite/browser environment variables.

All services are local-only. If Windows cannot reach WSL localhost forwarding,
check the Windows/WSL networking configuration; do not expose the API on all
interfaces as a workaround.

## Checks and test protection

`pnpm check` runs lint, formatting checks, type checks, tests and builds.
`pnpm format` formats unprotected source; it does not modify tests, snapshots or
fixtures. `pnpm format:check` still checks those files. Any existing-test change
requires explicit permission, including fixes suggested by a formatter.

Use Conventional Commits such as `feat(board): add task creation` and validate a
commit range with `pnpm check:commits -- <base-commit>`.
