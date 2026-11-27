# MVP acceptance

The local MVP contains the Board, API, Worker and shared contracts. Assignment
records responsibility; it does not start an agent or terminal session.

## Coverage

- Contract tests validate resource shapes and Worker messages.
- API tests cover project/version creation, task rules, ordering, revisions,
  Worker authentication and repository operation results.
- Worker tests cover path confinement, existing folders, command replay,
  recovery, state separation and result acknowledgement.
- Board tests cover task fields and editing restrictions.
- A real API/Worker integration test checks repository creation and reconnect
  after an API restart with persistent data.
- Browser acceptance covers project/version selection, task creation and edits,
  status locks, drag and drop, reload persistence and local Git initialization.
  A second scenario verifies rollback after a rejected move.

Run `pnpm check` and `pnpm test:e2e` as described in the README. Browser tests use
temporary data and separate ports, leaving the personal workspace untouched.

### Worker container and agent sandbox

At the time of writing `pnpm check` runs 60 contract, 111 Worker, 28 API and 41 Board
tests, plus 10 integration tests. They cover, with a stand-in agent and the sandbox off:

- session message schemas and limits, and the accepted capability lists (four forms since session status);
- Worker sessions and worktrees with real Git and a real PTY, the sandbox settings and
  agent arguments, required mode refusing to start without the sandbox, off mode running
  unwrapped, the Worker lock, the seccomp profile and the Worker configuration;
- the agent's own Git object folder and the Worker's copy into the project's object store,
  including refused forged objects and a commit usable in the project folder at session exit;
- the API session hub and socket, and the Board session section and terminal;
- API and Worker together through the Board socket: start, output, input, reattach,
  stop and reattach after an API restart.

`pnpm test:docker` is a separate group of 6 tests. It needs Docker, no agent login, and is
not part of `pnpm check`. It builds the image and registers the containerized Worker, runs
a stand-in agent through the Board socket with the sandbox required, checks what the
sandboxed agent can and cannot write, read and reach (the project's Git object store is among
the refused writes), checks that `git add -A` works and that the commit passes `git fsck` in
the project folder, and
checks that the default seccomp profile makes a required-mode session fail with no agent
started. The coordinating agent ran the group after the last change and all 6 passed. Its
stand-in agent does not create `.claude`, so it does not cover the two placeholders found in
the manual check below.

### Manual checks with a real logged-in Claude

The checks began on 2026-11-23, with `pnpm dev` and the login in the `atlas-agent-home` volume.

| Check                                                                | Result                                                                                   |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Session starts in the container and shows "Atlas: agent sandbox on…" | Passed, after a fix: Claude first exited with a read-only error creating `/tmp/claude`.  |
| Folder-trust question appears and can be answered on the Board       | Passed.                                                                                  |
| Permission-bypass warning appears on the Board                       | Passed. The user approved accepting it; the agent then started the task.                 |
| Agent edits and commits in its worktree with `git add -A`            | Passed with a defect, fixed afterwards; passed in the re-check on 2026-11-25, see below. |
| Agent cannot write `/tmp/outside.txt`                                | Passed: `Read-only file system`; the file exists neither in the container nor in WSL.    |
| Stop ends the session                                                | Passed: the Board shows the session ended and no agent process is left in the container. |

The commit check found a defect. Claude creates `.claude` in the worktree, the sandbox then
adds the placeholders `.claude/agents` and `.claude/commands`, and `git add -A` committed both
as empty files next to `NOTES.md`. Both paths were added to the agent's Git excludes file. The
fix is covered by a Worker test and was confirmed in the re-check below.

The folder-trust question and the permission-bypass warning are asked again in every new
session for the same worktree.

### Re-check on 2026-11-25

After the placeholder, Git link and object folder fixes, one session was run again with a real
logged-in Claude on the merged code, with `pnpm dev` and a freshly built Worker image. The user
answered the folder-trust question and the permission-bypass warning; the coordinating agent
started and stopped the session on the Board and checked the results from WSL.

