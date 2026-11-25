# Atlas HTTP and Worker protocol

The API defaults to port 4310 and the Board to port 5173. HTTP uses `/api/v1` and returns JSON. The Worker connects to `/api/v1/workers/connect` over WebSocket. Both apps use runtime schemas from `@atlas/contracts`.

## HTTP

| Method | Path under `/api/v1`                             | Request body                                                    | Success body                                       |
| ------ | ------------------------------------------------ | --------------------------------------------------------------- | -------------------------------------------------- |
| GET    | `/projects`                                      |                                                                 | `{items: Project[]}`                               |
| GET    | `/projects/:projectId`                           |                                                                 | `{project: Project}`                               |
| POST   | `/projects`                                      | `{name, repository}`                                            | `{project: Project, operation: Operation \| null}` |
| GET    | `/projects/:projectId/versions`                  |                                                                 | `{items: Version[]}`                               |
| POST   | `/projects/:projectId/versions`                  | `{name}`                                                        | `{version: Version}`                               |
| GET    | `/workers`                                       |                                                                 | `{items: Worker[]}`                                |
| GET    | `/projects/:projectId/versions/:versionId/tasks` |                                                                 | `{items: Task[]}`                                  |
| POST   | `/projects/:projectId/versions/:versionId/tasks` | `{title, description?, type?, priority?, assigneeId?, status?}` | `{task: Task}`                                     |
| PATCH  | `/tasks/:taskId`                                 | `{expectedRevision, changes}`                                   | `{task: Task}`                                     |
| POST   | `/tasks/:taskId/move`                            | `{expectedRevision, status, beforeTaskId}`                      | `{task: Task}`                                     |
| GET    | `/operations/:operationId`                       |                                                                 | `{operation: Operation}`                           |

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

Sign-in is controlled by the API setting `ATLAS_AUTH`: `github` (default) or `off`; any other value stops the API at start. `buildApp` called from code without sign-in options runs with sign-in off. The server entry point always reads the setting. With sign-in off the API behaves as before this section existed: none of the routes below except `GET /auth/state` exist, and no route needs a session. `GET /auth/state` then answers `{auth:"off",setup:"not_needed",user:null,app:null}`.

With sign-in on, every HTTP route and the Board session socket need a session, except routes marked `public`, `setup` or `worker` below. The session is the `atlas_session` cookie. Without one the API answers 401 `sign_in_required`. Until the GitHub App exists (the App file is missing), every route that needs a session answers 409 `setup_required`. The checks on `Host`, `Origin` and the JSON content type stay. Browsers must send `DELETE` requests with a JSON content type and the body `{}`; `DELETE` is in the CORS method list.

| Method | Path under `/api/v1`     | Access   | Body and answer                                                                              |
| ------ | ------------------------ | -------- | -------------------------------------------------------------------------------------------- |
| GET    | `/auth/state`            | `public` | `{auth:"off"\|"github",setup:"not_needed"\|"needed"\|"needs_owner"\|"done",user,app}`        |
| GET    | `/auth/github/start`     | `public` | 303 to GitHub's authorize page; sets `atlas_signin` for 10 minutes                           |
| GET    | `/auth/github/callback`  | `public` | 303 to the Board; sets `atlas_session` after a successful sign-in                            |
| POST   | `/auth/sign-out`         | `public` | 204; deletes the session and clears the cookie                                               |
| POST   | `/setup/github/start`    | `setup`  | `{organization?}`, answers `{action,manifest}`, the form the Board posts to GitHub           |
| GET    | `/setup/github/callback` | `setup`  | 303 to the Board with the outcome; writes the App file                                       |
| POST   | `/setup/owner-code`      | `setup`  | `{code}`, answers 204 and sets `atlas_setup_mark`; 403 `owner_code_invalid` for a wrong code |
| GET    | `/github/connection`     | session  | `{connection:{name,slug,account,manageUrl,installUrl}}`, read from GitHub                    |
| GET    | `/members`               | session  | `{items: Member[]}`; a member is `{id,login,name,role,signedIn}`                             |
| POST   | `/members`               | `owner`  | `{login}`, answers 201 `{member}`; 409 `member_exists`                                       |
| DELETE | `/members/:userId`       | `owner`  | `{}`, answers 204; 404 `member_not_found`, 409 `owner_not_removable`                         |

