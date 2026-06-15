# Maintainer Update Guide

## Purpose

Use this runbook when updating the Character Library fork from its maintainer
upstream, refreshing long-lived feature branches, or rebuilding an all-in-one
(AIO) integration branch. The goal is to preserve shared contracts while
keeping each feature branch independently understandable and verifiable.

Treat AIO branches as disposable integration output. Keep feature branches as
the source of truth for their own behavior, and keep documentation donor
branches separate from integration code.

## Inspect Before Editing

Confirm the remotes, worktrees, and branch state before changing files:

```powershell
git remote -v
git worktree list
git branch -vv
git status --short --branch
```

Fetch both remotes and prove that the fork baseline can advance to upstream:

```powershell
git fetch --prune origin
git fetch --prune upstream
git merge-base --is-ancestor origin/main upstream/main
git log --oneline origin/main..upstream/main
git diff --stat origin/main..upstream/main
git diff --name-status origin/main..upstream/main
```

Stop if `git merge-base --is-ancestor` fails. Do not rewrite or merge forward
until the divergence has been reviewed deliberately. Read the release diff and
identify changed shared files, migration code, helper routes, provider
registries, modal behavior, and tests before editing any maintained branch.

After the release diff is reviewed, fast-forward the clean foundation checkout
and the fork's `origin/main` to the verified upstream ref. Prove exact ref
equality before creating a fresh AIO branch from `origin/main`:

```powershell
$Root = 'C:\path\to\SillyTavern-CharacterLibrary'
git -C $Root status --short --branch
git -C $Root switch main
git -C $Root merge --ff-only upstream/main
git -C $Root push origin main:main
git -C $Root fetch --prune origin
$LocalMain = git -C $Root rev-parse refs/heads/main
$OriginMain = git -C $Root rev-parse refs/remotes/origin/main
$UpstreamMain = git -C $Root rev-parse refs/remotes/upstream/main
if (($LocalMain -ne $UpstreamMain) -or ($OriginMain -ne $UpstreamMain)) {
    throw 'main, origin/main, and upstream/main must resolve to the same commit'
}
git -C $Root diff --exit-code refs/remotes/upstream/main refs/heads/main
git -C $Root diff --exit-code refs/remotes/upstream/main refs/remotes/origin/main
```

Stop if the foundation checkout is dirty, the fast-forward fails, the push
fails, or any equality check fails. Do not create the fresh AIO branch until
local `main`, `origin/main`, and `upstream/main` resolve to the same commit.

Check every worktree with `git status --short --branch`. Preserve existing
uncommitted edits. Do not move, revert, or absorb another worker's changes.

## Classify Branches

Classify every branch before deciding how to update it:

| Classification | Meaning | Update rule |
| --- | --- | --- |
| Foundation | `main` and its remote tracking refs | Refresh from verified upstream first. |
| Maintained feature | A provider, helper, bookmark, or QOL branch with independent value | Merge refreshed `main`, resolve contracts, and verify independently. |
| Documentation donor | A branch that owns durable docs but must not donate stale integration code | Copy only the named documentation paths. |
| Historical donor or backup | A branch kept for reference or recovery | Inspect when needed; do not merge forward by default. |
| Disposable AIO | A combined integration branch | Rebuild from refreshed `main`; do not use as a development source of truth. |

Record which maintained features belong in the next AIO rebuild. QOL remains
independent unless a future task explicitly includes it.

## Use Isolated Worktrees

Give each maintained branch its own worktree. A worker owns only its assigned
branch and worktree.

```powershell
$Root = 'C:\path\to\SillyTavern-CharacterLibrary'
$Wt = Join-Path $Root '.worktrees'
git -C $Root worktree add (Join-Path $Wt 'feature-vNext') feature-branch
git -C (Join-Path $Wt 'feature-vNext') status --short --branch
```

Use a separate fresh worktree for the rebuilt AIO branch:

```powershell
git -C $Root worktree add -b codex/aio-clean-rebuild-vNext `
    (Join-Path $Wt 'aio-clean-rebuild-vNext') origin/main
