# CharacterLibrary 6.1 Branch Sync Design

## Goal

Update the maintained fork branches to Sillyanonymous's CharacterLibrary 6.1
baseline at `ee879cb`, preserve each feature branch as an independently usable
line of development, rebuild the all-in-one branch from the refreshed
foundation, add native tagline support for MasqueradeAI and BotBooru, and
document a repeatable workflow for future maintainer releases.

## Context

The fork's `origin/main` currently ends at `c137b30`. Upstream `main` adds one
large release commit:

```text
ee879cb CharacterLibrary 6.1: CL-helper updater, recommender chat, CL Tagline,
        card-write consolidation, provider and version-history overhaul
```

That release changes 35 files and introduces contracts that custom providers
must follow:

- provider-agnostic `extensions.cl.tagline` storage and provider namespace
  migration during link and unlink;
- centralized card mutation through `CoreAPI.writeCardFields` and
  `CoreAPI.applyCardFieldUpdates`;
- registry-driven provider metadata;
- live gallery-folder computation through a SillyTavern-side `Proxy`;
- simplified missing-gallery-ID migration;
- skeleton-first provider preview rendering and mobile no-flash import-summary
  transitions;
- CL-helper health, version, and self-update behavior.

The existing AIO branch is disposable integration output. It must not be merged
forward wholesale across this release.

## Maintained Branches

Update these branches individually:

| Branch | Purpose | AIO inclusion |
| --- | --- | --- |
| `main` | Fork baseline tracking upstream | Foundation only |
| `codex/masquerade-provider` | MasqueradeAI provider | Include |
| `codex/botbooru-provider` | BotBooru provider | Include |
| `extended-bookmarks` | Local provider bookmarks | Include |
| `QOL` | Independent tooltip and naming polish | Exclude |

Leave these branches untouched as historical donors:

- `codex/aio-clean-rebuild`
- `backup/aio-clean-rebuild-before-sync`
- `codex/botbooru-provider-impl`
- detached experimental worktrees

Create the rebuilt integration branch as:

```text
codex/aio-clean-rebuild-v6.1
```

## Sync Strategy

### Foundation

Fast-forward local `main` and the fork's `origin/main` from `c137b30` to
upstream `ee879cb`. Use the refreshed upstream commit unchanged as the
foundation.

### Feature Branches

Merge the refreshed `main` into each maintained feature branch individually.
Preserve the feature branch history. Resolve conflicts against the 6.1
contracts, run branch-focused verification, and push each branch before moving
to AIO reconstruction.

Expected branch-specific work:

#### MasqueradeAI

- Add `masquerade` to the SillyTavern-side listing-name namespace lookup in
  `index.js`.
- Add the mobile Online-search input hook expected by the shared browse view.
- Align previews with the upstream skeleton-first rendering pattern.
- Keep the preview behind the mobile import summary briefly to avoid a blank
  transition.
- Verify Masquerade gallery import and download behavior with live gallery
  folder computation.

#### BotBooru

- Resolve the `app/library.js` CL-helper status merge by preserving BotBooru
  banner fields and upstream thumbnail, gallery, health, version, and updater
  fields.
- Verify BotBooru CL-helper routes remain registered beside the 6.1 Dropbox and
  updater routes.
- Keep BotBooru's secure Creator's Notes rendering while aligning empty-state
  and skeleton-first behavior where appropriate.

#### Extended Bookmarks

- Keep bookmark backup import and export.
- Retain the new 6.1 ID-only `migrateGalleryFoldersBtn` behavior.
- Do not restore obsolete persisted folder-mapping cleanup UI.
- Combine bookmark imports with upstream `skeletonLines` imports in Wyvern.
- Review all bookmarked built-in providers after the upstream preview sweep.

#### QOL

- Update against 6.1 independently.
- Adapt tooltip selection to the new active tagline namespace resolver.
- Do not include QOL commits in AIO.

## Native Tagline Follow-Up

Native source taglines for MasqueradeAI and BotBooru are part of this update
cycle, but land after each provider branch is stable on the 6.1 foundation.

For each custom provider:

1. Identify the source-native tagline field with fixture evidence.
2. Normalize that field in the provider API adapter.
3. Store linked-card taglines under the provider namespace while allowing
   upstream 6.1 to migrate values to and from `extensions.cl.tagline` during
   link and unlink.
