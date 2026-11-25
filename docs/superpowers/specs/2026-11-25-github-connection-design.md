# GitHub connection: sign-in and repository access

Status: draft for the user's review, 2026-11-25.

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
- A sandboxed agent can never read a GitHub credential.
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

## Anti-goals

- A credential that an agent can read: in its environment, in its worktree, in
  the project's Git config, or in the Worker state directory.
- A GitHub token written to disk anywhere: the database, the Worker's command
  journal, a Git config or a log.
- Sign-in that can be switched off without anyone noticing. Running without
  sign-in must be an explicit setting and visible on the Board.
- Rights wider than needed "for later", other than the pull request right named
  below.

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
  supported and recommended.
- A pull request opened with an installation token is shown as the App's bot.
- A ruleset that requires pull requests on the default branch does not stop a
  push of another branch such as `atlas/task-<id>`.

Not settled by the documentation. The first step of the plan tests these live,
with the user at the browser, before anything is built on them:

1. Whether the manifest flow accepts `http://localhost` addresses for its
   redirect and callback URLs. GitHub's own sign-in tutorial uses one; the
   manifest page shows only `https`.
2. Whether an App can be created with webhooks inactive and no webhook URL.
3. Whether a sign-in callback to `http://localhost:<port>` must match the
   registered port exactly. Assume it must.
4. Who can sign in through an App that is not public. The expectation, not
   verified, is that only the owning account can, or the members of the owning
   organization. See "Who can be a member".

If 1 fails, the fallback is manual registration: the setup page shows the exact
values to enter on GitHub, and the owner pastes the App ID, client ID and client
secret into the setup page and uploads the key file there. If 2 fails, register
an inactive webhook with a placeholder address; if GitHub demands a reachable
one, stop and raise it with the user.

## Design

### The GitHub App

Each installation has one GitHub App. Its settings:

- Repository rights: Contents read and write, Pull requests read and write,
  Metadata read (GitHub requires it). Pull requests is unused this iteration. It
  is requested now because adding a right later needs the owner to approve it
  again on GitHub for every place the App is installed.
- No organization or account rights. No events.
- Webhooks inactive.
- Not public: only the owning account can install it.
- Sign-in callback: `<Board origin>/api/v1/auth/github/callback`.
- No "request user authorization during installation".

The Board reaches the API through the Board's own origin (the Vite proxy for
`/api/v1`), so GitHub's redirects go to the Board origin and cookies are
same-origin. The addresses come from the existing `ATLAS_BOARD_ORIGIN`. If the
owner later changes that origin, they update the callback address in the App's
settings on GitHub; document this.

### Where the App's secrets live

The App ID, slug, client ID, client secret and private key are stored by the API
in one file, by default `.atlas/github-app.json`, created with mode `0600`. A
new API setting names the file. This is the author's call, for these reasons:

- It sits beside `worker-token`, which is the same kind of secret.
- The Worker container mounts only the workspace root and the Worker state
  directory, so the file is not visible inside the container at all.
- Keeping it out of SQLite keeps it out of database copies and test databases.

The file must not be inside a workspace root or a Worker state directory;
document this next to the setting. The API never returns any of these values
and never logs them.

Removing the connection is manual this iteration: stop Atlas, delete the file,
start again. Users and project links stay in the database, and setup runs
again. The existing owner stays the owner: "first sign-in becomes the owner"
applies only while the database has no owner. Links survive because Atlas asks
GitHub at each use which installation of the current App covers the linked
repository; see "Linking a project to a repository". This is the author's call.

### Setup

While no App file exists, the installation is "not set up". In that state the
API serves only the sign-in state endpoint and the setup endpoints, and the
Board shows a setup page in place of everything else.

1. The owner optionally names an organization that should own the App;
   otherwise their personal account owns it. The Board asks the API for the
   manifest and a one-time `state` value, and posts them to GitHub in a form.
2. On GitHub the owner confirms the App's name and creates it. App names are
   unique across GitHub, so the manifest proposes `Atlas` plus a short random
   suffix and the owner can change it there.
3. GitHub returns to `<Board origin>/api/v1/setup/github/callback` with a code.
   The API checks `state`, exchanges the code, writes the App file, and marks
   this browser, with a short-lived cookie, as the one that completed setup.
4. The API sends the browser to GitHub's page for installing the App, where the
   owner picks the account and the repositories. GitHub then returns to the
   Board.
5. The owner signs in. The first sign-in from the browser marked in step 3
   becomes the owner of the installation. If that mark has expired, the first
   sign-in after setup becomes the owner.

Setup endpoints refuse to act once the App file exists. Setup is open to
whoever can reach the API, which today means a process on the same machine,
because the API listens on loopback only. A hosted installation needs a one-time
setup code; that belongs to the hosting work.

Atlas learns where the App is installed by asking GitHub with the App's own
key, not from values in a redirect.

### Sign-in

