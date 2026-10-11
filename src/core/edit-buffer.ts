import {
	defaultTextServices,
	resolveTextServices,
} from "./default-text-services";
import type {
	EditBufferOptions,
	SelectionRange,
	TextServices,
	TokenRange,
} from "./types";

const getSegmenter = () => new Intl.Segmenter();

interface HistoryEntry {
	text: string;
	caret: number;
	anchor: number;
}

/** Matches expanded image, video, and paste markers, including optional marker metadata. */
export const PLACEHOLDER_REGEX = /\[(Image|Video|Paste) #([1-9]\d*)(?:,[^\]\n]*)?\]/g;

/** Matches an expanded attachment marker, a compact attachment chip, or a skill chip. */
export const COMPOSER_TOKEN_REGEX =
	/\[(Image|Video|Paste) #([1-9]\d*)(?:,[^\]\n]*)?\]|(?:🖼||(?<![A-Za-z])\x69mg|🎞||(?<![A-Za-z])\x76id|📄||(?<![A-Za-z])\x74xt) #[1-9]\d*|(?:✦||(?<![A-Za-z])\x53K) ([\w-]+(?:\.[\w-]+)*(?:\/[\w-]+(?:\.[\w-]+)*)?)(?![\w-])/gu;

/**
 * Normalizes and sanitizes text for pasting:
 * 1. Normalize CRLF / CR -> LF
 * 2. Decode reencoded paste control sequences
 * 3. Replace tabs with spaces and strip C0 control chars except \n
 */
export function sanitizePasteText(
	text: string,
	services?: Partial<TextServices>,
): string {
	const svc = resolveTextServices(services);
	let normalized = text.replace(/\r\n?/g, "\n");
	normalized = svc.decodeReencodedPasteControls(normalized);
	normalized = svc
		.replaceTabs(normalized.replace(/\r\n?/g, "\n"))
		.replace(/[\x00-\x09\x0b-\x1f]/g, "");
	return normalized;
}

/**
 * Returns all token ranges matching COMPOSER_TOKEN_REGEX (images, videos, pastes, skills).
 */
export function getTokenRanges(text: string): TokenRange[] {
	if (!text) return [];
	const ranges: TokenRange[] = [];
	const re = new RegExp(COMPOSER_TOKEN_REGEX.source, COMPOSER_TOKEN_REGEX.flags);
	for (const match of text.matchAll(re)) {
		if (match.index !== undefined) {
			ranges.push({
				start: match.index,
				end: match.index + match[0].length,
				text: match[0],
			});
		}
	}
	return ranges;
}

/**
 * Returns word boundaries at the given offset.
 * Respects tokens (an atomic chip is selected as a single unit).
 */
export function getWordRangeAt(
	text: string,
	offset: number,
	services?: Partial<TextServices>,
): SelectionRange {
	if (text.length === 0) return { start: 0, end: 0 };
	const clamped = Math.max(0, Math.min(offset, text.length));

	// If offset falls within a token, the entire token is the word
	const tokens = getTokenRanges(text);
	for (const tok of tokens) {
		if (clamped >= tok.start && clamped <= tok.end) {
			return { start: tok.start, end: tok.end };
		}
	}

	const segmenter = getSegmenter();
	const graphemes = [...segmenter.segment(text)];
	if (graphemes.length === 0) return { start: 0, end: 0 };

	let targetIdx = graphemes.findIndex(
		g => clamped >= g.index && clamped < g.index + g.segment.length,
	);
	if (targetIdx === -1) {
		targetIdx = clamped >= text.length ? graphemes.length - 1 : 0;
	}

	const svc = resolveTextServices(services);
	const targetKind = svc.getWordNavKind(graphemes[targetIdx].segment);
	let startIdx = targetIdx;
	while (startIdx > 0 && svc.getWordNavKind(graphemes[startIdx - 1].segment) === targetKind) {
		startIdx--;
	}
	let endIdx = targetIdx;
	while (
		endIdx < graphemes.length - 1 &&
		svc.getWordNavKind(graphemes[endIdx + 1].segment) === targetKind
	) {
		endIdx++;
	}

	const start = graphemes[startIdx].index;
	const end = graphemes[endIdx].index + graphemes[endIdx].segment.length;
	return { start, end };
}

/**
 * Returns the line boundaries at the given offset.
 * Triple-click selects the entire logical line (including trailing newline if not the last line).
 */
export function getLineRangeAt(text: string, offset: number): SelectionRange {
	if (text.length === 0) return { start: 0, end: 0 };
	const clamped = Math.max(0, Math.min(offset, text.length));

	if (clamped === text.length && text.endsWith("\n")) {
		return { start: text.length, end: text.length };
	}

	const searchStart = clamped === text.length ? Math.max(0, clamped - 1) : clamped;
	const prevNl = text.lastIndexOf(
		"\n",
		searchStart > 0 && text[searchStart] === "\n" ? searchStart - 1 : searchStart,
	);
	const start = prevNl === -1 ? 0 : prevNl + 1;
	const nextNl = text.indexOf("\n", start);
	const end = nextNl === -1 ? text.length : nextNl + 1;
	return { start, end };
}

export class EditBuffer {
	#text: string;
	#caret: number;
	#anchor: number;
	#undoStack: HistoryEntry[] = [];
	#redoStack: HistoryEntry[] = [];
	#lastEditTime = 0;
	#lastEditKind: "insert" | "other" | null = null;
	#now: () => number;
	#services: TextServices;

	constructor(initialText: string, options?: EditBufferOptions) {
		this.#text = initialText;
		this.#caret = initialText.length;
		this.#anchor = this.#caret;
		this.#now = options?.now ?? (() => Date.now());
		this.#services = resolveTextServices(options?.services);
	}

	get text(): string {
		return this.#text;
	}

	get cursor(): number {
		return this.#caret;
	}

	get anchor(): number {
		return this.#anchor;
	}

	get selection(): SelectionRange | null {
		if (this.#anchor === this.#caret) return null;
		return {
			start: Math.min(this.#anchor, this.#caret),
			end: Math.max(this.#anchor, this.#caret),
		};
	}

	snapToBoundary(
		offset: number,
		direction: "left" | "right" | "closest" = "closest",
	): number {
		const len = this.#text.length;
		if (len === 0) return 0;
		const clamped = Math.max(0, Math.min(offset, len));

		const tokens = getTokenRanges(this.#text);
		for (const tok of tokens) {
			if (clamped > tok.start && clamped < tok.end) {
				if (direction === "left") return tok.start;
				if (direction === "right") return tok.end;
				return clamped - tok.start < tok.end - clamped ? tok.start : tok.end;
			}
		}

		const segmenter = getSegmenter();
		const graphemes = [...segmenter.segment(this.#text)];
		for (const g of graphemes) {
			const gStart = g.index;
			const gEnd = g.index + g.segment.length;
			if (clamped > gStart && clamped < gEnd) {
				if (direction === "left") return gStart;
				if (direction === "right") return gEnd;
				return clamped - gStart < gEnd - clamped ? gStart : gEnd;
			}
		}

		return clamped;
	}

	setCaret(offset: number, extend = false): void {
		const snapped = this.snapToBoundary(offset, "closest");
		this.#caret = snapped;
		if (!extend) {
			this.#anchor = snapped;
		}
	}

	select(start: number, end: number): void {
		const len = this.#text.length;
		let s = Math.max(0, Math.min(start, len));
		let e = Math.max(0, Math.min(end, len));

		const tokens = getTokenRanges(this.#text);
		if (s < e) {
			for (const tok of tokens) {
				if (s > tok.start && s < tok.end) s = tok.start;
				if (e > tok.start && e < tok.end) e = tok.end;
			}
		} else if (s > e) {
			for (const tok of tokens) {
				if (s > tok.start && s < tok.end) s = tok.end;
				if (e > tok.start && e < tok.end) e = tok.start;
			}
		}

		s = this.snapToBoundary(s, s < e ? "left" : "right");
		e = this.snapToBoundary(e, s < e ? "right" : "left");

		this.#anchor = s;
		this.#caret = e;
	}

	selectAll(): void {
		this.select(0, this.#text.length);
	}

	replaceSelection(insert: string): void {
		const now = this.#now();
		const sel = this.selection;

		const isTyping =
			sel === null &&
			insert.length > 0 &&
			insert.length <= 2 &&
			!insert.includes("\n") &&
			this.#lastEditKind === "insert" &&
			now - this.#lastEditTime < 500;

		if (!isTyping) {
			this.#undoStack.push({
				text: this.#text,
				caret: this.#caret,
				anchor: this.#anchor,
			});
			this.#redoStack.length = 0;
			this.#lastEditKind =
				sel === null && insert.length > 0 && insert.length <= 2 && !insert.includes("\n")
					? "insert"
					: "other";
		}
		this.#lastEditTime = now;

		if (sel !== null) {
			this.#text = this.#text.slice(0, sel.start) + insert + this.#text.slice(sel.end);
			this.#caret = sel.start + insert.length;
			this.#anchor = this.#caret;
		} else {
			this.#text = this.#text.slice(0, this.#caret) + insert + this.#text.slice(this.#caret);
			this.#caret = this.#caret + insert.length;
			this.#anchor = this.#caret;
		}
	}

	deleteBackward(): void {
		const sel = this.selection;
		if (sel !== null) {
			this.replaceSelection("");
			return;
		}

		if (this.#caret <= 0) return;

		this.#undoStack.push({
			text: this.#text,
			caret: this.#caret,
			anchor: this.#anchor,
		});
		this.#redoStack.length = 0;
		this.#lastEditKind = "other";
		this.#lastEditTime = this.#now();

		const tokens = getTokenRanges(this.#text);
		const prevToken = tokens.find(t => t.end === this.#caret);
		if (prevToken) {
			this.#text = this.#text.slice(0, prevToken.start) + this.#text.slice(this.#caret);
			this.#caret = prevToken.start;
			this.#anchor = this.#caret;
			return;
		}

		const prevBoundary = this.snapToBoundary(this.#caret - 1, "left");
		this.#text = this.#text.slice(0, prevBoundary) + this.#text.slice(this.#caret);
		this.#caret = prevBoundary;
		this.#anchor = this.#caret;
	}

	deleteForward(): void {
		const sel = this.selection;
		if (sel !== null) {
			this.replaceSelection("");
			return;
		}

		if (this.#caret >= this.#text.length) return;

		this.#undoStack.push({
			text: this.#text,
			caret: this.#caret,
			anchor: this.#anchor,
		});
		this.#redoStack.length = 0;
		this.#lastEditKind = "other";
		this.#lastEditTime = this.#now();

		const tokens = getTokenRanges(this.#text);
		const nextToken = tokens.find(t => t.start === this.#caret);
		if (nextToken) {
			this.#text = this.#text.slice(0, this.#caret) + this.#text.slice(nextToken.end);
			this.#anchor = this.#caret;
			return;
		}

		const nextBoundary = this.snapToBoundary(this.#caret + 1, "right");
		this.#text = this.#text.slice(0, this.#caret) + this.#text.slice(nextBoundary);
		this.#anchor = this.#caret;
	}

	undo(): boolean {
		if (this.#undoStack.length === 0) return false;
		const entry = this.#undoStack.pop()!;
		this.#redoStack.push({
			text: this.#text,
			caret: this.#caret,
			anchor: this.#anchor,
		});
		this.#text = entry.text;
		this.#caret = entry.caret;
		this.#anchor = entry.anchor;
		this.#lastEditKind = null;
		return true;
	}

	redo(): boolean {
		if (this.#redoStack.length === 0) return false;
		const entry = this.#redoStack.pop()!;
		this.#undoStack.push({
			text: this.#text,
			caret: this.#caret,
			anchor: this.#anchor,
		});
		this.#text = entry.text;
		this.#caret = entry.caret;
		this.#anchor = entry.anchor;
		this.#lastEditKind = null;
		return true;
	}

	moveWordLeft(extend = false): void {
		let target = this.#services.moveWordLeft(this.#text, this.#caret);
		const tokens = getTokenRanges(this.#text);
		for (const tok of tokens) {
			if (target > tok.start && target < tok.end) {
				target = tok.start;
				break;
			}
		}
		this.setCaret(target, extend);
	}

	moveWordRight(extend = false): void {
		let target = this.#services.moveWordRight(this.#text, this.#caret);
		const tokens = getTokenRanges(this.#text);
		for (const tok of tokens) {
			if (target > tok.start && target < tok.end) {
				target = tok.end;
				break;
			}
		}
		this.setCaret(target, extend);
	}
}
