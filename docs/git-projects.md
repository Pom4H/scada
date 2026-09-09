# Git-backed project delivery and hot reload

The server reads an explicitly configured Git repository. On an authenticated
connection it supplies the project's files, default scene and exact commit ID.
The browser shows the file list and revision, and opens the scene automatically
when there is no local draft. No URL from a project file starts a connection.

## Local example

Copy `examples/git-project` into a separate directory, then initialize it:

```sh
cd /path/to/pump-project
git init -b main
git add scada.project.json scene.ts README.md
git commit -m 'Initial pump project'
```

From the SCADA application checkout:

```sh
npm ci
SCADA_PROJECT_REPO=/path/to/pump-project npm run demo
```

Open the URL printed by the server, enter its separately printed token and
connect. The server can supply its project ID, so the default ID field need not
be edited when this server serves a single project. `VIEW` can read files and
recordings; `OPERATOR` can create scenarios and issue commands. Tokens are never
saved with files, URL fragments, browser drafts or Git commits.

PowerShell sets the environment separately:

```powershell
$env:SCADA_PROJECT_REPO = 'C:\projects\pump-project'
npm run demo
```

A normal `git commit`, `git merge`, `git revert`, or explicit ref update is picked
up without restarting the server or browser. Uncommitted working-tree files are
not a release. The same committed-object loader is used in development and
production.

## Manifest and file boundary

`scada.project.json` is JSON data, not an executable build configuration:

```json
{
  "version": 1,
  "id": "pump-demo",
  "entry": "scene.ts",
  "scenes": ["scene.ts", "standby.ts"],
  "files": ["scene.ts", "standby.ts", "README.md"]
}
```

All paths are relative to the repository root, including when the manifest is
at a configured nested path. `scenes` defaults to `[entry]`; every scene must be
a valid, independently compilable SCADA TS document with installed equipment
behaviors. Arbitrary imports and executable JavaScript remain disallowed.
Additional project files are available as read-only text in the file dialog.
They are not concatenated or evaluated as TS modules. Open another declared
scene with **Файлы → Открыть схему**.

Only explicitly listed regular UTF-8 files with `.ts`, `.json`, `.md`, `.txt` or
`.svg` extensions are delivered. SVG is displayed as text, not inserted as HTML.
Dot paths, parent traversal, credential/secret filenames, symlinks, submodules,
executables and binary files are rejected. Limits: 64 files, 256 KB per file,
1 MB for the published project, and the existing compiler limits per scene.
An allowlist cannot detect a password manually put into an otherwise allowed
file: never commit real credentials or sensitive operational data there.

## Atomic activation and failure behavior

The loader resolves one commit, reads its tree and blobs, validates every
published scene and only then swaps the active in-memory snapshot. It does not
run `git pull`, execute hooks, check out files over a live directory, run package
scripts, or restart a simulation on each commit. Git child processes use argument
arrays, no shell, bounded output, disabled hooks and a timeout.

A private `refs/scada/active/...` ref records the last validated revision. An
invalid commit, missing file, broken scene or failed fetch leaves that release
active and exposes a rejected-update status to the UI. A restart can load this
last-good ref while the deployment ref is broken. Reverting to an earlier valid
commit is an ordinary reload. Changing the manifest's project ID requires an
explicit server restart.

A run stores its exact source, Git revision, scene path and delivered file
snapshot alongside behavior versions and initial conditions. Existing runs keep
that snapshot through reload, archival, garbage collection of old Git commits
and server restart. New runs may select the newly active project. A request
claiming a Git revision must contain the exact source of its declared scene;
stale revisions or edited drafts cannot be falsely attributed to that commit.

In the browser, compatible layout-only updates can apply without dropping the
run. Model/topology updates are offered for explicit application while a run is
active. A local draft is never overwritten automatically. Applying a pending
revision preserves the draft in `scada.project.drafts.v1` (last ten snapshots) and
as a normal source-edit undo operation. Export `.ts` remains available. If draft
storage is unavailable, replacement is refused until the user exports it.

This is hot reload of the declarative project, not hot replacement of arbitrary
server executables or in-place mutation of an active simulation's hidden state.
Installed TS behavior/rendering modules still ship with the application. Their
version compatibility checks are unchanged.

## Production remote tracking

Configure a trusted remote and branch on the server, not through the browser:

```sh
git clone --no-checkout <your-project-repository> /srv/scada-project
SCADA_PROJECT_REPO=/srv/scada-project \
SCADA_PROJECT_REF=refs/remotes/origin/main \
SCADA_PROJECT_REMOTE=origin \
SCADA_PROJECT_BRANCH=main \
SCADA_PROJECT_POLL_MS=5000 \
npm run demo
```

The server fetches only that configured branch and validates its commit. Project
repositories must be trusted deployment inputs. Use CI/branch protection to
review commits before they reach the deployment branch. Fetch credentials belong
to the server's Git/SSH configuration, never the project or browser. Configure
TLS, the reverse proxy's exact allowed origin and persistent access tokens as in
[the server guide](server-runtime.md). There is no production-only watcher with
different semantics: the same validated release mechanism is used everywhere.

Remote-tracking mode is read-only to browser saves. No automatic force push,
merge or reset of a developer's working tree is performed. Multiple SCADA
processes should use separate project clones; one writable repository is a
single-writer deployment target, not a distributed Git server.

## Optional browser commits

Set `SCADA_PROJECT_WRITABLE=1` for an administrator-selected local branch. Use a
bare repository or a branch not checked out in a developer's working tree. With
an operator token, edit the open scene, enter a commit message and click
**Коммит**. The server validates a candidate tree and creates a commit without
running hooks. It moves the ref using `git update-ref <ref> <new> <expected-old>`.
A stale/concurrent save receives HTTP 409 instead of overwriting another edit.
Working-tree and index files are untouched. Browser commits are local Git
commits; publishing them to a remote remains an explicit Git/CI action.

Opening a saved run shows its pinned file revision read-only; it does not update
the deployment branch. Read-only project files and the manifest are changed in
Git, not through the scene editor.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SCADA_PROJECT_REPO` | unset | Enable delivery from this local Git repository |
| `SCADA_PROJECT_REF` | `HEAD` | `HEAD` or a full heads/tags/remotes ref |
| `SCADA_PROJECT_MANIFEST` | `scada.project.json` | Root-relative manifest path |
| `SCADA_PROJECT_POLL_MS` | `1000` | Reload interval, 100–3,600,000 ms |
| `SCADA_PROJECT_WRITABLE` | unset | `1` enables operator commits to a local branch |
| `SCADA_PROJECT_REMOTE` | unset | Optional trusted configured remote name |
| `SCADA_PROJECT_BRANCH` | unset | Branch fetched from that remote |

No repository is required for standalone/local-preview use or for runs created
from an explicitly authored source document.

## Authenticated API

- `GET /api/session`: role and project capability.
- `GET /api/projects`: configured project ID, entry and revision.
- `GET /api/projects/:id`: validated file snapshot and update status. The optional
  `knownRevision` query returns `unchanged: true` without retransmitting files.
- `POST /api/projects/:id`: operator-only save with `baseRevision`, `path`,
  `content` and `message`; requires writable local-branch configuration.
- `GET /api/runs/:id/project`: the run's pinned files and source, not latest HEAD.

Git's object model and ref-update behavior are documented at
https://git-scm.com/book/en/v2/Git-Internals-Git-Objects and
https://git-scm.com/docs/git-update-ref .
