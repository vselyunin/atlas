# Agent sessions: start on move, resume, trust and status

Status: draft for the user's approval, 2026-11-27.

## Intent and scope

The user tested agent sessions on the Board and reported that they do not behave
like part of the board. A session starts only from a button inside the task, a
start after a session has ended runs the whole task again, Claude asks whether
the folder is trusted in every session, and nothing on the board shows what an
agent is doing.

The user wants a task's agent to be driven by the board: moving a task to
Working starts its agent, the task then offers to connect to that session, and
each card shows at a glance whether its agent is working, needs the user, has
finished, or broke.

This design covers four parts, built together because they share the session
messages: starting on the move, resuming an ended session, trusting task
worktrees, and status indicators.

## What was found first

Checked on `main` before any change, with a stand-in agent in the sandbox:

- A second session next to a live one never started. Five `start` messages on a
  running session, and five on a task with none, each left one agent process.
  The guards are `SessionHub.start` in the API and `SessionManager.start` in
  the Worker.
- After a session has ended, every start launches a new agent process in the
  same worktree and passes the task prompt again. The agent has no memory of
  the earlier run and begins the task from the start. This is what the user saw
  as "executes every time".
- The trust answer is never saved. `~/.claude.json` in the agent's home was
  last written at the login on 2026-11-22 and holds no trust record for any
  worktree, although sessions ran until 2026-11-27. The sandbox makes that one
  file writable, not the home folder: writing the file in place works, but
  creating a temporary file next to it and renaming a file onto it both fail
  with "Read-only file system".
- The permission-bypass warning no longer repeats. Its answer is in
  `~/.claude/settings.json`, in a folder the sandbox lets Claude write.

## Goals

- Moving a task into Working starts exactly one agent session for it.
- No sequence of moves, clicks or repeated messages creates a second session
  for a task while one is starting or running.
- The task prompt reaches the agent once per task. A later start resumes the
  earlier conversation and sends no prompt.
- Claude does not ask the folder-trust question for a worktree Atlas created.
- Every card shows one status dot for its session, and the task shows the same
  status with a sentence saying what happened.

## Non-goals

- Locking a card in Working. The user wants a Working task to be immovable by
  hand, and to reach Done only when its pull request is created and merged.
  The user put this in the next iteration; it needs the push and pull request
  work. Until then moves stay free, see "Moves out of Working".
- Keeping sessions across an API restart. The API still holds sessions in
  memory. "Known limits" says what the user sees.
- Resume and detailed status for Codex or a custom agent command.
- Fixing the reason Claude cannot save `~/.claude.json` in the sandbox. The
  trust part below does not depend on it. It stays a known defect; it is listed
  under "Follow-ups".

## Anti-goals

- An agent repeats a finished task because the user opened or restarted its
  session.
- A status that looks certain when it is a guess. Where a status is a
  judgement, the text in the task says so.
- The Worker marking any folder trusted other than a task worktree it created
  itself.
- The task prompt, agent output or the agent's last message reaching the
  database, a log or the status channel.

## Approaches

Three decisions had real alternatives. The user picked in conversation.

**A session that has ended.** (1) Resume the earlier Claude conversation and
send no prompt. (2) Open a plain Claude with no prompt and no history: simpler,
never repeats the task, but the agent forgets its work. (3) Keep today's
behaviour. The user picked 1.

**Folder trust.** (A) Move Claude's config into a folder the sandbox lets it
write, so Claude saves its own answer and the user answers once per worktree.
(B) The Worker records the trust for each task worktree before the agent
starts, so the user is never asked. (C) Leave it. The user picked B: "Worktree
is created by app, why do I need to answer the same question".

**How Atlas knows the agent's state.** (A) Claude reports it through its hooks.
Accurate, Claude only. (B) Guess from terminal activity: works for any agent,
cannot tell a question from a finished turn, and a long silent command looks
like waiting. (C) A for Claude and B for the rest: most to build, and only
Claude is used today. The user picked A.

## Design

### Starting on the move

When `POST /tasks/:taskId/move` changes a task's status to `working` from
another status, the API starts the task's session after the move is committed.
Reordering inside Working starts nothing. The move's response and status code
do not depend on the start.

