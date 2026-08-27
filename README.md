# Roll20 Sheet Notes

A Chrome extension that pins a notes drawer to the right edge of a Roll20
character sheet page. Notes are saved per character.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. Open a sheet at `https://app.roll20.net/characters/sheet/<id>` and click
   the **Notes** tab on the right edge.

Reload the sheet tab after any change to the extension files.

## How it works

- The drawer is a fixed overlay on the top-level page, not an insert into the
  sheet's DOM. Roll20 renders the sheet inside an iframe, so anything injected
  in there would be at the mercy of the sheet re-rendering.
- The character ID comes from the URL path. Notes save to
  `chrome.storage.local` under `notes:<id>`, so two characters never share a
  pad.
- Saving is automatic: 600ms after you stop typing, plus on blur and on page
  unload. The footer shows the last save time.
- Open/closed state and drawer width persist across sessions.

## Controls

| Action | How |
| --- | --- |
| Open or close | Click the Notes tab, or press Escape while focused inside |
| Bold / italic / underline | Toolbar buttons, or Ctrl+B / Ctrl+I / Ctrl+U |
| Bulleted or numbered list | Toolbar buttons |
| Resize | Drag the left edge, or focus it and use arrow keys |

## Notes on the implementation

- Formatting uses `document.execCommand`. It is deprecated but still the only
  thing every browser implements for contenteditable formatting. If it ever
  breaks, the replacement is a Selection/Range based command layer.
- Stored HTML is rebuilt from a tag allowlist on both save and load, and all
  attributes are dropped. Pasted content goes through the same filter, so
  copying from another site brings the text and basic formatting and nothing
  else.
- `chrome.storage.local` is per profile and not synced. Switching to
  `chrome.storage.sync` is a one-line change in the `store` helper, but sync
  caps values at roughly 8KB each, which long notes will exceed.

## Possible next steps

- Export all notes to a file.
- Search across characters.
- A popup listing every character you have notes for.
