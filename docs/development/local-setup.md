# Run Atlas locally

Run commands inside WSL from the Atlas repository. Use the Node version in
`.nvmrc`, pnpm version in `package.json`, and Git available on PATH. The Worker
runs in a Docker container, so Docker must be installed in WSL (see below).

```sh
pnpm install --frozen-lockfile
pnpm worker:login   # once, to log the agent in
pnpm dev
```

Open <http://localhost:5173> in your Windows browser. The combined launcher builds
shared contracts, builds the Worker image `atlas-worker:dev`, and starts the API and
Board natively and the Worker in the container `atlas-worker`. The image is built on
every start, so a change to Worker or contracts code reaches the container on the next
`pnpm dev`; Docker's cache keeps an unchanged rebuild fast. Docker prints a
deprecation notice about the legacy builder on each build; that is expected. The
launcher generates a local Worker token if one is not configured, without printing it.
The API listens on port 4310. The Worker reconnects if it starts before the API is ready.

Commands:

- `pnpm dev`: API and Board natively, Worker in the container.
- `pnpm dev:web`: API and Board only, with no Worker and no Docker. The Board shows
  the Worker as offline and sessions cannot start.
- `pnpm worker:login [claude|codex]`: opens the agent CLI in a container with the login
  volume, once, so the agent is logged in. The default is `claude`.
- `pnpm test:docker`: the Docker test group. It needs Docker and no agent login, and it
  is not part of `pnpm check`.

Default local state is in the ignored `.atlas/` directory:

- `atlas.sqlite`: projects, versions, tasks and operations.
- `projects/`: new project repositories created by the Worker.
- `worker/`: Worker lock and durable command journal. The lock file holds `<pid> <token>`;
  a lock left by a container that was killed hard is taken over on the next start. The lock
  keeps two Workers apart only when they share a PID namespace; it does not keep a native
  Worker and the container Worker apart (see "What the sandbox does not protect").
- `worker-token`: secret shared by the local API and Worker.
- `github-app.json`: the secrets of the GitHub App that signs people in; see "The App file".

Ctrl+C stops all services, including the container; it does not erase data or
repositories. Restart with `pnpm dev`. Do not run two copies of the same Worker
identity/state directory.

Closing the terminal that runs `pnpm dev` stops the stack the same way as Ctrl+C. Only if the
launcher itself is killed hard (for example `kill -9`) can the API, Board and the
`atlas-worker` container be left running; then clean up with `docker rm -f atlas-worker` and
stop the leftover node processes after checking their ownership. Do not start a second stack
while they run.

## Sign in with GitHub

The first time you start Atlas, the Board shows only a setup page until you create a GitHub
App. This applies to every start with the default `ATLAS_AUTH=github`, including an existing
installation after an upgrade: its projects, tasks and Worker are unchanged, but nobody can use
the Board until setup is done and someone signs in. To run without sign-in, see "Run without
sign-in". Every installation has its own App; Atlas is not a service and shares nothing with
other installations.

### One GitHub account per installation

Read these before you choose the account on the setup page.

- One Atlas works with the repositories of exactly one GitHub account, a person's or an
  organization's. The App is not public, so GitHub lets it be installed only on the account that
  owns it.
- An App owned by a personal account cannot reach an organization's repositories. To use an
  organization's repositories, create the App under that organization on the setup page. That
  needs someone allowed to create Apps there.
- For an organization's App, the people who sign in must be members of that organization. For a
  personal App, GitHub is expected to let only its owner sign in, so a personal installation
  has one user. This was not tested with a second account. Atlas does not depend on it: a person
  gets in only when they are the owner or a member the owner added.

### First-run setup

1. Start Atlas (`pnpm dev` or `pnpm dev:web`) and open <http://localhost:5173>.
2. On the setup page, leave the organization field empty to use your own account, or enter an
   organization's name. Choose "Create the GitHub App".
3. GitHub shows the App's name. Atlas proposes `Atlas-` plus six random characters, because App
   names are unique across GitHub; you can change it. Confirm to create the App. Finish within
   one hour; GitHub allows no longer.
4. GitHub returns you to the Board. Atlas checks with GitHub that the App is not public and has
   only the rights it asked for, then writes the App file. If a check fails, Atlas stores nothing
   and the Board says why, but the App already exists on GitHub; see below.
