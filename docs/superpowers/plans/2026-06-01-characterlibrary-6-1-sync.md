# CharacterLibrary 6.1 Branch Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update the fork and maintained feature branches to CharacterLibrary 6.1, preserve QOL as an independent branch, rebuild AIO from the refreshed foundation with prefixed commits, and publish a reusable maintainer-update guide.

**Architecture:** Treat upstream `ee879cb` as an immutable foundation. Merge it into each maintained feature branch in an isolated worktree, verify each branch independently, and rebuild `codex/aio-clean-rebuild-v6.1` from updated `main` with one squash commit per included feature. Keep the existing `codex/aio-clean-rebuild` branch as a documentation donor only; never merge its stale integration tree into the rebuilt AIO branch.

**Tech Stack:** Git worktrees, PowerShell, JavaScript ES modules, Node.js built-in test runner, SillyTavern extension APIs, CL-helper Express plugin.

---

## Branch And File Map

| Area | Branch | Owned files and responsibilities |
| --- | --- | --- |
| Foundation | `main` | Exact mirror of `upstream/main` at `ee879cb` |
| MasqueradeAI | `codex/masquerade-provider` | `index.js`, `app/library*.js`, `app/library.*`, `modules/module-loader.js`, `modules/providers/browse-shared.css`, `modules/providers/masquerade/**`, `tests/masquerade-*.test.mjs` |
| BotBooru | `codex/botbooru-provider` | `.gitignore`, `index.js`, `app/library*.js`, `app/library.*`, `extras/cl-helper/**`, `modules/module-loader.js`, `modules/providers/browse-shared.css`, `modules/providers/botbooru/**`, `tests/botbooru-api.test.mjs`, `tests/cl-helper-routes.test.mjs` |
| Bookmarks | `extended-bookmarks` | `app/library.js`, `app/library.html`, `modules/providers/bookmark-module.js`, `modules/providers/browse-shared.css`, bookmarked built-in provider browse files, `tests/extended-bookmarks-contract.test.mjs` |
| QOL | `QOL` | `app/library.js`, `tests/qol-tooltip-contract.test.mjs`; excluded from AIO |
| Documentation donor | `codex/aio-clean-rebuild` | `docs/superpowers/specs/2026-06-01-characterlibrary-6-1-sync-design.md`, this plan, `docs/maintainer-update-guide.md` |
| Rebuilt integration | `codex/aio-clean-rebuild-v6.1` | Fresh `main` plus BotBooru, MasqueradeAI, bookmarks, and copied documentation paths |

## Supervised Execution Order

The parent agent performs Task 1 first. Tasks 2 through 6 then run in isolated
worktrees with disjoint branch ownership and can be delegated concurrently.
Each worker must commit its branch, report changed files and verification
output, and wait for parent review before push. The parent performs Tasks 7
through 11 sequentially because each AIO landing changes the next landing's
base.

### Task 1: Refresh The Fork Foundation

**Files:**
- Modify refs only: `refs/heads/main`, `refs/remotes/origin/main`, `refs/remotes/upstream/main`

- [ ] **Step 1: Confirm clean worktrees and configure upstream**

Run:

```powershell
$Root = 'C:\Users\DJLegnds\Downloads\SillyTavern\extension\SillyTavern-CharacterLibrary'
Set-Location $Root
git status --short --branch
git -C "$Root\.worktrees\aio-clean-rebuild" status --short --branch
if (-not ((git remote) -contains 'upstream')) {
    git remote add upstream https://github.com/Sillyanonymous/SillyTavern-CharacterLibrary.git
}
git fetch --prune origin
git fetch --prune upstream
```

Expected: both worktrees are clean; `upstream/main` resolves to `ee879cb`.

- [ ] **Step 2: Prove the foundation is a fast-forward**

Run:

```powershell
git merge-base --is-ancestor origin/main upstream/main
if ($LASTEXITCODE -ne 0) { throw 'origin/main is not an ancestor of upstream/main' }
git merge-base --is-ancestor main upstream/main
if ($LASTEXITCODE -ne 0) { throw 'local main is not an ancestor of upstream/main' }
git log --oneline origin/main..upstream/main
```