The API has no terminal size at that moment, so it starts with a default size
(builder's choice, for example 120 by 30); the Board sends its real size when
it connects, as it does today.

If the start is refused (the Worker is offline, the project has no checkout,
the Worker is too old), the move still succeeds. The API records for the task
that the session did not start and why. The card shows the red dot, and the
task shows the reason and a "Start session" button to try again. This record
is replaced by the next start.

A start for a task that has a `starting` or `running` session does nothing, as
today. The move and a click arriving together must still give one session; a
test covers this in the API and one in the Worker.

### The button in the task

The task panel replaces "Open terminal" and the start button inside the
terminal with one control that depends on the session:

| Session                      | Button                           | Shown for          |
| ---------------------------- | -------------------------------- | ------------------ |
| starting or running          | "Connect" (then "Hide terminal") | any column         |
| none, or did not start       | "Start session"                  | Working tasks only |
| ended                        | "Resume session"                 | Working tasks only |
| none or ended, other columns | no button                        |                    |

"Connect" opens the terminal on the existing session and never starts
anything. "Start session" and "Resume session" send the same `start` message;
the Worker decides what it means (next section). "Stop" stays in the open
terminal. A task that is not in Working shows its status sentence but offers
no start; an ended session's last output can still be opened read-only with
"Show last output" (author's call).

### Prompt once, then resume

The Worker decides between a first run and a resume, because only it knows
what ran. It keeps a small record per task in its state directory, which the
agent cannot read. For Claude:

- No saved conversation for the task: the Worker starts Claude with the prompt
  and a session ID it chose (`--session-id <uuid>`), and writes the record with
  that ID.
- Claude has a saved conversation with the recorded ID: the Worker starts
  `claude --resume <uuid>` with no prompt.

The prompt counts as delivered only once Claude has saved a conversation. A
first run that dies before that (an expired login, a crash, an immediate Stop)
is followed by another first run with the prompt, so a task is neither
repeated nor left without its prompt. (An earlier proposal to the user opened
Claude with no prompt in that case; the review showed the task would then
never get its prompt.)

The Worker writes one line to the terminal before the agent's output saying
which of the two happened, next to the sandbox line it already writes.

A start fails closed like today when the sandbox cannot start.

For Codex and custom commands, a later run starts the agent with no prompt and
no history. That is documented as unverified, like the rest of Codex support.

The record survives a Worker restart, so a task is not repeated after one.

To be checked against the real Claude first, see "Checks before building":
that `--session-id` and `--resume` behave as described under the sandbox, and
how the Worker can tell reliably that a saved conversation exists. If either
cannot be made to work, stop and raise it rather than fall back to sending the
prompt again.

### Trusting task worktrees

Before it starts Claude in a task worktree, the Worker sets
`projects["<worktree path>"].hasTrustDialogAccepted` to `true` in the agent's
`~/.claude.json`. Rules:

- Only for the Claude profile, and only for the path `ensureWorktree` returned,
  which is always a checked worktree under `.atlas-worktrees`.
- The file is changed in place and every other key is kept. If the file is
  missing or cannot be parsed, the Worker changes nothing and starts the agent
  anyway; the user then sees the question as today.
- The Worker starts sessions one at a time, so two of its own writes cannot
  collide.
- Nothing of the file's content is logged.

What this means for security, to be stated in `local-setup.md`: accepting
trust lets Claude load the repository's own Claude settings, hooks and MCP
servers without asking. They run inside the sandbox with the same limits as
the agent, which already runs without permission prompts. The user decided
this for every repository Atlas runs.

To be checked with the real Claude: that the question no longer appears in a
new worktree, and which path Claude looks up for a linked worktree. If it is
not the worktree path, raise it before widening what is marked trusted.

### Status

The Worker reports what the agent is doing, the API turns that and the
session's state into one status, and the Board shows it.

**From Claude to the Worker.** The Worker passes Claude a settings value on
the command line (`--settings`) that adds hooks. Nothing is written into the
repository or Claude's settings files. Each hook runs a fixed command that
appends one short line to a status file for that session, in a folder the
sandbox lets the agent write and the Worker can read, outside the worktree and
on the container's own filesystem (file watching does not work on a Windows
drive). The Worker watches the file and deletes it when the session ends.

| Claude event                                  | Activity                                                |
| --------------------------------------------- | ------------------------------------------------------- |
| Prompt submitted, question answered           | `working`                                               |
| A question dialog or permission request opens | `needs_input`                                           |
| Turn finished                                 | `idle`                                                  |
| Turn ended on an API error                    | `error`, with the error kind (for example `rate_limit`) |

The status line carries the activity and, for an error, its kind. It never
carries the agent's message. One judgement is made inside the hook: when a
turn finishes and the agent's last message ends with a question mark, the
activity is `needs_input` with the detail `asked in text`, otherwise `idle`
(author's call; the user was told and did not object). The message itself
stays in the hook.

The agent can write to its own status file, so a misbehaving agent can show a
wrong dot on its own card. It cannot affect another task. This is accepted.

To be checked with the real Claude first, see "Checks before building": that
hooks given this way run in a task worktree under the sandbox, that the events
in the table exist in the installed version, and whether the first prompt
fires the "prompt submitted" event. A session with no reports counts as
working, so the start is covered either way.

**From the Worker to the API.** A new Worker message `session.activity` with
`{sessionId, runId, activity, detail}`; `activity` is `working`,
`needs_input`, `idle` or `error`, `detail` is a short code or null. The API
ignores it for a run that is not current, as with the other session messages.
The Worker also tells the API in `session.exit` whether the user's Stop ended
the session, so a stopped session is not shown as a failure.

After it registers, the Worker sends the list of sessions it is running
(`session.sync`, `{sessions: [{sessionId, runId}]}`). The API ends every
session it holds for that Worker that is not in the list, with the reason
"The Worker restarted and the session was lost". While a Worker is offline,
its live sessions show the red dot with "Worker offline"; they return to
their last status when it reconnects with them.

**Status the API serves.** One value per task, with a sentence:

| Status        | Dot           | When                                                                                                         |
| ------------- | ------------- | ------------------------------------------------------------------------------------------------------------ |
| `none`        | no dot        | No session and no failed start                                                                               |
| `working`     | blue, pulsing | Starting; running with activity `working` or no report yet                                                   |
| `needs_input` | amber         | Running, a dialog is open or the agent asked in text                                                         |
| `finished`    | green         | Running, the turn finished and the agent waits                                                               |
| `problem`     | red           | Start refused or failed; agent exited with a non-zero code; API error in a turn; Worker offline or restarted |
| `ended`       | grey          | Agent exited with code 0, or the user stopped it                                                             |

The sentence names the case, for example "Working since 14:02", "Waiting for
your answer", "The agent asked something in its last message", "Finished at
14:10, waiting for your next message", "Agent exited with code 1", "Model API
error: rate limit", "Session not started: the project worker is offline".
Times come from the API's clock.

**To the Board.** Two paths:

- The session socket's `session` message gains `status`, `detail` and
  `since`. The task panel shows the dot and sentence from it, live.
- A new route `GET /projects/:projectId/versions/:versionId/sessions` returns
  `{items: [{taskId, status, detail, since}]}` for tasks that have a session or
  a failed start. The board polls it every few seconds and draws the dot on
  each card. It needs a session like the other routes when sign-in is on.

The dot has a text alternative for screen readers and does not rely on colour
alone inside the task, where the sentence is next to it. Both themes get their
own token values for the five colours, per the Board instructions; the pulse
respects reduced-motion settings.

### Moves out of Working

Until the lock arrives in the next iteration, a task can still be moved out of
Working. A live session keeps running and its dot stays on the card in the new
column; the user stops it from the task. Moving the task back into Working
while its session is live starts nothing; if the session has ended, the move
resumes it, like "Resume session" (author's call).

## Checks before building

The plan opens with a short throwaway check in the Worker container with the
real Claude, the user's login and the user present, before any contract work.
It answers the three "to be checked" notes above: session ID and resume, the
trust record's path, and the hooks. Outcomes:

- All work: build as designed.
- Hooks do not run, or an event is missing: stop and ask the user. Guessing
  from terminal activity was rejected and is not a fallback. Starting on the
  move, resume and trust do not depend on hooks and can go ahead meanwhile.
- Resume or the trust record does not work: stop and ask the user.

## Contracts and compatibility

Follow `.agents/skills/atlas-contract-changes/SKILL.md`. Changes:

- Worker messages: new `session.activity` and `session.sync` (Worker to API);
  `session.exit` gains a field saying the user stopped the session. A new
  capability, for example `agent.session.status`, as a fourth allowed list
  (author's call; the builder may choose another compatible way). As before:
  update the API before the Worker. A newer API accepts an older Worker but
  starts no session on it, neither on a move nor from a button, and records
  "The project worker is too old to run agent sessions" as a failed start. An
  older Worker passes the prompt on every start, which would repeat tasks
  (author's call).
- `session.start` is unchanged in shape. Its meaning changes: the Worker uses
  the prompt only on a task's first run.
- Board socket: the `session` message gains three fields. The Board's
  validator is strict, so the Board and API are deployed together, as now.
- New HTTP route for the status list; `Task` is unchanged, and so is the
  database.
- `docs/development/protocol.md`, `local-setup.md` and `acceptance.md` are
  updated with the behaviour, the trust note and the manual checks.

## Tests

No existing test is changed without the user's permission. Existing tests that
describe the replaced behaviour (the start button inside the terminal, the
"Open terminal" control, a second start passing the prompt) will need changes;
the builder lists the files and exact changes and asks before touching them.

New tests cover at least: the move starting one session; the move with the
Worker offline; move plus click giving one session; first run, resume and
resume-without-conversation argument lists; the trust write keeping other keys
and skipping an unreadable file; the mapping from session state and activity
to status; `session.sync` ending lost sessions; the status route; the card dot
and the three buttons on the Board in both themes.

## Verification

`pnpm check`, the Docker test group, and a run in the Board with the real
Claude and the user present for: a move starting the session, no trust
question in a new worktree, the dot changing through working, needs-input and
finished, Stop, and "Resume session" continuing the conversation without
repeating the task. Verification is reported as self-review unless an
independent review is run.

## Known limits

- After an API restart the cards show no dot until a session is started or
  connected again, because the API forgets sessions. A task in Working then
  offers "Start session", which attaches to the session if the Worker still
  runs it and resumes it otherwise. Output replay from before the restart is
  lost, as today.
- The card's dot can be a few seconds behind; the task panel is live.
- "Asked in text" is a guess from the last character of the agent's message.
- Status detail exists for Claude only.

## Follow-ups

- Next iteration (user's decision): a task in Working cannot be moved by hand
  and reaches Done when its pull request is merged.
- Claude cannot save `~/.claude.json` inside the sandbox, so whatever else it
  records there is lost between sessions.

## Left to the builder

The default terminal size, the status file's place and line format, the
record file's format, the poll interval, the exact capability name, the
component structure on the Board, and the wording of sentences not quoted
above.