`access` is the route's own setting. `public`: no session needed; the route reads the session itself when it needs one. `setup`: anyone while the database has no owner, the owner's session after that. `worker`: the Worker socket, which keeps its token check and ignores sessions. `owner`: the owner's session. A route with no value needs any session. The `user` in the auth state is `{id,login,name,avatarUrl,role}` or `null`. `app` is `{name,account,installUrl}` or `null`; it is filled for a signed-in user, and during setup before an owner exists. A test lists every registered route with its access and checks that each refuses a request without a session, apart from these exceptions.

Cookies, all `HttpOnly` and `SameSite=Lax`, and `Secure` when the Board origin is `https`:

| Cookie              | Holds                                               | Lifetime                                                                                             |
| ------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `atlas_session`     | Random session ID; the database keeps only its hash | 30 days from last use; the cookie is kept for 400 days so the browser does not drop a session in use |
| `atlas_signin`      | Sign-in `state` and PKCE verifier                   | 10 minutes                                                                                           |
| `atlas_setup_state` | Binds a setup `state` to the browser                | 1 hour                                                                                               |
| `atlas_setup_mark`  | Lets this browser's first sign-in become the owner  | 30 days; the API ends it with the owner                                                              |

The two callbacks carry a code and `state` in their query string. The API omits that query string from its request log and answers every outcome with a redirect to the Board, reporting the result in the Board's address (`?setup=created`, `?setup=failed&reason=…`, `?signin=failed&reason=…&login=…`). A `state` works once and expires: one hour for setup, 10 minutes for sign-in. Pending values live in memory, so an API restart cancels them. Setup is refused with 409 `setup_done` while the App file exists.

The App file, its secrets and the one-time owner code never appear in a response or the log. The owner code is written only to the API's standard output at start.

### Board session socket and sessions

With sign-in on, the upgrade of `/api/v1/tasks/:taskId/session` needs a session in addition to the `Origin` check. The API checks the session again every 30 seconds while the socket is open, and at once on sign-out and on member removal. When the session has ended it closes the socket with code 4401.

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

### Capabilities

A Worker registers with `["repository.init"]`, `["repository.init","agent.session"]` or `["repository.init","agent.session","repository.clone"]`. The API rejects any other list, including `["repository.init","repository.clone"]`. The second form was added with agent sessions; a Worker that sends only the first form still registers, and the API refuses to start a session on it. The third form was added with cloning.

Compatibility in both directions:

- An older API refuses a newer Worker's registration, because its validator does not know the third list. Update the API before the Worker.
- A newer API accepts an older Worker. It never sends a Worker without `repository.clone` a clone command or a credential message.

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

| Code                        | When                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `unknown_command`           | No command has this ID                                                                                |
| `wrong_connection`          | The command belongs to another Worker, or was not last dispatched on this connection                  |
| `command_finished`          | The command already has a result                                                                      |
| `wrong_kind`                | The command is not a clone                                                                            |
| `already_granted`           | A credential was already given, or is being asked for, for this dispatch                              |
| `grant_window_closed`       | More than 900,000 ms have passed since the latest dispatch                                            |
| `github_unavailable`        | Sign-in is off, the App file is missing or unreadable, or GitHub failed or did not answer within 20 s |
| `app_file_exposed`          | The App file lies inside a registered Worker's workspace root                                         |
| `repository_not_accessible` | The project has no link, or the App no longer covers the linked repository                            |

A refusal for another Worker's command names nothing about it. The API asks GitHub for the repository's current name and then for an installation token limited to the linked repository ID with `contents: read`, and gives GitHub at most 20 seconds in all so that the refusal reaches the Worker within its 30-second wait; a token GitHub hands out after that is revoked at once. The window counts from the latest dispatch: a clone sent again after a reconnect can be granted again on the new connection. A token given for an earlier dispatch is not revoked by the re-dispatch, because a Worker that reconnected may still be fetching with it. The API revokes every token it handed out for a command when the command's result arrives, when the grant window closes, and when the API stops (best-effort, each revocation bounded by the 10-second GitHub timeout). The broker's state is in memory only, so an API restart forgets it; a token not revoked then expires within an hour. The API logs one line per grant and per refusal naming the command, the Worker, the repository and the rights (`contents:read`), never the token.