Expected: the release list contains only:

```text
ee879cb CharacterLibrary 6.1: CL-helper updater, recommender chat, CL Tagline, card-write consolidation, provider and version-history overhaul
```

- [ ] **Step 3: Fast-forward local and remote main**

Run:

```powershell
$OldLocalMain = git rev-parse refs/heads/main
git update-ref refs/heads/main refs/remotes/upstream/main $OldLocalMain
git diff --exit-code upstream/main main
git push origin refs/heads/main:refs/heads/main
git fetch origin
git diff --exit-code upstream/main origin/main
```

Expected: local `main`, `origin/main`, and `upstream/main` all resolve to
`ee879cb`.

- [ ] **Step 4: Create isolated worktrees**

Run:

```powershell
$Wt = Join-Path $Root '.worktrees'
git check-ignore -q -- .worktrees
if ($LASTEXITCODE -ne 0) { throw '.worktrees must be ignored before continuing' }
git switch main
git worktree add (Join-Path $Wt 'masquerade-provider-v6.1') codex/masquerade-provider
git worktree add (Join-Path $Wt 'botbooru-provider-v6.1') codex/botbooru-provider
git worktree add --track -b extended-bookmarks (Join-Path $Wt 'extended-bookmarks-v6.1') origin/extended-bookmarks
git worktree add --track -b QOL (Join-Path $Wt 'qol-v6.1') origin/QOL
```

Expected: four clean feature worktrees exist and the root checkout is on
`main`.

### Task 2: Write The Maintainer Update Guide

**Files:**
- Create: `docs/maintainer-update-guide.md`
- Verify: `docs/superpowers/specs/2026-06-01-characterlibrary-6-1-sync-design.md`
- Verify: `docs/superpowers/plans/2026-06-01-characterlibrary-6-1-sync.md`

Work in the existing `.worktrees/aio-clean-rebuild` checkout on
`codex/aio-clean-rebuild`.

- [ ] **Step 1: Write the guide**

Create `docs/maintainer-update-guide.md` with these sections in this order:

```markdown
# Maintainer Update Guide

## Purpose
## 1. Inspect Before Editing
## 2. Classify Branches
## 3. Use Isolated Worktrees
## 4. Dispatch Read-Only Audits
## 5. Merge Feature Branches Or Rebuild AIO
## 6. Preserve Shared Contracts
### Card Writes
### Active Tagline Namespace
### Live Gallery Folders
### CL-helper Versioning
### Modal And Mobile Behavior
## 7. Rebuild AIO With Prefixed Commits
## 8. Run Automated Checks
## 9. Run Manual Smoke Checks
## 10. Report Git State
```

Include the exact fetch gate:

```powershell
git fetch --prune origin
git fetch --prune upstream
git merge-base --is-ancestor origin/main upstream/main
git log --oneline origin/main..upstream/main
git diff --stat origin/main..upstream/main
git diff --name-status origin/main..upstream/main
```

Include the exact minimum verification gate:

```powershell
node --test tests/*.mjs
git diff --check
git status --short --branch
git log --oneline origin/main..HEAD
```

State explicitly:

```text
Never merge an old AIO branch forward when upstream changed shared contracts.
Rebuild AIO from refreshed main and integrate one verified feature at a time.
QOL remains independent unless a future task explicitly includes it.
```

- [ ] **Step 2: Verify the documentation diff**

Run:

```powershell
rg -n "T[B]D|T[O]DO|implement l[a]ter|fill in d[e]tails" docs
git diff --check
git status --short --branch
```

Expected: no placeholder hits and no whitespace errors.

- [ ] **Step 3: Commit the documentation donor**

Run:

```powershell
git add docs/maintainer-update-guide.md docs/superpowers
git commit -m "[provider-guide] Document maintainer update workflow"
```

Expected: the existing AIO docs donor contains the design, plan, and guide.

### Task 3: Update MasqueradeAI To 6.1

