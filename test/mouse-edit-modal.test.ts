import { describe, expect, it } from "bun:test";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent";
import { TUI } from "@oh-my-pi/pi-tui";
import { MouseEditModal } from "../src/mouse-edit-modal";
import { MinimalTerminal } from "./support/minimal-terminal";
describe("MouseEditModal - Component and Fullscreen Overlay", () => {
	it("enables alt screen and SGR mouse tracking in TUI overlay and disables on hide", () => {
		const term = new MinimalTerminal();
		const tui = new TUI(term);
		tui.start();

		let saved = false;
		const modal = new MouseEditModal(tui, "test text", {
			onSave: () => {
				saved = true;
				return true;
			},
			onCancel: () => {},
			copy: async () => {},
			setInterval: () => 0,
			clearTimer: () => {},
		});

		const handle = tui.showOverlay(modal, {
			fullscreen: true,
			mouseTracking: true,
			anchor: "top-left",
			width: "100%",
			margin: 0,
		});

		tui.renderNow();

		const output = term.writes.join("");
		// Alt screen buffer enabled
		expect(output.includes("\x1b[?1049h")).toBe(true);
		// Mouse tracking enabled
		expect(output.includes("\x1b[?1000h") || output.includes("\x1b[?1002h")).toBe(true);

		handle.hide();
		tui.renderNow();

		const exitOutput = term.writes.slice(-5).join("");
		// Alt screen buffer exited
		expect(exitOutput.includes("\x1b[?1049l")).toBe(true);
		// Mouse tracking disabled
		expect(exitOutput.includes("\x1b[?1000l") || exitOutput.includes("\x1b[?1002l")).toBe(true);

		tui.stop();
		expect(saved).toBe(false);
	});

	it("executes the drag-select, delete, and save scenario from plan", () => {
		const term = new MinimalTerminal();
		const tui = new TUI(term);

		let savedResult: string | undefined;
		const modal = new MouseEditModal(tui, "alpha beta\n中文🙂 tail", {
			onSave: text => {
				savedResult = text;
				return true;
			},
			onCancel: () => {},
			copy: async () => {},
			setInterval: () => 0,
			clearTimer: () => {},
		});

		// Render to initialize layout
		modal.render(80);

		// 1. Left-click at beta's 'b': col 8, row 2 (1-based SGR report)
		modal.handleInput("\x1b[<0;8;2M");
		expect(modal.buffer.cursor).toBe(6);

		// 2. Motion to after '文': col 6, row 3 (1-based SGR report)
		modal.handleInput("\x1b[<32;6;3M");
		expect(modal.buffer.selection).toEqual({ start: 6, end: 13 });
		expect(
			modal.buffer.text.slice(modal.buffer.selection!.start, modal.buffer.selection!.end),
		).toBe("beta\n中文");

		// 3. Mouse release
		modal.handleInput("\x1b[<0;6;3m");

		// 4. Backspace
		modal.handleInput("\x7f");
		expect(modal.buffer.text).toBe("alpha 🙂 tail");

		// 5. Ctrl+Q to save
		modal.handleInput("\x11");
		expect(savedResult).toEqual("alpha 🙂 tail");
	});

	it("handles cancellation via Esc leaving original intact", () => {
		const term = new MinimalTerminal();
		const tui = new TUI(term);

		let cancelled = false;
		let saved = false;
		const modal = new MouseEditModal(tui, "original text", {
			onSave: () => {
				saved = true;
				return true;
			},
			onCancel: () => {
				cancelled = true;
			},
			copy: async () => {},
			setInterval: () => 0,
			clearTimer: () => {},
		});

		modal.render(80);
		// Type some characters
		modal.handleInput("X");
		modal.handleInput("Y");
		expect(modal.buffer.text).toBe("original textXY");

		// Press Esc
		modal.handleInput("\x1b");
		expect(cancelled).toBe(true);
		expect(saved).toBe(false);
	});

	it("double-click selects word and triple-click selects whole line", () => {
		const term = new MinimalTerminal();
		const tui = new TUI(term);

		let fakeClock = 1000;
		const modal = new MouseEditModal(
			tui,
			"alpha beta\n中文🙂 tail",
			{
				onSave: () => true,
				onCancel: () => {},
				copy: async () => {},
				setInterval: () => 0,
				clearTimer: () => {},
				now: () => fakeClock,
			},
		);

		modal.render(80);

		// Click 1 at 'beta' (col 8, row 2)
		modal.handleInput("\x1b[<0;8;2M");
		expect(modal.buffer.cursor).toBe(6);
		modal.handleInput("\x1b[<0;8;2m");

		// Click 2 at same spot 100ms later (double click -> select word)
		fakeClock = 1100;
		modal.handleInput("\x1b[<0;8;2M");
		expect(modal.buffer.selection).toEqual({ start: 6, end: 10 });
		expect(modal.buffer.text.slice(6, 10)).toBe("beta");
		modal.handleInput("\x1b[<0;8;2m");

		// Click 3 at same spot 100ms later (triple click -> select line with newline)
		fakeClock = 1200;
		modal.handleInput("\x1b[<0;8;2M");
		expect(modal.buffer.selection).toEqual({ start: 0, end: 11 });
		expect(modal.buffer.text.slice(0, 11)).toBe("alpha beta\n");
		modal.handleInput("\x1b[<0;8;2m");
	});

	it("handles wheel scrolling", () => {
		const term = new MinimalTerminal();
		const tui = new TUI(term);

		const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
		const modal = new MouseEditModal(tui, lines, {
			onSave: () => true,
			onCancel: () => {},
			copy: async () => {},
			setInterval: () => 0,
			clearTimer: () => {},
		});

		modal.render(80);

		// SGR Wheel down (button 65)
		modal.handleInput("\x1b[<65;10;10M");
		// Check that rendered lines scrolled
		const rendered = modal.render(80);
		// Middle lines should show scrolled content (line 4 or higher)
		expect(rendered.some(l => l.includes("line 4"))).toBe(true);

		// SGR Wheel up (button 64)
		modal.handleInput("\x1b[<64;10;10M");
		const renderedUp = modal.render(80);
		expect(renderedUp.some(l => l.includes("line 1"))).toBe(true);
	});

	it("activates edge scroll interval when dragging near boundary", () => {
		const term = new MinimalTerminal();
		const tui = new TUI(term);

		let scheduledTimer: { fn: () => void; ms: number } | null = null;
		let clearedTimer = false;

		const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
		const modal = new MouseEditModal(tui, lines, {
			onSave: () => true,
			onCancel: () => {},
			copy: async () => {},
			setInterval: (fn, ms) => {
				scheduledTimer = { fn, ms };
				return 999;
			},
			clearTimer: () => {
				clearedTimer = true;
				scheduledTimer = null;
			},
		});

		modal.render(80);

		// Click inside text area
		modal.handleInput("\x1b[<0;10;5M");
		// Drag to bottom row (row 23 in 24-row terminal -> row >= 22)
		modal.handleInput("\x1b[<32;10;23M");

		expect(scheduledTimer !== null).toBe(true);
		if (scheduledTimer) {
			const timer: { fn: () => void; ms: number } = scheduledTimer;
			expect(timer.ms).toBe(50);
			timer.fn();
		}

		// Release stops the timer
		modal.handleInput("\x1b[<0;10;23m");
		expect(clearedTimer).toBe(true);
		expect(scheduledTimer).toBeNull();
	});

	it("displays small window notice when columns < 6 or rows < 3", () => {
		const term = new MinimalTerminal();
		term.columns = 5;
		term.rows = 2;
		const tui = new TUI(term);

		let cancelled = false;
		const modal = new MouseEditModal(tui, "sample", {
			onSave: () => true,
			onCancel: () => {
				cancelled = true;
			},
			copy: async () => {},
			setInterval: () => 0,
			clearTimer: () => {},
		});

		const rendered = modal.render(5);
		expect(rendered.some(l => l.includes("窗口"))).toBe(true);

		// Normal typing ignored
		modal.handleInput("A");
		expect(modal.buffer.text).toBe("sample");

		// Esc still works to exit
		modal.handleInput("\x1b");
		expect(cancelled).toBe(true);
	});

	it("copies selected text to clipboard on Ctrl+C", async () => {
		const term = new MinimalTerminal();
		const tui = new TUI(term);

		let copiedText: string | undefined;
		const { promise, resolve } = Promise.withResolvers<string>();
		const modal = new MouseEditModal(tui, "hello world", {
			onSave: () => true,
			onCancel: () => {},
			copy: async text => {
				copiedText = text;
				resolve(text);
			},
			setInterval: () => 0,
			clearTimer: () => {},
		});

		modal.render(80);

		// Select all (Ctrl+A)
		modal.handleInput("\x01");
		expect(modal.buffer.selection).toEqual({ start: 0, end: 11 });

		// Ctrl+C
		modal.handleInput("\x03");
		const result = await promise;

		expect(result).toBe("hello world");
		expect(copiedText).toEqual("hello world");
	});

	it("integrates with CustomEditor and preserves atom expansion", () => {
		const term = new MinimalTerminal();
		const tui = new TUI(term);
		const editor = new CustomEditor(tui);

		// Register an image atom in the editor
		editor.registerAtom("[Image #1]", "attachment://image-uuid-1234");
		editor.setText("prefix [Image #1] suffix");

		const original = editor.getText();
		expect(original).toBe("prefix [Image #1] suffix");
		expect(editor.getExpandedText()).toBe("prefix attachment://image-uuid-1234 suffix");

		// Simulate modal saving an updated text that retains the atom
		let savedOk = false;
		const modal = new MouseEditModal(tui, original, {
			onSave: updated => {
				if (editor.getText() !== original) {
					return false;
				}
				editor.setText(updated);
				savedOk = true;
				return true;
			},
			onCancel: () => {},
			copy: async () => {},
			setInterval: () => 0,
			clearTimer: () => {},
		});

		modal.render(80);
		// Replace "prefix" with "new-prefix"
		modal.buffer.select(0, 6);
		modal.buffer.replaceSelection("new-prefix");

		// Save via Ctrl+Q
		modal.handleInput("\x11");
		expect(savedOk).toBe(true);

		// Verify that CustomEditor now has updated text AND still expands the atom
		expect(editor.getText()).toBe("new-prefix [Image #1] suffix");
		expect(editor.getExpandedText()).toBe("new-prefix attachment://image-uuid-1234 suffix");
	});

	it("detects background modification conflict and refuses to overwrite", () => {
		const term = new MinimalTerminal();
		const tui = new TUI(term);
		const editor = new CustomEditor(tui);
		editor.setText("initial draft");

		const original = editor.getText();
		const modal = new MouseEditModal(tui, original, {
			onSave: updated => {
				// Simulating index.ts conflict detection:
				if (editor.getText() !== original) {
					modal.setErrorMessage("草稿在后台发生变化，未覆盖；按 Esc 退出");
					return false;
				}
				editor.setText(updated);
				return true;
			},
			onCancel: () => {},
			copy: async () => {},
			setInterval: () => 0,
			clearTimer: () => {},
		});

		modal.render(80);
		modal.buffer.replaceSelection(" modified in modal");

		// Meanwhile, background editor changed:
		editor.setText("background changed draft");

		// User tries to save
		modal.handleInput("\x11");

		// Save was rejected
		expect(editor.getText()).toBe("background changed draft");
		expect(modal.errorMessage).toBe("草稿在后台发生变化，未覆盖；按 Esc 退出");
	});
	it("handles bracketed paste: inserts at caret and sanitizes text", () => {
		const term = new MinimalTerminal();
		const tui = new TUI(term);

		const modal = new MouseEditModal(tui, "hello world", {
			onSave: () => true,
			onCancel: () => {},
			copy: async () => {},
			setInterval: () => 0,
			clearTimer: () => {},
		});

		modal.render(80);
		modal.buffer.setCaret(5); // right after "hello"

		// Bracketed paste sequence: \x1b[200~ ... \x1b[201~
		modal.handleInput("\x1b[200~, \r\npaste\x1b[31m_red\x1b[0m\x07\x1b[201~");

		// CRLF normalized to \n, C0 control chars stripped (preserving escape payload), inserted at caret
		expect(modal.buffer.text).toBe("hello, \npaste[31m_red[0m world");
		expect(modal.buffer.cursor).toBe("hello, \npaste[31m_red[0m".length);
	});

	it("handles bracketed paste replacing active selection", () => {
		const term = new MinimalTerminal();
		const tui = new TUI(term);

		const modal = new MouseEditModal(tui, "hello world", {
			onSave: () => true,
			onCancel: () => {},
			copy: async () => {},
			setInterval: () => 0,
			clearTimer: () => {},
		});

		modal.render(80);
		// Select "world"
		modal.buffer.select(6, 11);

		// Paste replaces selection
		modal.handleInput("\x1b[200~earth\x1b[201~");
		expect(modal.buffer.text).toBe("hello earth");
		expect(modal.buffer.selection).toBeNull();
		expect(modal.buffer.cursor).toBe("hello earth".length);
	});

	it("supports pasteText and beginPaste async queue contract", () => {
		const term = new MinimalTerminal();
		const tui = new TUI(term);

		const modal = new MouseEditModal(tui, "initial ", {
			onSave: () => true,
			onCancel: () => {},
			copy: async () => {},
			setInterval: () => 0,
			clearTimer: () => {},
		});

		modal.render(80);

		// Direct pasteText
		modal.pasteText("direct");
		expect(modal.buffer.text).toBe("initial direct");

		// beginPaste: queues async delivery and delivers in order
		const deliverFirst = modal.beginPaste();
		const deliverSecond = modal.beginPaste();

		// Delivering second before first shouldn't insert out-of-order
		deliverSecond(" second");
		expect(modal.buffer.text).toBe("initial direct");

		// Now deliver first -> both first and second are flushed in order
		deliverFirst(" first");
		expect(modal.buffer.text).toBe("initial direct first second");
	});
	it("renders mimic layout with previous reply card and anchors editor to bottom", () => {
		const term = new MinimalTerminal();
		term.columns = 80;
		term.rows = 24;
		const tui = new TUI(term);

		const previousReply = "Here is the previous agent answer.\nSecond line.\nThird line.";
		const modal = new MouseEditModal(tui, "draft line 1\ndraft line 2", {
			contextReply: previousReply,
			layout: "mimic",
			onSave: () => true,
			onCancel: () => {},
			copy: async () => {},
			setInterval: () => 0,
			clearTimer: () => {},
		});

		const lines = modal.render(80);
		expect(lines.length).toBe(24);

		// Top reply card is rendered
		expect(lines.some(l => l.includes("上一次回复"))).toBe(true);
		expect(lines.some(l => l.includes("Here is the previous agent answer."))).toBe(true);

		// Bottom mimic box is rendered
		expect(lines.some(l => l.includes("鼠标编辑 (Alt+E)"))).toBe(true);
		expect(lines.some(l => l.includes("draft line 1"))).toBe(true);

		// Test wheel over top area scrolls top context
		modal.handleInput("\x1b[<65;10;2M"); // wheel down on row 2 (top area)
		const scrolledLines = modal.render(80);
		expect(scrolledLines.length).toBe(24);
	});
});
