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

| Status | Meaning                                                                         |
| ------ | ------------------------------------------------------------------------------- |
| 400    | Invalid input                                                                   |
| 403    | Forbidden state or origin                                                       |
| 404    | Unknown entity                                                                  |
| 409    | Revision conflict or other conflicting state, including duplicate version names |
| 503    | Worker unavailable                                                              |

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

The Worker registers `repository.clone` and sends one `credential.request` per clone after it has created and journaled the target folder. A refusal fails the clone with its code and message. A grant whose `repository` differs from the command's fails it with `repository_renamed` before Git contacts the host. When no reply arrives within 30,000 ms, the connection drops or the Worker stops, the clone ends as `needs_attention`. Replies for a command ID with no pending request are ignored. A clone journaled without reaching the `cloned` stage recovers as `needs_attention` (`recovery_uncertain`).

### Project creation

The `local` repository form of `POST /projects` accepts an optional `githubRepositoryId` (positive integer). The `existing` form rejects it. Stored projects and `Repository` responses do not carry it. Older strict validators reject the field, so deploy the updated API before a Board that sends it.

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
