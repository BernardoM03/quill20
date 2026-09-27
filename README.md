# Quill20

This Chrome extension pins a notes drawer to the right edge of your character sheet page. Notes are saved per character, split into as many named sections as you want, and the drawer can show two of those sections stacked at once.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. Open a sheet at `https://www.dndbeyond.com/characters/<id>z` and click
   the **Notes** tab on the right edge.

Reload the sheet tab after any change to the extension files.

## Tabs

Each note is a tab. Press **+** to add one. Drag tabs to reorder them.

**Split** moves the tab you're on into a pane of its own below, which then gets its own set of tabs. You need at least two tabs to split. With two panes open, drag a tab onto the other pane's tab strip or note area to move it there. When either pane runs out of tabs, closed or dragged away, the drawer goes back to one pane. Clicking **Split** again does the same, moving the bottom tabs back to the top.

Closing a tab with **×** doesn't delete the note. It moves to the **▾** menu next to **+**, which lists your closed notes, newest first. Click one to reopen it. The same menu lists the notes open in the other pane, and it's the only place a note is deleted for good. A brand-new note that you never named or wrote in is simply discarded when you close it.

## Writing notes

Notes are Markdown, rendered as you type, like Obsidian's Live Preview. The line your cursor is on shows its raw syntax so you can edit it. Every other line shows the formatted result.

| Type this | Get |
| --- | --- |
| `# Title` … `###### Title` | Headings |
| `**bold**`, `*italic*` or `_italic_`, `***both***` | Bold, italic |
| `~~struck~~`, `==highlight==`, `<u>underline</u>` | Strikethrough, highlight, underline |
| `` `code` `` and ```` ``` ```` fences | Inline code, code blocks |
| `- item`, `1. item` | Lists (Tab / Shift+Tab to nest) |
| `- [ ] task` | Checkbox (click it, or Ctrl+Enter) |
| `> quote` | Block quote |
| `---` | Divider |
| `\| a \| b \|` rows over a `\|---\|---\|` line | Table |
| `[text](https://…)`, bare `https://…` | Links (click to open) |
| `[[Section name]]` | Jumps to that section, creating it if needed |
| `#tag` | Tag |

Pressing Enter in a list, checklist or quote continues it, and pressing Enter on an empty item ends it. Shortcuts: Ctrl+B bold, Ctrl+I italic, Ctrl+U underline, Ctrl+K link, Ctrl+Z / Ctrl+Y undo and redo. Pasting from a web page converts its formatting to Markdown, and Ctrl+Shift+V pastes plain text. Copying from the editor copies the Markdown source.

Notes written with earlier versions are converted to Markdown the first time you open them.

## Example

<!--
Source - https://stackoverflow.com/a/41912122
Posted by Philipp Schwarz, modified by community. See post 'Timeline' for change history
Retrieved 2026-09-01, License - CC BY-SA 4.0
-->

![Quill20_Example.png](Quill20_Example.png "Example Image")
