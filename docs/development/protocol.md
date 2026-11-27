# Atlas HTTP and Worker protocol

The API defaults to port 4310 and the Board to port 5173. HTTP uses `/api/v1` and returns JSON. The Worker connects to `/api/v1/workers/connect` over WebSocket. Both apps use runtime schemas from `@atlas/contracts`.

## HTTP

| Method | Path under `/api/v1`                                | Request body                                                    | Success body                                               |
| ------ | --------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------- |
| GET    | `/projects`                                         |                                                                 | `{items: Project[]}`                                       |
| GET    | `/projects/:projectId`                              |                                                                 | `{project: Project}`                                       |
| POST   | `/projects`                                         | `{name, repository}`                                            | `{project: Project, operation: Operation \| null}`         |
| GET    | `/projects/:projectId/versions`                     |                                                                 | `{items: Version[]}`                                       |
| POST   | `/projects/:projectId/versions`                     | `{name}`                                                        | `{version: Version}`                                       |
| GET    | `/workers`                                          |                                                                 | `{items: Worker[]}`                                        |
| GET    | `/projects/:projectId/versions/:versionId/tasks`    |                                                                 | `{items: Task[]}`                                          |
| GET    | `/projects/:projectId/versions/:versionId/sessions` |                                                                 | `{items: {taskId,status,reason,message,exitCode,since}[]}` |
| POST   | `/projects/:projectId/versions/:versionId/tasks`    | `{title, description?, type?, priority?, assigneeId?, status?}` | `{task: Task}`                                             |
| PATCH  | `/tasks/:taskId`                                    | `{expectedRevision, changes}`                                   | `{task: Task}`                                             |
| POST   | `/tasks/:taskId/move`                               | `{expectedRevision, status, beforeTaskId}`                      | `{task: Task}`                                             |
| GET    | `/operations/:operationId`                          |                                                                 | `{operation: Operation}`                                   |

Successful project creation returns 201 for an existing repository and 202 for local provisioning. Task and version creation return 201. The other successful HTTP routes return 200.

To create an existing-repository project, send this body to `POST /api/v1/projects`.

```json
{
  "name": "Atlas demo",
  "repository": { "mode": "existing", "gitUrl": "https://example.com/team/demo.git" }
}
```

The API accepts HTTPS, SSH and conventional `git@host:path` repository URLs. SSH allows a username. Supply authentication separately from the URL. Validation is syntactic and performs no network request.

To request local repository initialization, send this body to the same route.

```json
{
  "name": "Atlas demo",
  "repository": { "mode": "local", "workerId": "atlas:local", "relativePath": "demo" }
}
```

The 202 response contains an operation. Fetch it by ID to follow provisioning. `connectionLost` records a transport interruption independently of the execution outcome. A successful operation exposes its `result.localPath`. When a project creation response is lost, refresh the project list before offering another attempt. Clients never retry this POST automatically.

A relative path whose first part starts with a dot is refused: the API answers 400 `invalid_relative_path` and the Worker refuses it too, because `.atlas-worktrees` holds the task worktrees. This applies to every `local` project. Clients that sent such a path before now receive the 400; the `existing` form has no path and is unaffected.

Names and titles are trimmed and limited to 1–200 characters. Descriptions accept 0–100,000 characters. Relative paths accept 1–1,024 characters. IDs are opaque nonempty strings and timestamps are UTC ISO strings. Version names within a project are unique after trimming and compare case-sensitively.

### Task revisions and ordering

A new task starts at revision 1. Creation accepts optional status `backlog` or `todo`; omitted status defaults to Backlog. Working and Done cannot be creation destinations. The creation defaults are an empty description, type `task`, priority `medium`, and no assignee. The task status values are `backlog`, `todo`, `working`, and `done`.

The PATCH request changes at least one editable field. Supply the latest task revision as `expectedRevision`.

```json
{ "expectedRevision": 1, "changes": { "priority": "high", "assigneeId": "human:vladi" } }
```

All task fields are editable in Backlog and To do. Working permits description changes only; Done permits no field edits. Changing `versionId` appends the task to the same column in the target version and compacts the source column. Project association is immutable.

To append to a different column, send a move with a null anchor.

```json
{ "expectedRevision": 2, "status": "working", "beforeTaskId": null }
```

