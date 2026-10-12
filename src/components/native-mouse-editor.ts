import { CustomEditor } from "@oh-my-pi/pi-coding-agent";
import { copyToClipboard } from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import type { KeybindingsManager } from "@oh-my-pi/pi-coding-agent";
import type {
	EditorTextDecorationContext,
	EditorTheme,
	EditorTopBorder,
	TUI,
} from "@oh-my-pi/pi-tui";
import {
	extractPrintableText,
	getSegmenter,
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
export type IndicatorDisplayMode = "icon" | "text" | "hidden";

export interface NativeMouseEditorOptions {
	indicatorDisplay?: IndicatorDisplayMode;
}

/**
 * Maps visual cell column offset within a logical line to a UTF-16 character offset.
 * Accurately steps through Unicode grapheme clusters taking visibleWidth (e.g. 2 for CJK/Emoji)
 * into account, preventing 2x velocity overshoot on wide characters.
 */
export function visualColToCharOffset(
	lineText: string,
	targetCol: number,
): number {
	if (targetCol <= 0 || lineText.length === 0) return 0;
	const segmenter = getSegmenter();
	let currentVisualCol = 0;
	for (const { segment, index } of segmenter.segment(lineText)) {
		const segWidth = visibleWidth(segment);
		if (targetCol < currentVisualCol + segWidth) {
			return targetCol < currentVisualCol + segWidth / 2
				? index
				: index + segment.length;
		}
		currentVisualCol += segWidth;
	}
	return lineText.length;
}
/**
 * Injects the mouse mode badge into the exact slot where OMP displays Vim status:
 * directly after the leading brand segment ("π") and separator, preceding the hostname.
 * e.g. " π > 🖥 Outerwall " -> " π > 🖱 > 🖥 Outerwall "
 */
export function injectBadgeIntoStatusLine(
	content: string,
	badgeStr: string,
): { content: string; widthDiff: number } {
	if (!badgeStr) return { content, widthDiff: 0 };

	const piIndex = content.indexOf("π");
	const searchStart = piIndex !== -1 ? piIndex + 1 : 0;
	const sub = content.slice(searchStart);

	const sepRegex =
		/((?:\x1b\[[0-9;]*m)*\s*[>›\u203a\u2039\u25b6\u25c0\u2595\u2506\ue0b0\ue0b1\ue0b2\ue0b3\ue0b6\ue0b7\|\/]\s*(?:\x1b\[[0-9;]*m)*\s*)/;
	const match = sub.match(sepRegex);

	if (match && match.index !== undefined) {
		const sep = match[0];
		const insertIdx = searchStart + match.index + sep.length;
		const before = content.slice(0, insertIdx);
		const after = content.slice(insertIdx);
		const nextSep = sep.startsWith(" ") ? sep : ` ${sep}`;
		const injected = `${before}${badgeStr}${nextSep}${after}`;
		const widthDiff = visibleWidth(injected) - visibleWidth(content);
		return { content: injected, widthDiff };
	}

	return { content, widthDiff: 0 };
}



export class NativeMouseEditor extends CustomEditor {
	readonly #tui: TUI;
	#mouseActive = false;
	#isDragging = false;
	#selection: { start: number; end: number } | null = null;
	#editBuffer: EditBuffer;
	#lastClickTime = 0;
	#lastClickOffset = -1;
	#clickCount = 0;
	#upstreamTopBorderProvider?: ((availableWidth: number) => EditorTopBorder | undefined) | undefined = undefined;
	#indicatorDisplay: IndicatorDisplayMode = "icon";

	constructor(
		tui: TUI,
		theme: EditorTheme,
		_keybindings?: KeybindingsManager,
		options?: NativeMouseEditorOptions,
	) {
		super(theme);
		this.#tui = tui;
		this.#indicatorDisplay = options?.indicatorDisplay ?? "icon";
		this.#editBuffer = new EditBuffer("", { services: hostTextServices });
		// Wrap setTopBorderProvider so [MOUSE 🖱️] dynamically prepends to the host StatusLine
		super.setTopBorderProvider((availableWidth: number) => {
			if (!this.isMouseEnabled || this.#indicatorDisplay === "hidden") {
				return this.#upstreamTopBorderProvider?.(availableWidth);
			}

			const badge =
				this.#indicatorDisplay === "text"
					? "\x1b[1;36m[MOUSE]\x1b[0m"
					: "\x1b[1;36m🖱\x1b[0m";
			const badgeWidth = visibleWidth(badge) + 3;
			const innerWidth = availableWidth - badgeWidth;

			// Narrow terminal safeguard: don't crowd status line if width is tight
			if (innerWidth < 10) {
				return this.#upstreamTopBorderProvider?.(availableWidth);
			}

			const base = this.#upstreamTopBorderProvider?.(innerWidth);
			if (!base) {
				const fallback = ` ${badge} `;
				return { content: fallback, width: visibleWidth(fallback) };
			}

			const { content: injectedContent, widthDiff } = injectBadgeIntoStatusLine(
				base.content,
				badge,
			);

			return {
				content: injectedContent,
				width: base.width + widthDiff,
			};
		});


		// Register selection decoration hook on CustomEditor
		this.decorateText = (rowText: string, ctx: EditorTextDecorationContext): string => {
			if (!this.isMouseEnabled || !this.#selection) return rowText;
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

	get isMouseEnabled(): boolean {
		if (this.vimEnabled) {
			return false;
		}
		return this.#mouseActive;
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
		this.#tui.requestRender();
	}

	toggleMouseMode(): boolean {
		if (this.vimEnabled) {
			return false;
		}
		this.setMouseActive(!this.#mouseActive);
		return this.#mouseActive;
	}

	get indicatorDisplay(): IndicatorDisplayMode {
		return this.#indicatorDisplay;
	}

	setIndicatorDisplay(mode: IndicatorDisplayMode): void {
		if (this.#indicatorDisplay === mode) return;
		this.#indicatorDisplay = mode;
		this.#tui.requestRender();
	}

	override setTopBorderProvider(
		provider: ((availableWidth: number) => EditorTopBorder | undefined) | undefined,
	): void {
		this.#upstreamTopBorderProvider = provider;
	}

	/**
	 * Takes priority before TUI-wide input listeners (such as inputController.#handleInlineMouse).
	 * Reserving SGR mouse events when mouseActive is true ensures mouse clicks route to this editor.
	 */
	override capturesInput(data: string): boolean {
		if (this.isMouseEnabled && data.startsWith("\x1b[<")) {
			const event = parseSgrMouse(data);
			if (event) {
				return this.#isRowInsideEditor(event.row);
			}
		}
		return false;
	}

	#getLine0ScreenRow(): number {
		if (typeof this.#tui.getMutableViewport === "function") {
			const vp = this.#tui.getMutableViewport();
			if (
				vp &&
				typeof vp.top === "number" &&
				typeof vp.length === "number" &&
				vp.length > 0
			) {
				const rendered = this.render(this.#tui.terminal.columns);
				const editorBoxHeight = rendered.length;
				return vp.top + vp.length - editorBoxHeight + 1;
			}
		}
		const paint =
			typeof this.#tui.getDebugPaint === "function"
				? this.#tui.getDebugPaint()
				: undefined;
		if (paint?.cursor && typeof paint.cursor.y === "number") {
			const cursor = this.getCursor();
			return paint.cursor.y - cursor.line;
		}
		const totalRows = this.#tui.terminal.rows;
		const rendered = this.render(this.#tui.terminal.columns);
		const editorBoxHeight = rendered.length;
		return Math.max(0, totalRows - editorBoxHeight + 1);
	}

	#isRowInsideEditor(row: number): boolean {
		const line0Row = this.#getLine0ScreenRow();
		const lines = this.getLines();
		return row >= line0Row && row < line0Row + lines.length;
	}

	#getHitOffset(screenRow: number, screenCol: number): number {
		const line0Row = this.#getLine0ScreenRow();
		const contentRow = screenRow - line0Row;
		const textCol = Math.max(0, screenCol - 3);

		const lines = this.getLines();
		const targetLine = Math.max(0, Math.min(lines.length - 1, contentRow));
		let docOffset = 0;
		for (let i = 0; i < targetLine; i++) {
			docOffset += (lines[i]?.length ?? 0) + 1;
		}
		const lineText = lines[targetLine] ?? "";
		docOffset += visualColToCharOffset(lineText, textCol);
		const text = this.getText();
		this.#editBuffer = new EditBuffer(text, { services: hostTextServices });
		return this.#editBuffer.snapToBoundary(docOffset, "closest");
	}

	#handleSgrMouse(event: SgrMouseEvent): void {
		if (event.leftClick) {
			if (!this.#isRowInsideEditor(event.row)) {
				return;
			}
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
		if (this.isMouseEnabled && data.startsWith("\x1b[<")) {
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

		if (this.isMouseEnabled) {
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
