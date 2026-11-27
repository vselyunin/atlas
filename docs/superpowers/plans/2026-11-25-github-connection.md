# GitHub Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an Atlas installation one GitHub App that signs people in and
lets the API hand a Worker a one-hour, one-repository token to clone a
repository into a new project.

**Architecture:** The API owns the App's secrets in a file outside every
workspace, runs setup and sign-in, keeps sessions in SQLite and refuses every
`/api/v1` route without a session unless the route is marked otherwise. A
project links to a repository through its own resource. A new
`repository.clone` command carries no credential; the Worker asks for one over
the socket when it is about to fetch, and the API grants it once per dispatch on
the dispatching connection.

**Tech Stack:** TypeScript, Node 22, Fastify 5, `@fastify/cookie` (new), Node
`crypto` for the App JWT and hashes, SQLite with drizzle, zod 4, React with
TanStack Query, vitest, Git over HTTPS.

**Spec:** `docs/superpowers/specs/2026-11-25-github-connection-design.md`. Read
it first; this plan argues from it and does not repeat its reasons.

## Global Constraints

- Run every command in WSL from the repository root. Never use Windows Git.
- Existing tests are protected: anything under `apps/*/tests/`,
  `packages/contracts/tests/`, `tests/`, `scripts/e2e-server.mjs`,
  `playwright.config.ts` and vitest configuration. Do not edit, move, skip or
  reformat them. The one permitted change is adding the line
  `ATLAS_AUTH: 'off',` to the `env` object in `scripts/e2e-server.mjs`
  (Task 3). If any other change seems necessary, stop and ask the user, naming
  the file, the exact change and the reason. New test files and new support
  files are fine.
- Everything new on `buildApp` options and on `WorkerConfig` input is optional,
  so existing test literals keep type-checking.
- `buildApp` without an `auth` option runs with sign-in off and behaves exactly
  as today.
- No GitHub token, App secret, `state`, code or owner code is written to the
  database, the Worker journal, a Git config, a command line or a log line.
- No test talks to github.com. Tests use the stand-ins from Tasks 4 and 13.
- Never mount or delete the Docker volume `atlas-agent-home`.
- App rights: Contents read and write, Pull requests read and write, Metadata
  read. Not Workflows. Not public. Webhooks inactive. No events.
- Sessions: 30 days from last use. Setup `state`: one hour, single use.
- Roles: exactly `owner` and `member`; one owner.
- Use read-only checks: `pnpm lint`, `pnpm format:check`. Format only files you
  created or changed in production code, with
  `pnpm exec prettier --write <file>`.
- After touching `packages/contracts`, run
  `pnpm --filter @atlas/contracts build` before other packages' checks.
- Commit after each task with a Conventional Commit; scopes are `board`, `api`,
  `worker`, `contracts`, `repo`. End messages with
  `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. Never amend. Do
  not push.
- Do not build pushing, pull requests, hosting, webhooks or per-Worker tokens.

## Names fixed by this plan

Later tasks rely on these. The spec left them to the builder.

| Thing                              | Value                                                     |
| ---------------------------------- | --------------------------------------------------------- |
| API setting: sign-in mode          | `ATLAS_AUTH` = `github` (default) or `off`                |
| API setting: App file              | `ATLAS_GITHUB_APP_FILE`, default `.atlas/github-app.json` |
| API setting: GitHub REST address   | `ATLAS_GITHUB_API_URL`, default `https://api.github.com`  |
| API setting: GitHub web address    | `ATLAS_GITHUB_WEB_URL`, default `https://github.com`      |
| Worker setting: Git host           | `ATLAS_GIT_HOST_URL`, default `https://github.com`        |
| Session cookie                     | `atlas_session`                                           |
| Setup `state` cookie               | `atlas_setup_state`                                       |
| Setup mark cookie                  | `atlas_setup_mark`                                        |
| Sign-in `state` and PKCE cookie    | `atlas_signin`, 10 minutes                                |
| Capability                         | `repository.clone`                                        |
| Journal stage                      | `cloned`                                                  |
| Credential grant window            | 15 minutes after dispatch                                 |
| Worker wait for a credential reply | 30 seconds                                                |
| Board session socket recheck       | every 30 seconds                                          |
| GitHub request timeout             | 10 seconds                                                |
| Git fetch time limit               | 30 minutes                                                |
| Setup URL registered on the App    | `<Board origin>/?github=installed`                        |

HTTP endpoints, all under `/api/v1`. "Access" is the route's `config.access`
value from Task 3.

| Method and path                           | Access    | Purpose                               |
| ----------------------------------------- | --------- | ------------------------------------- |
| `GET /auth/state`                         | `public`  | What the Board should show            |
| `GET /auth/github/start`                  | `public`  | Redirect to GitHub's authorize page   |
| `GET /auth/github/callback`               | `public`  | Finish sign-in, redirect to the Board |
| `POST /auth/sign-out`                     | `public`  | Delete the session                    |
| `POST /setup/github/start`                | `setup`   | Returns the manifest form to post     |
| `GET /setup/github/callback`              | `setup`   | Exchange the code, write the App file |
| `POST /setup/owner-code`                  | `setup`   | Trade the owner code for a setup mark |
| `GET /members`                            | `session` | List members                          |
| `POST /members`                           | `owner`   | Add a member by GitHub login          |
| `DELETE /members/:userId`                 | `owner`   | Remove a member and their sessions    |
| `GET /github/connection`                  | `session` | App name, owning account, manage link |
| `GET /github/repositories`                | `session` | Repositories the App can access       |
| `GET /projects/:projectId/github-link`    | `session` | The link and whether it is accessible |
| `POST /projects/:projectId/github-link`   | `session` | Link `{ repositoryId }`               |
| `DELETE /projects/:projectId/github-link` | `session` | Remove the link                       |

`DELETE` requests carry the body `{}` with a JSON content type, because the
existing request hook requires JSON for `DELETE`. Add `DELETE` to the CORS
method list in `apps/api/src/app.ts`.

## Review Focus

Conditions the spec implies but does not spell out. Each has a test in the
named task.

1. The person cancels on GitHub, so a callback arrives with `error=` and no
   code. Expected: a redirect to the Board with a readable message and nothing
   stored; never a 500. (Tasks 5 and 6)
2. GitHub is slow, unreachable, rate limited or answers 5xx during sign-in,
   listing or minting a token. Expected: the request ends within the timeout
   with a clear error; the API does not hang or crash. (Task 4)
3. The App can access more than one page of repositories. Expected: the list
   and the access check see all of them. (Task 4)
4. The App file exists but is unreadable or not valid, or the App was deleted
   on GitHub. Expected: an unreadable file stops the API at start with a
   message that names the file; a deleted App makes sign-in and GitHub features
   fail with a message while existing sessions keep working. (Tasks 4 and 6)
5. The repository to clone is empty. Expected: the clone succeeds with an
   empty checkout, as `repository.init` does, and a session can start on it.
   (Task 13)

