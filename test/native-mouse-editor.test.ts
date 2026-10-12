import { describe, expect, it } from "bun:test";
import { getEditorTheme, TUI } from "@oh-my-pi/pi-tui";
import {
	NativeMouseEditor,
	injectBadgeIntoStatusLine,
} from "../src/components/native-mouse-editor";
import { MinimalTerminal } from "./support/minimal-terminal";

describe("NativeMouseEditor (In-Place Native Mouse Editing)", () => {
	it("initializes in normal mode with mouse inactive", () => {
		const term = new MinimalTerminal();
		const tui = new TUI(term);
		const editor = new NativeMouseEditor(tui, getEditorTheme());

		expect(editor.mouseActive).toBe(false);
		expect(editor.selection).toBeNull();
		// Does not capture SGR mouse events when mouse is inactive
		expect(editor.capturesInput("\x1b[<0;10;5M")).toBe(false);
	});

	it("toggles mouse mode, sets [MOUSE 🖱️] top badge, and captures SGR input", () => {
		const term = new MinimalTerminal();
		const tui = new TUI(term);
		const editor = new NativeMouseEditor(tui, getEditorTheme());

		editor.toggleMouseMode();
		expect(editor.mouseActive).toBe(true);
		// Captures SGR mouse events inside editor content rows
		expect(editor.capturesInput("\x1b[<0;10;24M")).toBe(true);
		// Ignores SGR mouse events outside editor (e.g. transcript rows)
		expect(editor.capturesInput("\x1b[<0;10;5M")).toBe(false);
		// Render to inspect top border
		const lines = editor.render(80);
		expect(lines[0]?.includes("🖱")).toBe(true);

		// Esc disables mouse mode
		editor.handleInput("\x1b");
		expect(editor.mouseActive).toBe(false);
		expect(editor.capturesInput("\x1b[<0;10;24M")).toBe(false);
	});

	it("moves caret on SGR click and updates selection on drag", () => {
		const term = new MinimalTerminal();
		term.columns = 80;
		term.rows = 24;
		const tui = new TUI(term);
		const editor = new NativeMouseEditor(tui, getEditorTheme());
		editor.setText("alpha beta\nsecond line");
		editor.setMouseActive(true);

		// Render once
		editor.render(80);

		// In 24 rows, editor with 2 lines has 3 rendered rows (startRow = 21).
		// Row 21 is top border, Row 22 is line 1 ("alpha beta"), Row 23 is line 2 ("second line").
		// Content row 22 is row 23 in 1-based SGR report.
		// Column: left margin is "|  " (3 cols) -> text col 6 ('beta') is screen col 9 -> col 10 in 1-based SGR.
		editor.handleInput("\x1b[<0;10;23M");
		expect(editor.getCursor()).toEqual({ line: 0, col: 6 });

		// Drag motion to col 14 (col 10 in text -> end of 'beta')
		editor.handleInput("\x1b[<32;14;23M");
		expect(editor.selection).toEqual({ start: 6, end: 10 });

		// Release
		editor.handleInput("\x1b[<0;14;23m");

		// Test decorateText: row 0 should contain reverse video highlight around 'beta'
		const decorated = editor.decorateText("alpha beta", {
			line: 0,
			startCol: 0,
			endCol: 10,
		});
		expect(decorated.includes("\x1b[7mbeta\x1b[27m")).toBe(true);

		// Backspace deletes selection
		editor.handleInput("\x7f");
		expect(editor.getText()).toBe("alpha \nsecond line");
		expect(editor.selection).toBeNull();
	});

	it("replaces active selection when printable characters are typed", () => {
		const term = new MinimalTerminal();
		term.columns = 80;
		term.rows = 24;
		const tui = new TUI(term);
		const editor = new NativeMouseEditor(tui, getEditorTheme());
		editor.setText("hello world");
		editor.setMouseActive(true);
		editor.render(80);

		// Drag over "world" (offset 6 to 11)
		editor.handleInput("\x1b[<0;10;24M"); // click at 'w'
		editor.handleInput("\x1b[<32;15;24M"); // drag to end
		editor.handleInput("\x1b[<0;15;24m");
		expect(editor.selection).not.toBeNull();

		// Type 'earth'
		editor.handleInput("earth");
		expect(editor.getText()).toBe("hello earth");
		expect(editor.selection).toBeNull();
	});

	it("dynamically prepends [MOUSE 🖱️] to host StatusLine provider and restores on exit", () => {
		const term = new MinimalTerminal();
		const tui = new TUI(term);
		const editor = new NativeMouseEditor(tui, getEditorTheme());

		// Attach upstream statusLine provider
		editor.setTopBorderProvider(availableWidth => ({
			content: " π > 🖥 Outerwall > ◒ Gemini 3.8 Flash ",
			width: 37,
		}));

		// Initially without mouseActive
		let lines = editor.render(80);
		expect(lines[0]?.includes("Outerwall")).toBe(true);
		expect(lines[0]?.includes("⌨")).toBe(true);

		// Activate mouse mode
		editor.setMouseActive(true);
		lines = editor.render(80);
		expect(Bun.stripANSI(lines[0] ?? "").includes("π > 🖱 > 🖥 Outerwall")).toBe(true);
		// Exit mouse mode
		editor.setMouseActive(false);
		lines = editor.render(80);
		expect(lines[0]?.includes("⌨")).toBe(true);
		expect(lines[0]?.includes("🖱")).toBe(false);
		expect(lines[0]?.includes("Outerwall")).toBe(true);
	});

	it("correctly maps CJK double-width character columns without 2x scaling error", () => {
		const term = new MinimalTerminal();
		term.columns = 80;
		term.rows = 24;
		const tui = new TUI(term);
		const editor = new NativeMouseEditor(tui, getEditorTheme());
		editor.setText("词一 词二 词三 词四");
		editor.setMouseActive(true);
		editor.render(80);

		// 1. Click on '词一' (screen col 4 -> text col 1)
		editor.handleInput("\x1b[<0;5;24M");
		expect(editor.getCursor().col).toBe(1);

		// 2. Click on '词二' (screen col 9 -> text col 6)
		editor.handleInput("\x1b[<0;10;24M");
		// Must land at '词二' (offset 4), NOT overshoot to '词四' (offset 7)!
		expect(editor.getCursor().col).toBe(4);

		// 3. Click on '词三' (screen col 14 -> text col 11)
		editor.handleInput("\x1b[<0;15;24M");
		expect(editor.getCursor().col).toBe(7);

		// 4. Click on '词四' (screen col 19 -> text col 16)
		editor.handleInput("\x1b[<0;20;24M");
		expect(editor.getCursor().col).toBe(10);
	});

	it("supports text and hidden indicator display modes", () => {
		const term = new MinimalTerminal();
		const tui = new TUI(term);

		// Text mode
		const textEditor = new NativeMouseEditor(tui, getEditorTheme(), undefined, {
			indicatorDisplay: "text",
		});
		textEditor.setTopBorderProvider(availableWidth => ({
			content: " π > 🖥 Outerwall ",
			width: 20,
		}));
		textEditor.setMouseActive(true);
		let lines = textEditor.render(80);
		expect(Bun.stripANSI(lines[0] ?? "").includes("π > [MOUSE] > 🖥 Outerwall")).toBe(true);
		// Hidden mode
		const hiddenEditor = new NativeMouseEditor(tui, getEditorTheme(), undefined, {
			indicatorDisplay: "hidden",
		});
		hiddenEditor.setTopBorderProvider(availableWidth => ({
			content: " π > 🖥 Outerwall ",
			width: 20,
		}));
		hiddenEditor.setMouseActive(true);
		lines = hiddenEditor.render(80);
		expect(lines[0]?.includes("[MOUSE]")).toBe(false);
		expect(lines[0]?.includes("🖱")).toBe(false);
		expect(hiddenEditor.capturesInput("\x1b[<0;10;24M")).toBe(true);
	});

	it("automatically disables mouse editing and relinquishes capture when Vim mode is active", () => {
		const term = new MinimalTerminal();
		const tui = new TUI(term);
		const editor = new NativeMouseEditor(tui, getEditorTheme());

		// Simulate vimEnabled as true
		Object.defineProperty(editor, "vimEnabled", {
			get: () => true,
			configurable: true,
		});

		expect(editor.vimEnabled).toBe(true);
		expect(editor.isMouseEnabled).toBe(false);

		// Alt+E toggle is rejected when vim mode is active
		const toggled = editor.toggleMouseMode();
		expect(toggled).toBe(false);
		expect(editor.mouseActive).toBe(false);
		expect(editor.isMouseEnabled).toBe(false);

		// capturesInput must return false so Vim gets 100% priority
		expect(editor.capturesInput("\x1b[<0;10;24M")).toBe(false);
	});

	it("relinquishes tracking and mouse dispatch when setVimMode(true) is enabled after mouse was active", () => {
		const term = new MinimalTerminal();
		term.columns = 80;
		term.rows = 24;
		const tui = new TUI(term);
		const editor = new NativeMouseEditor(tui, getEditorTheme());
		editor.setText("first line\nsecond line");

		// 1. Activate mouse first
		editor.setMouseActive(true);
		expect(editor.mouseActive).toBe(true);
		expect(editor.isMouseEnabled).toBe(true);
		expect(editor.capturesInput("\x1b[<0;10;24M")).toBe(true);

		// 2. Enable real Vim mode via native setVimMode(true)
		editor.setVimMode(true);
		expect(editor.vimEnabled).toBe(true);
		expect(editor.isMouseEnabled).toBe(false);
		expect(editor.capturesInput("\x1b[<0;10;24M")).toBe(false);

		// 3. Render: mode badge must NOT be present on top border
		const lines = editor.render(80);
		expect(lines[0]?.includes("🖱")).toBe(false);
		expect(lines[0]?.includes("[MOUSE]")).toBe(false);

		// 4. Feed SGR click: cursor must NOT be moved by mouse editor
		const cursorBefore = editor.getCursor();
		editor.handleInput("\x1b[<0;5;23M");
		expect(editor.getCursor()).toEqual(cursorBefore);
	});

	it("verifies injectBadgeIntoStatusLine inserts into the exact Vim status slot after π >", () => {
		const standard = " π > 🖥 Outerwall > ◒ Gemini 3.8 Flash ";
		const resIcon = injectBadgeIntoStatusLine(standard, "🖱");
		expect(resIcon.content).toBe(" π > 🖱 > 🖥 Outerwall > ◒ Gemini 3.8 Flash ");

		const resText = injectBadgeIntoStatusLine(standard, "[MOUSE]");
		expect(resText.content).toBe(" π > [MOUSE] > 🖥 Outerwall > ◒ Gemini 3.8 Flash ");

		// Powerline thin separator
		const powerline = " π › 🖥 Outerwall › ◒ Gemini 3.8 Flash ";
		const resPowerline = injectBadgeIntoStatusLine(powerline, "🖱");
		expect(resPowerline.content).toBe(" π › 🖱 › 🖥 Outerwall › ◒ Gemini 3.8 Flash ");


		// Unicode powerline separator (preset: full with symbolPreset: unicode)
		const unicodeSep = " π ▶ 🖥 Outerwall ▶ ◒ Gemini 3.8 Flash ";
		const resUnicode = injectBadgeIntoStatusLine(unicodeSep, "🖱");
		expect(resUnicode.content).toBe(" π ▶ 🖱 ▶ 🖥 Outerwall ▶ ◒ Gemini 3.8 Flash ");
		// If no separator found, do not prepend to front (safe fallback)
		const noSep = " SimpleStatusTitle ";
		const resNoSep = injectBadgeIntoStatusLine(noSep, "🖱");
		expect(resNoSep.content).toBe(" SimpleStatusTitle ");
		expect(resNoSep.widthDiff).toBe(0);
	});

	it("discards edits and restores draft snapshot when Ctrl+D is pressed in mouse mode", () => {
		const term = new MinimalTerminal();
		const tui = new TUI(term);
		const editor = new NativeMouseEditor(tui, getEditorTheme());
		editor.setText("original draft");

		editor.setMouseActive(true);
		expect(editor.mouseActive).toBe(true);

		// Type edits in mouse mode
		editor.handleInput(" extra edits");
		expect(editor.getText()).toBe("original draft extra edits");

		// Press Ctrl+D -> discards edits and restores snapshot!
		editor.handleInput("\x04");
		expect(editor.mouseActive).toBe(false);
		expect(editor.getText()).toBe("original draft");
	});

	it("auto-saves edits and exits mouse mode when Esc is pressed", () => {
		const term = new MinimalTerminal();
		const tui = new TUI(term);
		const editor = new NativeMouseEditor(tui, getEditorTheme());
		editor.setText("original draft");

		editor.setMouseActive(true);
		editor.handleInput(" saved edits");

		// Press Esc -> auto-saves!
		editor.handleInput("\x1b");
		expect(editor.mouseActive).toBe(false);
		expect(editor.getText()).toBe("original draft saved edits");
	});

	it("does not treat Ctrl+Q as a save chord in mouse mode", () => {
		const term = new MinimalTerminal();
		const tui = new TUI(term);
		const editor = new NativeMouseEditor(tui, getEditorTheme());
		editor.setText("draft");

		editor.setMouseActive(true);
		// Pressing Ctrl+Q should NOT exit mouse mode
		editor.handleInput("\x11");
		expect(editor.mouseActive).toBe(true);
	});

	it("preserves status line background color by avoiding \\x1b[0m resets in badge", () => {
		const term = new MinimalTerminal();
		const tui = new TUI(term);
		const editor = new NativeMouseEditor(tui, getEditorTheme());

		editor.setTopBorderProvider(availableWidth => ({
			content: "\x1b[48;2;40;40;40m π > 🖥 Outerwall \x1b[49m",
			width: 25,
		}));

		editor.setMouseActive(true);
		const lines = editor.render(80);
		// Crucial assertion: lines[0] must NOT contain \x1b[0m which wipes out background!
		expect(lines[0]?.includes("\x1b[0m")).toBe(false);
	});
});