**Files:**
- Modify: `index.js`
- Modify: `modules/providers/masquerade/masquerade-browse.js`
- Modify as merge requires: `app/library.js`, `app/library-mobile.js`, `app/library.css`, `app/library.html`, `modules/module-loader.js`, `modules/providers/browse-shared.css`
- Test: `tests/masquerade-provider.test.mjs`
- Test: `tests/masquerade-api.test.mjs`

Work in `.worktrees/masquerade-provider-v6.1`.

- [ ] **Step 1: Merge the refreshed foundation**

Run:

```powershell
git merge --no-ff --no-commit origin/main
git diff --name-only --diff-filter=U
```

Expected: no textual conflicts. Review auto-merged shared files before commit.

- [ ] **Step 2: Write failing compatibility tests**

Extend `tests/masquerade-provider.test.mjs`:

```js
test('Masquerade mobile search resolves the character input only', async () => {
    const provider = await loadProvider();

    assert.equal(provider.browseView.getSearchInputId('character'), 'masqueradeSearchInput');
    assert.equal(provider.browseView.getSearchInputId('creator'), null);
});

test('Masquerade 6.1 integration uses shared preview utilities and ST listing names', async () => {
    const browseSource = await readFile(new URL('../modules/providers/masquerade/masquerade-browse.js', import.meta.url), 'utf8');
    const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');

    assert.match(indexSource, /PROVIDER_EXT_KEYS = \[[^\]]*'masquerade'/s);
    assert.match(browseSource, /BROWSE_PURIFY_CONFIG,\s*skeletonLines/);
    assert.doesNotMatch(browseSource, /const BROWSE_PURIFY_CONFIG\s*=/);
    assert.match(browseSource, /skeletonLines\(3\)/);
    assert.match(browseSource, /skeletonLines\(4\)/);
});
```

Extend the existing mobile import-summary test so it stubs
`window.matchMedia('(max-width: 768px)')`, records `show-summary` and
`close-preview`, and asserts:

```js
assert.ok(order.indexOf('show-summary') < order.indexOf('close-preview'));
assert.ok(waits.includes(220));
```

- [ ] **Step 3: Run tests to prove the compatibility gaps**

Run:

```powershell
node --test tests/masquerade-api.test.mjs tests/masquerade-provider.test.mjs
```

Expected: the new search hook and shared preview utility assertions fail.

- [ ] **Step 4: Add listing-name, search, and shared preview compatibility**

In `index.js`, include `masquerade`:

```js
const PROVIDER_EXT_KEYS = [
    'chub', 'jannyai', 'pygmalion', 'wyvern',
    'chartavern', 'masquerade', 'datacat'
];
```

In `modules/providers/masquerade/masquerade-browse.js`, import shared utilities:

```js
import {
    IMG_PLACEHOLDER,
    formatNumber,
    BROWSE_PURIFY_CONFIG,
    skeletonLines,
} from '../provider-utils.js';
```

Delete the provider-local `BROWSE_PURIFY_CONFIG`. Add this method to
`MasqueradeBrowseView`:

```js
getSearchInputId(mode) {
    return mode === 'character' ? 'masqueradeSearchInput' : null;
}
```

Add a helper:

```js
function setSectionSkeleton(sectionId, contentId, lines) {
    const section = document.getElementById(sectionId);
    const content = document.getElementById(contentId);
    if (section) section.style.display = 'block';
    if (content) content.innerHTML = skeletonLines(lines);
}
```

Open the preview before metadata fetch and seed:

```js
setSectionSkeleton('masqueradeCharDescriptionSection', 'masqueradeCharDescription', 3);
setSectionSkeleton('masqueradeCharPersonalitySection', 'masqueradeCharPersonality', 2);
setSectionSkeleton('masqueradeCharScenarioSection', 'masqueradeCharScenario', 2);
setSectionSkeleton('masqueradeCharFirstMsgSection', 'masqueradeCharFirstMsg', 4);
```

Apply fetched metadata only when the selected preview still matches its ID.

- [ ] **Step 5: Preserve the mobile import-summary transition**

In `importSelectedCharacter()`, use:

