# GitHub connection: sign-in and repository access

Status: approved by the user, 2026-11-25, as revised that day after an independent
review; "Review record" at the end lists what changed.

## Intent and scope

Atlas is software a person installs for themselves or their team. It is not a
service: every installation has its own API, Board and Workers, and a Worker
belongs to one installation. Today an installation has no users and no link to
any Git host. Projects are folders on a Worker and task branches stay there.

The user wants one GitHub connection per installation that does two jobs:

1. People sign in to Atlas with their GitHub account, so an installation has
   users.
2. Atlas gets narrow access to chosen GitHub repositories, so that the next
   iteration can push task branches and open pull requests.

This design covers sign-in, creating the connection, linking a project to a
repository, cloning a repository into a new project, and how a Worker receives a
short-lived credential. Pushing a task branch and opening the pull request is
the next iteration; "What the push iteration needs" lists what it builds on.

## Goals

- An installation has users, identified by GitHub account. The API and the
  Board's session socket refuse anyone who is not signed in.
- The owner of an installation decides which GitHub accounts may sign in.
- Atlas can reach only the repositories the owner picked on GitHub, with only
  the rights it needs.
- Atlas stores no person's GitHub token.
- A Worker never holds a long-lived GitHub credential. It receives a token for
  one repository, valid for at most one hour, only while it runs a command that
  needs it.
- An agent running in the Atlas sandbox, in the Worker container, cannot read a
  GitHub credential.
- Everything built works unchanged when an installation is later hosted for a
  team.

## Non-goals

- Hosting: HTTPS, a public address, an API reachable from other machines, a
  token per Worker. Atlas stays on loopback this iteration.
- Pushing task branches and opening pull requests.
- Atlas creating a repository on GitHub. Whether an App can do this in a
  personal account was not settled by GitHub's documentation.
- Per-user project ownership, private projects, or roles beyond owner and
  member.
- Turning signed-in users into task assignees. The seeded person
  `human:vladi` stays as it is.
- Webhooks from GitHub. A local installation has no address GitHub can reach.
- Git hosts other than github.com, including GitHub Enterprise Server. Keep the
  GitHub addresses configurable so tests can point at a stand-in.
- Changing the `existing` project mode, which records a Git URL and never
  clones it.
- Git LFS and submodules when cloning.
- Repositories in more than one GitHub account per installation. See "One
  account per installation".

## Anti-goals

- A credential that a sandboxed agent can read: in its environment, in its
  worktree, in the project's Git config, or in the Worker state directory.
- A GitHub token written to disk anywhere: the database, the Worker's command
  journal, a Git config or a log.
- Sign-in that can be switched off without anyone noticing. Running without
  sign-in must be an explicit setting and visible on the Board.
- Rights wider than needed "for later", other than the pull request right named
  below.
- An installation whose owner is "whoever came first".

## Approaches

**What kind of GitHub connection.** Three were compared.

- A GitHub App per installation. The owner creates it once from Atlas's setup
  page. Sign-in through it grants no repository rights. For repository work the
  API asks GitHub for a token that lasts one hour and can be limited to one
  repository and to a subset of the App's rights. The owner chooses on GitHub
  which repositories the App may touch. It costs the most setup code.
- An OAuth App. Simple sign-in, but repository work needs the `repo` scope:
  read and write on every repository the person can reach. Its tokens do not
  expire by default and are a person's tokens.
- A fine-grained personal access token pasted in by the owner. Least code and
  limited to chosen repositories, but it gives no sign-in, acts as the owner
  personally, and may never expire.

The user chose the GitHub App. It is the only one that gives sign-in and a
narrow repository credential from one connection.

**Who GitHub shows as the author of a push or pull request.** The App's bot
(`<app name>[bot]`), using the App's own token, or the person who started the
session, using that person's token. The second needs every user's token and
renewal token stored in Atlas, and such a token reaches every repository that
both the person and the App can access. The user chose the bot.

**How a Worker gets a credential.** Three were compared.

- The API keeps the App's key, asks GitHub for a narrow one-hour token when a
  command needs one, and hands it to the Worker over the existing socket.
- The Worker holds the App's key. Every Worker could then mint tokens for every
  repository, and the key would sit in the container that runs agents.
- The API does the Git work. Not workable: the checkout is on the Worker's
  machine, which in a team installation is not the API's machine.

The user chose the first.

Other decisions by the user:

- Atlas is self-hosted, for one person or a team, and is not a service.
- Projects reach GitHub both ways: a project started in Atlas is connected to a
  repository, and a repository already on GitHub is cloned into a new project.
  Connecting is built first.
- Sign-in is remembered per browser; the user is not asked on every visit.
- An explicit setting turns sign-in off so that existing tests stay unchanged;
  see "Running without sign-in".