1. The Board's sign-in page links to `GET /api/v1/auth/github/start`. The API
   creates a `state` value and a PKCE verifier, keeps them in a short-lived
   `HttpOnly` cookie, and redirects to GitHub's authorize page.
2. GitHub returns to the callback. The API checks `state`, exchanges the code
   using the client secret and the verifier, and asks GitHub who the person is.
3. The API keeps the numeric account ID, login, display name and avatar
   address, then discards the GitHub token. It is never stored. The builder may
   also revoke it at GitHub.
4. If the account may sign in, the API creates a session and redirects to the
   Board. Otherwise the Board shows that this account has no access and names
   the account, so a person signed in to the wrong GitHub account can tell.

Sessions:

- A random session ID in a cookie that is `HttpOnly`, `SameSite=Lax`, and
  `Secure` when the Board origin is `https`. The database stores only a hash of
  the ID.
- A session lasts 30 days from its last use. The stored last-use time need not
  be updated on every request.
- Signing out deletes the session. Removing a member deletes all their
  sessions.

Who may sign in:

- The owner, always.
- Members the owner added by GitHub login on a settings page. At a member's
  first sign-in Atlas binds the entry to the account's numeric ID and matches by
  ID from then on, so a renamed or re-registered login cannot inherit access.
- Membership is checked on every request, so removal takes effect at once.

Roles: `owner` and `member`. The only difference is that the owner manages
members. There is exactly one owner; transferring ownership is not built.

Who can be a member. The App stays not public, so that no stranger can install
it and Atlas never has to decide which installations to trust. If live check 4
shows that GitHub lets only the owning account or organization through a
non-public App's sign-in, then a team installation must create its App under the
team's organization, and members must belong to that organization. The setup
page and the member page say so. A personal installation is unaffected. Making
the App public is not a fallback; if a team needs members from outside its
organization, raise it with the user. This is the author's call.

### What the API protects

Every `/api/v1` route requires a session, except:

- the sign-in state endpoint, the sign-in start and callback, and sign-out;
- the setup endpoints, only while the installation is not set up;
- the Worker socket, which keeps its own token check.

The existing checks on `Host`, `Origin` and JSON content type stay. The Board
session socket checks the session cookie at upgrade in addition to `Origin`.
When a user's sessions are deleted, their open Board session sockets are
closed.

A new endpoint, open to everyone, tells the Board which page to show: whether
sign-in is on, whether setup is done, and who is signed in.

The API records which user created a project or a task in the database. These
columns are not exposed through the shared contracts this iteration.

### Running without sign-in

A new API setting, `ATLAS_AUTH`, takes `github` (the default) or `off`.

- `off` makes the API behave as it does today: no sign-in, no setup, and no
  GitHub features. The Board shows a permanent notice that sign-in is off.
- `buildApp` called from code without sign-in options also runs with sign-in
  off. The server entry point always reads the setting, so a started server has
  sign-in on unless the setting says otherwise.

This is the author's call and needs the user's decision; see "Tests". Its
purpose is to keep the existing tests, which call the API without signing in,
unchanged. It follows the precedent of `ATLAS_AGENT_SANDBOX=off`.

### Linking a project to a repository

Any signed-in user can link a ready `local` project to a repository.

- The Board shows the accounts where the App is installed and, for one account,
  the repositories the App can access there, with a link to GitHub's page for
  changing that selection. The API reads both from GitHub with the App's own
  credentials.
- Linking stores the repository's numeric ID, its `owner/name` and its default
  branch. The API first confirms with GitHub that the repository is among those
  the App can access. The installation is not stored as a fact: whenever Atlas
  needs it, it asks GitHub which installation of the App covers the repository.
  If none does, because the owner withdrew the repository or replaced the App,
  the Board shows the link as not accessible and anything that needs GitHub
  fails with that message.
- A project has at most one link. A link can be removed.
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

- The project is stored as a `local` project, with a Worker and a relative
  path, plus a link as above. Sessions therefore work on it with no change to
  the session code.
- The API dispatches a new command kind, `repository.clone`, carrying the
  project ID, the relative path and the repository's `owner/name`. It carries
  no credential.
- A Worker that can clone registers a new capability. The API refuses to create
  such a project on a Worker without it.
- The Worker clones over HTTPS into a folder that must not exist, with the same
  path confinement and journal stages as `repository.init`. It does not fetch
  submodules. A clone interrupted partway is reported as `needs_attention`, as
  an interrupted init is today.
- The resulting `origin` address contains no credential.

### How a Worker receives a credential

Commands are stored by the API and journaled by the Worker, and are sent again
after a reconnect. A token inside a command would be written to disk in both
places and could be stale when the command is replayed. So the token is asked
for separately, at the moment it is needed:

- When the Worker is about to run Git for a command that needs GitHub, it sends
  a credential request naming the command ID.
- The API grants it only if that command exists, is assigned to this Worker, is
  not finished, and is of a kind that needs a credential. It then asks GitHub
  for a token limited to that project's linked repository and to the rights
  that kind needs: Contents read for a clone.
