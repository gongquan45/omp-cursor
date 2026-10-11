import type { Component, Focusable } from "@oh-my-pi/pi-tui";
import {
	extractPrintableText,
	getSegmenter,
	matchesKey,
	parseSgrMouse,
	type SgrMouseEvent,
	truncateToWidth,
	type TUI,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { BracketedPasteHandler } from "@oh-my-pi/pi-tui/bracketed-paste";
import {
	EditBuffer,
	getTokenRanges,
	getWordRangeAt,
	getLineRangeAt,
	sanitizePasteText,
} from "../core/edit-buffer";
import { hostTextServices } from "../host/text-services";

export type TimerHandle = unknown;

export interface MouseEditModalCallbacks {
	onSave: (text: string) => boolean;
	onCancel: () => void;
	copy: (text: string) => Promise<void>;
	setInterval: (callback: () => void, ms: number) => TimerHandle;
	clearTimer: (timer: TimerHandle) => void;
	now?: () => number;
}

interface VisualCell {
	startCol: number;
	endCol: number;
	startOffset: number;
	endOffset: number;
	text: string;
	width: number;
	isToken: boolean;
}

interface VisualLine {
	lineIndex: number;
	startOffset: number;
	endOffset: number;
	cells: VisualCell[];
	hasTrailingNewline: boolean;
	totalWidth: number;
}

export class MouseEditModal implements Component, Focusable {
	readonly focused = true;
	readonly #tui: TUI;
	readonly #buffer: EditBuffer;
	readonly #callbacks: MouseEditModalCallbacks;
	readonly #pasteHandler = new BracketedPasteHandler();
	readonly #now: () => number;

	#disposed = false;
	#errorMessage: string | null = null;
	#scrollOffset = 0;
	#lastRenderWidth = 80;
	#lastRenderHeight = 24;

	// Mouse interaction state
	#isDragging = false;
	#lastClickTime = 0;
	#lastClickOffset = -1;
	#clickCount = 0;
	#dragTimer: TimerHandle | null = null;
	#dragTimerDirection: -1 | 1 | 0 = 0;
	#lastMouseRow = 0;
	#lastMouseCol = 0;

	// Async paste queue
	#pendingPastes: { settled: boolean; text: string | undefined }[] = [];

	// Layout cache
	#cachedWidth = -1;
	#cachedText = "";
	#cachedVisualLines: VisualLine[] = [];

	constructor(tui: TUI, initialText: string, callbacks: MouseEditModalCallbacks) {
		this.#tui = tui;
		this.#callbacks = callbacks;
		this.#now = callbacks.now ?? (() => Date.now());
		this.#buffer = new EditBuffer(initialText, {
			now: this.#now,
			services: hostTextServices,
		});
	}

	get buffer(): EditBuffer {
		return this.#buffer;
	}

	get errorMessage(): string | null {
		return this.#errorMessage;
	}

	setErrorMessage(msg: string | null): void {
		this.#errorMessage = msg;
		this.#tui.requestRender();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#stopDragTimer();
		this.#pendingPastes.length = 0;
	}

	beginPaste(): (text: string | undefined) => boolean {
		if (this.#disposed) return () => false;
		const pending: { settled: boolean; text: string | undefined } = {
			settled: false,
			text: undefined,
		};
		this.#pendingPastes.push(pending);
		return text => {
			if (this.#disposed || pending.settled) return false;
			pending.settled = true;
			pending.text = text;
			let delivered = 0;
			for (const paste of this.#pendingPastes) {
				if (!paste.settled) break;
				if (paste.text) this.#insertPastedText(paste.text);
				delivered++;
			}
			if (delivered > 0) this.#pendingPastes.splice(0, delivered);
			return !!text;
		};
	}

	pasteText(text: string): void {
		if (this.#disposed) return;
		if (this.#pendingPastes.length > 0) {
			this.beginPaste()(text);
		} else {
			this.#insertPastedText(text);
		}
	}

	#insertPastedText(text: string): void {
		if (this.#disposed) return;
		const sanitized = sanitizePasteText(text);
		this.#buffer.replaceSelection(sanitized);
		this.#ensureCursorVisible();
		this.#tui.requestRender();
	}

	#save(): void {
		if (this.#disposed) return;
		const ok = this.#callbacks.onSave(this.#buffer.text);
		if (ok) {
			this.dispose();
		}
	}

	#cancel(): void {
		if (this.#disposed) return;
		this.dispose();
		this.#callbacks.onCancel();
	}

	#stopDragTimer(): void {
		if (this.#dragTimer !== null) {
			this.#callbacks.clearTimer(this.#dragTimer);
			this.#dragTimer = null;
			this.#dragTimerDirection = 0;
		}
	}

	#startDragScrollTimer(direction: -1 | 1): void {
		if (this.#dragTimerDirection === direction && this.#dragTimer !== null) {
			return;
		}
		this.#stopDragTimer();
		this.#dragTimerDirection = direction;
		this.#dragTimer = this.#callbacks.setInterval(() => {
			if (this.#disposed || !this.#isDragging) {
				this.#stopDragTimer();
				return;
			}
			const maxScroll = Math.max(
				0,
				this.#getVisualLines().length - Math.max(1, this.#lastRenderHeight - 2),
			);
			this.#scrollOffset = Math.max(0, Math.min(maxScroll, this.#scrollOffset + direction));
			const hit = this.#hitTest(this.#lastMouseRow, this.#lastMouseCol);
			this.#buffer.setCaret(hit, true);
			this.#tui.requestRender();
		}, 50);
	}

	#getVisualLines(): VisualLine[] {
		const textAreaWidth = Math.max(1, this.#lastRenderWidth - 2);
		const text = this.#buffer.text;
		if (this.#cachedWidth === textAreaWidth && this.#cachedText === text) {
			return this.#cachedVisualLines;
		}

		const vLines: VisualLine[] = [];
		const segmenter = getSegmenter();
		const tokens = getTokenRanges(text);

		// Decompose text into items: tokens and graphemes
		const items: {
			start: number;
			end: number;
			text: string;
			isToken: boolean;
		}[] = [];
		let pos = 0;
		for (const tok of tokens) {
			if (tok.start > pos) {
				const slice = text.slice(pos, tok.start);
				for (const seg of segmenter.segment(slice)) {
					items.push({
						start: pos + seg.index,
						end: pos + seg.index + seg.segment.length,
						text: seg.segment,
						isToken: false,
					});
				}
			}
			items.push({
				start: tok.start,
				end: tok.end,
				text: tok.text,
				isToken: true,
			});
			pos = tok.end;
		}
		if (pos < text.length) {
			const slice = text.slice(pos);
			for (const seg of segmenter.segment(slice)) {
				items.push({
					start: pos + seg.index,
					end: pos + seg.index + seg.segment.length,
					text: seg.segment,
					isToken: false,
				});
			}
		}

		let curLineStart = 0;
		let curCells: VisualCell[] = [];
		let curWidth = 0;

		for (const item of items) {
			if (item.text === "\n") {
				vLines.push({
					lineIndex: vLines.length,
					startOffset: curLineStart,
					endOffset: item.end,
					cells: curCells,
					hasTrailingNewline: true,
					totalWidth: curWidth,
				});
				curLineStart = item.end;
				curCells = [];
				curWidth = 0;
				continue;
			}

			const w = visibleWidth(item.text);
			if (curWidth + w > textAreaWidth && curCells.length > 0) {
				vLines.push({
					lineIndex: vLines.length,
					startOffset: curLineStart,
					endOffset: item.start,
					cells: curCells,
					hasTrailingNewline: false,
					totalWidth: curWidth,
				});
				curLineStart = item.start;
				curCells = [];
				curWidth = 0;
			}

			curCells.push({
				startCol: curWidth,
				endCol: curWidth + w,
				startOffset: item.start,
				endOffset: item.end,
				text: item.text,
				width: w,
				isToken: item.isToken,
			});
			curWidth += w;
		}

		vLines.push({
			lineIndex: vLines.length,
			startOffset: curLineStart,
			endOffset: text.length,
			cells: curCells,
			hasTrailingNewline: false,
			totalWidth: curWidth,
		});

		this.#cachedWidth = textAreaWidth;
		this.#cachedText = text;
		this.#cachedVisualLines = vLines;
		return vLines;
	}

	#hitTest(screenRow: number, screenCol: number): number {
		const vLines = this.#getVisualLines();
		if (vLines.length === 0) return 0;

		const targetVRow = screenRow - 1 + this.#scrollOffset;
		if (targetVRow < 0) {
			return vLines[0].startOffset;
		}
		if (targetVRow >= vLines.length) {
			return vLines[vLines.length - 1].endOffset;
		}

		const vLine = vLines[targetVRow];
		const textCol = screenCol - 1; // 1-column left margin

		if (textCol <= 0) {
			return vLine.startOffset;
		}

		if (textCol >= vLine.totalWidth) {
			if (vLine.hasTrailingNewline) {
				return vLine.endOffset - 1;
			}
			return vLine.endOffset;
		}

		for (const cell of vLine.cells) {
			if (textCol >= cell.startCol && textCol < cell.endCol) {
				if (cell.width === 1) {
					return cell.startOffset;
				}
				if (cell.width === 2) {
					// Double-width character: left cell takes front boundary, right cell takes back boundary
					return textCol === cell.startCol ? cell.startOffset : cell.endOffset;
				}
				if (cell.isToken) {
					return textCol < cell.startCol + cell.width / 2 ? cell.startOffset : cell.endOffset;
				}
				const frac = (textCol - cell.startCol) / cell.width;
				return frac < 0.5 ? cell.startOffset : cell.endOffset;
			}
		}

		return vLine.endOffset;
	}

	#ensureCursorVisible(): void {
		const vLines = this.#getVisualLines();
		const cursor = this.#buffer.cursor;
		let cursorVRow = 0;
		for (let i = 0; i < vLines.length; i++) {
			const line = vLines[i];
			if (cursor >= line.startOffset && cursor <= line.endOffset) {
				cursorVRow = i;
				// If cursor is at line.endOffset and line has trailing newline, cursor might belong to next line
				if (cursor === line.endOffset && line.hasTrailingNewline && i + 1 < vLines.length) {
					continue;
				}
				break;
			}
		}

		const viewHeight = Math.max(1, this.#lastRenderHeight - 2);
		if (cursorVRow < this.#scrollOffset) {
			this.#scrollOffset = cursorVRow;
		} else if (cursorVRow >= this.#scrollOffset + viewHeight) {
			this.#scrollOffset = cursorVRow - viewHeight + 1;
		}
	}

	#handleMouse(event: SgrMouseEvent): void {
		const totalRows = this.#lastRenderHeight;
		const textAreaHeight = Math.max(1, totalRows - 2);
		const maxScroll = Math.max(0, this.#getVisualLines().length - textAreaHeight);

		// Wheel scroll
		if (event.wheel !== null) {
			this.#scrollOffset = Math.max(
				0,
				Math.min(maxScroll, this.#scrollOffset + event.wheel * 3),
			);
			this.#tui.requestRender();
			return;
		}

		// Left click
		if (event.leftClick) {
			const now = this.#now();
			const hit = this.#hitTest(event.row, event.col);
			if (now - this.#lastClickTime <= 500 && hit === this.#lastClickOffset) {
				this.#clickCount = (this.#clickCount % 3) + 1;
			} else {
				this.#clickCount = 1;
			}
			this.#lastClickTime = now;
			this.#lastClickOffset = hit;
			this.#lastMouseRow = event.row;
			this.#lastMouseCol = event.col;

			if (this.#clickCount === 1) {
				this.#buffer.setCaret(hit, false);
				this.#isDragging = true;
			} else if (this.#clickCount === 2) {
				const { start, end } = getWordRangeAt(
					this.#buffer.text,
					hit,
					hostTextServices,
				);
				this.#buffer.select(start, end);
				this.#isDragging = true;
			} else if (this.#clickCount === 3) {
				const { start, end } = getLineRangeAt(this.#buffer.text, hit);
				this.#buffer.select(start, end);
				this.#isDragging = true;
			}

			this.#stopDragTimer();
			if (event.row <= 1) {
				this.#startDragScrollTimer(-1);
			} else if (event.row >= totalRows - 2) {
				this.#startDragScrollTimer(1);
			}
			this.#tui.requestRender();
			return;
		}

		// Motion while holding left button
		if (event.motion && (event.button & 3) === 0 && this.#isDragging) {
			this.#lastMouseRow = event.row;
			this.#lastMouseCol = event.col;
			const hit = this.#hitTest(event.row, event.col);
			this.#buffer.setCaret(hit, true);

			if (event.row <= 1) {
				this.#startDragScrollTimer(-1);
			} else if (event.row >= totalRows - 2) {
				this.#startDragScrollTimer(1);
			} else {
				this.#stopDragTimer();
			}
			this.#tui.requestRender();
			return;
		}

		// Mouse release
		if (event.release) {
			this.#isDragging = false;
			this.#stopDragTimer();
			this.#tui.requestRender();
			return;
		}
	}

	#moveVertical(delta: -1 | 1, extend: boolean): void {
		const vLines = this.#getVisualLines();
		const cursor = this.#buffer.cursor;

		let curVRow = 0;
		let curVCol = 0;
		for (let i = 0; i < vLines.length; i++) {
			const line = vLines[i];
			if (cursor >= line.startOffset && cursor <= line.endOffset) {
				curVRow = i;
				if (cursor === line.endOffset && line.hasTrailingNewline && i + 1 < vLines.length) {
					continue;
				}
				for (const cell of line.cells) {
					if (cursor >= cell.startOffset && cursor < cell.endOffset) {
						curVCol = cell.startCol;
						break;
					}
					if (cursor >= cell.endOffset) {
						curVCol = cell.endCol;
					}
				}
				break;
			}
		}

		const targetVRow = curVRow + delta;
		if (targetVRow < 0) {
			this.#buffer.setCaret(0, extend);
		} else if (targetVRow >= vLines.length) {
			this.#buffer.setCaret(this.#buffer.text.length, extend);
		} else {
			const targetLine = vLines[targetVRow];
			// Map curVCol to targetLine offset
			let targetOffset = targetLine.startOffset;
			if (curVCol >= targetLine.totalWidth) {
				targetOffset = targetLine.hasTrailingNewline
					? targetLine.endOffset - 1
					: targetLine.endOffset;
			} else {
				for (const cell of targetLine.cells) {
					if (curVCol >= cell.startCol && curVCol < cell.endCol) {
						targetOffset =
							cell.width === 2 && curVCol === cell.startCol + 1
								? cell.endOffset
								: cell.startOffset;
						break;
					}
					targetOffset = cell.endOffset;
				}
			}
			this.#buffer.setCaret(targetOffset, extend);
		}
		this.#ensureCursorVisible();
		this.#tui.requestRender();
	}

	#moveLineBoundary(target: "start" | "end", extend: boolean): void {
		const vLines = this.#getVisualLines();
		const cursor = this.#buffer.cursor;
		for (let i = 0; i < vLines.length; i++) {
			const line = vLines[i];
			if (cursor >= line.startOffset && cursor <= line.endOffset) {
				if (cursor === line.endOffset && line.hasTrailingNewline && i + 1 < vLines.length) {
					continue;
				}
				const offset =
					target === "start"
						? line.startOffset
						: line.hasTrailingNewline
							? line.endOffset - 1
							: line.endOffset;
				this.#buffer.setCaret(offset, extend);
				break;
			}
		}
		this.#ensureCursorVisible();
		this.#tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.#disposed) return;

		// SGR Mouse handling
		if (data.startsWith("\x1b[<")) {
			const event = parseSgrMouse(data);
			if (event) {
				this.#handleMouse(event);
				return;
			}
		}

		// Minimum dimension guard: only Esc is processed
		if (this.#lastRenderWidth < 6 || this.#lastRenderHeight < 3) {
			if (matchesKey(data, "escape")) {
				this.#cancel();
			}
			return;
		}

		// Bracketed paste handling
		const pasteResult = this.#pasteHandler.process(data);
		if (pasteResult.handled) {
			if (pasteResult.pasteContent !== undefined) {
				this.#insertPastedText(pasteResult.pasteContent);
			}
			if (pasteResult.remaining) {
				this.handleInput(pasteResult.remaining);
			}
			return;
		}

		// Save Chords: Ctrl+Enter or Ctrl+Q
		if (matchesKey(data, "ctrl+enter") || matchesKey(data, "ctrl+q")) {
			this.#save();
			return;
		}

		// Cancel Chord: Esc
		if (matchesKey(data, "escape")) {
			this.#cancel();
			return;
		}

		// Undo / Redo
		if (matchesKey(data, "ctrl+z")) {
			this.#buffer.undo();
			this.#ensureCursorVisible();
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+y")) {
			this.#buffer.redo();
			this.#ensureCursorVisible();
			this.#tui.requestRender();
			return;
		}

		// Select All: Ctrl+A
		if (matchesKey(data, "ctrl+a")) {
			this.#buffer.selectAll();
			this.#tui.requestRender();
			return;
		}

		// Copy: Ctrl+C (only if non-empty selection)
		if (matchesKey(data, "ctrl+c")) {
			const sel = this.#buffer.selection;
			if (sel !== null) {
				const selectedText = this.#buffer.text.slice(sel.start, sel.end);
				this.#callbacks.copy(selectedText).catch(err => {
					if (!this.#disposed) {
						const msg = err instanceof Error ? err.message : String(err);
						this.setErrorMessage(`复制失败: ${msg}`);
					}
				});
			}
			return;
		}

		// Backspace / Delete
		if (matchesKey(data, "backspace")) {
			this.#buffer.deleteBackward();
			this.#ensureCursorVisible();
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "delete")) {
			this.#buffer.deleteForward();
			this.#ensureCursorVisible();
			this.#tui.requestRender();
			return;
		}

		// Enter / Shift+Enter
		if (matchesKey(data, "enter") || matchesKey(data, "shift+enter")) {
			this.#buffer.replaceSelection("\n");
			this.#ensureCursorVisible();
			this.#tui.requestRender();
			return;
		}

		// Word Navigation: Ctrl+Left / Alt+Left / Shift+Ctrl+Left / Shift+Alt+Left
		if (
			matchesKey(data, "shift+ctrl+left") ||
			matchesKey(data, "shift+alt+left")
		) {
			this.#buffer.moveWordLeft(true);
			this.#ensureCursorVisible();
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+left") || matchesKey(data, "alt+left")) {
			this.#buffer.moveWordLeft(false);
			this.#ensureCursorVisible();
			this.#tui.requestRender();
			return;
		}
		if (
			matchesKey(data, "shift+ctrl+right") ||
			matchesKey(data, "shift+alt+right")
		) {
			this.#buffer.moveWordRight(true);
			this.#ensureCursorVisible();
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+right") || matchesKey(data, "alt+right")) {
			this.#buffer.moveWordRight(false);
			this.#ensureCursorVisible();
			this.#tui.requestRender();
			return;
		}

		// Line / Document boundary: Home / End
		if (matchesKey(data, "shift+ctrl+home")) {
			this.#buffer.setCaret(0, true);
			this.#ensureCursorVisible();
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+home")) {
			this.#buffer.setCaret(0, false);
			this.#ensureCursorVisible();
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "shift+ctrl+end")) {
			this.#buffer.setCaret(this.#buffer.text.length, true);
			this.#ensureCursorVisible();
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+end")) {
			this.#buffer.setCaret(this.#buffer.text.length, false);
			this.#ensureCursorVisible();
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "shift+home")) {
			this.#moveLineBoundary("start", true);
			return;
		}
		if (matchesKey(data, "home")) {
			this.#moveLineBoundary("start", false);
			return;
		}
		if (matchesKey(data, "shift+end")) {
			this.#moveLineBoundary("end", true);
			return;
		}
		if (matchesKey(data, "end")) {
			this.#moveLineBoundary("end", false);
			return;
		}

		// Arrow Keys: Left, Right, Up, Down (with Shift)
		if (matchesKey(data, "shift+left")) {
			const target = this.#buffer.snapToBoundary(this.#buffer.cursor - 1, "left");
			this.#buffer.setCaret(target, true);
			this.#ensureCursorVisible();
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "left")) {
			const target = this.#buffer.snapToBoundary(this.#buffer.cursor - 1, "left");
			this.#buffer.setCaret(target, false);
			this.#ensureCursorVisible();
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "shift+right")) {
			const target = this.#buffer.snapToBoundary(this.#buffer.cursor + 1, "right");
			this.#buffer.setCaret(target, true);
			this.#ensureCursorVisible();
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "right")) {
			const target = this.#buffer.snapToBoundary(this.#buffer.cursor + 1, "right");
			this.#buffer.setCaret(target, false);
			this.#ensureCursorVisible();
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "shift+up")) {
			this.#moveVertical(-1, true);
			return;
		}
		if (matchesKey(data, "up")) {
			this.#moveVertical(-1, false);
			return;
		}
		if (matchesKey(data, "shift+down")) {
			this.#moveVertical(1, true);
			return;
		}
		if (matchesKey(data, "down")) {
			this.#moveVertical(1, false);
			return;
		}

		// Printable text insertion
		const printable = extractPrintableText(data);
		if (printable) {
			this.#buffer.replaceSelection(printable);
			this.#ensureCursorVisible();
			this.#tui.requestRender();
			return;
		}
	}

	render(width: number): readonly string[] {
		this.#lastRenderWidth = width;
		const totalRows = this.#tui.terminal.rows;
		this.#lastRenderHeight = totalRows;

		// Guard for small terminals
		if (width < 6 || totalRows < 3) {
			const alert = truncateToWidth("窗口过小", width);
			const lines: string[] = [];
			const mid = Math.floor(totalRows / 2);
			for (let i = 0; i < totalRows; i++) {
				lines.push(i === mid ? alert : "");
			}
			return lines;
		}

		const lines: string[] = [];

		// Header (row 0)
		let title = " ── 鼠标编辑浮层 ──────────────────────────────────────────";
		if (this.#errorMessage) {
			title = ` ── [错误] ${this.#errorMessage} ──────────────────────────`;
		}
		lines.push(truncateToWidth(title, width, "", true));

		// Text area (rows 1 to totalRows - 2)
		const textAreaHeight = totalRows - 2;
		const vLines = this.#getVisualLines();
		const sel = this.#buffer.selection;
		const cursor = this.#buffer.cursor;

		for (let row = 0; row < textAreaHeight; row++) {
			const vIndex = this.#scrollOffset + row;
			if (vIndex >= vLines.length) {
				lines.push(truncateToWidth("", width, "", true));
				continue;
			}

			const vLine = vLines[vIndex];
			let lineContent = " "; // 1-column left margin
			let cursorDrawn = false;

			for (const cell of vLine.cells) {
				const isCellSelected =
					sel !== null && cell.startOffset >= sel.start && cell.endOffset <= sel.end;
				const isCursorOnCell = sel === null && cursor === cell.startOffset;

				if (isCellSelected || isCursorOnCell) {
					lineContent += `\x1b[7m${cell.text}\x1b[27m`;
					if (isCursorOnCell) cursorDrawn = true;
				} else {
					lineContent += cell.text;
				}
			}

			// If cursor is at the end of this visual line or line is empty
			if (sel === null && !cursorDrawn) {
				const isCursorAtEndOfLine =
					vLine.cells.length === 0
						? cursor === vLine.startOffset
						: vLine.hasTrailingNewline
							? cursor === vLine.endOffset - 1
							: cursor === vLine.endOffset;
				if (isCursorAtEndOfLine) {
					lineContent += "\x1b[7m \x1b[27m";
				}
			}

			lines.push(truncateToWidth(lineContent, width, "", true));
		}

		// Footer (row totalRows - 1)
		const footer = this.#errorMessage
			? ` [错误] ${this.#errorMessage} (按 Esc 退出)`
			: " Alt+E 打开 | Ctrl+Enter/Ctrl+Q 保存 | Esc 取消 | 鼠标无响应时请检查终端 SGR 鼠标支持";
		lines.push(truncateToWidth(footer, width, "", true));

		return lines;
	}
}