Also pinned: member logins match without regard to letter case (Task 6).

---

## Part 1: Sign-in and setup

### Task 1: Live checks against GitHub

Needs the user at a browser. No product code. Do not start Task 5 before this
is done, because two answers change it.

**Files:**

- Create: `scripts/github-live-check.mjs` (throwaway helper; delete it at the
  end of this task, do not commit it)
- Modify: `docs/superpowers/specs/2026-11-25-github-connection-design.md`
  ("What was checked, and what was not")

- [ ] **Step 1:** Write the helper: a loopback HTTP server on port 5173 that
      serves a page with the manifest form from the spec's "The GitHub App"
      (name `Atlas-check-<4 random chars>`, `public: false`, no `hook_attributes`,
      the three repository rights, `redirect_url`, `callback_urls` and
      `setup_url` on `http://localhost:5173`), receives the redirect, exchanges
      the code at `POST /app-manifests/{code}/conversions`, and keeps the result
      in memory only. It prints outcomes, never secrets.
- [ ] **Step 2:** Ask the user to open the page and create the App. Record:
      check 1 (were `http://localhost` addresses accepted) and check 2 (was the
      App created with no webhook section; if GitHub refused, retry with
      `hook_attributes: { url: "https://example.invalid", active: false }`).
- [ ] **Step 3:** Ask the user to install the App on one test repository, then
      to open the sign-in link the helper shows while signed in to GitHub as a
      second account, if they have one. Record check 3: who could sign in.
- [ ] **Step 4:** In the helper, mint an installation token, call
      `DELETE /installation/token` with it, then call
      `GET /installation/repositories` with it. Record check 4: the status of
      both calls.
- [ ] **Step 5:** Check 5 is noted for the push iteration only: write "not
      tested this iteration" unless the user wants it run now.
- [ ] **Step 6:** Ask the user to delete the check App on GitHub. Delete the
      helper. Write the five results, dated, into the spec section, replacing
      "Not settled by the documentation" wording for each settled item.
- [ ] **Step 7:** If check 1 failed, stop and tell the user that Task 5 will
      build the manual registration fallback from the spec instead of the
      manifest flow, and confirm before going on. If check 2 needed a reachable
      webhook address, stop and raise it with the user.
- [ ] **Step 8:** Commit: `docs(repo): record the live GitHub checks`.

### Task 2: Contracts for sign-in, members and GitHub resources

**Files:**

- Create: `packages/contracts/src/auth.ts`, `packages/contracts/src/github.ts`
- Modify: `packages/contracts/src/index.ts` (export both)
- Test: `packages/contracts/tests/auth.test.ts`,
  `packages/contracts/tests/github.test.ts` (new files)

**Interfaces:**

- Produces, all strict objects with inferred types of the same name without
  `Schema`:
  - `UserRoleSchema = z.enum(['owner', 'member'])`
  - `UserSchema`: `{ id, login, name: string | null, avatarUrl: string | null, role }`
  - `AuthStateResponseSchema`:
    `{ auth: 'off' | 'github', setup: 'not_needed' | 'needed' | 'needs_owner' | 'done', user: User | null, app: { name, account, installUrl: url } | null }`.
    `not_needed` goes with `auth: 'off'`; `needs_owner` means the App file
    exists and the database has no owner. `app` is set once the App file
    exists, so the setup page can confirm the created App before anyone is
    signed in.
  - `SetupStartSchema`: `{ organization?: string }` (GitHub login pattern
    `^[A-Za-z0-9-]{1,39}$`)
  - `SetupStartResponseSchema`: `{ action: url, manifest: string }`. The
    Board posts a form to `action` with the field `manifest`. `action` already
    carries `state` in its query string.
  - `OwnerCodeSchema`: `{ code: string }`
  - `MemberSchema`: `{ id, login, name: string | null, role, signedIn: boolean }`
  - `MemberListResponseSchema`: `{ items: Member[] }`;
    `MemberCreateSchema`: `{ login }`; `MemberResponseSchema`: `{ member }`
  - `GithubConnectionResponseSchema`:
    `{ connection: { name, slug, account, manageUrl: url, installUrl: url } }`
  - `GithubRepositorySchema`:
    `{ id: positive int, fullName: 'owner/name' pattern, private: boolean, defaultBranch: string }`
  - `GithubRepositoryListResponseSchema`: `{ items: GithubRepository[] }`
  - `GithubLinkSchema`:
    `{ projectId, repositoryId, fullName, defaultBranch, accessible: boolean, createdAt }`
  - `GithubLinkResponseSchema`: `{ link: GithubLink | null }`;
    `GithubLinkCreateSchema`: `{ repositoryId: positive int }`
  - `GithubFullNameSchema`: `^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$`

- [ ] **Step 1:** Write tests: each schema accepts one valid value and rejects
      an unknown key; `GithubFullNameSchema` rejects `a/b/c`, `a`, `a/b c` and
      `https://github.com/a/b`; `SetupStartSchema` rejects `organization: 'a b'`;
      `GithubLinkCreateSchema` rejects `0` and `1.5`.
- [ ] **Step 2:** Run `pnpm --filter @atlas/contracts test`. Expected: the new
      files fail on missing exports.
- [ ] **Step 3:** Implement the schemas.
- [ ] **Step 4:** Run `pnpm --filter @atlas/contracts test && pnpm --filter @atlas/contracts build`.
      Expected: pass, existing contract tests included.
- [ ] **Step 5:** Commit: `feat(contracts): add sign-in, member and GitHub link shapes`.

### Task 3: The sign-in switch, route access rule and state endpoint

After this task, sign-in on means every route is refused except the listed
ones. Nobody can sign in yet.

**Files:**

- Create: `apps/api/src/auth/access.ts`, `apps/api/src/auth/routes.ts`,
  `apps/api/src/auth/sessions.ts`, `apps/api/drizzle/0001_github.sql`
- Modify: `apps/api/src/config.ts`, `apps/api/src/app.ts`,
  `apps/api/src/server.ts`, `apps/api/src/db/schema.ts`,
  `apps/api/drizzle/meta/_journal.json`, `apps/api/package.json`
  (`@fastify/cookie`), `apps/api/src/sessions/routes.ts`,
  `apps/api/src/workers/gateway.ts`, `scripts/dev.mjs`,
  `scripts/e2e-server.mjs` (the one permitted line)
- Test: `apps/api/tests/auth-switch.test.ts`,
  `apps/api/tests/route-protection.test.ts`,
  `apps/api/tests/support/auth-app.ts` (new files)

**Interfaces:**

