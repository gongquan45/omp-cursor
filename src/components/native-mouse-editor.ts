import { CustomEditor } from "@oh-my-pi/pi-coding-agent";
import { copyToClipboard } from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import type { KeybindingsManager } from "@oh-my-pi/pi-coding-agent";
import type {
	EditorTextDecorationContext,
	EditorTheme,
	TUI,
} from "@oh-my-pi/pi-tui";
import {
	extractPrintableText,
	matchesKey,
	parseSgrMouse,
	type SgrMouseEvent,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import {
	EditBuffer,
	getLineRangeAt,
	getWordRangeAt,
} from "../core/edit-buffer";
import { hostTextServices } from "../host/text-services";

export class NativeMouseEditor extends CustomEditor {
	readonly #tui: TUI;
	#mouseActive = false;
	#isDragging = false;
	#selection: { start: number; end: number } | null = null;
	#editBuffer: EditBuffer;
	#lastClickTime = 0;
	#lastClickOffset = -1;
	#clickCount = 0;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		_keybindings?: KeybindingsManager,
	) {
		super(theme);
		this.#tui = tui;
		this.#editBuffer = new EditBuffer("", { services: hostTextServices });

		// Register selection decoration hook on CustomEditor
		this.decorateText = (rowText: string, ctx: EditorTextDecorationContext): string => {
			if (!this.#selection) return rowText;
			const lines = this.getLines();
			let lineOffset = 0;
			for (let i = 0; i < ctx.line; i++) {
				lineOffset += (lines[i]?.length ?? 0) + 1;
			}
			const rowStart = lineOffset + ctx.startCol;
			const rowEnd = lineOffset + ctx.endCol;

			const oStart = Math.max(rowStart, this.#selection.start);
			const oEnd = Math.min(rowEnd, this.#selection.end);
			if (oStart < oEnd) {
				const idx1 = Math.max(0, oStart - rowStart);
				const idx2 = Math.min(rowText.length, oEnd - rowStart);
				return (
					rowText.slice(0, idx1) +
					"\x1b[7m" +
					rowText.slice(idx1, idx2) +
					"\x1b[27m" +
					rowText.slice(idx2)
				);
			}
			return rowText;
		};
	}

	get mouseActive(): boolean {
		return this.#mouseActive;
	}

	get selection(): { start: number; end: number } | null {
		return this.#selection;
	}

	setMouseActive(active: boolean): void {
		if (this.#mouseActive === active) return;
		this.#mouseActive = active;
		this.#selection = null;
		this.#isDragging = false;
		this.#updateTopBadge();
		this.#tui.requestRender();
	}

	toggleMouseMode(): void {
		this.setMouseActive(!this.#mouseActive);
	}

	#updateTopBadge(): void {
		if (this.#mouseActive) {
			const badge = " \x1b[1;36m[MOUSE 🖱️]\x1b[0m ";
			this.setTopBorder({
				content: badge,
				width: visibleWidth(badge),
			});
		} else {
			this.setTopBorder(undefined);
		}
	}

	/**
	 * Takes priority before TUI-wide input listeners (such as inputController.#handleInlineMouse).
	 * Reserving SGR mouse events when mouseActive is true ensures mouse clicks route to this editor.
	 */
	override capturesInput(data: string): boolean {
		if (this.#mouseActive && data.startsWith("\x1b[<")) {
			return true;
		}
		return false;
	}

	#getHitOffset(screenRow: number, screenCol: number): number {
		const totalRows = this.#tui.terminal.rows;
		const rendered = this.render(this.#tui.terminal.columns);
		const editorBoxHeight = rendered.length;
		const editorStartRow = Math.max(0, totalRows - editorBoxHeight);

		const contentRow = screenRow - (editorStartRow + 1);
		const textCol = Math.max(0, screenCol - 3);

		const lines = this.getLines();
		const targetLine = Math.max(0, Math.min(lines.length - 1, contentRow));
		let docOffset = 0;
		for (let i = 0; i < targetLine; i++) {
			docOffset += (lines[i]?.length ?? 0) + 1;
		}
		const lineLength = lines[targetLine]?.length ?? 0;
		docOffset += Math.max(0, Math.min(lineLength, textCol));
		const text = this.getText();
		this.#editBuffer = new EditBuffer(text, { services: hostTextServices });
		return this.#editBuffer.snapToBoundary(docOffset, "closest");
	}

	#handleSgrMouse(event: SgrMouseEvent): void {
		if (event.leftClick) {
			const now = Date.now();
			const hit = this.#getHitOffset(event.row, event.col);
			if (now - this.#lastClickTime <= 500 && hit === this.#lastClickOffset) {
				this.#clickCount = (this.#clickCount % 3) + 1;
			} else {
				this.#clickCount = 1;
			}
			this.#lastClickTime = now;
			this.#lastClickOffset = hit;

			if (this.#clickCount === 1) {
				this.#selection = null;
				this.#isDragging = true;
				this.applyHostEdit({
					from: 0,
					to: 0,
					text: "",
					cursor: hit,
					len: this.getText().length,
				});
			} else if (this.#clickCount === 2) {
				const range = getWordRangeAt(this.getText(), hit, hostTextServices);
				this.#selection = range;
				this.#isDragging = true;
			} else if (this.#clickCount === 3) {
				const range = getLineRangeAt(this.getText(), hit);
				this.#selection = range;
				this.#isDragging = true;
			}
			this.#tui.requestRender();
			return;
		}

		if (event.motion && (event.button & 3) === 0 && this.#isDragging) {
			const hit = this.#getHitOffset(event.row, event.col);
			const anchor = this.#lastClickOffset;
			if (hit !== anchor) {
				this.#selection = {
					start: Math.min(anchor, hit),
					end: Math.max(anchor, hit),
				};
			} else {
				this.#selection = null;
			}
			this.#tui.requestRender();
			return;
		}

		if (event.release) {
			this.#isDragging = false;
			this.#tui.requestRender();
			return;
		}
	}

	override handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			const event = parseSgrMouse(data);
			if (event) {
				this.#handleSgrMouse(event);
				return;
			}
		}

		// Alt+E toggles mouse mode
		if (matchesKey(data, "alt+e")) {
			this.toggleMouseMode();
			return;
		}

		if (this.#mouseActive) {
			// Esc or Ctrl+Q exits mouse mode
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+q")) {
				this.setMouseActive(false);
				return;
			}

			// Backspace / Delete over selection
			if (
				this.#selection !== null &&
				(matchesKey(data, "backspace") || matchesKey(data, "delete"))
			) {
				const sel = this.#selection;
				this.#selection = null;
				this.applyHostEdit({
					from: sel.start,
					to: sel.end,
					text: "",
					cursor: sel.start,
					len: this.getText().length,
				});
				this.#tui.requestRender();
				return;
			}

			// Copy selection on Ctrl+C
			if (this.#selection !== null && matchesKey(data, "ctrl+c")) {
				const text = this.getText().slice(this.#selection.start, this.#selection.end);
				copyToClipboard(text).catch(() => {});
				return;
			}

			// Replace selection on printable input
			if (this.#selection !== null) {
				const printable = extractPrintableText(data);
				if (printable) {
					const sel = this.#selection;
					this.#selection = null;
					this.applyHostEdit({
						from: sel.start,
						to: sel.end,
						text: printable,
						cursor: sel.start + printable.length,
						len: this.getText().length,
					});
					this.#tui.requestRender();
					return;
				}
			}
		}

		super.handleInput(data);
	}
}