- The API answers with the token and its expiry, or with a refusal that has a
  code and a message. A refusal fails the command with that message.
- Neither side stores the token or logs the message that carries it. The Worker
  keeps it in memory for the one Git process.

The Worker gives Git the token without putting it in the command line, in any
Git config file, or in the remote's address: for example through a credential
helper that reads it from the environment of that one Git process. Other
credential helpers and terminal prompts are turned off for that process, and
only HTTPS is allowed as a transport.

The Worker builds the repository address from a Worker setting for the Git
host, by default `https://github.com`. Plain `http` is accepted only when that
host is a loopback address, which is what the tests' stand-in uses; with any
other `http` address the Worker refuses to start. This is the author's call.

Why an agent cannot get it: the Worker runs this Git process itself, outside
any agent sandbox. An agent has its own process view, so it cannot read another
process's environment; it cannot read the Worker state directory; and its
network filter does not allow GitHub's hosts.

These are new Worker protocol messages and a new command kind, so they follow
the repository's contract-change rules: document them in
`docs/development/protocol.md`, update validators and fixtures together with
both consumers, and say how an older Worker behaves. An older Worker never
receives a clone command because it lacks the capability.

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

## The Board

- Setup page, shown while the installation is not set up.
- Sign-in page with one button, and the "this account has no access" state.
- The signed-in user's name and avatar with a sign-out action.
- Settings: the GitHub connection (App name, where it is installed, a link to
  manage it on GitHub) and, for the owner, the member list.
- On a project: its linked repository, with link and unlink actions.
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
proposal is:

- Existing tests that build the API in code keep working unchanged, because
  `buildApp` without sign-in options runs with sign-in off.
- `scripts/e2e-server.mjs` gets one added line, `ATLAS_AUTH: 'off'`, in its
  environment. This needs the user's permission.

The alternative is to make every existing test sign in, which means editing
most existing test files.

If the new capability or command kind makes an existing contract test fail, for
example one that lists the accepted capability sets, stop and ask the user,
naming the file, the exact change and the reason.

New tests use a stand-in for GitHub: a local HTTP server the API is pointed at
through its configurable GitHub addresses. No test talks to github.com.

- Contracts: the new messages, the command kind, the capability, and the new
  HTTP shapes.
- API sign-in: `state` and PKCE checked; a wrong or reused `state` refused; the
  GitHub token not stored; session cookie attributes; expiry and renewal;
  sign-out; a member bound to an ID is refused under another ID; removal ends
  sessions and closes sockets; every protected route and the Board session
  socket refuse a request without a session; the Worker socket still works with
  its token and no session.
- API setup: endpoints refuse once set up; the App file is written with mode
  `0600`; no secret appears in any response or log line; the first sign-in
  becomes owner.
- API GitHub access: listing; linking refused for a repository the App cannot
  access; a credential granted only for the right Worker, command state and
  kind; the token request sent to GitHub names one repository and the narrow
  right.
- Worker: a clone from a local stand-in Git server over HTTP using the
  credential exchange; the token absent from the journal, the Git config, the
  remote address and the process arguments; refusal fails the command;
  interrupted clone reported as `needs_attention`.
- Board: the page shown for each state, the member list, linking, and the clone
  choice.
- Integration: API and Worker together, sign-in through the stand-in, create a
  project by cloning, start a session on it.

Manual checks added to `docs/development/acceptance.md`, done with the real
GitHub: create the App from the setup page, install it on one repository, sign
in, see a second GitHub account refused, link a project, clone a private
repository, and confirm on GitHub that the App has only the expected rights.

## Documentation

- `docs/development/local-setup.md`: first-run setup, sign-in, the new
  settings, where the App file lives and what must not be done with it, how to
  remove the connection, and the limits below.
- `docs/development/protocol.md`: the new HTTP endpoints, the sign-in
  requirement, the credential messages, the clone command and the capability.
- `AGENTS.md` and `.env.example`: the new settings.

## Known limits

- The App file holds a private key in plain text. Its mode protects it only on
  a Linux filesystem. On a Windows drive under WSL, where the user's checkout
  is, file modes do not apply and the file is as protected as the Windows
  account.
- Anyone who can run a process on the machine can reach the API on loopback.
  Sign-in stops them using it; it does not stop them reading `.atlas/`.
- Setup is open to whoever reaches the API first.
- A token handed to a Worker is valid for up to one hour for one repository,
  even though it is needed for seconds.
- Every signed-in user sees every project and every repository name the App can
  access.
- A session socket that is already open stays open when its session merely
  expires; it is closed on sign-out and on removal.

## Left to the builder

- Database tables, endpoint paths and payload shapes beyond those named, and
  setting names other than `ATLAS_AUTH`.
- Whether to add a cookie or JWT library or use Node's own `crypto`.
- How the Worker passes the token to Git, within the rules above.
- Clone timeouts and how progress is shown.
- Board layout and wording.
- How the stand-in GitHub and the stand-in Git server are built for tests.