Within an installation every signed-in user sees and can change every project
and task. This is the author's reading of "personal or team usage", stated to
the user and not contradicted; it is not a choice the user made between
alternatives.

## What was checked, and what was not

Checked against GitHub's documentation on 2026-11-25:

- Creating an App from a manifest returns its ID, slug, client ID, client
  secret and private key in one exchange, for a personal account or an
  organization. The whole flow must finish within one hour.
- A token for an App installation expires after one hour and can be limited to
  named repositories and to a subset of the App's rights when it is requested.
- Git over HTTPS with such a token uses the user name `x-access-token` and the
  token as password. Pushing needs the "Contents" right; opening a pull request
  needs "Pull requests".
- Sign-in through a GitHub App uses no scopes. The resulting token can do only
  what both the person and the App may do. Reading the person's own account
  (`GET /user`) is listed under no App right. PKCE (`S256`) and `state` are
  supported and recommended. The return address must match a registered
  callback address exactly, port included.
- A pull request opened with an installation token is shown as the App's bot.
- A ruleset that requires pull requests on the default branch does not stop a
  push of another branch such as `atlas/task-<id>`.
- An App that is not public can be installed only on the account that owns it,
  and when an organization owns it, only that organization's members can sign
  in through it. (Reported by the reviewer from the documentation.)
- After installation GitHub sends the browser only to the App's "Setup URL".
  The installation ID in that redirect can be forged and must not be trusted.

Tested live on 2026-11-25, with the user at the browser, against a throwaway
App (`Atlas-check-…`, owned by the user's personal account, installed on one
test repository):

1. The manifest flow accepts `http://localhost` addresses. GitHub redirected to
   `http://localhost:5173` after creating the App, and again to the Setup URL
   after installation. Setup uses the manifest flow; the manual registration
   fallback is not built.
2. An App can be created from a manifest with no webhook section. The App came
   back with the three rights (`contents: write`, `pull_requests: write`,
   `metadata: read`) and no events.
3. The account that owns the App signed in through it (PKCE, no scopes).
   Sign-in from a second GitHub account was not tried, so "only that account"
   remains the documented expectation, not a tested fact. Atlas does not rely
   on it: a person signs in only when their GitHub ID is the owner's or a
   member's.
4. GitHub lets the API revoke an installation token early. A token minted for
   one repository with `contents: read` answered 200,
   `DELETE /installation/token` answered 204, and the same token then
   answered 401.
5. Not tested this iteration: whether a push from an App without the
   "Workflows" right is rejected when the branch changes files under
   `.github/workflows` (expected: yes). It only matters for the push
   iteration.

## Design

### The GitHub App

Each installation has one GitHub App. Its settings:

- Repository rights: Contents read and write, Pull requests read and write,
  Metadata read (GitHub requires it). Pull requests is unused this iteration. It
  is requested now because adding a right later needs the owner to approve it
  again on GitHub.
- Not the Workflows right. With it the bot could change a repository's
  automation, which can read that repository's stored secrets. The cost is
  recorded under "What the push iteration needs". This is the author's call.
- No organization or account rights. No events.
- Webhooks inactive.
- Not public.
- Sign-in callback: `<Board origin>/api/v1/auth/github/callback`.
- Setup URL, where GitHub returns after installation: a Board address.
- No "request user authorization during installation".

The Board reaches the API through the Board's own origin (the Vite proxy for
`/api/v1`), so GitHub's redirects go to the Board origin and cookies are
same-origin. The addresses come from the existing `ATLAS_BOARD_ORIGIN`. If the
owner later changes that origin, they update the addresses in the App's
settings on GitHub; document this.

### One account per installation

Because the App is not public, it can be installed only on the account that
owns it. So:

- An installation of Atlas works with the repositories of exactly one GitHub
  account: a person's or an organization's.
- An App owned by a personal account cannot reach an organization's
  repositories. To use Atlas on an organization's repositories, the App must be
  created under that organization, which needs a person allowed to create Apps
  there.
- For an organization's App, people who sign in must be members of that
  organization. For a personal App, the expectation is that only the owner can
  sign in at all (live check 3), so a personal installation has one user.

The setup page states these before the owner chooses the account. Making the
App public is not a fallback: anyone on GitHub could then install it, and Atlas
would have to decide which installations to trust. If a team needs members from
outside its organization, raise it with the user. This is the author's call.

### Where the App's secrets live

The App ID, slug, client ID, client secret and private key are stored by the API
in one file, by default `.atlas/github-app.json`, created with mode `0600`. A
new API setting names the file. This is the author's call, for these reasons:

- It sits beside `worker-token`, which is the same kind of secret.
- The Worker container mounts only the workspace root and the Worker state
  directory, so the file is not visible inside the container at all.