| Check                                                             | Result                                                                                        |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Session starts with the sandbox on                                | Passed.                                                                                       |
| Agent commits with `git add -A`                                   | Passed: the commit holds only `RECHECK.md`, with no `.claude` placeholders.                   |
| The commit is usable in the project folder while the session runs | Passed: the task branch shows the commit there and `git fsck --strict` reports nothing.       |
| The agent's objects are in its own folder                         | Passed: the folder was empty before the agent ran and held three objects after the commit.    |
| The worktree's Git links are unchanged                            | Passed: `commondir`, `gitdir` and `.git` hold their original values.                          |
| Agent cannot write `/tmp/outside.txt`                             | Passed: `Read-only file system`; the file exists neither in the container nor in WSL.         |
| Stop ends the session                                             | Passed: exit code 0 on the Board, no agent or sandbox process left, the commit still present. |

One observation is not a failure of these checks. The sandbox leaves eleven empty read-only
placeholders in the worktree, such as `.bashrc`, `.gitconfig`, `.mcp.json` and `.idea`. The
agent's `git add -A` did not commit them, but Git run in the worktree from WSL lists them as
untracked, so a commit made there outside the sandbox would include them.

Codex was not checked under the sandbox and is unverified.

### Manual checks with real GitHub: sign-in and setup

Status: run by the user on 2026-11-26 and 2026-11-27 with a personal App; the results are in the
table after the steps. Steps 8 to 10 were not run. The automated tests for sign-in and setup use a local stand-in for GitHub
and never reach github.com, so only these steps cover the real service. They need a GitHub
account that may create Apps and one test repository. Steps 8 to 10 need a second GitHub
account, and for them to work the App must be owned by an organization, created by choosing that
organization on the setup page, with the second account a member of it. GitHub is expected, but
was not tested, to refuse a second account on a personal App before Atlas sees it. With a
personal App, record "GitHub refused the account" as the outcome of step 8 and skip steps 9 and 10. Use a fresh database, for example by starting with an unused `ATLAS_DB_PATH` and
`ATLAS_GITHUB_APP_FILE`. Do not write down the owner code, the App file's content or any token.

1. Run `pnpm dev:web` and open <http://localhost:5173>. Expected: only the setup page shows, with
   the three "one account" rules.
2. Choose "Create the GitHub App". Expected: GitHub shows a name like `Atlas-xxxxxx` and asks you
   to confirm. Confirm.
3. Expected: the Board shows "Install and sign in" with the App's name and your account. On
   GitHub, open the App's settings and check: three rights (Contents, Pull requests, Metadata),
   no Workflows, no webhook, no events, not public.
4. Choose "Install the App on GitHub" and select only the test repository. Expected: GitHub
   returns to the Board.
5. Choose "Sign in with GitHub". Expected: you are signed in as the owner; your avatar
   shows in the header, and your name in the user menu.
6. Open Settings from the user menu. Expected: the App's name and owning account, and a member list with only you.
7. Reload the page. Expected: still signed in. Sign out from the user menu. Expected: the sign-in
   page shows.
8. Sign in with the second account. Expected: the Board says that account has no access and
   names it. With a personal App, GitHub may refuse the account first; record that and skip
   steps 9 and 10.
9. Sign in as the owner, add the second account's login in Settings, then sign in with the
   second account in another browser. Expected: it gets in, and has no member list or setup
   rights.
10. As the owner, remove that member. Expected: the second browser returns to the sign-in page
    on its next request; an open terminal in it closes. Sign in with the second account again.
    Expected: no access.
11. Restart the API with `ATLAS_AUTH=off`. Expected: no sign-in, and a permanent "Sign-in is off"
    notice on the Board. Restart with sign-in on again. Expected: the sign-in page.