4. Prefer the active provider tagline in linked-card rendering and preserve the
   provider-agnostic fallback for unlinked cards.
5. Add focused tests for import, link, unlink, rendering fallback, and version
   history compatibility.

Do not couple native tagline extraction to the foundation merge. If source
evidence is missing or ambiguous, stop that provider's tagline subtask and keep
the 6.1 fallback behavior intact.

## AIO Rebuild

Create `codex/aio-clean-rebuild-v6.1` from refreshed `main`. Integrate each
verified non-QOL feature branch as a clean logical commit. Do not merge the
feature branches wholesale into AIO.

Use prefixed AIO commit subjects:

```text
[botbooru-provider] Integrate BotBooru provider
[masquerade-provider] Integrate MasqueradeAI provider
[extended-bookmarks] Integrate provider bookmarks
[provider-guide] Document maintainer update workflow
```

Preserve source commit hashes in commit bodies when squashing or recreating
feature changes. Add compatibility fixes to the owning feature branch first
when practical, then carry them into AIO through that integration commit.

Inspect these shared files after each AIO landing:

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

## Maintainer Update Guide

Add a durable runbook at:

```text
docs/maintainer-update-guide.md
```

The guide must explain:

- how to fetch and compare a maintainer release before editing;
- how to classify maintained, donor, backup, and disposable AIO branches;
- how to dispatch parallel read-only audits for desktop, mobile, providers, and
  branch topology;
- when to merge a release into a feature branch versus rebuild from a fresh
  base;
- the shared conflict hotspots and 6.1 card-write, tagline, gallery, helper,
  modal, and mobile contracts;
- how to rebuild AIO with prefixed commits and source hashes;
- the automated and manual verification matrix;
- how to check status and report whether each branch is uncommitted,
  committed, or pushed.

## Verification

### Automated Checks

Run after every feature branch merge and after each AIO integration landing:

```powershell
node --test tests/*.mjs
git diff --check
git status --short --branch
```

Run syntax checks for changed provider, helper, and loader files where they are
not covered by tests.

### Desktop Smoke Checks

- Settings, Help, import, localization, and confirm dialogs use the expected
  modal chrome and dismiss correctly.
- Thumbnail modes populate, purge, and open full avatars correctly with and
  without CL-helper.
- Filtered grid detail navigation and dirty-edit prompts behave correctly.
- Tagline edit, link, unlink, version diff, restore, and undo preserve the
  correct namespaces.
- Gallery missing-ID assignment, legacy mapping report generation, and Dropbox
  extraction work as designed.

### Mobile Smoke Checks

- Bottom navigation, FAB search, keyboard handling, safe areas, and Android
  back behavior work at a phone viewport.
- Online FAB search submits correctly for every provider, including
  MasqueradeAI and BotBooru.
- Provider previews render skeletons first, hide empty Creator's Notes, and
  transition to import summaries without a blank flash.
- Card gestures, detail navigation swipes, drawers, sheets, and recommender
  chat remain usable.

### Provider Checks

- MasqueradeAI public browse, search, preview, import, gallery import, linking,
  update checks, listing names, and native taglines.
- BotBooru public browse, token validation, favorites, following, tags, creator
  follow, helper routes, Creator's Notes, listing names, and native taglines.
- Bookmark filters, bookmark import and export, Wyvern Following pagination,
  and gallery migration controls on the rebuilt AIO branch.

## Subagent Execution Model

Use supervised subagents after the implementation plan is approved:

- one worker for each maintained feature branch;
- one worker for the maintainer-update guide;
- one integration worker for the fresh AIO rebuild after feature branches are
  verified;
- parent-agent review after every worker result;
- full verification from the parent before any completion claim or push.

Workers must use isolated worktrees, own disjoint branches, avoid reverting
other work, and report changed files, test commands, commit hashes, and push
state.

## Success Criteria

- `main` matches upstream `ee879cb` and is pushed.
- Each maintained feature branch is independently usable on 6.1 and pushed.
- QOL remains independent and is excluded from AIO.
- Native MasqueradeAI and BotBooru taglines work with 6.1 namespace migration.
- `codex/aio-clean-rebuild-v6.1` starts from refreshed `main`, contains one
  prefixed logical integration commit per included feature area, passes the
  complete verification matrix, and is pushed.
- `docs/maintainer-update-guide.md` exists and describes the repeatable sync
  workflow.