- Keeping it out of SQLite keeps it out of database copies and test databases.

The file must not be inside a workspace root or a Worker state directory. The
API refuses to start, and refuses to grant a credential, when the file's path
lies under the workspace root of any registered Worker. The API never returns
any of these values and never logs them.
(amended — see Amendments after approval)

`scripts/dev.mjs` must resolve the file's path from the repository root, as it
already does for the database path; the API package runs with its own folder as
working directory.

Removing the connection is manual this iteration: stop Atlas, delete the file,
start again. Users and project links stay in the database, and setup runs
again, under the rule in "Setup" that an existing owner must be signed in.
Links survive because Atlas asks GitHub at each use which installation of the
current App covers the linked repository. This is the author's call.

### Setup

While no App file exists, the installation is "not set up". In that state the
Board shows a setup page in place of everything else, and the API serves only:
the sign-in state endpoint, the setup endpoints, and the Worker socket, which
has its own token check and is independent of sign-in.

1. The owner reads the "one account" rules, optionally names an organization
   that should own the App, and starts setup. The API creates a one-time
   `state` value that expires after one hour, remembers it, and also binds it
   to this browser with an `HttpOnly` cookie. The Board posts the manifest and
   `state` to GitHub in a form.
2. On GitHub the owner confirms the App's name and creates it. App names are
   unique across GitHub, so the manifest proposes `Atlas` plus a short random
   suffix and the owner can change it there.
3. GitHub returns to `<Board origin>/api/v1/setup/github/callback` with a code.
   The API accepts it only with a `state` that it issued, that is unused and
   unexpired, and that matches this browser's cookie. It exchanges the code,
   then asks GitHub, using the new key, what App this is, and checks that the
   App is not public and has exactly the rights the manifest asked for. If any
   check fails it stores nothing and says why.
4. The API writes the App file and gives this browser a setup mark: a random
   secret in an `HttpOnly` cookie, whose hash the API keeps. The Board shows
   the App's name and owning account and a button to continue.
5. The browser goes to GitHub's page for installing the App, where the owner
   picks the repositories. GitHub returns to the Setup URL on the Board.
6. The owner signs in. A sign-in becomes the owner only if the database has no
   owner and the browser carries the setup mark. The mark does not expire by
   time; it ends when an owner exists.
   (amended — see Amendments after approval)

If the setup mark is lost, for example the owner finishes in another browser,
nobody becomes owner by signing in. While the installation is set up but has no
owner, the API writes a one-time owner code to its own output at start, and the
sign-in page accepts it in place of the mark. There is no "first sign-in wins".
(amended — see Amendments after approval)

If the database already has an owner, every setup endpoint requires that
owner's session. Sessions do not depend on the App file, so the owner stays
signed in across removal and can run setup again; nobody else can.
(amended — see Amendments after approval)

Setup of a fresh installation is open to whoever can reach the API, which today
means a process on the same machine, because the API listens on loopback only.
A hosted installation needs a setup code from the start; that belongs to the
hosting work.

Atlas learns where the App is installed by asking GitHub with the App's own
key, never from values in a redirect.

Existing installations: with the default `ATLAS_AUTH=github`, the first
`pnpm dev` or `pnpm dev:web` after this change shows only the setup page until
the owner has created the App. This is intended; say so in the setup guide.

### Sign-in

1. The Board's sign-in page links to `GET /api/v1/auth/github/start`. The API
   creates a `state` value and a PKCE verifier, keeps them in a short-lived
   `HttpOnly` cookie, and redirects to GitHub's authorize page.
2. GitHub returns to the callback. The API checks `state`, exchanges the code
   using the client secret and the verifier, and asks GitHub who the person is.
3. The API keeps the numeric account ID, login, display name and avatar
   address, then discards the GitHub token. It is never stored. The builder may
   also revoke it at GitHub.
4. If the account may sign in, the API creates a new session and redirects to
   the Board. Otherwise the Board shows that this account has no access and
   names the account, so a person signed in to the wrong GitHub account can
   tell.

Sessions:

- A random session ID, created at sign-in and never taken from the request, in
  a cookie that is `HttpOnly`, `SameSite=Lax`, and `Secure` when the Board
  origin is `https`. The database stores only a hash of the ID.
- A session lasts 30 days from its last use. The stored last-use time need not
  be updated on every request.
- Signing out is a `POST` and deletes the session. Removing a member deletes
  all their sessions.
- No route that changes anything is a `GET`, apart from the two GitHub
  callbacks, which are protected by `state`.

Who may sign in:

- The owner, always.
- Members the owner added by GitHub login on a settings page. At a member's
  first sign-in Atlas binds the entry to the account's numeric ID and matches by
  ID from then on, so a renamed or re-registered login cannot inherit access.
