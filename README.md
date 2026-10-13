[English](README.md) | [简体中文](README_zh.md)

# omp-cursor

In-place mouse cursor positioning, drag-to-highlight selection, and text editing directly inside the native [Oh-My-Pi (OMP)](https://omp.sh) prompt box.

---

## Why this exists

Editing long drafts, pasted code snippets, or detailed prompts in a terminal can be tedious. When you spot a typo in the middle of a sentence, holding the left arrow key for seconds gets old quickly.

`omp-cursor` adds direct mouse support to OMP's native editor:
- Click anywhere to jump the cursor directly to that character;
- Drag to highlight text, double-click to select words, triple-click to select lines;
- Type over selections to replace them immediately, or press Backspace to delete;
- Operates in-place on OMP's live interface—no popups, no screen switching, no jarring UI shifts.

---

## Controls & Gestures

| Action | Key / Mouse Gesture | Description |
| :--- | :--- | :--- |
| **Toggle Mode** | `Alt+E` | Toggles mouse editing mode. Status bar icon switches from `⌨` to `🖱`. |
| **Position Cursor**| Click | Jumps caret immediately. CJK characters and Emoji are aligned by visual cell width. |
| **Highlight Text** | Drag | Drags to select text with reverse-video (`\x1b[7m`) highlighting. |
| **Quick Select** | Double / Triple Click | Double-click selects the word; triple-click selects the whole line. |
| **Edit Selection** | Type / `Backspace` | Typing replaces the active selection; Backspace/Delete removes it. |
| **Copy Text** | `Ctrl+C` | Copies active selection to the OS clipboard. |
| **Save & Exit** | `Esc` or `Alt+E` | Exits mouse mode while preserving all edits (switches back to `⌨`). |
| **Discard & Exit**| `Ctrl+D` | Discards edits made in mouse mode and reverts the draft to its initial snapshot. |

---

## Status Bar Indicator (`/cursor`)

The mode badge occupies the exact status-line segment slot where OMP's built-in Vim mode appears (`π > ⌨/🖱 > hostname ...`).

You can customize the indicator style at any time using the `/cursor` command:

- `/cursor icon` (default): Shows muted `⌨` in regular typing mode, switching to cyan `🖱` when mouse mode is active.
- `/cursor text`: Text style. Shows `[KB]` normally, switching to `[MOUSE]` when active.
- `/cursor hidden`: Hides the indicator entirely for minimalists, while preserving full mouse clicking and highlighting.

---

## Vim Mode Compatibility

If OMP's built-in Vim mode is enabled (`tui.vim: true`):

`omp-cursor` detects it automatically and yields control. `Alt+E` will not intercept keys, and mouse reports will not conflict with Vim's modal state machine or operator-pending gestures.

---

## Technical Design

Many terminal extensions solve mouse input by displaying a fullscreen alternate-screen overlay. While simpler to implement, an overlay completely replaces the terminal screen, hiding the OMP logo, chat history, and active theme colors.

`omp-cursor` stays in-place on the normal buffer:
1. **In-Place Hook**: Extends OMP's `CustomEditor` via `setEditorComponent`, keeping OMP's native status bar and composer frame intact.
2. **Input Capture**: Uses `capturesInput` to intercept SGR mouse reports before host listeners can swallow them.
3. **Native Editing & Undo**: Calls `applyHostEdit` for cursor movements and selection replacements, integrating directly with OMP's native undo history.
4. **Visual Cell Alignment**: CJK ideographs take two terminal columns but one UTF-16 code unit. We map visual cells using Unicode Grapheme segmentation, eliminating the 2x coordinate drift common in naive column calculations.

---

## Known Trade-offs

- **Terminal-Native Selection**: While mouse mode is active, the terminal reports clicks to the application instead of selecting text locally. To copy text from earlier chat history, simply press `Esc` to exit mouse mode, or hold your terminal's `Shift` key while dragging.

---

## Installation

### Method A: One-line plugin install (Recommended)

Install and resolve dependencies with a single command:

```bash
omp plugin install github:gongquan45/omp-cursor
```

---

### Method B: Add as an OMP Marketplace source

This repository includes a built-in `.omp-plugin/marketplace.json` catalog. You can add it via CLI or interactive TUI commands:

```bash
# Via CLI:
omp plugin marketplace add gongquan45/omp-cursor
omp plugin install omp-cursor@omp-cursor

# Or inside OMP interactive chat:
/marketplace add gongquan45/omp-cursor
/marketplace install omp-cursor@omp-cursor
```

---

### Method C: Manual clone to extensions directory

```bash
git clone https://github.com/gongquan45/omp-cursor.git ~/.omp/agent/extensions/omp-cursor
cd ~/.omp/agent/extensions/omp-cursor
bun install
```

---

### Method D: Configure local path

If cloned to a custom directory, add the absolute path to your user configuration `~/.omp/agent/config.yml` (on Windows: `%USERPROFILE%\.omp\agent\config.yml`):

```yaml
extensions:
  - /path/to/omp-cursor
```

---

## Development & Testing

Run the full automated test suite using Bun:

```bash
bun test          # Runs all 55 integration and unit tests
bun run typecheck # Strict TypeScript check
```

---

## License

[MIT License](LICENSE)