- Produces:
  - `ApiOptions.auth?: AuthOptions` where
    `AuthOptions = { appFile: string; githubApiUrl?: string; githubWebUrl?: string; ownerCodeSink?: (code: string) => void }`.
    Absent means sign-in off. `ownerCodeSink` defaults to writing one line to
    the process output; tests pass their own.
  - `readConfig(env)` returns `auth: AuthOptions | undefined`: `undefined` for
    `ATLAS_AUTH=off`, options for `github` or unset; any other value, the empty
    string included, throws.
  - Fastify route config: `config: { access: 'public' | 'setup' | 'worker' | 'owner' }`.
    A route with no `access` requires a session. Declare the type by
    augmenting `FastifyContextConfig`.
  - `request.user: User | null`, set by the access hook.
  - `app.routeList: { method: string; url: string; access: string }[]`, a
    Fastify decoration filled from an `onRoute` hook.
  - `SessionStore` in `auth/sessions.ts`:
    `create(userId: string): string` (returns the raw ID; stores only its
    SHA-256), `find(rawId: string): User | null` (null when older than 30 days
    since last use or the user no longer exists; refreshes last use at most
    once an hour), `delete(rawId: string): void`,
    `deleteForUser(userId: string): void`,
    `onUserRemoved(listener: (userId: string) => void): void`.
  - Tables in `0001_github.sql` and `schema.ts`:
    `users(id pk, githubId integer unique null, login text not null, name text, avatarUrl text, role text not null, createdAt text not null)`
    with a unique index on `lower(login)`;
    `authSessions(idHash pk, userId not null references users on delete cascade, createdAt, lastUsedAt)`;
    `installation(key pk, value text not null)` for the setup mark hash and
    owner code hash; nullable `createdBy` on `projects` and `tasks`;
    `kind text not null default 'repository.init'` on `operations`;
    `githubLinks(projectId pk references projects, repositoryId integer not null, fullName text not null, defaultBranch text not null, createdBy text, createdAt text not null)`.
    Write all of it in this one migration so later tasks add no migration.
  - `tests/support/auth-app.ts`: `buildAuthApp(overrides?)` returning
    `{ app, appFile, directory, ownerCodes: string[], close() }` with sign-in on
    and a temporary App file path; `signIn(app, user)` is added in Task 6.

- [ ] **Step 1: Write `auth-switch.test.ts`.** `readConfig` with
      `ATLAS_AUTH` unset gives `auth` defined; `'off'` gives `undefined`;
      `''`, `'OFF'` and `'none'` throw. `buildApp` without `auth`:
      `GET /api/v1/projects` is 200 and `GET /api/v1/auth/state` is
      `{ auth: 'off', setup: 'not_needed', user: null }`. With `auth` and no App
      file: `GET /api/v1/auth/state` is
      `{ auth: 'github', setup: 'needed', user: null }`.
- [ ] **Step 2: Write `route-protection.test.ts`.** Build with sign-in on and
      an App file present (write one by hand in the `AppSecrets` shape of Task 4). For every
      entry of `app.routeList` whose access is not `public`, `setup` or
      `worker`, inject the request with no cookie, substituting `x` for each
      path parameter and sending `{}` as JSON for methods with a body, and
      expect status 401 with error code `sign_in_required`. Assert the list has
      more than ten entries, so an empty list cannot pass. Assert every
      `public`, `setup` and `worker` route is one of the rows with that
      access value in this plan's endpoint table or the Worker socket, so a
      route cannot be opened up without this list changing.
      Websocket: connecting to `/api/v1/tasks/x/session` with the right
      `Origin` and no cookie is refused at upgrade; the Worker socket with its
      token and no cookie registers.
- [ ] **Step 3:** Run `pnpm --filter @atlas/api test`. Expected: the two new
      files fail; existing files pass.
- [ ] **Step 4: Implement.** Register `@fastify/cookie`. In `access.ts`, one
      `onRequest` hook, added after the existing host and origin hook, that
      does nothing when sign-in is off and otherwise: lets `public` and
      `worker` through; for every other route loads `request.user` from the
      `atlas_session` cookie; refuses with 401 `sign_in_required` when a
      session is required and absent; refuses `owner` routes for members with
      403 `owner_required`; while the App file is absent refuses everything
      except `public`, `setup` and `worker` with 409 `setup_required`. `setup`
      routes apply the rule from the spec's "Setup": open while the database
      has no owner, the owner's session required once it has one. Mark the
      Worker socket `worker`. Give the Board session socket no access value,
      so it needs a session at upgrade. `GET /auth/state` is `public`.
- [ ] **Step 5:** `server.ts` passes `auth` from `readConfig` through, and its
      catch block also reports an invalid `ATLAS_AUTH`. `scripts/dev.mjs`
      resolves `ATLAS_GITHUB_APP_FILE` from the repository root the way it
      resolves `ATLAS_DB_PATH`. Add `ATLAS_AUTH: 'off',` to
      `scripts/e2e-server.mjs`.
- [ ] **Step 6:** Run `pnpm --filter @atlas/api test && pnpm test:integration`.
      Expected: all pass. If an existing test fails, fix production code; do
      not touch the test.
- [ ] **Step 7:** Commit: `feat(api): require a session unless a route says otherwise`.

### Task 4: GitHub client, App file and the GitHub stand-in

**Files:**

- Create: `apps/api/src/github/client.ts`, `apps/api/src/github/app-file.ts`,
  `apps/api/src/github/jwt.ts`
- Test: `apps/api/tests/github-client.test.ts`,
  `apps/api/tests/app-file.test.ts`,
  `apps/api/tests/support/github-stand-in.ts` (new files)

**Interfaces:**

- Produces:
  - `AppSecrets = { appId: number; slug: string; name: string; account: string; clientId: string; clientSecret: string; privateKey: string }`
  - `AppFile` in `app-file.ts`: `constructor(path: string)`,
    `read(): AppSecrets | null` (null when the file does not exist; throws
    `Error('GitHub App file is not readable: <path>')` when it exists but does
    not parse), `write(secrets: AppSecrets): void` (creates with mode `0o600`
    through a temporary file and rename; refuses to replace an existing file),
    `isUnder(directory: string): boolean`.
  - `GitHubClient` in `client.ts`:
    `constructor(options: { apiUrl: string; webUrl: string; fetch?: typeof fetch })`
    with methods, each throwing `GitHubError` (`status: number | null`,
    `code: 'unreachable' | 'timeout' | 'rate_limited' | 'unauthorized' | 'not_found' | 'failed'`):
    - `convertManifest(code: string): Promise<AppSecrets & { ownerLogin: string }>`
    - `describeApp(secrets: AppSecrets): Promise<{ id: number; slug: string; name: string; account: string; public: boolean; permissions: Record<string, string>; events: string[] }>`
      (public is derived from an unauthenticated `GET /apps/{slug}`: 200 means
      public)
    - `authorizeUrl(secrets, params: { state: string; codeChallenge: string; redirectUri: string }): string`
    - `exchangeUserCode(secrets, params: { code: string; codeVerifier: string; redirectUri: string }): Promise<string>`
    - `getUser(userToken: string): Promise<{ id: number; login: string; name: string | null; avatarUrl: string | null }>`
    - `revokeUserToken(secrets, userToken: string): Promise<void>` (failure is
      swallowed)
    - `listRepositories(secrets): Promise<GithubRepository[]>` (every
      installation of the App, every page)
    - `findInstallation(secrets, fullName: string): Promise<{ installationId: number; repository: GithubRepository } | null>`
      (`GET /repos/{owner}/{repo}/installation` with the App JWT; null on 404)
    - `getRepositoryById(secrets, repositoryId: number): Promise<{ installationId: number; repository: GithubRepository } | null>`
    - `mintToken(secrets, params: { installationId: number; repositoryId: number; permissions: { contents: 'read' | 'write' } }): Promise<{ token: string; expiresAt: string }>`
    - `revokeToken(token: string): Promise<boolean>`
  - `appJwt(secrets, now: Date): string` in `jwt.ts`: RS256, `iss` the App ID,
    `iat` 60 seconds back, `exp` 9 minutes ahead, signed with Node `crypto`.
  - `startGithubStandIn()` in the support file: a loopback HTTP server that
    implements the endpoints above, verifies the App JWT against a key pair it
    generates, and returns
    `{ apiUrl, webUrl, secrets: AppSecrets, state, close() }` where `state` is a
    mutable object the test edits: `users` by code, `repositories`,
    `appPublic`, `appPermissions`, `manifestCodes`, `failWith`
    (`null | 500 | 403 | 'hang'`), and `requests: { method, path, body, authorization }[]`
    recording everything received.

