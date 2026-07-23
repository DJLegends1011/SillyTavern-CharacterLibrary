# Compact Provider Detail Actions

**Status:** Approved design  
**Date:** 2026-07-23

## Objective

Bring the DataCat account-save control, JannyAI account-bookmark control, and
local backup control into the compact character-detail presentation established
by the maintainer's ChubAI and BotBooru providers.

The provider-native account actions remain distinct from Character Library's
local backup feature. This change makes their presentation and Features-menu
grouping consistent, merges DataCat's account-save and folder entry points,
and removes duplicate DataCat feedback.

## Reference Pattern

ChubAI and BotBooru render their provider-native favorite control inside
`.browse-char-meta` as a compact `browse-fav-toggle`. The icon changes between
regular and solid heart states, while a tooltip explains the current action.
Open, Import, and Close remain in `.modal-controls`.

The new controls will follow that visual hierarchy:

1. Identity, provider statistics, and compact save/bookmark actions in the
   character metadata.
2. Navigation and import actions in the modal controls.
3. JannyAI collection management remains a separate secondary action. DataCat
   folder management opens from its single compact heart.

## Source Branches

The work is divided by the feature's original source branch:

- `codex/datacat-account-sync`
- `codex/jannyai-account-sync`
- `extended-bookmarks`

Each implementation commit is made on its source branch first and then brought
into `aio-v6.7.0` with its existing prefix:

- `[datacat-account-sync]`
- `[jannyai-account-sync]`
- `[extended-bookmarks]`

## DataCat UX

### Character details

- Replace both the large star-labelled **Save** action and the separate
  **Folder** action with one compact heart in the character metadata.
- Clicking the heart opens the existing DataCat folder picker. The heart does
  not directly toggle Main/Yours.
- Use a regular heart when the character belongs to neither Main nor a custom
  folder. Use a solid heart when the status response reports
  `collected === true` or at least one custom `folderId`.
- Give the control the tooltip and accessible label **Save to folder**.
- Keep the existing DataCat account and folder APIs. The folder picker becomes
  the sole UI for adding or removing Main and custom-folder membership.
- Keep Local Backup, **Open**, **Import**, and **Close** as separate actions.

The character-detail save action is the only DataCat provider-native save
control on desktop and mobile. Mobile may use the existing detail-action
collapse mechanism when the metadata row cannot be displayed, but it must
mirror the same canonical heart state, open the same folder picker, and must
not create a grid-card control.

### Grid cards

- Remove the DataCat Yours star overlay from every DataCat grid-card mode on
  desktop and mobile.
- Remove the associated grid click handling, lazy state probes, and responsive
  affordances only where they exist solely to render or operate that star.
- Preserve the Local Backup grid icon supplied by `extended-bookmarks`.
- Preserve all other card badges, statistics, and card-opening behavior.

### Save notifications

- A successful DataCat save produces one notification only.
- Use the DataCat-style success treatment: a check icon and
  `Saved to "<folder name>"`.
- The Main/Yours save names its destination consistently with the folder
  picker; a custom folder uses its displayed folder name.
- Remove duplicate success notifications emitted by overlapping save and
  folder helpers.
- Failures still produce one actionable error notification.

### Features filter

- Place the DataCat account filter under
  **PERSONAL (REQUIRES LOGIN)**.
- Label it **My Folders** and use a heart icon.
- Preserve its current Yours/folder filtering behavior and the secondary
  All Yours/Main/custom-folder selector.

## JannyAI UX

- Replace the large **Bookmark** action with a compact inline bookmark control
  in the character metadata.
- Use regular and solid bookmark icons for inactive and active states.
- Give the control a state-aware tooltip and accessible label:
  **Save to Janny bookmarks** or **Remove from Janny bookmarks**.
- Keep the existing JannyAI account API, bookmark limits, loading state, and
  error handling.
- Keep **Add to collection**, **Open**, **Import**, and **Close** as separate
  actions.
- Apply the same character-detail behavior on desktop and mobile without adding
  a new grid-card account-bookmark control.
- In Features, place the account filter under
  **PERSONAL (REQUIRES LOGIN)** and label it **My Bookmarks**.

## Local Backup UX

The `extended-bookmarks` branch continues to support only its original provider
set:

- CharacterTavern
- DataCat
- JannyAI
- Pygmalion
- Wyvern

For those providers:

- Replace the full **Local Backup** detail button with a compact inline backup
  icon in the character metadata.
- Preserve the existing inactive/active state, persistence, filters, grid-card
  backup icons, and bookmark-only views.
- Add state-aware tooltips and accessible labels:
  **Save local backup** or **Remove local backup**.
- Do not add this control to ChubAI, BotBooru, MasqueradeAI, or any other
  provider that the branch did not initially support.
- In each supported provider's Features menu, place the local filter under
  **LIBRARY** and label it **Local Backups**.
- Remove the standalone **Bookmarks** section. Keep **Hide Owned Characters**
  and **Hide Possible Matches** in the same Library group.

## Shared Presentation

Compact provider actions share the maintainer's visual contract:

- Inline placement in character metadata.
- Icon-only presentation.
- Clear hover tooltip and accessible label.
- Visible inactive, active, loading, and unavailable states.
- No layout shift when state changes.
- Touch target remains usable in the mobile character-detail surface.

Shared CSS or rendering helpers may be introduced where they reduce
duplication, but provider-specific account state and API behavior remain in
their provider modules.

## Error and Authentication Behavior

- Logged-out or unavailable account actions remain visible when that matches
  the provider's existing behavior, with a tooltip explaining the requirement.
- Activating an unavailable provider-native control follows its current login
  or informational flow.
- A failed mutation restores the last authoritative icon state and emits one
  error notification.
- Local Backup continues to function independently of provider authentication.

## Verification

### Automated checks

- DataCat grid-card markup contains no DataCat Yours star control.
- DataCat detail markup places the heart in character metadata, not modal
  controls.
- DataCat detail markup contains no separate account Save or Folder button.
- Clicking the DataCat heart opens the existing folder picker.
- DataCat status updates render a solid heart for Main or any custom-folder
  membership and a regular heart only when no membership exists.
- The DataCat tooltip and accessible label are **Save to folder**.
- A successful DataCat folder save emits exactly one success notification with
  the destination folder name.
- JannyAI detail markup places the bookmark in character metadata, not modal
  controls.
- JannyAI bookmark state updates preserve limits and account error handling.
- Local Backup detail markup is compact for exactly the five original
  providers.
- Local Backup grid controls and persisted backup behavior remain unchanged.
- Features-menu checks enforce **My Folders** and **My Bookmarks** under
  Personal, and **Local Backups** under Library with no standalone Bookmarks
  section.

### Browser checks

- Inspect DataCat and JannyAI character details on desktop.
- Inspect the same details at the project's mobile breakpoint.
- Confirm DataCat cards have no provider-native star on either layout.
- Confirm Local Backup remains on supported grid cards.
- Open the DataCat folder picker from the heart, change Main/custom-folder
  membership, and verify icon, tooltip, and notification behavior.
- Confirm Features-menu groupings and labels match the approved Personal and
  Library structure.
- Confirm Open, Import, Add to Collection, and Close still work and the detail
  header no longer appears crowded.

## Non-Goals

- Changing provider APIs, authentication, or account data models.
- Merging provider-native saves/bookmarks with Local Backup.
- Adding local backups to additional providers.
- Restyling unrelated provider toolbars, grids, or detail content.
- Changing ChubAI or BotBooru behavior.