- Membership is checked on every request, so removal takes effect at once.

Roles: `owner` and `member`. The only difference is that the owner manages
members and can run setup again. There is exactly one owner; transferring
ownership is not built.

The server logs requests. The two callback addresses carry a code and `state`
in their query string, so their query strings must be kept out of the log.

### What the API protects

Every `/api/v1` route requires a session, except:

- the sign-in state endpoint, the sign-in start and callback, and sign-out;
- the setup endpoints, under the rules in "Setup";
- the Worker socket, which keeps its own token check.

The existing checks on `Host`, `Origin` and JSON content type stay. The Board
session socket checks the session cookie at upgrade in addition to `Origin`,
and checks again at a regular interval while it is open, so a socket does not
outlive its session. When a user's sessions are deleted, their open Board
session sockets are closed at once.

A new endpoint, open to everyone, tells the Board which page to show: whether
sign-in is on, whether setup is done, and who is signed in.

The API records which user created a project or a task in the database. These
columns are not exposed through the shared contracts this iteration.

### Running without sign-in

A new API setting, `ATLAS_AUTH`, takes `github` (the default) or `off`. Any
other value, including an empty one, stops the server at start.

- `off` makes the API behave as it does today: no sign-in, no setup, and no
  GitHub features. The Board shows a permanent notice that sign-in is off.
- `buildApp` called from code without sign-in options also runs with sign-in
  off. The server entry point always reads the setting, so a started server has
  sign-in on unless the setting says otherwise.

The user chose this on 2026-11-25 over making every existing test sign in; see
"Tests". Its purpose is to keep the existing tests, which call the API without
signing in, unchanged. It follows the precedent of `ATLAS_AGENT_SANDBOX=off`.
(amended — see Amendments after approval)

### Linking a project to a repository

Any signed-in user can link a ready `local` project to a repository.

- The Board shows the repositories the App can access, with a link to GitHub's
  page for changing that selection. The API reads them from GitHub with the
  App's own credentials. There is one account, so there is no account picker.
- Linking stores the repository's numeric ID, its `owner/name` and its default
  branch. The API first confirms with GitHub that the repository is among those
  the App can access. The installation is not stored as a fact: whenever Atlas
  needs it, it asks GitHub which installation of the App covers the repository.
  If none does, because the owner withdrew the repository or replaced the App,
  the Board shows the link as not accessible and anything that needs GitHub
  fails with that message.
- A project has at most one link. A link can be removed.
  (amended — see Amendments after approval)
- Linking sends nothing to the Worker and changes nothing in the checkout. The
  push iteration can push to the repository's address directly, so no Git
  remote is needed, and the agent-readable Git config stays untouched.
- The link is its own resource under the project in the HTTP API, so the
  existing project shape does not change. This is the author's call, made to
  avoid changing responses that existing tests check.

Because the workspace is shared, every signed-in user can see the names of all
repositories the App can access.

Linking does not check that the repository's history matches the project's. See
"What the push iteration needs".

### Cloning a repository into a new project

Creating a project gains a third choice beside "new local repository" and
"existing Git URL": pick a repository the App can access.

- In the create request this is the `local` form with one added optional field
  naming the repository's numeric ID. The project is stored as a `local`
  project, with a Worker and a relative path, plus a link as above, so the
  session hub's check for a local checkout passes unchanged.
  (amended — see Amendments after approval)
- The API dispatches a new command kind, `repository.clone`, carrying the
  project ID, the relative path and the repository's `owner/name`. It carries
  no credential.
- A Worker that can clone registers a new capability. The API refuses to create
  such a project on a Worker without it.
- The Worker clones over HTTPS into a folder that must not exist, with the same
  path rules as `repository.init`. It does not fetch submodules or LFS content.
- The resulting `origin` address contains no credential.

Recovery is not the same as for init. Today a recovered init is reported as
succeeded when the folder is the one the Worker made and Git sees a repository
there (`apps/worker/src/repositories/initialize.ts`). A clone that was killed
partway would pass that test. So a clone gets its own journal stage, written
only after every Git step of the clone has exited successfully, and a recovered
clone that has not reached that stage is reported as `needs_attention`. The
journal's entry shape must accept both command kinds, and journal files written
before this change must still be readable.

A clone can take minutes, and the Worker runs commands one at a time and waits
for them when it stops. A clone must not hold up shutdown: when the Worker
stops, it ends the Git process, and the command is `needs_attention` on the
next start. `pnpm dev` stops the container after ten seconds.
(amended — see Amendments after approval)

Creating a session's worktree has a 30-second limit today. The builder checks
that limit against a real repository on the user's workspace, which is on a
Windows drive, and raises it if needed.

### Project paths