To insert before another task, pass its ID. The anchor must belong to the moved task's project and version and to the destination status. A missing or stale anchor returns 409. A self-anchor is a no-op after the revision check. A same-column no-op may retain its revision. The API serializes moves transactionally, compacts positions in affected columns, and increments revisions for changed tasks. Position is zero-based within project, version and status. Refetch affected task lists after mutations.

A move that changes a task's status to `working` from another status also starts the task's agent session once the move is committed; see [Start on move](#start-on-move). The move's response and status code do not depend on it.

The optional creation status extends the HTTP request only. Existing callers that omit it remain compatible; deploy the updated API before a Board that sends it, since older strict validators reject it. Persisted task rows and Worker messages are unchanged; no database migration or Worker protocol version change is needed.

### Errors

| Status | Meaning                                                                                              |
| ------ | ---------------------------------------------------------------------------------------------------- |
| 400    | Invalid input                                                                                        |
| 401    | No valid session while sign-in is on (`sign_in_required`)                                            |
| 403    | Forbidden state, origin or role, including `owner_required` and `owner_code_invalid`                 |
| 404    | Unknown entity                                                                                       |
| 409    | Revision conflict or other conflicting state, including duplicate version names and `setup_required` |
| 502    | GitHub did not answer as expected (`github_unavailable`)                                             |
| 503    | Worker unavailable                                                                                   |

Errors use an `{error:{code,message,details?}}` envelope. For example, a PATCH with no revision can return the schema validation error below.

```json
{
  "error": {
    "code": "invalid_input",
    "message": "Invalid input",
    "details": [{ "path": ["expectedRevision"], "code": "invalid_type" }]
  }
}
```

Map schema parsing failures to the public error envelope and keep internal stacks out of response bodies. Clients validate any optional details against an expected schema before displaying them and render them as text.

## Sign-in and setup

Sign-in is controlled by the API setting `ATLAS_AUTH`: `github` (default) or `off`; any other value stops the API at start. `buildApp` called from code without sign-in options runs with sign-in off. The server entry point always reads the setting. With sign-in off the API behaves as before this section existed: none of the routes below except `GET /auth/state` exist (they answer 404, `GET /github/connection` among them), and no route needs a session. `GET /auth/state` then answers `{auth:"off",setup:"not_needed",user:null,app:null}`. The repository and link routes in "Repository links" are the exception: they exist and answer 409 `github_unavailable`.

With sign-in on, every HTTP route and the Board session socket need a session, except routes marked `public`, `setup` or `worker` below. The session is the `atlas_session` cookie. Without one the API answers 401 `sign_in_required`. Until the GitHub App exists (the App file is missing), every route that needs a session answers 409 `setup_required`. The checks on `Host`, `Origin` and the JSON content type stay. Browsers must send `DELETE` requests with a JSON content type and the body `{}`; `DELETE` is in the CORS method list.

| Method | Path under `/api/v1`     | Access   | Body and answer                                                                                                                                              |
| ------ | ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/auth/state`            | `public` | `{auth:"off"\|"github",setup:"not_needed"\|"needed"\|"needs_owner"\|"reconnect"\|"done",user,app}`                                                           |
| GET    | `/auth/github/start`     | `public` | 303 to GitHub's authorize page; sets `atlas_signin` for 10 minutes                                                                                           |
| GET    | `/auth/github/callback`  | `public` | 303 to the Board; sets `atlas_session` after a successful sign-in                                                                                            |
| POST   | `/auth/sign-out`         | `public` | 204; deletes the session and clears the cookie                                                                                                               |
| POST   | `/setup/github/start`    | `setup`  | `{organization?}`, answers `{action,manifest}`, the form the Board posts to GitHub                                                                           |
| GET    | `/setup/github/callback` | `setup`  | 303 to the Board with the outcome; writes the App file                                                                                                       |
| POST   | `/setup/owner-code`      | `setup`  | `{code}`, answers 204 and sets `atlas_setup_mark` before an owner exists, `atlas_setup_reconnect` for a reconnect; 403 `owner_code_invalid` for a wrong code |
| GET    | `/github/connection`     | session  | `{connection:{name,slug,account,manageUrl,installUrl}}`, read from GitHub                                                                                    |
| GET    | `/members`               | session  | `{items: Member[]}`; a member is `{id,login,name,role,signedIn}`                                                                                             |
| POST   | `/members`               | `owner`  | `{login}`, answers 201 `{member}`; 409 `member_exists`                                                                                                       |
| DELETE | `/members/:userId`       | `owner`  | `{}`, answers 204; 404 `member_not_found`, 409 `owner_not_removable`                                                                                         |

`access` is the route's own setting. `public`: no session needed; the route reads the session itself when it needs one. `setup`: anyone while the database has no owner, the owner's session after that. The exception is a reconnect: while an owner exists and the App file is missing, a request with a valid `atlas_setup_reconnect` cookie may use every `setup` route, and `POST /setup/owner-code` is open to anyone while the code printed at start is unused. A reconnect never creates, replaces or changes the owner. `worker`: the Worker socket, which keeps its token check and ignores sessions. `owner`: the owner's session. A route with no value needs any session. The `user` in the auth state is `{id,login,name,avatarUrl,role}` or `null`. `setup` is `needed` while the App file is missing and this browser may run setup (no owner yet, the owner's session, or the reconnect cookie), and `reconnect` while an owner exists, the App file is missing and this browser may not run setup until it enters the owner code. `app` is `{name,account,installUrl}` or `null`; it is filled for a signed-in user, and during setup before an owner exists. A test lists every registered route with its access and checks that each refuses a request without a session, apart from these exceptions.

Cookies, all `HttpOnly` and `SameSite=Lax`, and `Secure` when the Board origin is `https`:

| Cookie                  | Holds                                                                                         | Lifetime                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `atlas_session`         | Random session ID; the database keeps only its hash                                           | 30 days from last use; the cookie is kept for 400 days so the browser does not drop a session in use |
| `atlas_signin`          | Sign-in `state` and PKCE verifier                                                             | 10 minutes                                                                                           |
| `atlas_setup_state`     | Binds a setup `state` to the browser                                                          | 1 hour                                                                                               |
| `atlas_setup_mark`      | Lets this browser's first sign-in become the owner                                            | 30 days; the API ends it with the owner                                                              |
| `atlas_setup_reconnect` | Lets this browser run setup while an owner exists and the App file is missing; path `/api/v1` | 1 day; the API ends it when the App file is written                                                  |

The two callbacks carry a code and `state` in their query string. The API omits that query string from its request log and answers every outcome with a redirect to the Board, reporting the result in the Board's address (`?setup=created`, `?setup=failed&reason=…`, `?signin=failed&reason=…&login=…`). A `state` works once and expires: one hour for setup, 10 minutes for sign-in. Pending values live in memory, so an API restart cancels them. Setup is refused with 409 `setup_done` while the App file exists.

The App file, its secrets and the one-time owner code never appear in a response or the log. The owner code is written only to the API's standard output at start. The API issues one at start while the App file exists and no owner does, and also while an owner exists and the App file is missing (a reconnect); the printed line says which. Only its hash is stored, and it works once.

Compatibility: `reconnect` is a new value of `setup` in `GET /auth/state`. The Board validates the auth state strictly, so an older Board shows an error in that state; update the Board together with the API.

### Board session socket and sessions

With sign-in on, the upgrade of `/api/v1/tasks/:taskId/session` needs a session in addition to the `Origin` check. The API checks the session again every 30 seconds while the socket is open, and at once on sign-out and on member removal. When the session has ended it closes the socket with code 4401.

### Repository links

These routes need a session and, like every route that talks to GitHub, answer 409 `setup_required` before the App exists. Any signed-in person, member or owner, can use them.

| Method | Path under `/api/v1`               | Body and answer                                                                                        |
| ------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| GET    | `/github/repositories`             | `{items:{id,fullName,private,defaultBranch}[]}`, the repositories the App can access, read from GitHub |
| GET    | `/projects/:projectId/github-link` | `{link: null \| {projectId,repositoryId,fullName,defaultBranch,accessible,createdAt}}`                 |
| POST   | `/projects/:projectId/github-link` | `{repositoryId}`, answers 201 `{link}`                                                                 |
| DELETE | `/projects/:projectId/github-link` | `{}`, answers 204                                                                                      |

Errors:

| Status and code                 | When                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 404 `project_not_found`         | The project does not exist                                                                                                |
| 409 `project_not_linkable`      | Link: the project is not a `local` project in state `ready`. Unlink: the project's clone is still `pending` or `accepted` |
| 409 `already_linked`            | The project already has a link; unlink it first                                                                           |
| 403 `repository_not_accessible` | Link: GitHub says the App cannot access that repository                                                                   |
| 404 `link_not_found`            | Unlink: the project has no link                                                                                           |
| 409 `setup_required`            | The App file does not exist                                                                                               |
| 409 `github_unavailable`        | Sign-in is off                                                                                                            |
| 502 `github_unavailable`        | GitHub failed or did not answer within 10 seconds                                                                         |

A project has at most one link, but one repository can be linked to several projects. Linking stores the repository's ID, its `owner/name` and its default branch as GitHub reported them then, and the person who linked it. It sends nothing to a Worker and does not check that the repository's history matches the project's. `accessible` is asked of GitHub on every `GET`: `false` means the App no longer covers the repository (it was removed from the App's selection, or the App was replaced) or that GitHub could not be reached just now; this `GET` never answers 502. The stored name and branch are not refreshed.

### Compatibility

This part adds routes and a requirement. It changes no Worker message, capability or stored project shape. The Worker socket does not use sessions. A Board built before this change cannot sign in, so with sign-in on its requests fail with 401 or 409; deploy the Board with the API, or run the API with `ATLAS_AUTH=off`. Existing tests call the API with sign-in off, so they are unchanged.

## Worker WebSocket

The Worker sends `Authorization: Bearer <ATLAS_WORKER_TOKEN>` on the upgrade request. The API rejects browser-origin upgrades. Each frame is a JSON message with a 256 KiB maximum and this envelope shape.

```json
{
  "protocolVersion": 1,
  "messageId": "message:1",
  "type": "worker.heartbeat",
  "payload": { "workerId": "atlas:local" }
}
```

All messages use protocol version `1`. Command messages require a nonempty `commandId`. A `protocol.error` may include a command ID to identify its context.

| Direction    | Type                 | Payload                                                                                           |
| ------------ | -------------------- | ------------------------------------------------------------------------------------------------- |
| Worker → API | `worker.register`    | `{workerId,name,workspaceRoot,capabilities}`; see [capabilities](#capabilities)                   |
| API → Worker | `worker.registered`  | `{workerId,heartbeatIntervalMs:10000}`                                                            |
| Worker → API | `worker.heartbeat`   | `{workerId}`                                                                                      |
| API → Worker | `command.dispatch`   | `{kind:"repository.init",projectId,relativePath}` or the [clone form](#clone-and-credentials)     |
| Worker → API | `command.accepted`   | `{}`                                                                                              |
| Worker → API | `command.result`     | `{status:"succeeded",localPath}` or `{status:"failed" \| "needs_attention",error:{code,message}}` |
| API → Worker | `command.result_ack` | `{}`                                                                                              |
| Either       | `protocol.error`     | `{code,message}`                                                                                  |

Send `worker.register` first within 5 seconds of upgrade. The API rejects duplicate live Worker IDs and the reserved human ID `human:vladi`. A heartbeat goes stale after 30 seconds. The Worker reconnects using jittered exponential delays bounded between 500 ms and 30 seconds. A protocol error never changes the outcome of an unrelated command.

### Command recovery

The Worker journals terminal results and replays unacknowledged results after registration. The API accepts a result only from the assigned Worker. It sends `command.result_ack` only after durable persistence, acknowledges identical duplicates and rejects conflicting outcomes for the same command ID. The Worker can mark its result acknowledged when that acknowledgment arrives.

The API redispatches unresolved commands with their original IDs after reconnect. The Worker uses command IDs to deduplicate delivery and consult its journal. Delivery is at least once with deduplication. If the Worker cannot safely determine the outcome after a filesystem interruption, it reports `needs_attention`.

A Worker whose user may not change file permissions in its workspace fails `repository.init` and `repository.clone` with the error code `workspace_permissions`, removes the empty target folder it made and, for a clone, sends no `credential.request`. The code is new; the result's shape is unchanged, and the API and Board treat it like any other failure code. See "Workspace on a Windows drive" in `docs/development/local-setup.md`.

### Capabilities

A Worker registers with one of four lists, each the one before plus one entry: `["repository.init"]`, `["repository.init","agent.session"]`, `["repository.init","agent.session","repository.clone"]` or `["repository.init","agent.session","repository.clone","agent.session.status"]`. The API rejects any other list, including `["repository.init","repository.clone"]`. The second form was added with agent sessions, the third with cloning and the fourth with session start on move, resume and status. A Worker that registers the fourth form sends `session.activity` and `session.sync`, decides itself between a first run and a resume of a task's agent, and, when its sandbox is on, marks task worktrees trusted for Claude. A Worker that sends an older form still registers.

Compatibility in both directions:

- An older API refuses a newer Worker's registration, because its validator does not know the fourth list (or, for an API older still, the third). Update the API before the Worker.
- A newer API accepts an older Worker. It never sends a Worker without `repository.clone` a clone command or a credential message. It starts no agent session on an online Worker without `agent.session.status`, neither on a move nor from the Board's button: the start is refused with the code `sessions_unsupported` (409) and the message "The project worker is too old to run agent sessions". Over the Board socket the refusal arrives as an `error` message with that text, not as an HTTP status. On a move this is recorded as a refused start, see [Start on move](#start-on-move). An older Worker would send the task prompt on every start and so run the task again.
- The `session` message to the Board gains fields and the Board validates it strictly, and the sessions route is new, so deploy the Board and the API together.

### Clone and credentials

The clone command is a `command.dispatch` whose payload is `{kind:"repository.clone",projectId,relativePath,repository}`. `repository` is a GitHub full name such as `team/project`, never a URL, and the payload is strict, so a `token` field is rejected: the credential never travels inside the command. The Worker answers with the usual `command.accepted` and `command.result`.

The Worker asks for a credential when it needs one, over the same connection.

| Direction    | Type                 | Payload                                                     |
| ------------ | -------------------- | ----------------------------------------------------------- |
| Worker → API | `credential.request` | `{}`; the `commandId` names the clone                       |
| API → Worker | `credential.grant`   | `{token,expiresAt,repository}`                              |
| API → Worker | `credential.refusal` | `{code,message}`; the `commandId` is the one that was asked |

The API grants a credential only for a clone it dispatched to that Worker, for the repository in that command, and only within 900,000 ms (15 minutes) after dispatch. The Worker waits at most 30,000 ms for a reply. The token is short-lived, is held in memory and is never written to the database, the Worker journal, a Git configuration, a command line or a log.

The Worker registers `repository.clone` and sends one `credential.request` per clone after it has created and journaled the target folder. A refusal fails the clone with its code and message. A grant whose `repository` differs from the command's fails it with `repository_renamed` before Git contacts the host. When no reply arrives within 30,000 ms, the connection drops or the Worker stops, the clone ends as `needs_attention`. Replies for a command ID with no pending request are ignored. A clone journaled without reaching the `cloned` stage recovers as `needs_attention` (`recovery_uncertain`). A clone still queued when the Worker stops is not started and gets no result, so the API dispatches it again.

The API answers a request it does not grant with a `credential.refusal` whose `code` is one of these, never with a `protocol.error`. The checks that need no GitHub call come first; GitHub is asked last.

| Code                        | When                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `unknown_command`           | No command has this ID                                                                                                     |
| `wrong_connection`          | The command belongs to another Worker, or was not last dispatched on this connection                                       |
| `command_finished`          | The command already has a result                                                                                           |
| `wrong_kind`                | The command is not a clone                                                                                                 |
| `already_granted`           | A credential was already given or is being asked for on this dispatch, or GitHub was asked 3 times                         |
| `grant_window_closed`       | More than 900,000 ms have passed since the latest dispatch                                                                 |
| `github_unavailable`        | Sign-in is off, the App file is missing or unreadable, GitHub failed or did not answer within 20 s, or the API is stopping |
| `app_file_exposed`          | The App file lies inside a registered Worker's workspace root                                                              |
| `repository_not_accessible` | The project has no link, or the App no longer covers the linked repository                                                 |

A refusal for another Worker's command names nothing about it. The API asks GitHub for the repository's current name and then for an installation token limited to the linked repository ID with `contents: read`, and gives GitHub at most 20 seconds in all so that the refusal reaches the Worker within its 30-second wait; a token GitHub hands out after that is revoked at once. The window counts from the latest dispatch and limits only when a grant may be issued: a clone sent again after a reconnect can be granted again on the new connection, and a token granted inside the window stays valid after the window closes. A re-dispatch alone revokes nothing, because a Worker that reconnected may still be fetching with its token; a new grant for the command revokes the earlier tokens without waiting for GitHub. At most 3 requests per dispatch reach GitHub. A granted token is revoked at the first of: the command's result (also one the API rejects, such as a wrong result path), 61 minutes after the grant (the Worker's two 30-minute Git time limits and a minute's margin), and the API stopping (best-effort, each revocation bounded by the 10-second GitHub timeout). A clone still talking to GitHub when the API stops or restarts therefore fails with `git_failed`; in development the API's file watcher restarts it on every source change. A grant whose connection closed before it could be sent is revoked at once. The broker's state is in memory only, so an API restart forgets it; a token not revoked then expires within an hour. The API logs one line per grant and per refusal naming the command, the Worker, the repository and the rights (`contents:read`), never the token.

Two Git processes hold the token, one after the other: `git ls-remote --symref` reads the default branch, because Git 2.39 in the Worker image cannot record it during a fetch, and `git fetch` downloads the branches. Both read the token from one environment variable through the Worker's credential helper. Both run with the same locked-down settings: no system or user Git configuration, no other credential helper, TLS verification on, no extra headers, no redirects, HTTPS only, no submodules, no hooks and no background maintenance. Setting `origin` and checking out run in Git processes that never hold the token. Because the two token-holding processes ignore the system Git configuration, a system `http.proxy` or `http.sslCAInfo` is not used for a clone. Each of them is ended after 30 minutes (`clone_timeout`); the local steps are limited to 10 minutes each. The Worker builds the address from its `ATLAS_GIT_HOST_URL` setting (default `https://github.com`; plain `http` only for a loopback address).

### Project creation

The `local` repository form of `POST /projects` accepts an optional `githubRepositoryId` (positive integer). The `existing` form rejects it. Stored projects and `Repository` responses do not carry it. Older strict validators reject the field, so deploy the updated API before a Board that sends it.

With sign-in on, a create with `githubRepositoryId` clones that repository. The API answers 503 `worker_unavailable` unless the Worker is online and registered `repository.clone`, then confirms with GitHub that the App can access the repository before writing anything: 403 `repository_not_accessible` when it cannot, 502 `github_unavailable` when GitHub fails, 409 `setup_required` without an App file, 502 `github_unavailable` with an unreadable one. On success it answers 202 and writes the `local` project, its operation and the project's link (read it at `GET /projects/:projectId/github-link`) in one transaction, then dispatches the clone command with the repository's `owner/name` as stored in the link. The operation and project responses keep their shape. While the clone is pending or accepted, `DELETE /projects/:projectId/github-link` answers 409 `project_not_linkable`, because the clone needs the link to be sent again after a reconnect. With sign-in off there is no GitHub App: a create with `githubRepositoryId` answers 409 `github_unavailable` and writes nothing.

A clone that fails, or ends `needs_attention`, leaves its folder on the Worker, as `repository.init` does (a clone refused as `invalid_target` or `invalid_repository` creates none, and an existing folder is left untouched), and the project stays `failed` or `needs_attention`. The API has no retry, cancel or delete for a project: to try again, create a new project with another folder name, or remove the folder on the Worker's disk first and use its name again after checking what is in it. A clone stuck `pending` or `accepted` (for example a Worker that never comes back) keeps blocking `DELETE /projects/:projectId/github-link`, and nothing cancels it. A clone sent to a Worker that has gone offline waits and is sent again when that Worker registers again, with the same command ID.

A second clone queued on the same Worker behind a clone that runs longer than 15 minutes is refused with `grant_window_closed`: the window counts from dispatch, and the Worker starts commands one at a time. The refused clone leaves its folder, so the new project needs another folder name or the folder removed first.

Compatibility of this part: `githubRepositoryId` is new and the create request is strict, so an older API rejects it; deploy the API before the Board. The command kind, the capability and the three credential messages are new (see above); no existing message changes. A Worker without `repository.clone` keeps working for `repository.init` and sessions. An existing project whose path starts with a dot can no longer start a session: the Worker applies the same path rule when a session starts, and the session ends at once with the message "Choose a relative folder path without dot segments, not starting with a dot". Atlas cannot change a stored project's path, so such a project has to be created again under another name.

## Agent sessions

The messages are described in the contracts as `SessionActivityMessageSchema`, `SessionSyncMessageSchema` and `SessionActivitySchema`, next to the earlier session schemas. The session messages are covered by contract tests, API hub and socket tests, Worker session tests, an integration test with a stand-in agent and the Docker test group; `docs/development/acceptance.md` lists them. A session runs an agent CLI in a terminal on the Worker, inside a Git worktree made for one task. The task ID is the session ID, so a task has at most one session. Sessions live in memory: they end when the Worker stops, and the API forgets them when it restarts, and learns of the ones still running from the Worker's next `session.sync`.

Every session message carries the usual envelope and no `commandId`. Each payload has `sessionId` and `runId`, except `session.sync`, which lists sessions. The API creates a new `runId` for every start and ignores Worker messages whose `runId` is not the current one.

| Direction    | Type               | Payload besides `sessionId` and `runId`                                          |
| ------------ | ------------------ | -------------------------------------------------------------------------------- |
| API → Worker | `session.start`    | `{projectId,relativePath,prompt,cols,rows}`                                      |
| API → Worker | `session.input`    | `{data}`, at most 8,192 characters                                               |
| API → Worker | `session.resize`   | `{cols,rows}`                                                                    |
| API → Worker | `session.stop`     | none                                                                             |
| Worker → API | `session.started`  | `{worktreePath,branch}`                                                          |
| Worker → API | `session.output`   | `{data}`, at most 16,000 characters                                              |
| Worker → API | `session.exit`     | `{exitCode,message,stopped?}`; `exitCode` and `message` nullable                 |
| Worker → API | `session.activity` | `{activity,detail}`; see [Session activity](#session-activity)                   |
| Worker → API | `session.sync`     | `{sessions,exits}`, no `sessionId` or `runId`; see [Session sync](#session-sync) |

The Worker answers `session.start` for a session it already runs with `session.started` and adopts the new `runId`, so a restarted API can attach again. It answers input or a stop for a session it does not run with `session.exit`. Output produced while the Worker is disconnected is dropped.

`session.start` keeps its shape, but the meaning of `prompt` changed. The API sends the task's prompt on every start and the Worker decides what to do with it. It keeps a small record per task in its state directory and passes the prompt to the agent only on the task's first run. A later start of the same task resumes the agent's earlier conversation and sends no prompt (Claude), or starts the agent with no prompt (Codex). A custom agent command is never given the prompt. See "Agent sandbox" in `docs/development/local-setup.md` for the three cases and their notices. The record survives a Worker restart.

`session.exit` has a new optional field `stopped`. The Worker sets it to `true` when the user's stop ended the session, including a stop before the agent started, so the API shows a stopped session as ended and not as a failure. A Worker that omits it is read as `false`.

### Session activity

`session.activity` reports what the agent is doing. `activity` is `working`, `needs_input`, `idle` or `error`. `detail` is `null` or one of these codes, never free text: `asked_in_text`, `resumed`, `rate_limit`, `authentication_failed`, `billing_error`, `invalid_request`, `server_error`, `max_output_tokens`, `unknown`. The API ignores it for a run that is not the current one or has exited. Only Claude reports activity; the Worker reads it from hooks (see "Agent sandbox" in `docs/development/local-setup.md`). A session with no report counts as working. A Claude run that starts without the task prompt reports `idle` with the detail `resumed` before the agent has been asked anything.

### Session sync

After it registers, and before it replays unacknowledged command results, the Worker sends `session.sync` with `{sessions, exits}`. `sessions` lists every session it is running or still starting (at most 500), each with `sessionId`, `runId`, `state` (`starting` or `running`), `worktreePath`, `branch`, `activity` and `detail` (the last four may be `null`). `exits` holds the `session.exit` payloads it could not send while disconnected (at most 500; the oldest are dropped first). The API applies the message in this order:

1. The exits, as if they had just arrived. A session that ended cleanly while the Worker was away is shown as ended, not as lost.
2. The listed sessions. One the API holds as live, for the same Worker, takes the listed run ID and activity, and a `starting` session reported as running takes its worktree and branch. One of another Worker is skipped. A listed session the API holds as exited is not revived when it has the same `runId`; with another `runId` it is replaced by the listed session. A listed session the API does not know is adopted, with an empty output replay, when the task exists and its project's checkout is on this Worker. This is how the Board's dots return after an API restart.
3. Lost marking. Every other live session the API holds for that Worker is ended with exit code `null` and the message "The Worker restarted and the session was lost", and shown as a problem. This applies only to sessions that started before the Worker's latest registration, so a session started after it registered, and not yet in the Worker's list, is left alone. A late `session.started` never revives an ended session.

While a Worker is not connected, the API shows its live sessions as a problem with "Worker offline". When the Worker registers again they return to their reported status.

### Start on move

When `POST /tasks/:taskId/move` changes a task's status to `working` from another status, the API starts the task's session after the move is committed, with a default terminal size of 120 columns by 30 rows (`DEFAULT_SESSION_SIZE`); the Board's "Start session" and "Resume session" buttons send the same default size, and an open terminal then sends a `resize` with its real size. Reordering inside Working starts nothing. Moving a task back into Working while its session is live starts nothing; if its session has ended, the move starts it again and the Worker resumes it. A start for a task whose session is starting or running does nothing, so a move and a click that arrive together give one session.

If the API refuses the start (the Worker is offline, or too old, or an unexpected error), the move still succeeds. The API records for the task that the session did not start and why, shown as a problem with the reason `not_started` and the refusal's message, for example "The project worker is offline". The record is replaced by the next start and dropped when the task leaves Working. It is shown over an older ended session and held in memory only. A project that is not a ready local project has no checkout on a Worker: a move records nothing for it and its status reason is `no_checkout`.

The Worker creates the worktree at `<workspaceRoot>/.atlas-worktrees/<encoded relativePath>/<task ID>` on branch `atlas/task-<task ID>` and reuses it on later starts. The agent command is `claude` unless `ATLAS_AGENT_COMMAND` is set on the Worker. The agent and Git run without any `ATLAS_*` environment variables. Unless `ATLAS_AGENT_SANDBOX=off`, the Worker runs the agent inside a sandbox and first writes one line about it to the terminal; see `docs/development/local-setup.md`. This adds no messages.

### Board session socket

The Board opens a WebSocket at `/api/v1/tasks/:taskId/session`. The API accepts it only when the `Origin` header equals the configured Board origin. Frames are JSON without an envelope.

| Direction   | Message                                                                           |
| ----------- | --------------------------------------------------------------------------------- |
| Board → API | `{type:"start",cols,rows}`                                                        |
| Board → API | `{type:"input",data}`                                                             |
| Board → API | `{type:"resize",cols,rows}`                                                       |
| Board → API | `{type:"stop"}`                                                                   |
| API → Board | `{type:"session",state,branch,worktreePath,exitCode,message,status,reason,since}` |
| API → Board | `{type:"output",data}`                                                            |
| API → Board | `{type:"error",message}`                                                          |

`state` is `none`, `starting`, `running` or `exited`. `status`, `reason` and `since` are new; the Board validates the message strictly. On connect the API sends the current `session` message and then replays up to 400,000 characters of recent output. A session can start only for a task in a ready project that a Worker initialized locally. A `start` for a task whose session is starting or running does nothing.

### Session status

The API derives one status for a task from its session's state, its activity and a refused start. A refused start is newer than an ended session and is shown over it; an ended session is shown before the Worker's connection or activity are looked at.

| `status`      | `reason`                                    | When                                                                                                                              |
| ------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `none`        | `none`, `no_checkout`                       | No session and no refused start. `no_checkout`: the project has no ready checkout on a Worker                                     |
| `problem`     | `not_started`                               | The start was refused and is newer than any session                                                                               |
| `problem`     | `worker_lost`, `start_failed`, `exit_error` | The session was lost; it ended with no exit code; it ended with a nonzero exit code                                               |
| `ended`       | `stopped`, `exited`                         | The user's stop ended it; it ended with exit code 0 (the message about copying commits, if any, is kept in `message`)             |
| `problem`     | `worker_offline`                            | The session is live and its Worker is not connected                                                                               |
| `working`     | `starting`, `working`                       | Starting; running with activity `working` or no report                                                                            |
| `problem`     | `api_error`                                 | Running, activity `error`; `message` holds the detail code (the `StopFailure` hook behind it is unverified, see `local-setup.md`) |
| `needs_input` | `dialog`, `asked_in_text`                   | Running, activity `needs_input`; `asked_in_text` when its detail is that                                                          |
| `finished`    | `finished`, `resumed`                       | Running, activity `idle`; `resumed` when its detail is that                                                                       |

`since` is the API's clock time of the last change of the status, `null` when the status is `none`; a refused start with no session has one. `message` carries the refusal's text, an exit message or an error detail code, and is never the agent's output or last message. A session with `exitCode` `null` and a message (a failed start, a lost session) is a problem; one with exit code 0 is `ended`.

`GET /projects/:projectId/versions/:versionId/sessions` returns `{items: {taskId,status,reason,message,exitCode,since}[]}` for the tasks of that version that have a session or a refused start; the other tasks are left out. It needs a session while sign-in is on, like the tasks list. The Board polls it for the dot on each card.