```

Do not edit another worktree to save time. Worktree isolation is what makes
parallel updates reviewable and prevents accidental reversions.

## Dispatch Read-Only Audits

Run read-only audits in parallel before resolving conflicts. Give each audit a
clear area and ask for findings, likely conflict hotspots, and verification
coverage. Auditors must not edit files, commit, or push.

Useful audit areas:

| Audit | Inspect |
| --- | --- |
| Branch topology | Worktrees, local refs, remote refs, ahead/behind state, and donor branches |
| Desktop | `app/library.js`, `app/library.html`, shared settings, modals, taglines, gallery flows |
| Mobile | `app/library-mobile.js`, responsive CSS, Online FAB search, import summaries, Android back behavior |
| Providers | Provider registry, module loader, provider utilities, custom provider browse and import paths |
| CL-helper | `extras/cl-helper/index.js`, package version, `/health`, `/self-update`, and feature routes |
| Tests | Existing source-contract tests, provider tests, helper tests, and syntax-check targets |

Use targeted searches to find release-sensitive code:

```powershell
rg -n "writeCardFields|applyCardFieldUpdates|extensions\.cl\.tagline|getDisplayTagline" .
rg -n "gallery|assignGalleryId|folder|Proxy" app modules index.js
rg -n "CL_HELPER|/health|/self-update|register.*Routes|version" app extras modules
rg -n "skeletonLines|modal-overlay|browse-char-modal|matchMedia|Android|popstate" app modules
```

Summarize audit findings before integration work starts so shared changes are
resolved consistently across feature branches.

## Merge Feature Branches Or Rebuild AIO

Merge refreshed `main` into a maintained feature branch when that branch is an
independent source of truth. Preserve its history, resolve conflicts against
the refreshed contracts, and verify the branch before any AIO landing.

Rebuild an AIO branch when upstream changes shared contracts, when multiple
feature branches overlap in shared files, or when the previous AIO contains
integration-only fixes that are difficult to attribute. Carry a fix back to
its owning feature branch first when practical.

Never merge an old AIO branch forward when upstream changed shared contracts.
Preserve the old AIO branch as a documentation donor only. Create a separate
fresh AIO branch from refreshed `origin/main`, then integrate one verified
feature branch at a time so every landing has a clear source and a focused
verification result. Never merge the stale old AIO tree into the fresh AIO
branch. QOL remains independent unless a future task explicitly includes it.

## Preserve Shared Contracts

Review shared files after each feature merge and after each AIO landing:

```text
app/library.js
app/library.html
app/library-mobile.js
index.js
extras/cl-helper/index.js
modules/module-loader.js
modules/providers/browse-shared.css
modules/providers/provider-registry.js
modules/providers/provider-utils.js
```

### Card Writes

Preserve centralized card mutation through `CoreAPI.writeCardFields` and
`CoreAPI.applyCardFieldUpdates`. Do not restore older provider-local write
paths during conflict resolution. Recheck link, unlink, edit, import, version
restore, and undo flows after changes to card-write code.

### Active Tagline Namespace

Preserve provider-agnostic active tagline storage under
`extensions.cl.tagline` for unlinked cards only. Linked cards use the active
provider namespace through the resolver. Link and unlink transitions must
preserve tagline values without clobbering provider-authoritative metadata.

When adding a native provider tagline, require fixture evidence for the source
field. Verify import, link, unlink, rendering fallback, and version-history
behavior. Do not infer a tagline from creator notes, descriptions, or internal
ranking fields.

### Live Gallery Folders

Preserve live gallery-folder computation through the SillyTavern-side `Proxy`
and retain the simplified missing-gallery-ID migration. Do not revive obsolete
persisted folder-mapping cleanup paths during a merge. Verify gallery ID
assignment, gallery import, image download, Dropbox extraction, and any legacy
reporting that the refreshed baseline still exposes.

### CL-helper Versioning

Preserve `/health` metadata, helper version checks, and `/self-update` while
adding feature routes. Route registration is additive: verify existing
DataCat, BotBooru, image-host, Dropbox, updater, and any other maintained
registrations together after conflict resolution.

Bump the bundled helper package version when new bundled routes or helper
behavior require users to update. Keep settings banners and status fields
aligned with the helper health response.

### Modal And Mobile Behavior

Preserve the shared modal chrome, overlay dismiss behavior, close buttons,
persistent listeners, and provider cleanup. Provider previews should render
skeletons first, hide empty sections when loading finishes, and keep card-open
lookup state consistent with the rendered grid.

At a phone viewport, verify Online FAB search, keyboard handling, bottom
navigation, drawers, sheets, safe areas, and Android back behavior. Keep the
preview behind an import summary briefly where required so mobile users do not
see a blank transition.

## Rebuild AIO With Prefixed Commits

Create the new AIO branch from refreshed `origin/main`, then land verified
features one at a time. Prefer a squash landing or a carefully selected commit
chain over merging exploratory history.

```powershell
git worktree add -b codex/aio-clean-rebuild-vNext `
    .worktrees/aio-clean-rebuild-vNext origin/main
git -C .worktrees/aio-clean-rebuild-vNext merge --squash --no-commit <source-sha>
git -C .worktrees/aio-clean-rebuild-vNext add -A
git -C .worktrees/aio-clean-rebuild-vNext commit `
    -m "[feature-area] Integrate feature" `
    -m "Source-Branch: <source-branch>" `
    -m "Source-SHA: <source-sha>"