Found in review, and true today for `repository.init`: nothing rejects a
project path inside `.atlas-worktrees`, the folder that holds task worktrees.
A project created inside a task's worktree would have a Git folder an agent can
write, and the Worker later runs Git there outside any sandbox.

The API and the Worker both reject a project path whose first part starts with
a dot, for init and for clone. Existing projects are not affected unless one
already has such a path; if an existing test depends on such a path, stop and
ask the user.
(amended — see Amendments after approval)

### How a Worker receives a credential

Commands are stored by the API and journaled by the Worker, and are sent again
after a reconnect. A token inside a command would be written to disk in both
places and could be stale when the command is replayed. So the token is asked
for separately, at the moment it is needed:

- When the Worker is about to run Git for a command that needs GitHub, it sends
  a credential request naming the command ID.
- The API grants it only if that command exists, is not finished, is of a kind
  that needs a credential, and was dispatched on this same connection. Worker
  identity alone is not enough, because all Workers share one token today.
- The API gives one grant per dispatch of a command, and none later than a
  fixed time after that dispatch. A command dispatched again after a reconnect
  can be granted again.
  (amended — see Amendments after approval)
- The API asks GitHub for a token limited to that project's linked repository
  and to the rights the command kind needs: Contents read for a clone.
- The API answers with the token, its expiry and the repository's current
  `owner/name`, or with a refusal that has a code and a message. A refusal
  fails the command with that message. If the name differs from the one in the
  command, because the repository was renamed or moved, the Worker fails the
  command and does not clone.
- The API writes a log line for every grant and refusal: command, Worker,
  repository and rights, never the token.
- When the command's result arrives, or the time limit passes, the API asks
  GitHub to revoke the token, if live check 4 shows that is possible. For that
  it keeps the token in memory until then.
  (amended — see Amendments after approval)
- Neither side writes the token to disk or logs the message that carries it.

This is the first request and reply on the Worker socket. The reply names the
command ID. If no reply comes within a time limit, or the connection drops
while the Worker waits, the Worker ends the command as `needs_attention`
without having run Git.
(amended — see Amendments after approval)

How the Worker runs Git with the token:

- The token is not in the command line, in any Git config file, or in the
  remote's address. It is given through a credential helper that reads it from
  the environment of that one Git process and answers only for the configured
  Git host.
- That process fetches only. It is started so that it does not check out files,
  follow redirects, fetch submodules, run LFS, or read the user-level Git
  config; other credential helpers and terminal prompts are off; only HTTPS is
  allowed. Checking out the files is a second Git process that does not have
  the token.
  (amended — see Amendments after approval)
- Every Git process the Worker starts for a command gets an environment without
  `ATLAS_*` variables, as the session code already does. Today `git init` is
  started with the Worker's full environment, including the Worker token; fix
  that as part of this work.

The Worker builds the repository address from a Worker setting for the Git
host, by default `https://github.com`. Plain `http` is accepted only when that
host is a loopback address, which is what the tests' stand-in uses; with any
other `http` address the Worker refuses to start. The setting's name starts
with `ATLAS_`, so agents do not inherit it, and `scripts/worker-container.mjs`
must pass it to the container. This is the author's call.

Why a sandboxed agent cannot get the token: the Worker runs these Git processes
itself, outside any agent sandbox. An agent in the sandbox has its own process
view, so it cannot read another process's environment; it cannot read the
Worker state directory; and by default its network filter does not allow
GitHub's hosts. See "Known limits" for when this does not hold.

### Changes to shared contracts and existing code

These follow the repository's contract-change rules: document them in
`docs/development/protocol.md`, update validators and fixtures together with
both consumers, and check both directions of old and new.

- A second command kind. The message union is keyed on `type`, and both kinds
  have the type `command.dispatch`, so the dispatch message must become one
  message whose payload is a union on `kind`. The exported init command schema
  is used by the Worker and its journal.
- The API's dispatch code sends `repository.init` for every pending operation,
  and the operations table records no kind. The table needs a kind. Do not add
  it to the operation shape returned over HTTP.
- A new capability. The accepted capability lists are exact, so an older API
  refuses a newer Worker's registration outright, and a newer API accepts an
  older Worker and simply never sends it a clone. Document both.
- The credential request, grant and refusal messages.
- The optional repository field in the project create request.
- The new HTTP endpoints for sign-in, setup, members, repositories and links.

### What the push iteration needs

Not designed here. It can rely on:

- the project's link: repository ID, `owner/name`, default branch;
- the credential request, extended with a push command kind that is granted
  Contents write on that one repository;
- the API opening the pull request itself with its own token, so a Worker never
  holds the Pull requests right;
- the bot as author, with the starting user's name available from the session
  for the pull request text.

It must settle:

- A linked repository that is empty: the base branch has to be pushed before a
  pull request can exist.
