import { describe, expect, it } from "bun:test";
import { getEditorTheme, TUI } from "@oh-my-pi/pi-tui";
import { NativeMouseEditor } from "../src/components/native-mouse-editor";
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
		// Captures SGR mouse events when mouse mode is active
		expect(editor.capturesInput("\x1b[<0;10;5M")).toBe(true);

		// Render to inspect top border
		const lines = editor.render(80);
		expect(lines[0]?.includes("[MOUSE 🖱️]")).toBe(true);

		// Esc disables mouse mode
		editor.handleInput("\x1b");
		expect(editor.mouseActive).toBe(false);
		expect(editor.capturesInput("\x1b[<0;10;5M")).toBe(false);
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
		editor.handleInput("\x1b[<0;10;23M"); // click at 'w'
		editor.handleInput("\x1b[<32;15;23M"); // drag to end
		editor.handleInput("\x1b[<0;15;23m");
		expect(editor.selection).not.toBeNull();

		// Type 'earth'
		editor.handleInput("earth");
		expect(editor.getText()).toBe("hello earth");
		expect(editor.selection).toBeNull();
	});
});