Two Git processes hold the token, one after the other: `git ls-remote --symref` reads the default branch, because Git 2.39 in the Worker image cannot record it during a fetch, and `git fetch` downloads the branches. Both read the token from one environment variable through the Worker's credential helper. Both run with the same locked-down settings: no system or user Git configuration, no other credential helper, TLS verification on, no extra headers, no redirects, HTTPS only, no submodules, no hooks and no background maintenance. Setting `origin` and checking out run in Git processes that never hold the token.

### Project creation

The `local` repository form of `POST /projects` accepts an optional `githubRepositoryId` (positive integer). The `existing` form rejects it. Stored projects and `Repository` responses do not carry it. Older strict validators reject the field, so deploy the updated API before a Board that sends it.

With sign-in on, a create with `githubRepositoryId` clones that repository. The API answers 503 `worker_unavailable` unless the Worker is online and registered `repository.clone`, then confirms with GitHub that the App can access the repository before writing anything: 403 `repository_not_accessible` when it cannot, 502 `github_unavailable` when GitHub fails, 409 `setup_required` without an App file. On success it answers 202 and writes the `local` project, its operation and the project's link (read it at `GET /projects/:projectId/github-link`) in one transaction, then dispatches the clone command with the repository's `owner/name` as stored in the link. The operation and project responses keep their shape. With sign-in off the field is ignored and the project is initialized as a new local repository, as before cloning existed.

## Agent sessions

The session messages are covered by contract tests, API hub and socket tests, Worker session tests, an integration test with a stand-in agent and the Docker test group; `docs/development/acceptance.md` lists them. A session runs an agent CLI in a terminal on the Worker, inside a Git worktree made for one task. The task ID is the session ID, so a task has at most one session. Sessions live in memory: they end when the Worker stops, and the API forgets them when it restarts.

Every session message carries the usual envelope and no `commandId`. Each payload has `sessionId` and `runId`. The API creates a new `runId` for every start and ignores Worker messages whose `runId` is not the current one.

| Direction    | Type              | Payload besides `sessionId` and `runId`     |
| ------------ | ----------------- | ------------------------------------------- |
| API → Worker | `session.start`   | `{projectId,relativePath,prompt,cols,rows}` |
| API → Worker | `session.input`   | `{data}`, at most 8,192 characters          |
| API → Worker | `session.resize`  | `{cols,rows}`                               |
| API → Worker | `session.stop`    | none                                        |
| Worker → API | `session.started` | `{worktreePath,branch}`                     |
| Worker → API | `session.output`  | `{data}`, at most 16,000 characters         |
| Worker → API | `session.exit`    | `{exitCode,message}`, both nullable         |

The Worker answers `session.start` for a session it already runs with `session.started` and adopts the new `runId`, so a restarted API can attach again. It answers input or a stop for a session it does not run with `session.exit`. Output produced while the Worker is disconnected is dropped.

The Worker creates the worktree at `<workspaceRoot>/.atlas-worktrees/<encoded relativePath>/<task ID>` on branch `atlas/task-<task ID>` and reuses it on later starts. The agent command is `claude` unless `ATLAS_AGENT_COMMAND` is set on the Worker. The agent and Git run without any `ATLAS_*` environment variables. Unless `ATLAS_AGENT_SANDBOX=off`, the Worker runs the agent inside a sandbox and first writes one line about it to the terminal; see `docs/development/local-setup.md`. This adds no messages.

### Board session socket

The Board opens a WebSocket at `/api/v1/tasks/:taskId/session`. The API accepts it only when the `Origin` header equals the configured Board origin. Frames are JSON without an envelope.

| Direction   | Message                                                       |
| ----------- | ------------------------------------------------------------- |
| Board → API | `{type:"start",cols,rows}`                                    |
| Board → API | `{type:"input",data}`                                         |
| Board → API | `{type:"resize",cols,rows}`                                   |
| Board → API | `{type:"stop"}`                                               |
| API → Board | `{type:"session",state,branch,worktreePath,exitCode,message}` |
| API → Board | `{type:"output",data}`                                        |
| API → Board | `{type:"error",message}`                                      |

`state` is `none`, `starting`, `running` or `exited`. On connect the API sends the current `session` message and then replays up to 400,000 characters of recent output. A session can start only for a task in a ready project that a Worker initialized locally.