5. Choose "Install the App on GitHub" and pick the repositories the App may use. This choice is
   the limit of what Atlas can link and clone (see "GitHub repositories"); you can change it later
   on GitHub. GitHub returns you to the Board.
6. Choose "Sign in with GitHub". You become the owner if you sign in with the browser that
   created the App. Use the same browser from step 2 to this step.

The App asks for Contents (read and write), Pull requests (read and write) and Metadata (read).
It does not ask for Workflows, has no webhook and subscribes to no events. Pull requests and
Contents write are requested now so that you do not have to approve a wider right on GitHub
later; nothing in Atlas uses them yet. Cloning uses Contents read only, and sign-in itself grants
no repository right.

If setup fails after GitHub already created the App, the App exists on GitHub but Atlas has
forgotten it. This happens when the App turns out to be public, when its rights differ from what
Atlas asked for, when GitHub fails after creating it, and when Atlas could not write the file.
Delete the App named like `Atlas-xxxxxx` in your GitHub settings (Developer settings, GitHub
Apps) before you try again; an organization's App is under the organization's settings instead.
Otherwise it stays there with its keys.

If you finish in another browser, or lose the cookie, nobody becomes the owner by signing in.
Atlas does not let the first sign-in win. Instead, the API prints a one-time owner code on its
standard output each time it starts, while the App file exists and no owner does (and, for a
reconnect, while an owner exists and the App file is missing; see "Remove the connection"). Under
`pnpm dev` it is in the terminal that runs the stack. Enter it on the setup page ("Use owner
code") in the browser you want, then sign in. The code is created only when the API starts, so
restart the API to get a new one. It works once, and it and the cookie stop working as soon as
an owner exists. The cookie that marks the owner's browser lapses after 30 days.

Setup of a fresh installation is open to whoever can reach the API. The API listens on loopback
only, so that means a process on the same machine. Once an owner exists, every setup request
needs the owner's session, with one exception: while the App file is missing, the owner code
printed at start opens setup again (see "Remove the connection").

### Sign-in, members and sessions

- Sign-in uses GitHub's authorization-code flow with `state` and PKCE and asks for no scopes.
  Atlas reads your account number, login, name and avatar, and discards the GitHub token at
  once (it asks GitHub to revoke it). Atlas stores no GitHub token.
- The owner can always sign in. The owner adds other people in Settings (the user menu in the
  Board header) by their GitHub login. The entry shows "Invited" until that person first signs
  in, when Atlas binds it to the account's number; after that a renamed or re-registered login
  cannot take it over.
- A person whose account is not in the list sees a message naming the account they signed in
  with, so they can tell if they used the wrong one.
- There is one owner and one other role, member. Only the owner manages members or runs setup
  again. Ownership cannot be transferred and the owner cannot be removed.
- Every signed-in person sees and can change every project and task. Members are checked on every
  request, so removing one takes effect at once.
- A session lasts 30 days from its last use. The cookie is `atlas_session`, with `HttpOnly` and
  `SameSite=Lax`, and `Secure` when `ATLAS_BOARD_ORIGIN` is `https`. Atlas stores only a hash of
  the session ID. Sign out from the user menu. Removing a member ends their sessions. An open
  terminal socket closes at once on sign-out and on member removal; if the session ends another
  way, for example by expiry, it closes within 30 seconds, and the Board is told with close code 4401.
- The request log leaves out the query strings of the two GitHub callback addresses, which carry
  a code and `state`.

### Settings

| Setting                 | Meaning                                                                                                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ATLAS_AUTH`            | API. `github` (default) or `off`. Any other value, including an empty one, stops the API at start.                                                                                                                                  |
| `ATLAS_GITHUB_APP_FILE` | API. Path of the App file. Default `.atlas/github-app.json`. `pnpm dev` resolves it from the repository root; for an API started by itself, use an absolute path, because the API package runs from its own folder.                 |
| `ATLAS_GITHUB_API_URL`  | API. GitHub's REST address. Default `https://api.github.com`. For tests that point the API at a stand-in; leave it unset.                                                                                                           |
| `ATLAS_GITHUB_WEB_URL`  | API. GitHub's web address. Default `https://github.com`. For the same purpose; leave it unset.                                                                                                                                      |
| `ATLAS_GIT_HOST_URL`    | Worker. The Git host the Worker uses for GitHub repositories. Default `https://github.com`; `http` is accepted only for a loopback address. `pnpm dev` passes it to the container. Atlas does not use it for sign-in; cloning does. |

If you change `ATLAS_BOARD_ORIGIN`, GitHub still holds the old addresses. In the App's settings
on GitHub (Settings, Developer settings, GitHub Apps, your App; for an organization's App, the
organization's settings) update the homepage URL, the
callback URL (`<Board origin>/api/v1/auth/github/callback`) and the setup URL
(`<Board origin>/?github=installed`). Until you do, sign-in returns to the old address.

### The App file

The API keeps the App's ID, name, owning account, client ID, client secret and private key in
one file, by default `.atlas/github-app.json` (ignored by Git), created with mode `0600`. The
API never returns or logs these values. Treat the file like `worker-token`, only more
sensitive: the private key can act as the App on every repository you installed it on.

- Never commit it, paste it into a chat, a ticket or a log, print it, or copy it into a
  backup that others can read.
- Keep it out of any Worker's workspace root and state directory, and do not mount it into a
  container. The API refuses to start when the file lies inside the workspace root of a Worker
  registered in its database, and when the file exists but cannot be read as an App file.
- The mode protects it only on a Linux filesystem. On a Windows drive under WSL, where this
  checkout normally is, modes do not apply and the file is as protected as your Windows account.
- If it may have leaked, delete the App on GitHub and remove the connection as described below.

### Run without sign-in

Set `ATLAS_AUTH=off` in `.env` or the environment and restart. The API then behaves as it did
before sign-in existed: no sign-in, no setup, no GitHub features, and no session needed for any
route. The Board shows a permanent notice that sign-in is off. Anyone who can reach the API can
use Atlas, so keep it on loopback. The App file, users and sessions are left as they are; set
`ATLAS_AUTH=github` again to return to them. Automated tests and `scripts/e2e-server.mjs` run
with sign-in off.

### Remove the connection

Removal is manual.

1. Stop Atlas.
2. Delete the App file.
3. Delete the App on GitHub: Settings, Developer settings, GitHub Apps, the App, Advanced,
   Delete (for an organization's App, start from the organization's settings). Without this the App and its keys stay valid on GitHub.
4. Start Atlas again and create a new App. If setup never got as far as an owner, setup is open
   as on a first run. Once an owner exists, there are two ways in:
   - A browser where the owner is still signed in shows the setup page and runs setup as on a
     first run.
   - Any other browser shows "Reconnect Atlas to GitHub". The API prints an owner code at start
     while an owner exists and the App file is missing; the line says that the GitHub connection
     is missing. Under `pnpm dev` it is in the terminal that runs the stack. Enter it there ("Use
     owner code"), then create the App. This is the way back when the owner's session is gone, for
     example after 30 idle days, cleared cookies or another browser or machine.
5. Install the new App on your repositories, then sign in. The owner signs in with their own
   GitHub account as before, and members do too.

The owner code works the same way as on a first run: it is random, only its hash is stored, it
works once, and only the API's start creates one, so restart the API to get a new one. It is
printed only on that start; it never appears in a response or the request log. Entering it gives
the browser the cookie `atlas_setup_reconnect`, which lets it run setup; it ends when the App file
is written and lapses after one day. It never makes anyone the owner: the owner stays the account
recorded in the database, bound by its GitHub account number, and anyone else who signs in is
admitted only as a member the owner added. With an owner and an App file, no code is printed and
the setup routes need the owner's session. Anyone who can read the API's output can therefore
connect a new App, the same trust the first-run code relies on.

What stays: the users, members and their sessions, and all projects and tasks, remain in the
database. Until setup is done, every route that needs a session answers 409 `setup_required`, and
the Board shows the setup page. Sessions do not depend on the App file, so signed-in people stay
signed in, and members stay bound to their account numbers. Links keep their repository IDs; the
new App must be installed on those repositories for them to work. Atlas has no way to change the
owner; starting with no users means deleting the database, which also deletes projects and tasks.

### Known limits of sign-in and setup

- The check that keeps the App file out of a Worker's workspace root compares the App file's path,
  as the API sees it, with the workspace root each registered Worker reported. `pnpm dev` mounts
  the workspace and the Worker state directory into the container at the same paths as on the
  host, so for `pnpm dev` the check compares the right paths. It cannot see the file when a
  container mounts the workspace at another path than the host's, when the same folder is
  reached by two different paths (for example `/mnt/c` names that differ only in letter case,
  because the comparison is case-sensitive), or for a Worker that has not registered yet. It
  does not check the Worker state directory. Keep the App file out of both folders yourself.
- A browser without the owner's session sees "Reconnect Atlas to GitHub" after the connection
  was removed. It needs the owner code from the API's output; nothing on the page can produce one.
- The API is meant to listen on loopback. Pending sign-ins and setups are held in memory, capped
  (100 sign-ins, 50 setups), and lost when the API restarts; start again if you restart in the
  middle.
  Hosting Atlas for other machines (HTTPS, a public address, a token per Worker) is not
  supported.
- Anyone who can run a process on the machine can reach the API. Sign-in stops them using it; it
  does not stop them reading `.atlas/`.
- The browser sends a `localhost` cookie to every port on `localhost`, so another local web
  service receives the session cookie and can overwrite it.
- A Worker run natively, or with `ATLAS_AGENT_SANDBOX=off`, runs its agents as your own account.
  Such an agent can read the App file if it lies where your account can read it.
- Live checks against real GitHub on 2026-11-25 covered `localhost` addresses in the manifest
  flow, creating an App with no webhook, sign-in of the App's owner, and revoking a token early.
  Sign-in from a second GitHub account and one further check were not tried; see "What was
  checked, and what was not" in
  `docs/superpowers/specs/2026-11-25-github-connection-design.md`. The manual steps are in
  `docs/development/acceptance.md`, not yet run.

## GitHub repositories

With sign-in on and the App installed, a project can be linked to a GitHub repository, and a new
project can be created by cloning one onto a Worker. Both need only the App and its installation;
nothing else is set up. With `ATLAS_AUTH=off` neither works: the repository and link routes
answer 409 `github_unavailable` and the Board does not offer the clone choice.

### Link a project to a repository

- Any signed-in person, member or owner, can link and unlink. Every signed-in person sees the
  names of all repositories the App can access.
- Only a ready project created from a folder on a Worker (the "New local repository" form, or a
  clone) can be linked. A project made with "Existing repository" only records a URL and cannot be
  linked. Select the project, then open Settings (the user menu in the Board header): the repository
  section shows the link, or a picker with "Link", and "Unlink".
- A project has one link. The same repository can be linked to several projects.
- The Board lists the repositories the App can access, and a link to GitHub's page for changing
  that selection. A repository that is not in the list was not selected for the App; choose it on
  GitHub.
- The Board warns "The GitHub App can no longer reach this repository" when the App no longer
  covers the repository (the API reports `accessible: false`), because the owner
  removed it from the App's selection or replaced the App, or when GitHub cannot be reached at
  that moment. Choose the repository for the App again on GitHub, or unlink. The link keeps the
  name and default branch it had when it was made.
- Linking changes nothing in the folder and sends nothing to the Worker, and Atlas does not check
  that the repository's history matches the folder's.
- Unlinking is refused (409 `project_not_linkable`) while the project's own clone is still
  running, because the clone needs the link to be sent again after a reconnect.

### Clone a repository into a new project

1. Start the Worker with a version that can clone (`pnpm dev` builds the image on every start). A
   Worker that cannot clone is not offered for this choice; an API that is older than the Worker
   refuses the Worker's registration, so update the API first.
2. In "New project" choose "Clone from GitHub", pick a repository, a Worker and a folder. The
   folder is relative to the Worker's workspace, is filled in with the repository's name, and
   must not exist. Its first part must not start with a dot.
3. The project shows "Cloning your repository" until the Worker finishes. Large repositories take
   minutes.

What the Worker does: creates the folder and journals it, runs `git init` in it, asks the API for
a credential, reads the repository's default branch with `git ls-remote`, fetches every branch
with `git fetch`, then adds `origin` (an address without any credential), checks out the default
branch and writes the journal stage `cloned`. It fetches no submodules and no LFS content, and
runs no hooks. The command is `succeeded` only after every step succeeded. An empty repository
succeeds with nothing checked out. If the repository has branches but the Worker cannot tell the
default one after the fetch, the clone fails with `default_branch_unknown` and the folder stays;
a token the Worker cannot use fails with `invalid_credential`.

- Two Git processes hold the token, one after the other, not one. Git 2.39 in the Worker image
  cannot report the remote's default branch from a fetch, so `ls-remote` reads it first. Both are
  started the same way, neither runs repository content, and the steps that check out files never
  hold the token.
- Those two processes run with a clean Git environment: the system and the user Git configuration
  are ignored, every other credential helper and prompt is off, redirects are not followed, TLS
  verification is on, and only `https` is allowed. A system-wide `http.proxy` or `sslCAInfo`
  inside the Worker image or on the Worker host is therefore not used for a clone.
- The Worker builds the address from `ATLAS_GIT_HOST_URL`, default `https://github.com`. It
  accepts `http` only for a loopback address (the tests' stand-in) and refuses to start with any
  other `http` address. `pnpm dev` passes the setting to the container.
- Time limits: each of the two token-holding Git steps is ended after 30 minutes
  (`clone_timeout`); each local step after 10 minutes; the Worker waits 30 seconds for the API's
  credential reply. Creating a task's worktree has a 30-second limit of its own; check it with a
  large repository (see `docs/development/acceptance.md`).
- If the command fails or is refused after the folder was created, the folder stays, as with a new
  local repository, and the project is `failed`. A clone refused before that (`invalid_target`,
  `invalid_repository`) creates no folder, and a folder that already existed is left untouched. Atlas has no retry, cancel or delete for a project. Create a new project
  with another folder name, or look at the folder, remove it on the Worker's disk and reuse its
  name. If the Worker stops while a clone runs, the Git process is ended and the project ends
  `needs_attention`: inspect the folder before you use the name again.
- A clone still queued when the Worker stops has not started; the API sends it again when the
  Worker registers again. A clone the API sent while the Worker was offline waits the same way.
- The `repository.clone` capability: the API creates a clone only on an online Worker that
  registered it, otherwise it answers 503 `worker_unavailable` and writes nothing. Older Workers
  keep working for new local repositories and sessions.

### Credentials

- The API gives a Worker a token for one command: one repository, read-only Contents, with the
  lifetime GitHub sets (up to one hour). The token is never inside the command. The Worker asks
  for it when it is about to run Git, over the Worker socket, and the API answers only for a
  clone it sent on that same connection, once per send, and refuses a command that has finished.
- The 15-minute window counts from the latest send of the command and limits only when a token
  may be issued. A token issued inside the window keeps working after it. A token is revoked at
  the first of: the command's result, the Worker's Git time limit after the grant (61 minutes),
  the API stopping, and a newer grant for the same command. A grant that could not be delivered is
  revoked at once.
- At most three requests per send reach GitHub; a fourth is refused without asking GitHub.
- Refusals and when they happen: `unknown_command`, `wrong_connection` (another Worker's command,
  or another connection), `command_finished`, `wrong_kind` (not a clone), `already_granted` (a
  token was given or is being requested, or three attempts were used), `grant_window_closed`,
  `github_unavailable` (sign-in is off, the App file is unreadable, GitHub failed or took longer
  than 20 seconds, or the API is stopping), `app_file_exposed` (the App file lies in a Worker's
  workspace) and `repository_not_accessible` (no link, or the App no longer covers the
  repository). A refusal fails the clone with that code and message. If the repository was
  renamed, the clone fails with `repository_renamed`. The project is then `failed` and cannot be
  linked again (only a ready project can), so create a new project for the repository's new name,
  with another folder name or after removing the left-over folder.
- The API logs one line for every grant and refusal: the command, the Worker, the repository and
  the rights (`contents:read`). It never logs the token.
- The token is held in memory by the API and the Worker. It never reaches the database, the
  Worker journal, a Git configuration, a command line, a log or a task's agent: the Git processes
  run outside the agent sandbox, an agent cannot read another process's environment or the Worker
  state directory, and by default its network filter does not allow GitHub's hosts. Do not add
  GitHub hosts to `ATLAS_AGENT_ALLOWED_DOMAINS`, and do not run an unsandboxed Worker if this
  matters to you (see "What the sandbox does not protect").
- If the API crashes, it forgets which tokens it handed out and cannot revoke them. They stay
  valid until GitHub expires them, at most an hour after they were issued.

### Compatibility

- A project path whose first part starts with a dot is refused: the API answers 400
  `invalid_relative_path` when you create a `local` project, and the Worker refuses it too.
  `.atlas-worktrees` holds task worktrees, and a project inside it would sit in a folder agents
  can write. A project that already has such a path stays in the list, but its sessions cannot
  start: the session ends at once with the message "Choose a relative folder path without dot
  segments, not starting with a dot". Atlas cannot change a stored project's path, so create the
  project again under another name.
- An older Worker without `repository.clone` keeps working for `repository.init` and sessions; a
  newer API never sends it a clone. The reverse needs the API updated first.
- New Worker messages: `credential.request`, `credential.grant` and `credential.refusal`. See
  `docs/development/protocol.md`.

### Known limits of linking and cloning

- A cloned repository brings its own agent instructions and settings, and agents run with their
  permission prompts off. Agents can also read other projects' checkouts on the same Worker. A
  hostile repository could therefore steer an agent to read another project. Nothing leaves the
  machine through Atlas until pushing exists, which has to settle this; until then clone only
  repositories you trust.
- The workspace is normally on a case-insensitive Windows drive, a setting several past Git clone
  flaws needed. The image's Git (2.39.5 when checked) carries the fixes for the known ones, see
  `docker/worker/README.md`; rebuilding the image picks up later Debian fixes. Check the
  version again when you rebuild.
- The check that keeps the App file out of a Worker's workspace root runs at start and at every
  grant, only for Workers registered in the API's database. For `pnpm dev` it compares the right
  paths, because the container sees the workspace at the host's path; for other cases see "Known
  limits of sign-in and setup".
- Stopping or restarting the API while a clone runs revokes the clone's token, so Git's next
  request to GitHub fails and the clone ends `git_failed`; the project is `failed` and its folder
  stays. In development `pnpm dev` runs the API under a file watcher, so saving an API source file
  restarts it and has the same effect. Let a clone finish before you stop or change the API.
- A second clone queued behind a clone that runs longer than 15 minutes is refused with
  `grant_window_closed`: the window counts from the send, and the Worker runs commands one at a
  time. The refused clone's folder remains on the Worker, so create the project again after the
  first clone finishes, with another folder name or after removing that folder.
- A clone that stays pending blocks unlinking its project, and there is no way to cancel it.
- With sign-in off, a create request that carries `githubRepositoryId` currently ignores the field
  and initializes an empty repository. This is the current behaviour and it is under review; the
  Board does not offer the choice with sign-in off.
- A Worker run natively, or with `ATLAS_AGENT_SANDBOX=off`, runs its agents as your own account,
  which can read the environment of the Worker's Git processes while a clone runs.
- All Workers share one token; whoever has it can register as an offline Worker and receive its
  commands, and so its credentials.

## Docker in WSL

Install Docker Engine inside the WSL distribution; Docker Desktop is not needed. On Arch,
which this project was built on, that was `pacman -Syu docker socat`. It is a full system
upgrade; other distributions use their own packages and commands. Without systemd the
Docker service does not start by itself. When `pnpm dev` or `pnpm worker:login` runs as
root without systemd and the service is down, it starts `dockerd` itself and writes its
log to `/var/log/dockerd.log`. Otherwise it prints that the service is not running; start
it with your init system or run `dockerd` yourself, then run the command again.

## Agent login

Agents run as the container user `atlas` (UID 1001). Their login lives in the Docker volume
`atlas-agent-home`, which is the container user's home directory. Run `pnpm worker:login`
once and log in inside the container. The volume holds a real login; never delete it, or you
must log in again. All agents of the Worker share this login.

## Agent sandbox

The Worker wraps every agent in the sandbox runtime `@anthropic-ai/sandbox-runtime`
(`srt`, version 0.0.83) inside the container. The container uses a narrow seccomp profile,
`docker/worker/seccomp.json`; see `docker/worker/README.md`. It also runs with
`--cap-drop ALL` and `--security-opt no-new-privileges`. An agent can write only:

- its task's worktree;
- in the project's main checkout, `.git/worktrees/<this worktree>`,
  `.git/refs/heads/atlas` and `.git/logs`;
- its own login and state paths. For Claude these are `~/.claude`, `~/.claude.json` and
  `/tmp/claude`. The Worker creates the folders (`~/.claude` and `/tmp/claude`) before it
  starts the sandbox, because the sandbox can make only an existing folder writable.

It cannot read the Worker state directory and reaches only the servers its profile allows:
for Claude `api.anthropic.com`, `*.anthropic.com`, `claude.ai`, `*.claude.ai` and
`*.claude.com`. Because the sandbox enforces this, Claude starts with
`--dangerously-skip-permissions`, so the Board shows its permission-bypass warning. It still
asks the folder-trust question and real questions about the task; answer them on the Board.
When a session starts, the terminal first shows `Atlas: agent sandbox on...`.

If `srt` or its prerequisites are missing, or the sandbox does not start, the session ends
with a message naming the cause and the agent is not started.

The sandbox puts placeholder files in the worktree for names it protects, which would break
`git add -A`. The Worker therefore gives the agent a Git excludes file, through the agent's
environment, that ignores these thirteen paths at the worktree root: `.bash_profile`,
`.bashrc`, `.claude/agents`, `.claude/commands`, `.gitconfig`, `.gitmodules`, `.idea`,
`.mcp.json`, `.profile`, `.ripgreprc`, `.vscode`, `.zprofile` and `.zshrc`. Repository files
are not modified. The side effect: a new file with one of these paths at the worktree root is
not shown by `git status` and is not added by `git add -A` for the agent; it must be added by
name. The same names in subfolders are not covered.

The placeholders can stay in the worktree as empty read-only files after a session ends. Git
run outside the agent session, without the excludes file, lists them as untracked.

Treat a task worktree as untrusted on the host. Look at an agent's work from the project
folder, for example `git log atlas/task-<id>` or `git diff main...atlas/task-<id>`, and do not
run Git or open an editor that runs Git inside the worktree folder. The sandbox stops the agent
from rewriting the files that link a worktree to the project repository (`commondir`, `gitdir`
and `config.worktree` in the worktree's Git folder), and the Worker checks those links before
it reuses a task folder. Other routes stay open, because the rest of the worktree's Git folder
and the worktree itself are writable for the agent. Examples: a planted rebase in progress
whose steps run commands when you continue it, a nested repository inside the worktree, and a
project that keeps its Git hooks in the working tree.

The agent cannot write to the project's Git object store (`.git/objects`), so it cannot change
or replace stored file contents, including those of `main`. It still decides which new objects
the Worker adds there, so it can fill the store with objects of its own. Its own commits go to an object folder of its
own, `.git/worktrees/<this worktree>/objects`, which the Worker sets through the agent's
environment (`GIT_OBJECT_DIRECTORY` and `GIT_ALTERNATE_OBJECT_DIRECTORIES`). The Worker copies
the task branch's new objects into the project's store about every two seconds while the branch
moves, and once more when the session ends, before the Board shows it as ended. Git names every
copied object by its content again, so changed content cannot arrive under another object's
name. What this means in use:

- Right after an agent commits, `git log atlas/task-<id>` in the project folder can fail with
  `bad object` for a moment. Commands that read every branch, such as `git gc` or
  `git branch -v`, can report the same until the copy is done.
- If a copy fails while the session runs, nothing is shown and the branch stays unusable in
  the project folder until a later copy works. If the last copy fails, the session ends with
  "The agent's commits could not be copied into the project repository" and the cause. The
  commits are then still in the agent's object folder.
- Git run on the host inside the task worktree does not see the agent's object folder, so it
  reports missing objects for files the agent staged or committed there. Look at the work from
  the project folder, as described above.
- The Worker's Git reads the packs and loose objects the agent wrote, outside the sandbox. It
  checks every object before storing it, but a fault in Git's own reading of a crafted pack
  would not be contained.
- If the Worker is killed before the last copy, the next session for the task copies them.
  Deleting the task's worktree before that loses them.
- Only the task branch is copied. Other branches an agent creates under `atlas/` stay unusable
  in the project folder.
- The two variables apply to every Git command the agent runs, also in a repository it creates
  or clones inside the worktree, whose objects then land in the agent's object folder.

Codex is in the image but has not been verified under the sandbox. Treat it as unverified.

## Worker settings

Set these in `.env` (see `.env.example`) or the environment; `pnpm dev` passes them to the
container.

| Setting                       | Meaning                                                                                                                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ATLAS_AGENT_COMMAND`         | The agent command, split on spaces. Default `claude`. A custom command is wrapped in the sandbox too and may reach no servers unless `ATLAS_AGENT_ALLOWED_DOMAINS` lists them.                                        |
| `ATLAS_AGENT_SANDBOX`         | `required` (default) or `off`. `off` runs the agent unwrapped with its normal permission prompts. It exists for tests with a stand-in agent; no command sets it.                                                      |
| `ATLAS_AGENT_ALLOWED_DOMAINS` | Comma-separated extra hosts the agent may reach, for example `registry.npmjs.org,*.example.com`. Entries are bare host names (wildcards like `*.example.com` allowed), with no scheme, path or spaces. Default empty. |
| `ATLAS_AGENT_GIT_NAME`        | Name for the agent's commits.                                                                                                                                                                                         |
| `ATLAS_AGENT_GIT_EMAIL`       | Email for the agent's commits.                                                                                                                                                                                        |

The container cannot see your `~/.gitconfig`. `pnpm dev` fills in only the values that
are missing, from the host's `git config user.name` and `user.email`. The Worker applies the
identity only when both name and email are set; otherwise Git reports the missing identity when
the agent commits.

## What the sandbox does not protect

- All agents in a Worker share one login folder and can read and write it. One
  task's agent could read the credentials or change the agent settings used by
  the others.
- An agent can read other tasks' worktrees and the main checkout.
- An agent can move or delete another task's `atlas/` branch pointer. It cannot change or
  replace objects in the project's Git object store.
- The six extra system calls (`clone`, `clone3`, `unshare`, `mount`, `umount2`,
  `pivot_root`) are among the more sensitive ones Docker blocks by default. The
  narrow profile is tighter than no filter and looser than Docker's default.
- The container uses host networking.
- Anyone running the image elsewhere needs the seccomp profile file as well.
- Sessions and their output still live in memory only.
- The Worker lock decides liveness by PID, which cannot be seen across PID namespaces. A
  natively started Worker and the container Worker pointed at the same state directory can
  each treat the other's lock as stale and take it over, and two containers sharing a state
  directory (same PID) take over each other's lock. Never run a native Worker against the
  state directory `pnpm dev` uses while the container runs.

The sandbox is verified only inside the container. A Worker run natively with the sandbox
required is not supported and fails closed.

## Configuration

Optionally copy `.env.example` to `.env` and customize values. The combined
launcher resolves relative database/workspace/state paths from the repository
root. Worker state must remain outside project repository targets. A new local
repository path is relative to the displayed workspace; its parent must already
exist and the final folder must not exist. The first part of the path must not start with a
dot: the API answers 400 `invalid_relative_path` and the Worker refuses it too, because
`.atlas-worktrees` holds the task worktrees. Existing Git URL mode only records a
URL and never clones it.

For independently started apps (a native Worker without the container, for debugging
only; its sessions need `ATLAS_AGENT_SANDBOX=off`, and the agent then runs unsandboxed as your
own account and can change anything that account can), export the same
`ATLAS_WORKER_TOKEN` to API and Worker, use absolute filesystem paths, and run:

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

Run `pnpm setup:hooks` once after cloning to enable the repository's commit-message
hook. It checks messages without modifying source or tests.

## Browser verification and troubleshooting

Run `pnpm test:e2e` for browser acceptance. Install Playwright Chromium with
`pnpm exec playwright install chromium` if needed; its platform runtime libraries
must also be available. Browser tests use temporary data and separate ports
configured in `playwright.config.ts` and `scripts/e2e-server.mjs`.

The startup helper waits for the API and the intended Worker to be online before
starting the Board. A reachable Board alone does not mean the stack is ready.
Any replacement harness must clean up its child processes and temporary state
on success, failure and interruption. Keep personal `.atlas` data out of tests.

If the Worker is missing or offline:

1. Check API and Worker startup output, then request `/api/v1/workers` on the
   configured API port to inspect registration and availability. With sign-in on this route
   needs a session, so open it in the browser where you are signed in.
2. Confirm the Worker WebSocket URL points to that API and both processes use
   the same token. Do not print or paste the token into logs or the Board.
3. Check for a duplicate Worker identity or an already-running process using
   its state directory. Inspect ownership before stopping any process; do not
   delete a lock or journal to bypass the problem.
4. Confirm the workspace and state paths are accessible Linux paths, with Worker
   state outside the repository workspace. Preserve journals when investigating
   failed operations or reconnects.

For an occupied test port or missing browser dependency, report the environment
problem separately from application failures. Do not weaken tests to hide it.