- A linked repository with unrelated history: a pull request cannot be opened
  between unrelated branches.
- A push that outlasts one hour, and a token that expires mid-push.
- Rulesets that restrict creating branches named `atlas/*`.
- A task branch that changes files under `.github/workflows`: without the
  Workflows right the push is expected to be rejected.
- What leaves the machine. An agent can read every project's checkout on its
  Worker. Once branches are pushed, content in one repository could lead an
  agent to copy another project's files into its branch, and the push would
  publish them. Decide between a review before pushing and limiting what an
  agent can read.

## The Board

- Setup page, shown while the installation is not set up, including the "one
  account" rules, the confirmation of the created App, and the owner code
  field.
- Sign-in page with one button, and the "this account has no access" state.
- The signed-in user's name and avatar with a sign-out action.
- Settings: the GitHub connection (App name, owning account, a link to manage
  it on GitHub) and, for the owner, the member list.
- On a project: its linked repository, with link and unlink actions, and the
  "not accessible" state.
- In project creation: the choice to clone from GitHub.
- The "sign-in is off" notice.

Layout and wording are left to the builder, following the Board's existing
patterns.

## Tests

The project rule stands: existing tests, test helpers and test configuration
are not changed without the user's explicit permission. New tests go in new
files.

Required sign-in would break every existing test that calls the API, and the
end-to-end helper `scripts/e2e-server.mjs`, which starts the real server. The
user decided:

- Existing tests that build the API in code keep working unchanged, because
  `buildApp` without sign-in options runs with sign-in off.
- `scripts/e2e-server.mjs` gets one added line, `ATLAS_AUTH: 'off'`, in its
  environment. The user gave permission for exactly this change on 2026-11-25.
  It covers no other edit to that file or to any other existing test file.

The rejected alternative was to make every existing test sign in, which means
editing most existing test files.

Existing tests therefore prove the functions work with sign-in off, and cannot
notice a route left unprotected. A new test closes that gap: with sign-in on and
no session, it requests every route the API has registered and expects each to
be refused, apart from the listed exceptions. It reads the routes from the
running API, so a route added later is covered without anyone remembering to
add it.

The reviewer found that a third accepted capability list does not break the
existing contract tests. If any existing test does fail because of the changes
under "Changes to shared contracts and existing code", stop and ask the user,
naming the file, the exact change and the reason.

New tests use a stand-in for GitHub: a local HTTP server the API is pointed at
through its configurable GitHub addresses. No test talks to github.com.

- Contracts: the new messages, the command kinds, the capability, and the new
  HTTP shapes.
- API sign-in: `state` and PKCE checked; a wrong or reused `state` refused; the
  GitHub token not stored; a fresh session ID at every sign-in; session cookie
  attributes; expiry and renewal; sign-out; a member bound to an ID is refused
  under another ID; removal ends sessions and closes sockets; an open socket
  closes after its session expires; every protected route and the Board session
  socket refuse a request without a session; the Worker socket still works with
  its token and no session; an unknown `ATLAS_AUTH` value stops the server.
- API setup: a callback refused without the browser's cookie, with a reused or
  expired `state`, and for an App that is public or has other rights; endpoints
  refuse a non-owner once an owner exists; the App file is written with mode
  `0600`; no secret, code or `state` appears in any response or log line; a
  sign-in without the setup mark or owner code does not become owner.
- API GitHub access: listing; linking refused for a repository the App cannot
  access; a credential granted only on the dispatching connection, for an
  unfinished command of the right kind, once per dispatch and within the time
  limit; the token request sent to GitHub names one repository and the narrow
  right; revocation on result.
- Worker: a clone from a local stand-in Git server over HTTP using the
  credential exchange; the token absent from the journal, the Git config, the
  remote address and the process arguments, and absent from the environment of
  the checkout process; a renamed repository refused; refusal and a missing
  reply end the command; a clone killed partway is `needs_attention` on
  recovery and never succeeded; a journal file from before this change still
  reads; a project path starting with a dot refused.
- Docker group: a stand-in agent inside the sandbox cannot read the environment
  of the Worker or of another process the Worker started.
- Board: the page shown for each state, the member list, linking, and the clone
  choice.
- Integration: API and Worker together, sign-in through the stand-in, create a
  project by cloning, start a session on it.

Manual checks added to `docs/development/acceptance.md`, done with the real
GitHub: create the App from the setup page, install it on one repository, sign
in, see a second GitHub account refused, link a project, clone a private
repository, and confirm on GitHub that the App has only the expected rights.

## Documentation

- `docs/development/local-setup.md`: first-run setup and what an existing
  installation sees after upgrading, sign-in, the "one account" rules, the new
  settings, where the App file lives and what must not be done with it, how to
  remove the connection, and the limits below.