```js
if (showSummary) {
    if (window.matchMedia?.('(max-width: 768px)').matches) {
        showImportSummaryModal?.(importSummary);
        await new Promise(resolve => setTimeout(resolve, 220));
        closePreviewModal();
    } else {
        closePreviewModal();
        await new Promise(resolve => requestAnimationFrame(resolve));
        showImportSummaryModal?.(importSummary);
    }
} else {
    if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-check"></i> Imported';
    await new Promise(resolve => setTimeout(resolve, 350));
    closePreviewModal();
}
```

- [ ] **Step 6: Verify native tagline preservation**

MasqueradeAI already projects and stores native taglines. Add or retain:

```js
assert.equal(card.data.extensions.masquerade.tagline, 'A public tagline');
```

Verify `MasqueradeProvider.getComparableFields()` includes:

```text
extensions.masquerade.tagline
```

- [ ] **Step 7: Verify and commit**

Run:

```powershell
node --test tests/*.mjs
node --check index.js
node --check modules/providers/masquerade/masquerade-api.js
node --check modules/providers/masquerade/masquerade-browse.js
node --check modules/providers/masquerade/masquerade-provider.js
node --check modules/module-loader.js
git diff --check
git add -A
git commit -m "Merge CharacterLibrary 6.1 foundation into MasqueradeAI provider"
git diff --check origin/main...HEAD
git status --short --branch
```

Expected: all tests and syntax checks pass.

### Task 4: Update BotBooru To 6.1

**Files:**
- Modify: `app/library.js`
- Modify: `app/library.html`
- Modify: `app/library-mobile.js`
- Modify: `index.js`
- Modify: `extras/cl-helper/index.js`
- Modify: `extras/cl-helper/package.json`
- Modify: `modules/module-loader.js`
- Modify: `modules/providers/browse-shared.css`
- Modify: `modules/providers/botbooru/botbooru-browse.js`
- Modify when evidence exists: `modules/providers/botbooru/botbooru-api.js`
- Modify when evidence exists: `modules/providers/botbooru/botbooru-provider.js`
- Test: `tests/botbooru-api.test.mjs`
- Test: `tests/cl-helper-routes.test.mjs`

Work in `.worktrees/botbooru-provider-v6.1`.

- [ ] **Step 1: Merge the refreshed foundation and inspect the known conflict**

Run:

```powershell
git merge --no-ff --no-commit origin/main
git diff --name-only --diff-filter=U
```

Expected: `app/library.js` is the only textual conflict.

- [ ] **Step 2: Resolve CL-helper settings additively**

Inside `setupSettingsModal()`, retain:

```js
checkClHelperPlugin(
    pygmalionPluginBanner, pygmalionSettingsFields,
    ctPluginBanner, ctSettingsFields,
    datacatPluginBanner, datacatSettingsFields,
    botbooruPluginBanner, botbooruSettingsFields,
    gridThumbsClHelperBanner, settingsGridThumbClHelperFields,
    galleryThumbsClHelperBanner, galleryThumbsClHelperFields,
).then(available => {
    if (datacatSessionStatus) {
        datacatSessionStatus.textContent = available ? 'CL-helper detected' : 'CL-helper unavailable';
    }
    if (botbooruSessionStatus) {
        botbooruSessionStatus.textContent = available ? 'CL-helper detected' : 'CL-helper unavailable';
    }
});
```

Preserve upstream `refreshClHelperUpdateBanner(...)`.

- [ ] **Step 3: Preserve helper routes and bump the bundled helper**

In `extras/cl-helper/index.js`, retain upstream `/health` metadata and
`/self-update`, plus:

```js
registerDataCatRoutes(router);
registerBotBooruRoutes(router);
registerImgchestRoutes(router);
```

In `extras/cl-helper/package.json`, set:

```json
{
  "version": "1.5.5"
}
```

The new version is required because upstream helper `1.5.4` does not include
BotBooru `/bb-*` routes.

- [ ] **Step 4: Write failing helper and preview contract tests**

