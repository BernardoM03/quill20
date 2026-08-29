# D&D Beyond Sheet Notes

A Chrome extension that pins a notes drawer to the right edge of a D&D
Beyond character sheet page. Notes are saved per character, split into as
many named sections as you want, and the drawer can show two of those
sections stacked at once.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. Open a sheet at `https://www.dndbeyond.com/characters/<id>` and click
   the **Notes** tab on the right edge.

Reload the sheet tab after any change to the extension files.

## How it works

- The drawer is a fixed overlay on the top-level page, not an insert into the
  sheet's DOM. The sheet is a React app that re-renders freely, so anything
  injected inside it would be at the mercy of the next render.
- The character ID comes from the URL path — `/characters/<id>`, which also
  covers `/profile/<user>/characters/<id>` and the builder. Notes save to
  `chrome.storage.local` under `notes:<id>`, so two characters never share a
  pad.
- The drawer's heading reads the character name from the sheet's own
  `.ddbc-character-name` element, falling back to the page title and then to
  `Character <id>`. The app fills that in after load, so the same 800ms tick
  that watches the URL re-reads the name until it appears.
- Saving is automatic: 600ms after you stop typing, plus on section switch,
  on blur, and on page unload. The footer shows the last save time.
- Theme, open/closed state, drawer width, push mode, split mode, and the
  split ratio all persist across sessions.

## Sections

Each character's notes are a list of sections — a strip of tabs above the
editor, one body of text per tab.

| Action | How |
| --- | --- |
| New section | The **+** at the right of the tab strip; it opens straight into rename |
| Switch | Click a tab |
| Rename | Double-click the active tab, type, then Enter (Escape cancels) |
| Delete | The **×** on the active tab. Sections with text ask first, and the last remaining section cannot be deleted |
| Many tabs | The strip scrolls sideways; a plain mouse wheel over it scrolls it |

## Split view

**Split** (in the toolbar) divides the drawer into a top and a bottom note
area, each with its own tab strip and its own section — so a tall drawer can
hold a reference note above the notes you are actually typing. Drag the bar
between them to change the balance, or focus it and use the arrow keys.

- The two panes never show the same section. Clicking a tab that the other
  pane already has open **swaps** the two rather than opening one section in
  two editors, which would let one pane's stale text overwrite the other's.
- Turning Split on when the character has only one section creates a second
  one for the bottom pane. Deleting down to a single section folds the split
  away again.
- The formatting toolbar is shared and acts on whichever pane you last typed
  in; that pane is marked with an accent line down the left of its tab strip.

## Theme

The pill in the footer cycles **Auto → Light → Dark**.

- *Light* is a cool neutral: white editor, gray panels, blue accent.
- *Dark* is warm rather than blue-black — dark brown surfaces, sepia text,
  amber for anything selected or marked.
- *Auto* follows `prefers-color-scheme`, resolved by a media query in the
  stylesheet rather than in JS, so it re-themes the moment the OS flips
  without the extension listening for anything.

## Push mode

**Push** (the pill in the footer, on by default) narrows the document instead
of floating over it, so the sheet's own layout reflows into the space that is
left. Mechanically:

- `html` gets `width: calc(100% - <drawer width>)`, which is what makes the
  page's flex layout recompute — the sheet gets narrower rather than hidden.
- A synthetic `resize` event fires afterwards, because layouts driven by JS
  rather than CSS only recalculate when one arrives.
- `contain: layout paint` goes on `body` so the page's own `position: fixed`
  chrome moves with the push instead of staying pinned across the full
  viewport. It is applied only when `body` already fills the viewport height,
  since containing a short body would collapse anything fixed inside it.

Turn Push off to go back to overlay behaviour, where the drawer simply covers
the right edge of the page. That is the escape hatch if a future D&D Beyond
layout ever reacts badly to being narrowed.

## Controls

| Action | How |
| --- | --- |
| Open or close | Click the Notes tab, or press Escape while focused inside |
| Bold / italic / underline | Toolbar buttons, or Ctrl+B / Ctrl+I / Ctrl+U |
| Bulleted or numbered list | Toolbar buttons |
| Resize width | Drag the drawer's left edge, or focus it and use arrow keys |
| Resize the split | Drag the bar between panes, or focus it and use arrow keys |
| Split / theme / push | The **Split** pill in the toolbar; **Auto/Light/Dark** and **Push** in the footer |

## Notes on the implementation

- Formatting uses `document.execCommand`. It is deprecated but still the only
  thing every browser implements for contenteditable formatting. If it ever
  breaks, the replacement is a Selection/Range based command layer.
- Stored HTML is rebuilt from a tag allowlist on both save and load, and all
  attributes are dropped. Pasted content goes through the same filter, so
  copying from another site brings the text and basic formatting and nothing
  else.
- Storage is versioned (`v: 3`). `migrate()` accepts all three shapes: v1's
  single `{ html, updated }`, v2's `{ sections, activeId }`, and the current
  `{ v, sections: [{ id, name, html, updated }], active: { a, b }, updated }`.
  Nothing written under an older version is stranded by an upgrade.
- Panes are flushed into the model *before* any state change that could
  repoint an editor — collapsing the split, deleting a section, switching
  tabs. That ordering is what keeps a pane from writing text belonging to
  one section into another.
- Drawer width lives in a `--ddbn-width` custom property on `html`, so the
  drawer, the edge tab's offset, and the push width all read from one number.
  The split ratio works the same way through `--ddbn-split`.
- Colors are all custom properties on the root element, redefined under
  `[data-theme="dark"]` and under a `prefers-color-scheme` block for
  `[data-theme="auto"]`. Adding a theme means adding one such block.
- `chrome.storage.local` is per profile and not synced. Switching to
  `chrome.storage.sync` is a one-line change in the `store` helper, but sync
  caps values at roughly 8KB each, which a multi-section document will exceed.

## Possible next steps

- Drag to reorder sections.
- Export all notes to a file.
- Search across sections and characters.
- A popup listing every character you have notes for.
