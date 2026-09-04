# JannyAI account sync UX notes

These notes capture UX issues observed on the `codex/jannyai-account-sync` branch before turning them into an implementation plan.

## Issue 1: Save/remove card to collection

### Current CL branch behavior

- The Janny preview modal renders collections as a full `Collections` section below the card metadata.
- The section contains a native select labeled `Choose collection...` and a separate full-width `Add to collection` button.
- This makes collection saving feel heavier than the rest of the modal actions because it takes two explicit steps and occupies persistent vertical space.

### Native JannyAI behavior

Observed on:
`https://jannyai.com/characters/f207e6d4-205e-48c4-86a0-27b327bc651d_character-ruler-of-grain`

- The character page places `Add to collection` as a compact action beside `Download` and `Bookmark`.
- Clicking `Add to collection` opens a dropdown list directly below that action.
- Clicking a collection immediately adds the card; there is no separate submit button.
- A selected collection shows a check mark in its dropdown row.
- Clicking the checked collection again removes the card from that collection.
- The dropdown stays open after add/remove so the check state updates in place.
- Success feedback appears as a toast:
  - `Added RULER OF GRAIN to extra bookmarks.`
  - `Removed RULER OF GRAIN from extra bookmarks.`
- Long collection names truncate in the dropdown.

### Needed CL UX change

Replace the persistent preview-modal `Collections` section with a Janny-style collection dropdown action near the existing `Bookmark` and `Import` controls.

The dropdown should:

- Load and show the user's collections on open.
- Toggle membership immediately when a collection row is clicked.
- Show checked state for collections containing the current character.
- Keep the dropdown open after each add/remove so multiple memberships can be changed quickly.
- Toast clear add/remove results using the character and collection names.
- Truncate long collection names instead of expanding the modal.
- Preserve account setup/error handling by routing missing account, Cloudflare, and cl-helper failures to concise toasts or inline dropdown empty/error states.

## Issue 2: Collections tab is missing public collection browsing

### Current CL branch behavior

- The new `Collections` tab is useful and should stay.
- The current tab is focused on account-owned collections only:
  - `My Janny Collections` header.
  - Inline create-collection form.
  - Private collection rows with name, card count, privacy, and `Open`.
  - An opened collection renders its character cards below the user's collection list.
- The collection rows do not show collection descriptions.
- There is no public collection discovery surface.

### Native JannyAI behavior

Observed on:
`https://jannyai.com/collections`

- The top-level Collections page is public browsing first, not just account management.
- It includes `My collections` and `Create new collection` actions, but they are secondary actions on the public browse page.
- It has a `Sort By` select with at least:
  - `Latest`
  - `Most popular`
- It shows result counts and pagination, e.g. `Showing 1 to 20 of 794 entries`.
- Each public collection appears as a discovery card with:
  - A small preview collage of character avatars.
  - Collection name plus character count.
  - Last updated date.
  - Description under the collection name/date.
  - Collector/owner link.
  - View count.
- Opening a public collection shows a detail header with:
  - Larger preview collage.
  - Collection name and owner.
  - Last updated date.
  - Description.
  - Character grid below.

### Needed CL UX change

Keep the `Collections` tab, but expand it from `My collections` only into a two-surface collection browser:

- Public Collections:
  - Default or clearly available mode in the `Collections` tab.
  - Shows public collection cards with preview thumbnails, name, character count, description, owner, view count, and updated date when available.
  - Supports JannyAI-style sorting (`Latest`, `Most popular`) and pagination/load-more.
  - Opens a public collection into a detail view with metadata header and character grid.
- My Collections:
  - Preserve the current account-owned collection list and create-collection workflow.
  - Add descriptions under owned collection names, matching the public collection card treatment.
  - Keep private/public state visible for owned collections.

The tab should feel like JannyAI's `Collections` area: public discovery with quick access to personal collection management, not a purely private account-sync panel.

### Native JannyAI `My collections` behavior

Observed on:
`https://jannyai.com/collections/mine`

- The page title is `My collections (5)` and has a `Create new collection` action near the top.
- Personal collections are still displayed as cards, not plain rows.
- Each owned collection card shows:
  - Preview character thumbnails/collage.
  - Lock icon for private collections.
  - Collection name plus character count.
  - Last updated date.
  - Description under the collection name/date.
  - `Edit` action.
  - `Delete` action.
- The collection title/card is the open affordance; JannyAI does not use a separate `Open` button on the owner list.

### Additional CL UX change for owned collections

The CL `My Collections` surface should keep the new tab and current account-management purpose, but owned collection rows/cards should show richer metadata:

- Description under the collection name when present.
- Preview thumbnails/collage when available from the collection data or character fetch.
- Last updated date when available.
- Private/public icon or label.
- Clear open affordance, either the collection card/title or the existing `Open` button.
- Consider surfacing `Edit` and `Delete` later if the account proxy supports the matching JannyAI form routes safely.

### Native JannyAI collection edit behavior

Observed by opening the `Edit` action from:
`https://jannyai.com/collections/mine`

Native edit page for an owned collection includes:

- `Edit collection <name>` title.
- `Back` link to `My collections`.
- Metadata form:
  - `Name` text input.
  - `Type` radio options: public (`Public (all can view)`) and private (`Private (for you only)`).
  - `Description` textarea with markdown support.
  - `Save` button for metadata changes.
- Character membership management in the same page:
  - `Characters (<count>)` heading.
  - Search / paste-link combobox with placeholder like `Search or Paste link from janitorai.com/jannyai.com`.
  - Info banner: `Characters will be auto-saved!`.
  - Character rows with thumbnail, name, short description, and a `Remove` button.
- Membership add/remove appears to auto-save separately from the metadata `Save` button.

### Additional CL edit/manage delta

Current CL branch has backend/API pieces that can help (`edit-collection` and `delete-collection` form paths are allowed in cl-helper, and `removeJannyCharacterFromCollection` exists in `janny-api.js`), but the UI does not expose a native-style owned collection edit/manage page.

For parity, owned collection management should eventually include:

- Edit collection metadata: name, description, public/private.
- Delete collection with confirmation.
- Remove cards from an owned collection from the collection management surface.
- Add cards by search or pasted JannyAI/JanitorAI character link if practical.
- Clear separation between metadata changes that require `Save` and card membership changes that auto-save.

For the first UX cleanup pass, it may be acceptable to add descriptions/previews/public browsing first and leave full edit/delete/member management as a follow-up, but the design should not block adding it later.
