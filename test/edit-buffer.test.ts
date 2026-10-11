import { describe, expect, it } from "bun:test";
import {
	EditBuffer,
	getLineRangeAt,
	getTokenRanges,
	getWordRangeAt,
	sanitizePasteText,
} from "../src/edit-buffer";

describe("EditBuffer - Text Model", () => {
	it("handles UTF-16, combining diacritics, Chinese double-width, and emoji", () => {
		// "a\u0301" is 'a' + combining acute (length 2)
		// "🙂" is surrogate pair (length 2)
		const text = "a\u0301b中文🙂tail";
		const buffer = new EditBuffer(text);

		// Caret at end
		expect(buffer.cursor).toBe(text.length);

		// Snapping inside "a\u0301" (offset 1) snaps to 0 or 2
		expect(buffer.snapToBoundary(1, "closest")).toBe(2);
		expect(buffer.snapToBoundary(1, "left")).toBe(0);
		expect(buffer.snapToBoundary(1, "right")).toBe(2);

		// Snapping inside "🙂" (offset 6..8)
		// "a\u0301" (0..2), "b" (2..3), "中" (3..4), "文" (4..5), "🙂" (5..7)
		const emojiStart = text.indexOf("🙂");
		expect(buffer.snapToBoundary(emojiStart + 1, "closest")).toBe(emojiStart + 2);
		expect(buffer.snapToBoundary(emojiStart + 1, "left")).toBe(emojiStart);

		// Delete backward on emoji deletes both code units
		buffer.setCaret(emojiStart + 2);
		buffer.deleteBackward();
		expect(buffer.text).toBe("a\u0301b中文tail");
		expect(buffer.cursor).toBe(emojiStart);

		// Delete backward on combining diacritic deletes cluster
		buffer.setCaret(2);
		buffer.deleteBackward();
		expect(buffer.text).toBe("b中文tail");
		expect(buffer.cursor).toBe(0);
	});

	it("protects composer token chips as atomic units", () => {
		const text = "start [Image #1] middle [Paste #2, 10 lines] end";
		const buffer = new EditBuffer(text);

		const tokens = getTokenRanges(text);
		expect(tokens.length).toBe(2);
		expect(tokens[0].text).toBe("[Image #1]");
		expect(tokens[1].text).toBe("[Paste #2, 10 lines]");

		// Cannot place caret inside token
		const imgTok = tokens[0];
		expect(buffer.snapToBoundary(imgTok.start + 2, "closest")).toBe(imgTok.start);
		expect(buffer.snapToBoundary(imgTok.end - 1, "closest")).toBe(imgTok.end);

		// Selecting with boundary inside token expands to cover token completely
		buffer.select(imgTok.start + 2, imgTok.end + 5);
		const sel = buffer.selection;
		expect(sel).not.toBeNull();
		expect(sel?.start).toBe(imgTok.start);
		expect(sel?.end).toBe(imgTok.end + 5);

		// Delete backward after token deletes entire token
		buffer.setCaret(imgTok.end);
		buffer.deleteBackward();
		expect(buffer.text).toBe("start  middle [Paste #2, 10 lines] end");
		expect(buffer.cursor).toBe(imgTok.start);

		// Delete forward before token deletes entire token
		const pasteTokStart = buffer.text.indexOf("[Paste #2, 10 lines]");
		buffer.setCaret(pasteTokStart);
		buffer.deleteForward();
		expect(buffer.text).toBe("start  middle  end");
		expect(buffer.cursor).toBe(pasteTokStart);
	});

	it("deletes cross-line selection in one step", () => {
		const text = "line 1 alpha\nline 2 beta\nline 3 gamma";
		const buffer = new EditBuffer(text);

		// Select from "alpha" to "beta"
		const start = text.indexOf("alpha");
		const end = text.indexOf("beta") + "beta".length;
		buffer.select(start, end);
		expect(buffer.text.slice(start, end)).toBe("alpha\nline 2 beta");

		buffer.deleteBackward();
		expect(buffer.text).toBe("line 1 \nline 3 gamma");
		expect(buffer.cursor).toBe(start);
		expect(buffer.selection).toBeNull();
	});

	it("merges continuous typing within 500ms and splits when >500ms", () => {
		let fakeTime = 1000;
		const now = () => fakeTime;
		const buffer = new EditBuffer("hello", { now });

		// Type ' ' at t=1000
		buffer.replaceSelection(" ");
		expect(buffer.text).toBe("hello ");

		// Type 'w' at t=1200 (< 500ms diff)
		fakeTime = 1200;
		buffer.replaceSelection("w");
		expect(buffer.text).toBe("hello w");

		// Type 'o' at t=1400 (< 500ms diff)
		fakeTime = 1400;
		buffer.replaceSelection("o");
		expect(buffer.text).toBe("hello wo");

		// Undo should revert all consecutive typing in that burst to "hello"
		buffer.undo();
		expect(buffer.text).toBe("hello");

		// Redo should restore "hello wo"
		buffer.redo();
		expect(buffer.text).toBe("hello wo");

		// Advance time by 600ms (> 500ms)
		fakeTime = 2050;
		buffer.replaceSelection("r");
		expect(buffer.text).toBe("hello wor");

		// Now undo once reverts to "hello wo"
		buffer.undo();
		expect(buffer.text).toBe("hello wo");

		// Undo again reverts to "hello"
		buffer.undo();
		expect(buffer.text).toBe("hello");

		// New edit clears redo stack
		buffer.replaceSelection("!");
		expect(buffer.redo()).toBe(false);
	});

	it("does not create undo records on pure caret moves or selections", () => {
		const buffer = new EditBuffer("abcdef");
		buffer.setCaret(2);
		buffer.select(1, 4);
		buffer.setCaret(0);
		expect(buffer.undo()).toBe(false);
	});

	it("sanitizes pasted text properly", () => {
		// CRLF normalization, ESC stripping, tab replacement, control char stripping
		const raw = "line 1\r\nline 2\r\n\x1b[31mred\x1b[0m\tcolumn\x00\x07";
		const sanitized = sanitizePasteText(raw);

		expect(sanitized.includes("\r")).toBe(false);
		expect(sanitized.includes("\x1b")).toBe(false);
		expect(sanitized.includes("\x00")).toBe(false);
		expect(sanitized.includes("\x07")).toBe(false);
		expect(sanitized.includes("\t")).toBe(false);
		// \n is preserved
		expect(sanitized.includes("\n")).toBe(true);
	});

	it("identifies word and line ranges correctly for multi-click", () => {
		const text = "alpha beta\n中文🙂 tail\nlast line";

		// Double-click word detection
		const betaRange = getWordRangeAt(text, text.indexOf("beta") + 1);
		expect(text.slice(betaRange.start, betaRange.end)).toBe("beta");

		const cjkRange = getWordRangeAt(text, text.indexOf("中文") + 1);
		expect(text.slice(cjkRange.start, cjkRange.end)).toBe("中文");

		// Triple-click line detection (includes trailing \n for non-last lines)
		const line1Range = getLineRangeAt(text, 2);
		expect(text.slice(line1Range.start, line1Range.end)).toBe("alpha beta\n");

		const line2Range = getLineRangeAt(text, text.indexOf("tail"));
		expect(text.slice(line2Range.start, line2Range.end)).toBe("中文🙂 tail\n");

		const line3Range = getLineRangeAt(text, text.indexOf("last"));
		expect(text.slice(line3Range.start, line3Range.end)).toBe("last line");
	});
});