12. Stop Atlas, delete the App file and the App on GitHub, and start again. Expected: the setup
    page returns; the owner stays signed in and can create a new App. After that the Board goes
    straight to the app with no install step; choose repositories from Settings ("Choose
    repositories").
13. Start again from a fresh database and App file. Create the App and install it, but do not
    sign in. Restart the API and read the owner code from its output. In a different browser,
    enter it on the setup page, then sign in. Expected: that browser becomes the owner. Without
    the code, signing in from that browser is refused. Open exactly <http://localhost:5173> in
    that browser: at `http://127.0.0.1:5173`, the address Vite prints, the Board loads but the
    API refuses the code with "This browser Origin is forbidden".

The user ran the steps against github.com and reported the results; the coordinating agent
recorded them and did not sign in or create the App itself.

| Steps   | Result                                                                                                                                                                                                                                                                            |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 to 7  | Passed.                                                                                                                                                                                                                                                                           |
| 8 to 10 | Not run: no second GitHub account was available.                                                                                                                                                                                                                                  |
| 11      | Passed.                                                                                                                                                                                                                                                                           |
| 12      | Passed: the earlier projects were all still there. Whether the setup page asked for the owner code that the API prints for reconnecting was not recorded.                                                                                                                         |
| 13      | Passed at `http://localhost:5173`: the Board showed "The owner code was accepted. Now sign in with GitHub." The first tries, in Firefox and in a private Chrome window, were refused with "This browser Origin is forbidden" (see the note in step 13), before the code was read. |

One observation is not a failure of these checks. A sign-in started before the API was ready
came back as `?signin=failed&reason=state_invalid`, because pending sign-ins are kept in memory.
Signing in again worked, but the Board keeps that query in the address afterwards.

### Manual checks with real GitHub: linking, cloning and credentials

Status: run by the user on 2026-11-26 and 2026-11-27; the results are in the table after the
steps. Step 10 was not run. The automated tests for linking, cloning and credentials use a local
stand-in for GitHub and a local stand-in Git server and never reach github.com, so only these
steps cover the real service. Do the sign-in and setup checks above first: the App must exist,
and you must be signed in as the owner. You need one private repository the App is installed on,
one more repository it is not installed on, and `pnpm dev` with the Worker online (the Worker
image builds with Git 2.39 and clones over HTTPS). Do not write down any token, the owner code or
the App file's content.

1. Run `pnpm dev`. In Settings, choose "Choose repositories" and select only the private test
   repository. Expected: GitHub returns to the Board.
2. Create a project with "New local repository", wait until it is ready, select it and open
   Settings. In the repository section choose the test repository and "Link". Expected: the
   repository's name and default branch show, with no "The GitHub App can no longer reach this repository" warning.
3. Reload. Expected: the link is still there. Choose "Unlink". Expected: the link is gone. Link
   again.
4. First add a second repository to the App's selection on GitHub: GitHub may refuse to remove
   the only selected one. Then remove the test repository from the selection and reload the Board.
   Expected: the Board warns "The GitHub App can no longer reach this repository". Select the
   repository again. Expected: the warning goes.
5. Create a project with "Clone from GitHub", the test repository, the online Worker and a new
   folder name. Expected: "Cloning your repository" shows, then the project becomes ready with a
   task board. In WSL, in the new folder: `git log --oneline` shows the repository's history,
   `git branch -a` shows its branches with the default one checked out, and
   `git remote -v` shows an address without any credential (no `x-access-token`, no token).
6. In the same folder run `grep -r x-access-token .git; git config --list --show-origin`.
   Expected: no token anywhere in `.git` or the configuration.
7. Start a session on the cloned project and run, from the agent's terminal or a shell in the
   worktree, `env`. Expected: no token and no `ATLAS_*` variable.
8. Try the same create with a repository the App is not installed on (use its ID with the API, or
   remove it from the App's selection after the Board listed it). Expected: refused with
   `repository_not_accessible` and no project appears.
9. On GitHub, open the App's settings and its installation. Expected: the App has Contents (read
   and write), Pull requests (read and write) and Metadata (read) and nothing else; no
   Workflows; no webhook; no events (GitHub may show no events section at all while the webhook
   is inactive); the installation is limited to the repositories you
   chose. Atlas asks for each clone a token that is limited to one repository and to Contents
   read; GitHub does not show these tokens, so this part is covered by the stand-in tests, and
   the API log line (`Granted a repository credential`) shows the rights `contents:read`.
10. This needs a second GitHub account that can sign in, which works only with an
    organization-owned App (see the sign-in checks); with a personal App, skip this step. Sign in
    with that account, which is not the owner and not a member, in another browser. Expected:
    refused, as in the sign-in checks. As the owner, add it as a member, sign
    in with it and clone a repository. Expected: the clone works, because every signed-in person
    can clone every repository the App can access. Remove the member again.
11. Stop the Worker container (`docker stop atlas-worker`) while a clone of a large repository
    runs. Expected: `pnpm dev` notices the container stopped and stops the whole stack. Start
    `pnpm dev` again: the project then shows "Repository needs attention" and its folder stays.
    Check the folder before you reuse its name.
12. Time limit for task worktrees: with a real, large repository cloned onto the workspace (on a
    Windows drive, as in this checkout), create a task, move it to Working and start a session.
    Expected: the worktree is created and the session starts. If the Board reports that creating
    the worktree took too long, the 30-second limit in `apps/worker/src/sessions/worktree.ts`
    needs raising; record the repository's size and the time it took.

The user ran the steps against github.com with the Worker in its container and reported the
results; the coordinating agent recorded them. The workspace was `/srv/atlas-acceptance/projects`
on the WSL file system, not a Windows drive: the containerized Worker, which runs as user 1001,
could not run `git init` in a workspace under `/mnt/c`. That defect is open.

| Steps  | Result                                                                                                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 to 3 | Passed.                                                                                                                                                                                                      |
| 4      | Passed. GitHub refused to remove the only selected repository, as the step says.                                                                                                                             |
| 5, 6   | Passed with a private repository. An empty repository cloned as an empty folder; its `HEAD` stayed `master`, not the repository's default branch.                                                            |
| 7      | Passed.                                                                                                                                                                                                      |
| 8      | Passed: "The GitHub App cannot reach that repository…" and no project. The message stayed after another repository was chosen; fixed afterwards and covered by a Board test, not checked again in a browser. |
| 9      | Passed. The user found no events section on GitHub. The API log held three `Granted a repository credential` lines, each with the rights `contents:read`, and no token.                                      |
| 10     | Not run: no second GitHub account was available.                                                                                                                                                             |
| 11     | Passed: `pnpm dev` printed "worker stopped (0); stopping Atlas."; after the restart the project showed "Repository needs attention" and its folder held only `.git`.                                         |
| 12     | Passed with a small repository on the WSL file system: the worktree was created and the session ran. Not run on a Windows drive or with a large repository, so the 30-second limit is untested there.        |

The fix for repositories with thousands of branches (the default branch was looked for in a
branch list cut at 64 KiB) was made after steps 5 to 7 and before steps 8 to 12. It is covered by
a Worker test; no repository of that size was cloned from github.com.

### Session start, resume, trust and status

Design: `docs/superpowers/specs/2026-11-27-session-start-and-status-design.md`. This part
supersedes the statement above that the folder-trust question is asked again in every new session:
the Worker now records the trust of a task worktree when the sandbox is on.

Checks before building, run on 2026-11-27 with Claude Code 2.1.330 under `srt` in the Worker
container, in a linked worktree:

- Without a trust record the trust dialog appears and no hook runs. With
  `projects["<worktree path>"].hasTrustDialogAccepted = true` written in place (same inode) the
  dialog does not appear. The key is the worktree path.
- Hooks passed with `--settings '<json>'` run under the sandbox. Observed order for a first run
  with a prompt argument: `SessionStart` (`source: "startup"`), `UserPromptSubmit`, `Stop`. The
  `Stop` input has `last_assistant_message`.
- A question dialog fires `PreToolUse` (matcher `AskUserQuestion`), then `PermissionRequest`
  (`tool_name: "AskUserQuestion"`); answering it fires `PostToolUse` (matcher `AskUserQuestion`).
- `--session-id <uuid>` works; the conversation is saved as
  `~/.claude/projects/<encoded cwd>/<uuid>.jsonl`. `--resume <uuid>` reopens it and fires
  `SessionStart` with `source: "resume"` and nothing else until the user types.
- `--resume` with an unknown ID prints "No conversation found with session ID: …" and exits with
  code 1.
- Not checked: `StopFailure`. No API error could be provoked, so the hook is wired from the
  documentation and the red dot for a model API error is unverified.

Manual checks with a real logged-in Claude, with `pnpm dev` and the user present. Not run yet; the
results go here when they are. Do each step in both themes where it shows a dot.

- [ ] Move a task from To do to Working. Expected: exactly one session starts, the card shows a
      blue pulsing dot, and the task panel offers "Connect".
- [ ] Open the terminal on the new worktree. Expected: Claude does not ask whether to trust the
      folder, and the terminal shows "Atlas: first run, the task prompt was sent."
- [ ] Ask the agent to put a question to you with a dialog. Expected: the dot turns amber while the
      dialog is open and returns to blue when you answer.
- [ ] Let the agent finish its turn. Expected: the dot turns green, and the task panel says the
      agent finished and waits for your next message.
- [ ] Press Stop. Expected: the dot turns grey and the session shows as ended, not as a failure.
- [ ] Choose "Resume session". Expected: the terminal says the earlier conversation was resumed and
      the prompt was not sent again, the agent remembers its work and does not repeat the task, and
      the dot shows finished until you type.
- [ ] Stop the Worker container (`docker stop atlas-worker`) with a session running. Expected: the
      dot turns red and the task panel says the Worker is offline, unless `pnpm dev` stops the whole
      stack first (see step 11 of the cloning checks), in which case record that. Start `pnpm dev`
      again and record what the cards and the task panel show once the Worker has reconnected and
      synced: the session as lost, or no dot with "Start session" offered for a task in Working.

## Review and test permissions

The container and sandbox work was split into 11 tasks. Tasks 1 to 10 each had an independent
task review by a separate reviewer agent, covering spec compliance and quality; Tasks 4, 7, 9
and 10 needed fix rounds, each followed by a scoped re-review. The Task 11 documentation was
reviewed independently after it was first committed and corrected in a follow-up commit. The
implementers' own checks were self-review. An independent whole-branch review then found no
critical and six important issues. Five were fixed and independently re-reviewed; for the
Worker lock that meant documenting the limit, not removing it. The sixth was the unfinished
real-Claude checks above. The placeholder fix that followed those checks was self-reviewed
only. Twelve minor findings from that review remain open.

A second independent review, of the whole pull request, found one critical issue: a sandboxed
agent could redirect its worktree's Git links so that Git run there on the host executed the
agent's commands. The fix was independently re-reviewed, which confirmed the reported route
closed and added two important findings, both about limits that are now documented and not
removed: other writable Git state in the worktree, and the writable shared object store. Its
smaller findings on the fix were applied and those last changes were self-reviewed only. Ten
minor findings from the pull request review remain open.

The writable shared object store was then removed: each agent writes Git objects to a folder
of its own and the Worker copies them into the project's store. One independent reviewer
attacked the change with real Git, including hand-built packs, and confirmed that changed
content cannot arrive under another object's name. It found no critical and three important
issues: the Worker could be stalled through the task branch file, a session's exit could be
lost while its last commits were copied, and the Worker's Git reads agent-written packs
outside the sandbox. The first two were fixed and the third reduced and documented; these
fixes were self-reviewed only. The reviewer did not check the real sandbox or the Docker
tests; the coordinating agent ran those. Not done from its minor findings: a size limit on
copied objects, a forged-pack test in the suite, and showing a failed copy while the session
still runs. The change was run with a real logged-in Claude in the re-check of 2026-11-25.

The GitHub connection work (sign-in, setup, members, repository links and clones) was split
into tasks, each implemented by one agent and reviewed by a separate reviewer agent, followed by
an independent whole-branch review and one round of fixes. Three later commits (refusing a
GitHub create while sign-in is off, the API test timeouts and the commit body line length) were
self-reviewed when made. A second independent review of the whole branch then read them and the
contracts, API and Worker code in full, and the Board and the tests in part; it ran no tests. It
found no critical issue and one important one: the commit that added `apps/api/vitest.config.ts`
did not record the user's approval, which is recorded below. Of its six minor findings, the
branch-list limit was fixed, self-reviewed only. Open: pending sign-ins can be pushed out by
another website's requests, a native Worker that crashes leaves its Git processes running, an
unknown `/api/v1` path answers "sign in" instead of "not found" with sign-in on, and an App file
that becomes unreadable while the API runs gives an unexplained error. The fix to the create
dialog's refusal message was also self-reviewed only.

Earlier work was reviewed by the
implementing agent only; an independent agent review of it was attempted but unavailable
because the service usage limit was reached.

The user explicitly approved these changes to existing tests and test helpers:

- Board interaction tests: replace element casts with typed queries; preserve
  assertions and behavior.
- Browser startup helper: wait for the API and Worker, clean up child processes
  and temporary state, and format the file.
- Worker replay test: check that the temporary server has a TCP address before
  reading its port; preserve assertions and behavior.
- Browser test server (`scripts/e2e-server.mjs`): start the API with `ATLAS_AUTH: 'off'`.
- API tests: a 30-second test and hook timeout for every API test, in the new
  `apps/api/vitest.config.ts`; the tests time out on this checkout's Windows drive otherwise.
- `apps/api/tests/project-create-github-field.test.ts`: expect 409 `github_unavailable` for a
  create with `githubRepositoryId` while sign-in is off, after the behavior changed.
- Commit message check: no limit on the length of body lines, because two earlier commits on
  the branch exceed it and past commit messages are not reworded.

Other tests were added as new files. Mandatory TDD is not enabled. The root and
per-app instructions preserve the requirement to ask before changing tests.