- [ ] **Step 1: Write the tests.** `app-file.test.ts`: `write` then `stat`
      shows mode `0600`; `read` of a missing file is null; a file containing
      `{` throws an error whose message contains the path; `write` over an
      existing file throws. `github-client.test.ts` against the stand-in:
      `mintToken` sends `repository_ids: [id]` and
      `permissions: { contents: 'read' }` and nothing wider; `listRepositories`
      returns 250 repositories when the stand-in serves 100 per page;
      `failWith: 500` gives `code: 'failed'`; `failWith: 403` with a
      `x-ratelimit-remaining: 0` header gives `rate_limited`; `failWith: 'hang'`
      rejects with `timeout` within the 10-second limit (construct the client
      with a short limit for the test); a stand-in that is closed gives
      `unreachable`; `describeApp` reports `public: true` when the stand-in
      says so; a JWT signed by another key is refused by the stand-in.
- [ ] **Step 2:** Run `pnpm --filter @atlas/api test`. Expected: new files fail.
- [ ] **Step 3:** Implement the three modules. No secret appears in a thrown
      message.
- [ ] **Step 4:** Run `pnpm --filter @atlas/api test`. Expected: pass.
- [ ] **Step 5:** Commit: `feat(api): add the GitHub client and the App file`.

### Task 5: Setup

If live check 1 failed, build the spec's manual registration fallback here
instead of the manifest exchange: `POST /setup/github/start` returns the
values to type on GitHub, and a `POST /setup/github/manual` (`setup` access)
takes the App ID, client ID, client secret and key text. Everything from
"verify the App" onward is the same.

**Files:**

- Create: `apps/api/src/setup/service.ts`, `apps/api/src/setup/routes.ts`,
  `apps/api/src/setup/manifest.ts`