```

Use prefixed subjects so the AIO history reads like a checklist:

```text
[botbooru-provider] Integrate BotBooru provider
[masquerade-provider] Integrate MasqueradeAI provider
[extended-bookmarks] Integrate provider bookmarks
[provider-guide] Document maintainer update workflow
```

Run the automated gate after every landing. Inspect shared files before
integrating the next feature. Copy documentation paths from a documentation
donor branch explicitly; never merge its stale integration tree into the new
AIO.

## Run Automated Checks

Run this minimum verification gate after every maintained feature merge and
after every AIO landing:

```powershell
node --test tests/*.mjs
git diff --check
git diff --check origin/main...HEAD
git status --short --branch
git log --oneline origin/main..HEAD
```

The bare `git diff --check` validates uncommitted working-tree changes. The
range check validates committed feature or AIO landings against refreshed
`origin/main`. Also scan for unresolved conflicts and run syntax checks for
changed JavaScript files:

```powershell
rg -n "^(<<<<<<<|=======|>>>>>>>)" .
node --check app/library.js
node --check app/library-mobile.js
node --check index.js
node --check extras/cl-helper/index.js
node --check modules/module-loader.js
```

Add provider-specific `node --check` commands and focused tests for every
changed provider. If a check is not applicable or cannot run, record that
explicitly in the branch report.

## Run Manual Smoke Checks

Run manual smoke checks on each refreshed feature branch where practical, then
repeat the combined surface on rebuilt AIO.

Desktop:

- Settings, Help, import, localization, and confirm dialogs use expected modal
  chrome and dismiss correctly.
- Thumbnail modes populate, purge, and open full avatars with and without
  CL-helper.
- Tagline edit, link, unlink, version diff, restore, and undo preserve the
  correct namespaces.
- Gallery missing-ID assignment, gallery import, and image download work.

Mobile:

- Bottom navigation, FAB search, keyboard handling, safe areas, and Android
  back behavior work at a phone viewport.
- Online search submits for every provider.
- Provider previews render skeletons first and transition to import summaries
  without a blank flash.

Providers and helper:

- Public browse, search, preview, import, linking, update checks, and gallery
  flows work for each included provider.
- Account-backed provider features work with the expected token or session
  state.
- CL-helper health, version, updater, thumbnails, and feature routes respond as
  expected.
- Bookmark toggles, filters, export/import, and pagination work when bookmarks
  are included.

Run QOL smoke checks on the independent QOL branch only unless a later task
explicitly adds QOL to AIO.

## Report Git State

End every branch task by checking:

```powershell
git status --short --branch
git log --oneline origin/main..HEAD
git rev-parse HEAD
```

Report:

- the branch and worktree,
- changed files,
- verification commands and pass/fail summary,
- the resulting commit SHA when committed,
- whether the work is uncommitted, committed locally, or pushed,
- any skipped checks or concerns.

Do not claim a push unless the remote update was actually performed and
verified.