- `docs/development/protocol.md`: the new HTTP endpoints, the sign-in
  requirement, the credential messages, the clone command, the capability and
  how old and new Workers and APIs behave together.
- `AGENTS.md` and `.env.example`: the new settings.

## Known limits

- The App file holds a private key in plain text. Its mode protects it only on
  a Linux filesystem. On a Windows drive under WSL, where the user's checkout
  is, file modes do not apply and the file is as protected as the Windows
  account.
- Anyone who can run a process on the machine can reach the API on loopback.
  Sign-in stops them using it; it does not stop them reading `.atlas/`.
- Setup of a fresh installation is open to whoever reaches the API first.
- The promise that an agent cannot read a credential holds only for an agent in
  the Atlas sandbox inside the Worker container. With `ATLAS_AGENT_SANDBOX=off`
  or a Worker run natively, the agent runs as the Worker's own account: it can
  read the environment of the Worker's Git processes and the Worker token, and
  on a native Worker the App file itself, which reaches every repository the
  App can. Atlas does not refuse GitHub commands in that state; the existing
  warning about running unsandboxed applies in full. This is the author's call.
- GitHub's hosts are blocked for agents only by default. An owner who adds them
  to `ATLAS_AGENT_ALLOWED_DOMAINS` removes that layer.
- All Workers share one token, and a Worker names itself. Whoever holds that
  token can register under the name of a Worker that is offline and receive its
  commands, and so its credentials. A token per Worker belongs to the hosting
  work.
- If GitHub does not allow early revocation, a token handed to a Worker stays
  valid for up to one hour for one repository.
- A cloned repository brings its own agent instructions and settings, and the
  agent runs with its permission prompts off. Together with agents being able
  to read other projects' checkouts, a hostile repository could steer an agent
  to read another project. Nothing leaves the machine through Atlas until the
  push iteration, which must settle this.
- The browser sends a `localhost` cookie to every port on localhost, so another
  local web service receives the session cookie and can overwrite it.
- Every signed-in user sees every project and every repository name the App can
  access.
- The Worker image uses Git from Debian bookworm, and the user's workspace is
  on a case-insensitive Windows drive, a setting several past Git clone flaws
  needed. The builder checks the image's Git version against known clone flaws
  and moves to a newer Git if it is affected.

## Left to the builder

- Database tables, endpoint paths and payload shapes beyond those named, and
  setting names other than `ATLAS_AUTH`.
- Whether to add a cookie or JWT library or use Node's own `crypto`, and
  whether the session cookie can use the `__Host-` name prefix.
- The exact Git options that meet the rules in "How a Worker receives a
  credential".
- The time limits named without a number, and how clone progress is shown.
- Board layout and wording.
- How the stand-in GitHub and the stand-in Git server are built for tests.

## Review record

An independent reviewer, given this document, the user's requirements and the
code but not the design conversation, reviewed the first draft on 2026-11-25.
Its findings were checked against the code before being accepted. Changed as a
result:

- Setup: `state` bound to the browser and single-use; the created App is
  verified with GitHub before it is stored; an existing owner must be signed in
  to run setup again.
- Owner: "first sign-in becomes the owner" removed; a setup mark or a one-time
  owner code is required.
- The Setup URL, without which GitHub does not return to the Board.
- Clone recovery: the draft wrongly said an interrupted init is reported as
  `needs_attention`. It is reported as succeeded, so a clone needs its own
  stage.
- Credential: fetch and checkout separated; grants bound to the connection,
  limited to one per dispatch and in time, logged, and revoked where possible.
- Project paths starting with a dot refused.
- One account per installation, and the account picker removed.
- The Workflows right decided: not requested.
- The contract and code changes the draft did not name.
- Known limits added: unsandboxed and native Workers, the shared Worker token,
  hostile repositories, cookies across ports, the image's Git version.

Not taken: the reviewer suggested cutting members and roles from the first
iteration. They stay, because users of an installation are the reason the user
gave for sign-in.

## Amendments after approval

Written on 2026-11-25 while documenting the built behaviour. The approved sections
above are unchanged, apart from a pointer line in each affected section. Where this
list and an approved section disagree, the built behaviour is the one listed here.

- Two Git processes hold the token, one after the other, instead of one. Git 2.39 in
  the Worker image cannot report the remote's default branch from a fetch, so
  `git ls-remote --symref` reads it first. Both get the same locked-down setup, and
  neither runs repository content. Cloning with `--no-checkout` would break the
  init-first order and the tag rule.
- Those two processes also ignore the system Git configuration, not only the user's
  (`GIT_CONFIG_NOSYSTEM`), so a system `http.proxy` or `sslCAInfo` is not used for a
  clone. System configuration could weaken TLS, add headers or add a credential helper.