- Modify: `apps/api/src/app.ts` (register; refuse to start when the App file
  lies under a registered Worker's workspace root or does not parse; keep the
  two callbacks' query strings out of the request log)
- Test: `apps/api/tests/setup.test.ts` (new)

**Interfaces:**

- Consumes: `AppFile`, `GitHubClient`, `SessionStore`, `AuthOptions`,
  `SetupStartSchema`, `SetupStartResponseSchema`, `OwnerCodeSchema`.
- Produces:
  - `buildManifest(boardOrigin: string, name: string): object` with exactly
    the settings in the spec's "The GitHub App".
  - `SetupService`: `start(organization?: string): { response: SetupStartResponse; cookie: string }`,
    `finish(params: { code?: string; state?: string; error?: string; cookie?: string }): Promise<{ redirect: string; mark?: string }>`,
    `redeemOwnerCode(code: string): string | null` (returns a new mark),
    `hasMark(rawMark: string | undefined): boolean`,
    `clearOwnerSecrets(): void` (called when an owner is created).
  - Redirects after the callback go to `<Board origin>/?setup=created` or
    `<Board origin>/?setup=failed&reason=<code>` with `reason` one of
    `cancelled`, `state_invalid`, `app_public`, `app_rights`, `github_failed`.

- [ ] **Step 1: Write `setup.test.ts`** with the stand-in. The callback is
      refused (`state_invalid`, nothing written) when: the `atlas_setup_state`
      cookie is missing; the `state` was never issued; the `state` was already
      used; the clock is one hour and one second past `start`. It is refused
      with `app_public` when the stand-in's App is public and with `app_rights`
      when its permissions are not exactly
      `{ contents: 'write', pull_requests: 'write', metadata: 'read' }` or it
      has events. A callback with `error=access_denied` redirects with
      `reason=cancelled`. A good callback writes the file with mode `0600`,
      sets `atlas_setup_mark` as `HttpOnly`, and `GET /auth/state` then says
      `needs_owner`. With an owner in the database, every setup endpoint
      without that owner's session is 401, and with a member's session 403.
      The manifest posted to GitHub has `public: false`, no `hook_attributes`
      (or the inactive one, per live check 2), no `default_events`, and the
      three rights. With the App file present and no owner, building the app
      calls `ownerCodeSink` once with a code; `POST /setup/owner-code` with
      that code sets a mark cookie and a second use of the code fails; a wrong
      code fails. Capture the Fastify log with a stream and assert that no
      line contains the code, the `state`, the client secret or the key.
      `buildApp` throws when `appFile` is under a registered Worker's
      `workspaceRoot`, and throws with the file's path when the file is not
      valid.
- [ ] **Step 2:** Run the file. Expected: fail.
- [ ] **Step 3:** Implement. `state` values live in memory with their issue
      time. The mark and the owner code are random 32-byte values; only their
      SHA-256 goes in the `installation` table; comparisons use
      `timingSafeEqual`. The owner code is created at start only while the App
      file exists and no owner does.
- [ ] **Step 4:** Run `pnpm --filter @atlas/api test`. Expected: pass,
      `route-protection.test.ts` included.
- [ ] **Step 5:** Commit: `feat(api): create the GitHub App from the setup page`.

### Task 6: Sign-in, owner, members and socket checks

**Files:**

- Create: `apps/api/src/auth/signin.ts`, `apps/api/src/auth/members.ts`
- Modify: `apps/api/src/auth/routes.ts`, `apps/api/src/sessions/routes.ts`,
  `apps/api/src/sessions/hub.ts`, `apps/api/src/projects/service.ts` and
  `apps/api/src/tasks/service.ts` (record `createdBy` from `request.user`;
  optional parameter, not exposed in responses),
  `apps/api/tests/support/auth-app.ts` (new in Task 3, so editable)
- Test: `apps/api/tests/signin.test.ts`, `apps/api/tests/members.test.ts`,
  `apps/api/tests/session-socket-auth.test.ts` (new)

**Interfaces:**

- Consumes: `GitHubClient`, `SessionStore`, `SetupService.hasMark`,
  `SetupService.clearOwnerSecrets`.
- Produces:
  - Sign-in redirects end at `<Board origin>/` on success and at
    `<Board origin>/?signin=failed&reason=<code>&login=<login>` otherwise, with
    `reason` one of `cancelled`, `state_invalid`, `no_access`, `github_failed`.
    `login` is present only for `no_access`.
  - `signIn(app, user: { id: number; login: string }): Promise<string>` in the
    test support file, returning the `Cookie` header value for a session,
    driving the real routes through the stand-in.
  - `SessionHub.closeForUser(userId: string): void` and a per-socket recheck
    every 30 seconds that closes the socket with code 4401 when its session is
    gone. The interval comes from an optional `buildApp` option
    `sessionRecheckMs` so a test can shorten it.

- [ ] **Step 1: Write `signin.test.ts`.** `start` sets `atlas_signin` and
      redirects to the stand-in with `code_challenge_method=S256`, a `state`,
      and `redirect_uri` equal to `<origin>/api/v1/auth/github/callback`. The
      callback with a different `state`, with no cookie, or replayed after
      success gives `state_invalid`. The stand-in received the matching
      `code_verifier`. After success: the `atlas_session` cookie is `HttpOnly`,
      `SameSite=Lax`, has no `Secure` on an `http` origin and has it when the
      app is built with an `https` loopback origin; the database holds no
      column equal to the raw session ID or the GitHub token; two sign-ins
      give two different IDs. With the setup mark and no owner the user
      becomes `owner` and the mark stops working; without the mark the result
      is `no_access` and no owner exists. A second account is `no_access` and
      the redirect names its login. `error=access_denied` gives `cancelled`.
      With `failWith: 500` on the stand-in the result is `github_failed` and
      existing sessions still pass `GET /projects`. A session unused for 30
      days and one second is refused; one used on day 29 works on day 40
      (inject `now`). `POST /auth/sign-out` deletes the session; a `GET` to
      that path is 404.
- [ ] **Step 2: Write `members.test.ts`.** The owner adds `Octo-Cat`; the
      account `octo-cat` with ID 7 signs in and is bound; an account with the
      same login and ID 8 is then `no_access`; adding `octo-cat` again is 409;
      a member calling `POST /members` is 403; removing the member makes their
      next request 401; the owner cannot be removed (409).
- [ ] **Step 3: Write `session-socket-auth.test.ts`.** A signed-in socket to a
      task's session route opens; removing that member closes it at once;
      deleting the session row directly closes it within the shortened recheck
      interval.
- [ ] **Step 4:** Run the three files. Expected: fail.
- [ ] **Step 5:** Implement.
- [ ] **Step 6:** Run `pnpm --filter @atlas/api test && pnpm test:integration`.
      Expected: pass.
- [ ] **Step 7:** Commit: `feat(api): sign in with GitHub and manage members`.

### Task 7: Board pages for setup, sign-in and members

**Files:**

- Create: `apps/board/src/features/auth/AuthGate.tsx`,
  `apps/board/src/features/auth/SetupPage.tsx`,
  `apps/board/src/features/auth/SignInPage.tsx`,
  `apps/board/src/features/auth/UserMenu.tsx`,
  `apps/board/src/features/auth/SettingsDialog.tsx`,
  `apps/board/src/lib/auth.ts`
- Modify: `apps/board/src/main.tsx` (wrap `App` in `AuthGate`),
  `apps/board/src/features/layout/BoardHeader.tsx` (optional `user` slot prop;
  existing tests render the header without it), `apps/board/src/lib/api.ts`
  (on 401 `sign_in_required`, invalidate the auth state query),
  `apps/board/src/styles.css`
- Test: `apps/board/tests/auth-gate.test.tsx`,
  `apps/board/tests/settings-dialog.test.tsx` (new)

**Interfaces:**

- Consumes: the schemas from Task 2 and the endpoints in the table.
- Produces: `useAuthState()` in `lib/auth.ts` (query key `['auth']`);
  `AuthGate` renders, by state: `needed` → `SetupPage`; `needs_owner` →
  `SetupPage` at its "install and sign in" step with the owner code field;
  `done` with no user → `SignInPage`; `done` with a user → children;
  `auth: 'off'` → children plus the notice.

- [ ] **Step 1: Write `auth-gate.test.tsx`**, stubbing `fetch`. One test per
      row above. The setup page shows the three "one account" rules before the
      start button. The sign-in page with `?signin=failed&reason=no_access&login=other`
      shows that `other` has no access. The off notice has the text
      "Sign-in is off" and `role="status"`.
- [ ] **Step 2: Write `settings-dialog.test.tsx`.** An owner sees the member
      list with add and remove; a member sees the connection and no member
      controls.
- [ ] **Step 3:** Run `pnpm --filter @atlas/board test`. Expected: new files
      fail.
- [ ] **Step 4:** Implement, following the Board's existing dialog and button
      patterns. The setup page builds a form with the `manifest` field and
      posts it to `action`. Sign-in is a plain link to
      `/api/v1/auth/github/start`. Sign-out posts `{}`. Place the off notice
      where it does not move the header or the columns, because the browser
      tests run with sign-in off.
- [ ] **Step 5:** Run `pnpm --filter @atlas/board test && pnpm test:e2e`.
      Expected: pass. If a browser test fails because of the notice, change the
      notice, not the test.
- [ ] **Step 6:** Commit: `feat(board): add setup, sign-in and member pages`.

### Task 8: Documentation for Part 1 and a manual check

**Files:**

- Modify: `docs/development/local-setup.md`, `docs/development/protocol.md`,
  `docs/development/acceptance.md`, `AGENTS.md`, `.env.example`,
  `apps/api/.env.example`

- [ ] **Step 1:** Write the sections the spec's "Documentation" lists that
      concern sign-in, setup, the settings from "Names fixed by this plan", the
      App file, removal, and the known limits.
- [ ] **Step 2:** Run `pnpm check`. Expected: pass.
- [ ] **Step 3:** With the user: `pnpm dev:web`, create the App from the setup
      page, install it on one repository, sign in, add and remove a member if a
      second account exists. Report what was seen. This is a manual check, not
      an independent review.
- [ ] **Step 4:** Commit: `docs(repo): document GitHub sign-in and setup`.

---

## Part 2: Linking a project to a repository

### Task 9: Repositories and links in the API

**Files:**

- Create: `apps/api/src/github/links.ts`, `apps/api/src/github/routes.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/tests/github-links.test.ts` (new)

**Interfaces:**

- Consumes: `GitHubClient`, `AppFile`, `githubLinks` table, Task 2 schemas.
- Produces: `LinkService` with
  `get(projectId: string): Promise<GithubLink | null>` (asks GitHub whether the
  repository ID is still covered; `accessible: false` when not, and also when
  GitHub cannot be reached),
  `create(projectId: string, repositoryId: number, userId: string | null): Promise<GithubLink>`,
  `remove(projectId: string): void`,
  `stored(projectId: string): { repositoryId: number; fullName: string; defaultBranch: string } | null`
  (no GitHub call; Task 11 uses it).
  With sign-in off, all GitHub routes answer 409 `github_unavailable`.

- [ ] **Step 1: Write the test.** Listing returns the stand-in's repositories.
      Linking a ready `local` project stores ID, full name and default branch
      and returns 201. Linking is refused: 404 for an unknown project; 409
      `project_not_linkable` for an `existing` project or one that is not
      ready; 409 `already_linked` for a second link; 403
      `repository_not_accessible` for an ID the App does not cover. After the
      stand-in drops the repository, `GET` shows `accessible: false`. After the
      stand-in renames it, `GET` still shows the stored name and
      `accessible: true`. `DELETE` removes it and a second `DELETE` is 404. The
      project returned by `GET /projects/:id` has exactly the keys it has
      today.
- [ ] **Step 2:** Run the file. Expected: fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm --filter @atlas/api test`. Expected: pass.
- [ ] **Step 5:** Commit: `feat(api): link a project to a GitHub repository`.

### Task 10: Board link controls

**Files:**

- Create: `apps/board/src/features/projects/GithubLink.tsx`,
  `apps/board/src/features/projects/RepositoryPicker.tsx`
- Modify: `apps/board/src/features/auth/SettingsDialog.tsx` (host the link
  panel for the selected project), `apps/board/src/lib/queries.ts`
- Test: `apps/board/tests/github-link.test.tsx` (new)

**Interfaces:**

- Produces: `RepositoryPicker({ value, onChange })`, reused in Task 15;
  `useGithubRepositories()` and `useGithubLink(projectId)` in `queries.ts`.

- [ ] **Step 1: Write the test:** no link shows the picker and a "Link" button
      plus a link to `installUrl` labelled as the place to change which
      repositories Atlas can reach; a link shows `owner/name` with "Unlink"; an
      inaccessible link shows a message that the App can no longer reach the
      repository; with sign-in off the panel is not rendered.
- [ ] **Step 2:** Run. Expected: fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm --filter @atlas/board test`. Expected: pass.
- [ ] **Step 5:** Commit: `feat(board): link and unlink a GitHub repository`.

---

## Part 3: Cloning with a handed-over credential

### Task 11: Project path rule and a clean environment for `git init`

Independent of GitHub; fixes two things the review found in today's code.

**Files:**

- Modify: `apps/worker/src/repositories/paths.ts`,
  `apps/worker/src/repositories/initialize.ts`,
  `apps/api/src/projects/service.ts`
- Test: `apps/worker/tests/project-paths.test.ts`,
  `apps/api/tests/project-paths.test.ts` (new)

**Interfaces:**

- Consumes: `childEnvironment(root)` from `apps/worker/src/sessions/worktree.ts`.
  Move it to a new `apps/worker/src/git-environment.ts` and re-export it from
  `worktree.ts` so existing imports keep working.

- [ ] **Step 1: Write the tests.** Worker: `resolveTarget(root, '.atlas-worktrees/x/y')`
      and `resolveTarget(root, '.hidden')` reject; `'a/.b'` is accepted.
      `initializeRepository` with `git` set to a fixture script that writes its
      environment to a file: the file has no name starting with `ATLAS_`, with
      `ATLAS_WORKER_TOKEN` set in the test process. API: creating a `local`
      project with `relativePath: '.atlas-worktrees/x'` is 400
      `invalid_relative_path`.
- [ ] **Step 2:** Run `pnpm --filter @atlas/worker test && pnpm --filter @atlas/api test`.
      Expected: new tests fail.
- [ ] **Step 3:** Implement. Pass `env: childEnvironment(context.root)` to both
      `execFile` calls in `initialize.ts`.
- [ ] **Step 4:** Run both packages' tests. Expected: pass. If an existing
      test uses a dot-prefixed project path, stop and ask the user.
- [ ] **Step 5:** Commit: `fix(worker): refuse dot-prefixed project paths and clean the Git environment`.

### Task 12: Protocol contracts for clone and credentials

**Files:**

- Modify: `packages/contracts/src/workers.ts`,
  `packages/contracts/src/protocol.ts`, `packages/contracts/src/projects.ts`,
  `packages/contracts/src/fixtures.ts` (add fixtures; do not change existing
  ones), `docs/development/protocol.md`
- Test: `packages/contracts/tests/clone-protocol.test.ts` (new)

**Interfaces:**

- Produces:
  - `REPOSITORY_CLONE_CAPABILITY = 'repository.clone'`; a third accepted
    capability tuple `[init, session, clone]`.
  - `RepositoryInitCommandSchema` stays exported and unchanged.
  - `RepositoryCloneCommandSchema`: same envelope and `type`, payload
    `{ kind: 'repository.clone', projectId, relativePath, repository: GithubFullName }`.
  - `CommandDispatchSchema`: one `command.dispatch` message whose payload is a
    discriminated union on `kind` of the two payloads. Type
    `RepositoryCloneCommand` for the clone form. It replaces
    `RepositoryInitCommandSchema` inside `ApiToWorkerMessageSchema`. Type
    `CommandDispatch`.
  - `CredentialRequestSchema` (Worker to API): `type: 'credential.request'`,
    `commandId`, empty payload.
  - `CredentialGrantSchema` (API to Worker): `type: 'credential.grant'`,
    `commandId`, payload `{ token: string, expiresAt: timestamp, repository: GithubFullName }`.
  - `CredentialRefusalSchema` (API to Worker): `type: 'credential.refusal'`,
    `commandId`, payload `ErrorInfo`.
  - `CREDENTIAL_GRANT_WINDOW_MS = 900_000`,
    `CREDENTIAL_REPLY_TIMEOUT_MS = 30_000`.
  - `ProjectCreateSchema`'s `local` form gains optional
    `githubRepositoryId: positive int`. `RepositorySchema` and `ProjectSchema`
    do not gain it: define the create form as its own extension so the stored
    shape is unchanged.

- [ ] **Step 1: Write the test:** an init dispatch and a clone dispatch both
      parse through `ApiToWorkerMessageSchema`; a clone payload with a token
      field, or with `repository: 'https://github.com/a/b'`, is rejected; the
      three credential messages parse in their direction and are rejected in
      the other; the three capability tuples are accepted and
      `['repository.init', 'repository.clone']` is not; `ProjectSchema` rejects
      a repository with `githubRepositoryId`; `ProjectCreateSchema` accepts it
      on `local` and rejects it on `existing`.
- [ ] **Step 2:** Run. Expected: fail.
- [ ] **Step 3:** Implement. In `protocol.md` document the messages, the
      command, the capability, and both directions of old and new: an older
      API refuses a newer Worker's registration; a newer API accepts an older
      Worker and never sends it a clone.
- [ ] **Step 4:** Run `pnpm --filter @atlas/contracts test && pnpm --filter @atlas/contracts build && pnpm typecheck`.
      Expected: contract tests pass. If the API or Worker no longer
      type-checks where it handles `command.dispatch`, narrow on
      `payload.kind` there in this task and leave behavior unchanged: the
      Worker answers a clone with a `protocol.error` until Task 13.
- [ ] **Step 5:** Commit: `feat(contracts): add the clone command and credential messages`.

### Task 13: Worker clone and credential exchange

**Files:**

- Create: `apps/worker/src/repositories/clone.ts`,
  `apps/worker/src/repositories/credential.ts`,
  `apps/worker/src/repositories/git-credential-helper.sh`
- Modify: `apps/worker/src/state/journal.ts`, `apps/worker/src/connection.ts`,
  `apps/worker/src/config.ts`, `scripts/worker-container.mjs` (add
  `ATLAS_GIT_HOST_URL` to the optional variables), `docker/worker/Dockerfile`
  only if the helper script is not copied by the existing build
- Test: `apps/worker/tests/clone.test.ts`,
  `apps/worker/tests/clone-journal.test.ts`,
  `apps/worker/tests/git-host-config.test.ts`,
  `apps/worker/tests/support/git-server.ts`,
  `apps/worker/tests/fixtures/journal-before-clone.json` (new)

**Interfaces:**

- Consumes: `CommandDispatch`, the credential schemas, `childEnvironment`,
  `resolveTarget`.
- Produces:
  - `WorkerConfig.gitHostUrl: string`, optional on input, default
    `https://github.com`. `prepareConfig` throws when it is `http` and its host
    is not a loopback address.
  - Journal: `command` accepts either command; `stage` gains `cloned`. The
    exported `JournalEntry` type becomes the union.
  - `CredentialRequester = (commandId: string, signal: AbortSignal) => Promise<{ token: string; expiresAt: string; repository: string }>`,
    rejecting with `CredentialRefused` (`code`, `message`) or
    `CredentialUnavailable` (timeout or dropped connection).
  - `cloneRepository(command: RepositoryCloneCommand, context: ExecutionContext & { gitHostUrl: string; requestCredential: CredentialRequester; signal: AbortSignal }): Promise<CommandOutcome>`.
  - In `connection.ts`: dispatch chooses by `payload.kind`; the Worker
    registers the three capabilities; pending credential requests are a map by
    command ID, rejected with `CredentialUnavailable` on close and after 30
    seconds; `stop()` aborts the running clone before awaiting the queue.
  - `startGitServer(options: { token: string })` in the support file: serves
    bare repositories through `git http-backend` as CGI behind Basic auth
    (`x-access-token` and the token), on loopback HTTP, returning
    `{ url, addRepository(fullName, files?), requests, close() }`.

Order of work inside `cloneRepository`, each a decision the tests pin:

1. Validate, resolve the target with the init path rules, journal `queued`,
   call `onAccepted`.
2. Create the folder, journal `created` with its identity, `git init` there.
3. Request the credential. On refusal, the outcome is `failed` with the
   refusal's message. On no reply, `needs_attention`. If `repository` in the
   grant differs from the command's, `failed` with code `repository_renamed`,
   and Git is not run against the network.
4. Fetch in one Git process whose environment is `childEnvironment` plus the
   token in one variable read by the helper script. That process gets, as
   command-line configuration: an emptied helper list followed by the helper;
   redirects off; only the `https` protocol allowed (plus `http` when the
   configured host is loopback); no submodule recursion; no tags beyond those
   reachable; terminal prompts off; the user-level config pointed at
   `/dev/null`; LFS smudge skipped. The helper answers only when the host Git
   asks about equals the configured host.
5. A second Git process without the token sets `origin` to the address with no
   credential and checks out the default branch with hooks disabled. An empty
   repository skips the checkout.
6. Journal `cloned`, then `finished` with the outcome.

Recovery: an entry for a clone with no outcome and a stage other than `cloned`
gives `needs_attention` with the existing `recovery_uncertain` message. At
`cloned`, apply the same identity checks as init and report success.

- [ ] **Step 1: Write `clone-journal.test.ts`.** The fixture file, a journal
      entry in today's shape, parses. A clone entry round-trips. A clone entry
      at `created` with a folder that passes init's recovery test recovers as
      `needs_attention`, not `succeeded`. One at `cloned` recovers as
      `succeeded`.
- [ ] **Step 2: Write `git-host-config.test.ts`.** `http://127.0.0.1:9` and
      `https://example.com` are accepted; `http://example.com` throws.
- [ ] **Step 3: Write `clone.test.ts`** against the Git server. A clone with a
      granted token produces the files, and afterwards: the token appears in
      no file under the target, in no journal file, and not in
      `git remote get-url origin`; the arguments of every Git process (use a
      wrapper script as `context.git` that logs arguments and environment
      names to a file, then runs real Git) never contain it; the checkout
      process has no variable holding it. An empty repository succeeds with an
      empty checkout. A grant naming another repository gives
      `repository_renamed` and the server saw no request. A refusal gives
      `failed` with the refusal's message. A requester that never answers
      gives `needs_attention` after the timeout (shortened through the
      context). Aborting the signal during a fetch from a server that stalls
      ends the Git process and returns within two seconds, and re-dispatching
      the command gives `needs_attention`. An existing target folder gives
      `failed` and is left untouched. A wrong token gives `failed` and the
      message does not contain the token. A target of `.x/y` gives `failed`.
- [ ] **Step 4:** Run `pnpm --filter @atlas/worker test`. Expected: new files
      fail.
- [ ] **Step 5:** Implement.
- [ ] **Step 6:** Run `pnpm --filter @atlas/worker test && pnpm test:integration`.
      Expected: pass. `tests/integration/worker-container.test.ts` checks the
      container arguments; if it fails on the new variable, stop and ask the
      user.
- [ ] **Step 7:** Check the image's Git version against known clone flaws
      (`docker run --rm atlas-worker:dev git --version`) and record the finding
      in `docker/worker/README.md`; if it is affected, raise it with the user
      before changing the image.
- [ ] **Step 8:** Commit: `feat(worker): clone a repository with a requested credential`.

### Task 14: API clone dispatch and the credential broker

**Files:**

- Create: `apps/api/src/github/credentials.ts`
- Modify: `apps/api/src/operations/service.ts`,
  `apps/api/src/projects/service.ts`, `apps/api/src/projects/routes.ts`,
  `apps/api/src/workers/gateway.ts`, `apps/api/src/workers/registry.ts`,
  `apps/api/src/app.ts`
- Test: `apps/api/tests/clone-dispatch.test.ts`,
  `apps/api/tests/credentials.test.ts` (new)

**Interfaces:**

- Consumes: `LinkService.stored`, `GitHubClient.getRepositoryById`,
  `mintToken`, `revokeToken`, the protocol schemas, `operations.kind`.
- Produces:
  - `WorkerRegistry.socketOf(workerId: string): WebSocket | undefined`.
  - `CredentialBroker`:
    `noteDispatch(commandId: string, socket: WebSocket): void`,
    `request(commandId: string, workerId: string, socket: WebSocket): Promise<CredentialGrant['payload']>`
    throwing `ApiError` with one of the codes `unknown_command`,
    `command_finished`, `wrong_kind`, `wrong_connection`, `already_granted`,
    `grant_window_closed`, `repository_not_accessible`, `github_unavailable`,
    `app_file_exposed` (the App file lies under a registered Worker's
    workspace root);
    `release(commandId: string): Promise<void>` (revokes and forgets; called
    on result and when the window closes).
  - `createProject` accepts `githubRepositoryId`: checks the Worker has
    `repository.clone`, confirms the repository with GitHub before the
    transaction, strips the field from the stored repository, inserts the
    operation with `kind: 'repository.clone'` and the link row in the same
    transaction. It becomes async for this path only; keep the existing paths
    synchronous inside.
  - `dispatchPending` sends by `operations.kind`; for a clone it sends the
    stored `fullName` and calls `broker.noteDispatch`.

- [ ] **Step 1: Write `clone-dispatch.test.ts`**, with a fake Worker socket as
      the existing gateway tests do (write a new helper; do not edit theirs).
      Creating a project with `githubRepositoryId` on a Worker that registered
      two capabilities is 503 `worker_unavailable`; on one with three it is 202
      and the Worker receives `kind: 'repository.clone'` with the repository's
      full name and no other field beyond `projectId` and `relativePath`; the
      project is a `local` project with a link; an ID the App cannot access is
      403 and no project row exists; with sign-in off it is 409
      `github_unavailable`; an init project still receives
      `kind: 'repository.init'`; `GET /operations/:id` has exactly the keys it
      has today. A succeeded result makes the project ready.
- [ ] **Step 2: Write `credentials.test.ts`.** A request on the dispatching
      connection gets a grant, and the stand-in's token request carried one
      repository ID and `{ contents: 'read' }`. Each refusal code above is
      produced by its case: unknown ID; a finished command; an init command; a
      second connection registered under another Worker ID asking for the
      first one's command; a second request after a grant; a request 15
      minutes and one second after dispatch (inject `now`); a Worker registered
      with a workspace root that contains the App file. After a reconnect
      and re-dispatch, a new request is granted. On `command.result` the
      stand-in receives the revocation. Capture the log: one line per grant
      and per refusal naming command, Worker, repository and rights; no line
      contains the token. The grant's `repository` is the current name after a
      rename at the stand-in.
- [ ] **Step 3:** Run. Expected: fail.
- [ ] **Step 4:** Implement. A refusal is sent as `credential.refusal`, not as
      `protocol.error`. If live check 4 showed revocation is not possible,
      `release` only forgets, and say so in `protocol.md`.
- [ ] **Step 5:** Run `pnpm --filter @atlas/api test && pnpm test:integration`.
      Expected: pass.
- [ ] **Step 6:** Commit: `feat(api): dispatch clones and grant one-repository credentials`.

### Task 15: Board clone choice

**Files:**

- Modify: `apps/board/src/features/projects/CreateProjectDialog.tsx`,
  `apps/board/src/features/projects/ProjectProvisioning.tsx`
- Test: `apps/board/tests/create-project-clone.test.tsx` (new)

- [ ] **Step 1: Write the test:** with sign-in on, the dialog offers a third
      choice, "Clone from GitHub", showing `RepositoryPicker`, the Worker
      select limited to Workers with `repository.clone`, and the folder field
      prefilled with the repository's name; submitting posts `mode: 'local'`
      with `githubRepositoryId`; with sign-in off the choice is absent; a
      pending clone's provisioning view says it is cloning and names the
      repository.
- [ ] **Step 2:** Run. Expected: fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm --filter @atlas/board test && pnpm test:e2e`.
      Expected: pass.
- [ ] **Step 5:** Commit: `feat(board): create a project by cloning from GitHub`.

### Task 16: End-to-end tests across API and Worker

**Files:**

- Test: `tests/integration/github-clone.test.ts`,
  `tests/docker/credential-isolation.test.ts`,
  `tests/docker/fixtures/environment-probe.mjs` (new)

- [ ] **Step 1: Write the integration test.** Start the GitHub stand-in, the
      Git server and a real API with sign-in on, and a real Worker through
      `startWorker` with `gitHostUrl` pointing at the Git server. Sign in
      through the stand-in, create a project by cloning, wait for it to be
      ready, check the files are there, start a session on it with the
      existing stand-in agent and see it start. Then stop the Worker during a
      second, stalled clone and assert `stop()` resolves within five seconds
      and the project is `needs_attention` after the Worker starts again.
- [ ] **Step 2: Write the Docker test**, following `tests/docker/sandbox.test.ts`
      and its support file without editing them: inside the sandbox the probe
      tries to read `/proc/<pid>/environ` for the Worker and for a long-running
      process the Worker started with a marker variable, and to list the
      Worker state directory; all are refused, and the marker value never
      appears in the probe's output.
- [ ] **Step 3:** Run `pnpm test:integration` and `pnpm test:docker`. Expected:
      pass. A failure here is a product defect; fix the product.
- [ ] **Step 4:** Check the 30-second worktree limit with the user's real
      workspace: clone a real repository through `pnpm dev`, start a session,
      and raise the limit in `apps/worker/src/sessions/worktree.ts` only if it
      was hit. Report the measured time.
- [ ] **Step 5:** Commit: `test(repo): cover cloning and credential isolation end to end`.

### Task 17: Documentation, acceptance and the full check

**Files:**

- Modify: `docs/development/local-setup.md`, `docs/development/protocol.md`,
  `docs/development/acceptance.md`, `docker/worker/README.md`, `AGENTS.md`,
  `.env.example`

- [ ] **Step 1:** Complete the spec's "Documentation" list for linking, cloning
      and credentials, and add the manual checks from the spec's "Tests" to
      `acceptance.md`.
- [ ] **Step 2:** Run `pnpm check` and `pnpm test:docker` and `pnpm test:e2e`.
      Expected: pass.
- [ ] **Step 3:** With the user, on the real GitHub: link a project, clone a
      private repository, confirm on GitHub that the App has only the expected
      rights, and see a second GitHub account refused.
- [ ] **Step 4:** Request an independent review of the whole branch
      (`superpowers:requesting-code-review`). Fix what it finds. In the report,
      keep self-review and independent review apart.
- [ ] **Step 5:** Commit: `docs(repo): document GitHub linking and cloning`.

## What this plan does not build

Listed in the spec under "What the push iteration needs" and "Non-goals":
pushing a task branch, opening a pull request, hosting, webhooks, a token per
Worker, creating repositories, transferring ownership.