Create `tests/cl-helper-routes.test.mjs` with source-contract checks:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('CL-helper keeps updater, DataCat, and BotBooru routes together', async () => {
    const source = await readFile(new URL('../extras/cl-helper/index.js', import.meta.url), 'utf8');
    const pkg = JSON.parse(await readFile(new URL('../extras/cl-helper/package.json', import.meta.url), 'utf8'));

    assert.equal(pkg.version, '1.5.5');
    assert.match(source, /router\.post\(['"]\/self-update['"]/);
    assert.match(source, /registerDataCatRoutes\(router\)/);
    assert.match(source, /registerBotBooruRoutes\(router\)/);
    assert.match(source, /registerImgchestRoutes\(router\)/);
    assert.match(source, /['"]\/bb-following['"]/);
    assert.match(source, /['"]\/bb-users\/:userId\/follow['"]/);
});
```

Extend `tests/botbooru-api.test.mjs` after exporting
`getBotbooruPreviewSectionPlan()`:

```js
test('BotBooru preview hides empty notes and skeletonizes missing definitions while loading', async () => {
    globalThis.window ||= {};
    const { getBotbooruPreviewSectionPlan } = await import(`../modules/providers/botbooru/botbooru-browse.js?case=preview-plan-${Date.now()}`);
    const plan = getBotbooruPreviewSectionPlan({}, { loading: true });

    assert.equal(plan.find(x => x.id === 'botbooruCharCreatorNotes').mode, 'hidden');
    assert.equal(plan.find(x => x.id === 'botbooruCharDescription').mode, 'skeleton');
});
```

- [ ] **Step 5: Add skeleton-first BotBooru preview behavior**

In `modules/providers/botbooru/botbooru-browse.js`, import:

```js
import { formatNumber, skeletonLines } from '../provider-utils.js';
```

Add:

```js
export function getBotbooruPreviewSectionPlan(char, { loading = false } = {}) {
    const notes = String(char?.creator_notes || char?.description || '').trim();
    const description = String(char?.description || '').trim();
    return [
        { id: 'botbooruCharCreatorNotes', mode: notes ? 'content' : 'hidden' },
        { id: 'botbooruCharDescription', mode: description ? 'content' : (loading ? 'skeleton' : 'hidden') },
    ];
}
```

Use the plan during initial preview render, after card JSON succeeds, and after
card JSON fails. Empty Creator's Notes must remain hidden rather than flashing a
placeholder.

- [ ] **Step 6: Preserve shared integration**

Confirm these exact outcomes:

```text
index.js: PROVIDER_EXT_KEYS includes 'botbooru' after the ext.cl.pageName fallback.
modules/module-loader.js: BotBooru CSS and import remain registered; MODULE_CSS_VERSION is 73.
app/library-mobile.js: upstream syncSort() gating remains; BotBooru fullSrc and previewSrc avatar behavior remains.
app/library.html: upstream tagline editor and helper Info status remain; BotBooru helper banner includes cl-goto-info.
modules/providers/browse-shared.css: upstream opacity-only fade and BotBooru selectors both remain.
```

- [ ] **Step 7: Audit native BotBooru tagline evidence**

Inspect a real public BotBooru payload before mapping a source-native tagline.
If the payload proves `post.tagline`, add:

```js
// normalizeBotbooruPost()
tagline: post.tagline || '',
```

and:

```js
// ensureBotbooruExtension()
tagline: post?.tagline || existing.tagline || '',
```

Also include `extensions.botbooru.tagline` in comparable fields. If the payload
does not prove a native field, keep manually edited linked-card taglines under
`extensions.botbooru.tagline`, add a short note to the commit body, and do not
map `meta_name` or `creator_notes`.

- [ ] **Step 8: Verify and commit**

Run:

```powershell
node --test tests/*.mjs
node --check app/library.js
node --check app/library-mobile.js
node --check index.js
node --check extras/cl-helper/index.js
node --check modules/module-loader.js
node --check modules/providers/botbooru/botbooru-api.js
node --check modules/providers/botbooru/botbooru-browse.js
node --check modules/providers/botbooru/botbooru-provider.js
rg -n "^(<<<<<<<|=======|>>>>>>>)" .
git diff --check
git add -A
git commit -m "Merge CharacterLibrary 6.1 foundation into BotBooru provider"
git diff --check origin/main...HEAD
git status --short --branch
```

Expected: tests and syntax checks pass; no conflict markers remain.

### Task 5: Update Extended Bookmarks To 6.1

**Files:**
- Modify: `app/library.js`
- Modify: `app/library.html`
- Modify: `modules/providers/wyvern/wyvern-browse.js`
- Modify: `modules/providers/datacat/datacat-browse.css`
- Verify: `modules/providers/bookmark-module.js`
- Verify: `modules/providers/browse-shared.css`
- Verify: bookmarked built-in provider browse files
- Test: `tests/extended-bookmarks-contract.test.mjs`

Work in `.worktrees/extended-bookmarks-v6.1`.

- [ ] **Step 1: Merge the refreshed foundation**

Run:

```powershell
git merge --no-ff --no-commit origin/main
git diff --name-only --diff-filter=U
```

Expected: conflicts in `app/library.js` and
`modules/providers/wyvern/wyvern-browse.js`.

- [ ] **Step 2: Resolve gallery migration without reviving obsolete mappings**

In `setupSettingsModal()`, retain the bookmark backup import and export block
from `extended-bookmarks`. Then retain upstream's ID-only migration:

```js
const needsId = countCharactersNeedingGalleryId();
if (needsId === 0) {
    showToast('All characters already have gallery IDs.', 'info');
    updateGalleryMigrationStatus();
    return;
}
```

Keep the upstream loop calling `assignGalleryIdToCharacter(char)`.

Do not retain calls to:

```text
countCharactersNeedingFolderRegistration
registerGalleryFolderOverride
removeGalleryFolderOverride
fullGallerySync
```

- [ ] **Step 3: Resolve Wyvern imports**

Use:

```js
import { IMG_PLACEHOLDER, formatNumber, fetchWithProxy, BROWSE_PURIFY_CONFIG, skeletonLines } from '../provider-utils.js';
import { createBookmarkModule } from '../bookmark-module.js';
```

Preserve `wyvernFollowingHasMore`, Following pagination in `canLoadMore()`,
skeleton-first previews, and failed-fetch skeleton collapse.

- [ ] **Step 4: Add a source-contract regression test**

Create `tests/extended-bookmarks-contract.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('bookmarks coexist with 6.1 gallery migration and Wyvern previews', async () => {
    const app = await readFile(new URL('../app/library.js', import.meta.url), 'utf8');
    const wyvern = await readFile(new URL('../modules/providers/wyvern/wyvern-browse.js', import.meta.url), 'utf8');

    assert.match(app, /countCharactersNeedingGalleryId\(\)/);
    assert.match(app, /assignGalleryIdToCharacter\(char\)/);
    assert.doesNotMatch(app, /countCharactersNeedingFolderRegistration/);
    assert.doesNotMatch(app, /registerGalleryFolderOverride/);
    assert.match(wyvern, /skeletonLines/);
    assert.match(wyvern, /createBookmarkModule/);
});
```

- [ ] **Step 5: Remove the bookmark branch whitespace regression**

Remove the blank EOF line in:

```text
modules/providers/datacat/datacat-browse.css
```

- [ ] **Step 6: Verify and commit**

Run:

```powershell
node --test tests/*.mjs
node --check app/library.js
node --check modules/providers/bookmark-module.js
node --check modules/providers/wyvern/wyvern-browse.js
rg -n "^(<<<<<<<|=======|>>>>>>>)" app modules
rg -n "countCharactersNeedingFolderRegistration|registerGalleryFolderOverride|removeGalleryFolderOverride|fullGallerySync" app/library.js
git diff --check
git add -A
git commit -m "Merge CharacterLibrary 6.1 foundation into extended bookmarks"
git diff --check origin/main...HEAD
git status --short --branch
```

Expected: tests pass, obsolete gallery mapping names are absent, and no
whitespace regression remains beyond upstream's unchanged lines.

### Task 6: Update QOL Independently

**Files:**
- Modify: `app/library.js`
- Test: `tests/qol-tooltip-contract.test.mjs`

Work in `.worktrees/qol-v6.1`.

- [ ] **Step 1: Merge the refreshed foundation**

Run:

```powershell
git merge --no-ff --no-commit origin/main
git diff --name-only --diff-filter=U
```

Expected: no textual conflicts.

- [ ] **Step 2: Write a failing tooltip resolver test**

Create `tests/qol-tooltip-contract.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('QOL card tooltip uses the canonical active tagline resolver', async () => {
    const source = await readFile(new URL('../app/library.js', import.meta.url), 'utf8');

    assert.match(source, /const tooltipSource = getDisplayTagline\(char\)/);
    assert.doesNotMatch(source, /const providerTagline = providerMatch/);
    assert.match(source, /modalTitleEl\.title = ''/);
});
```

- [ ] **Step 3: Use the canonical tagline resolver**

In `createCharacterCard()`, replace direct provider lookup with:

```js
const tooltipSource = getDisplayTagline(char)
    || char.data?.creator_notes
    || char.creator_notes
    || '';
```

Keep QOL's delegated truncated-name hover listener after
`setupCharacterGridDelegates()` and keep `modalTitleEl.title = ''` in
`openModal()`.

- [ ] **Step 4: Verify QOL remains independent**

Run:

```powershell
node --test tests/*.mjs
node --check app/library.js
git diff --check
git add -A
git commit -m "Merge CharacterLibrary 6.1 foundation into QOL"
git diff --check origin/main...HEAD
git status --short --branch
```

Expected: checks pass. Do not integrate QOL into AIO.

### Task 7: Review And Push Source Branches

**Files:**
- Verify refs only

- [ ] **Step 1: Parent review each worker branch**

For each feature worktree, run:

```powershell
git status --short --branch
git log --oneline --decorate -3
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
node --test tests/*.mjs
```

Expected: each branch is clean and verified.

- [ ] **Step 2: Push maintained branches**

Run:

```powershell
git -C "$Wt\masquerade-provider-v6.1" push -u origin codex/masquerade-provider
git -C "$Wt\botbooru-provider-v6.1" push -u origin codex/botbooru-provider
git -C "$Wt\extended-bookmarks-v6.1" push -u origin extended-bookmarks
git -C "$Wt\qol-v6.1" push -u origin QOL
git -C "$Root\.worktrees\aio-clean-rebuild" push -u origin codex/aio-clean-rebuild
```

Expected: maintained feature branches and the documentation donor are pushed.

### Task 8: Create Fresh AIO And Integrate BotBooru

**Files:**
- Create worktree: `.worktrees/aio-clean-rebuild-v6.1`
- Modify: BotBooru-owned paths listed in Task 4

- [ ] **Step 1: Create fresh AIO**

Run:

```powershell
$Aio = Join-Path $Wt 'aio-clean-rebuild-v6.1'
git worktree add -b codex/aio-clean-rebuild-v6.1 $Aio origin/main
$BotSource = git -C "$Wt\botbooru-provider-v6.1" rev-parse HEAD
```

- [ ] **Step 2: Squash BotBooru and verify**

Run:

```powershell
git -C $Aio merge --squash --no-commit $BotSource
git -C $Aio add -A
git -C $Aio commit -m "[botbooru-provider] Integrate BotBooru provider" -m "Source-Branch: codex/botbooru-provider" -m "Source-SHA: $BotSource"
Push-Location $Aio
node --test tests/*.mjs
git diff --check origin/main...HEAD
Pop-Location
```

Expected: BotBooru landing passes its focused suite.

### Task 9: Integrate MasqueradeAI

**Files:**
- Modify: MasqueradeAI-owned paths listed in Task 3

- [ ] **Step 1: Squash MasqueradeAI and verify**

Run:

```powershell
$MasqSource = git -C "$Wt\masquerade-provider-v6.1" rev-parse HEAD
git -C $Aio merge --squash --no-commit $MasqSource
git -C $Aio add -A
git -C $Aio commit -m "[masquerade-provider] Integrate MasqueradeAI provider" -m "Source-Branch: codex/masquerade-provider" -m "Source-SHA: $MasqSource"
Push-Location $Aio
node --test tests/*.mjs
git diff --check origin/main...HEAD
Pop-Location
```

Expected: combined BotBooru and MasqueradeAI tests pass.

### Task 10: Integrate Extended Bookmarks

**Files:**
- Modify: bookmark-owned paths listed in Task 5

- [ ] **Step 1: Squash bookmarks and verify**

Run:

```powershell
$BooksSource = git -C "$Wt\extended-bookmarks-v6.1" rev-parse HEAD
git -C $Aio merge --squash --no-commit $BooksSource
git -C $Aio add -A
git -C $Aio commit -m "[extended-bookmarks] Integrate provider bookmarks" -m "Source-Branch: extended-bookmarks" -m "Source-SHA: $BooksSource"
Push-Location $Aio
node --test tests/*.mjs
node --check app/library.js
node --check modules/providers/wyvern/wyvern-browse.js
git diff --check origin/main...HEAD
Pop-Location
```

Expected: bookmarks coexist with 6.1 gallery migration and provider previews.

### Task 11: Copy Documentation And Publish Rebuilt AIO

**Files:**
- Copy: `docs/maintainer-update-guide.md`
- Copy: `docs/superpowers/specs/2026-06-01-characterlibrary-6-1-sync-design.md`
- Copy: `docs/superpowers/plans/2026-06-01-characterlibrary-6-1-sync.md`

- [ ] **Step 1: Copy documentation paths only**

Run:

```powershell
$DocsSource = git -C "$Root\.worktrees\aio-clean-rebuild" rev-parse HEAD
git -C $Aio checkout $DocsSource -- docs/maintainer-update-guide.md docs/superpowers/specs/2026-06-01-characterlibrary-6-1-sync-design.md docs/superpowers/plans/2026-06-01-characterlibrary-6-1-sync.md
git -C $Aio add docs
git -C $Aio commit -m "[provider-guide] Document maintainer update workflow" -m "Source-Branch: codex/aio-clean-rebuild" -m "Source-SHA: $DocsSource"
```

Expected: stale AIO code is not copied.

- [ ] **Step 2: Run the complete automated gate**

Run:

```powershell
Push-Location $Aio
node --test tests/*.mjs
node --check app/library.js
node --check app/library-mobile.js
node --check index.js
node --check extras/cl-helper/index.js
node --check modules/module-loader.js
node --check modules/providers/botbooru/botbooru-api.js
node --check modules/providers/botbooru/botbooru-browse.js
node --check modules/providers/botbooru/botbooru-provider.js
node --check modules/providers/masquerade/masquerade-api.js
node --check modules/providers/masquerade/masquerade-browse.js
node --check modules/providers/masquerade/masquerade-provider.js
rg -n "^(<<<<<<<|=======|>>>>>>>)" .
git diff --check origin/main...HEAD
git status --short --branch
git log --reverse --format='%h %s%n%b%n---' origin/main..HEAD
Pop-Location
```

Expected: the rebuilt AIO worktree is clean and the log contains exactly four
prefixed commits, each with a `Source-SHA`.

- [ ] **Step 3: Run manual smoke checks**

Verify:

```text
Desktop: settings, helper updater banner, thumbnails, taglines, link/unlink, version restore, gallery missing-ID migration.
Mobile: bottom nav, Online FAB search, Masquerade search, preview skeletons, no-flash import summaries, Android back behavior.
BotBooru: public browse, token state, favorites, following, creator follow, helper routes, Creator's Notes.
Bookmarks: footer and modal toggles, filters, export/import, Wyvern Following pagination.
QOL branch only: tooltip resolver and truncated-name hover behavior.
```

- [ ] **Step 4: Push rebuilt AIO and report status**

Run:

```powershell
git -C $Aio push -u origin codex/aio-clean-rebuild-v6.1
git -C $Aio status --short --branch
git ls-remote --heads origin
```

Expected: `codex/aio-clean-rebuild-v6.1` is committed, pushed, and synchronized
with origin.
