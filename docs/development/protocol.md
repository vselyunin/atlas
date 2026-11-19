# Atlas HTTP and Worker protocol

The API defaults to port 4310 and the Board to port 5173. HTTP uses `/api/v1` and returns JSON. The Worker connects to `/api/v1/workers/connect` over WebSocket. Both apps use runtime schemas from `@atlas/contracts`.

## HTTP

| Method | Path under `/api/v1`                             | Request body                                           | Success body                                       |
| ------ | ------------------------------------------------ | ------------------------------------------------------ | -------------------------------------------------- |
| GET    | `/projects`                                      |                                                        | `{items: Project[]}`                               |
| GET    | `/projects/:projectId`                           |                                                        | `{project: Project}`                               |
| POST   | `/projects`                                      | `{name, repository}`                                   | `{project: Project, operation: Operation \| null}` |
| GET    | `/projects/:projectId/versions`                  |                                                        | `{items: Version[]}`                               |
| POST   | `/projects/:projectId/versions`                  | `{name}`                                               | `{version: Version}`                               |
| GET    | `/workers`                                       |                                                        | `{items: Worker[]}`                                |
| GET    | `/projects/:projectId/versions/:versionId/tasks` |                                                        | `{items: Task[]}`                                  |
| POST   | `/projects/:projectId/versions/:versionId/tasks` | `{title, description?, type?, priority?, assigneeId?}` | `{task: Task}`                                     |
| PATCH  | `/tasks/:taskId`                                 | `{expectedRevision, changes}`                          | `{task: Task}`                                     |
| POST   | `/tasks/:taskId/move`                            | `{expectedRevision, status, beforeTaskId}`             | `{task: Task}`                                     |
| GET    | `/operations/:operationId`                       |                                                        | `{operation: Operation}`                           |

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

A new task starts in Backlog at revision 1. The creation defaults are an empty description, type `task`, priority `medium`, and no assignee. The task status values are `backlog`, `todo`, `working`, and `done`.

The PATCH request changes at least one editable field. Supply the latest task revision as `expectedRevision`.

```json
{ "expectedRevision": 1, "changes": { "priority": "high", "assigneeId": "human:vladi" } }
```

Changing `versionId` appends the task to the target version's Backlog. Project association is immutable.

To append to a different column, send a move with a null anchor.

```json
{ "expectedRevision": 2, "status": "working", "beforeTaskId": null }
```

To insert before another task, pass its ID. The anchor must belong to the moved task's project and version and to the destination status. A missing or stale anchor returns 409. A self-anchor is a no-op after the revision check. A same-column no-op may retain its revision. The API serializes moves transactionally, compacts positions in affected columns, and increments revisions for changed tasks. Position is zero-based within project, version and status. Refetch affected task lists after mutations.

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
| Worker → API | `worker.register`    | `{workerId,name,workspaceRoot,capabilities:["repository.init"]}`                                  |
| API → Worker | `worker.registered`  | `{workerId,heartbeatIntervalMs:10000}`                                                            |
| Worker → API | `worker.heartbeat`   | `{workerId}`                                                                                      |
| API → Worker | `command.dispatch`   | `{kind:"repository.init",projectId,relativePath}`                                                 |
| Worker → API | `command.accepted`   | `{}`                                                                                              |
| Worker → API | `command.result`     | `{status:"succeeded",localPath}` or `{status:"failed" \| "needs_attention",error:{code,message}}` |
| API → Worker | `command.result_ack` | `{}`                                                                                              |
| Either       | `protocol.error`     | `{code,message}`                                                                                  |

Send `worker.register` first within 5 seconds of upgrade. The API rejects duplicate live Worker IDs and the reserved human ID `human:vladi`. A heartbeat goes stale after 30 seconds. The Worker reconnects using jittered exponential delays bounded between 500 ms and 30 seconds. A protocol error never changes the outcome of an unrelated command.

### Command recovery

The Worker journals terminal results and replays unacknowledged results after registration. The API accepts a result only from the assigned Worker. It sends `command.result_ack` only after durable persistence, acknowledges identical duplicates and rejects conflicting outcomes for the same command ID. The Worker can mark its result acknowledged when that acknowledgment arrives.

The API redispatches unresolved commands with their original IDs after reconnect. The Worker uses command IDs to deduplicate delivery and consult its journal. Delivery is at least once with deduplication. If the Worker cannot safely determine the outcome after a filesystem interruption, it reports `needs_attention`.