- The setup mark cookie lapses after 30 days. The approved text said it does not
  expire by time; it still ends on the server when an owner exists. A cookie with no
  lifetime would be dropped when the browser closes, losing the mark mid-setup.
- The one-time owner code is entered on the setup page ("Use owner code"), not on the
  sign-in page, because the setup page is what the Board shows before an owner exists.
  The code is created only at API start.
- The App file's workspace check runs at API start and at every credential grant, as
  approved, but it compares the paths the API sees and only for Workers already
  registered in its database. A Worker that registers after the start is not checked
  until a grant. `pnpm dev` mounts the workspace and state directories into the
  container at the host's paths, so its Worker reports paths the check can compare; a
  container that mounts the workspace at another path, or the same folder reached by
  two different paths, is not covered, and the state directory is not checked (see the
  setup guide's known limits). An earlier version of this amendment said a Docker
  Worker always reports container paths; that was wrong for `pnpm dev`.
- The 15-minute window limits only when a token may be issued, counted from the latest
  dispatch. A granted token is revoked at the command's result, at the Worker's Git
  time limit after the grant (two 30-minute processes and a minute's margin), when a
  newer grant for the command replaces it, or when the API stops. The approved text
  revoked "when the time limit passes", which a slow clone could trigger mid-fetch.
- Credential requests that reach GitHub are capped at 3 per dispatch, one at a time.
  Later ones are refused `already_granted` without calling GitHub. A grant that cannot
  be delivered is revoked at once.
- Unlinking is refused with 409 `project_not_linkable` while the project's own clone
  is pending or accepted, because the clone needs the link to be sent again after a
  reconnect. The approved text said a link can be removed. A clone stuck in that state
  therefore blocks unlinking, and there is no cancel.
- A project path whose first part starts with a dot is refused at create (API 400
  `invalid_relative_path`, and the Worker). The same check runs when a session starts,
  so an existing project with such a path stays listed but cannot start a session; the
  session ends at once with the Worker's message. The approved text only said that
  existing projects "are not affected".
- `GET /github/connection` is not registered while sign-in is off (404), whereas
  `GET /github/repositories` and the link routes exist and answer 409
  `github_unavailable`. The approved text gave no status. The Board never calls the
  connection route with sign-in off, while the other routes were given a clear answer
  because the Board's project views can reach them.
- With sign-in off, a create that carries `githubRepositoryId` ignores the field and
  initializes an empty repository. The plan said 409 `github_unavailable`; changing it
  needs permission to change an existing test. This is the current behaviour and it is
  under review.
- A clone still queued when the Worker stops is not started and gets no result; the
  API sends it again when the Worker registers again. The approved text said it is
  `needs_attention` on the next start, which holds for a clone that was running.
- The Worker runs `git init` for the new folder before it asks for a credential. A
  missing reply therefore ends the command as `needs_attention` after a local Git
  step, not "without having run Git"; no Git step that reaches the network has run.
- A second clone queued on a Worker behind one that runs longer than 15 minutes is
  refused `grant_window_closed`, because the window counts from dispatch and the Worker
  runs commands one at a time.
- Creating a task's worktree still has its 30-second limit. The check against a real
  repository on the Windows drive is in the acceptance checks and has not been run.
- Clone outcomes the approved text did not describe: an empty repository succeeds with
  nothing checked out; a repository with branches whose default branch cannot be
  determined after the fetch fails `default_branch_unknown`; a token with characters
  Git cannot carry fails `invalid_credential`. Each failure leaves the folder, like
  any other failed clone.
- Reconnect without the owner's session. The approved text required the owner's
  session for setup once an owner exists. After the App file is removed, an owner
  whose session is gone (30 idle days, cleared cookies, another browser) could then
  neither sign in, which needs the App, nor run setup; the only way back was deleting
  the database. Reason for the change: the final review (finding I-1) found this dead
  end, and the documented response to a leaked App file leads straight into it. Built
  behaviour: when the API starts with an owner and no App file, it prints a one-time
  owner code, as on a first run and with the same properties (random, hash stored,
  one use, new code only at start). Entering it on the setup page gives the browser a
  reconnect mark (`atlas_setup_reconnect`, one day, ended when the App file is written)
  that opens the setup routes, so a new App can be created. It never creates, replaces
  or changes the owner: the owner signs in by their GitHub account number as before,
  and anyone else is admitted only as an added member. `GET /auth/state` reports the
  new value `reconnect` to a browser that may not run setup yet, and the Board shows
  the code entry there instead of a start button that would answer 401. With an owner
  and an App file nothing changes.
- Stopping or restarting the API revokes the tokens it holds, as approved, so a clone
  still fetching then fails `git_failed`. In development the API runs under a file
  watcher, so any API source change does this.
