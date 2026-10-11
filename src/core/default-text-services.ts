import type { TextServices, WordNavKind } from "./types";

const REENCODED_CTRL_CSI_U = /\x1b\[(\d+);5u/g;
const REENCODED_CTRL_XTERM = /\x1b\[27;5;(\d+)~/g;

function decodeReencodedCtrlByte(match: string, code: string): string {
	const cp = Number(code);
	if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
	if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
	return match;
}

export function defaultDecodeReencodedPasteControls(text: string): string {
	return text
		.replace(REENCODED_CTRL_CSI_U, decodeReencodedCtrlByte)
		.replace(REENCODED_CTRL_XTERM, decodeReencodedCtrlByte);
}

export function defaultReplaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

export function defaultGetWordNavKind(segment: string): WordNavKind {
	if (!segment) return "other";
	if (/^\s+$/u.test(segment)) return "whitespace";
	if (/^[\p{P}\p{S}]+$/u.test(segment)) return "delimiter";
	if (
		/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u.test(
			segment,
		)
	) {
		return "cjk";
	}
	if (/^[\p{L}\p{M}\p{N}_]+$/u.test(segment)) return "word";
	return "other";
}

export const defaultTextServices: TextServices = {
	visibleWidth: (str: string): number => {
		let width = 0;
		for (const ch of str) {
			const cp = ch.codePointAt(0) ?? 0;
			if (
				(cp >= 0x4e00 && cp <= 0x9fff) ||
				(cp >= 0x3400 && cp <= 0x4dbf) ||
				(cp >= 0x20000 && cp <= 0x2fa1f) ||
				(cp >= 0x1f300 && cp <= 0x1f9ff)
			) {
				width += 2;
			} else {
				width += 1;
			}
		}
		return width;
	},
	getWordNavKind: defaultGetWordNavKind,
	moveWordLeft: (text: string, cursor: number): number => {
		const len = text.length;
		if (len === 0) return 0;
		let i = Math.min(Math.max(cursor, 0), len);
		if (i === 0) return 0;
		const segmenter = new Intl.Segmenter();
		const graphemes = [...segmenter.segment(text.slice(0, i))];
		if (graphemes.length === 0) return 0;

		while (
			graphemes.length > 0 &&
			defaultGetWordNavKind(graphemes[graphemes.length - 1]?.segment ?? "") === "whitespace"
		) {
			i -= graphemes.pop()?.segment.length ?? 0;
		}
		if (i === 0 || graphemes.length === 0) return i;

		const kind = defaultGetWordNavKind(graphemes[graphemes.length - 1]?.segment ?? "");
		while (
			graphemes.length > 0 &&
			defaultGetWordNavKind(graphemes[graphemes.length - 1]?.segment ?? "") === kind
		) {
			i -= graphemes.pop()?.segment.length ?? 0;
		}
		return i;
	},
	moveWordRight: (text: string, cursor: number): number => {
		const len = text.length;
		if (len === 0) return 0;
		let i = Math.min(Math.max(cursor, 0), len);
		if (i >= len) return len;
		const segmenter = new Intl.Segmenter();
		const graphemes = [...segmenter.segment(text.slice(i))];
		if (graphemes.length === 0) return i;

		let idx = 0;
		while (
			idx < graphemes.length &&
			defaultGetWordNavKind(graphemes[idx]?.segment ?? "") === "whitespace"
		) {
			i += graphemes[idx]?.segment.length ?? 0;
			idx++;
		}
		if (idx >= graphemes.length) return i;

		const kind = defaultGetWordNavKind(graphemes[idx]?.segment ?? "");
		while (
			idx < graphemes.length &&
			defaultGetWordNavKind(graphemes[idx]?.segment ?? "") === kind
		) {
			i += graphemes[idx]?.segment.length ?? 0;
			idx++;
		}
		return i;
	},
	replaceTabs: defaultReplaceTabs,
	decodeReencodedPasteControls: defaultDecodeReencodedPasteControls,
};

export function resolveTextServices(
	customServices?: Partial<TextServices>,
	fallback: TextServices = defaultTextServices,
): TextServices {
	if (!customServices) return fallback;
	return {
		visibleWidth: customServices.visibleWidth ?? fallback.visibleWidth,
		getWordNavKind: customServices.getWordNavKind ?? fallback.getWordNavKind,
		moveWordLeft: customServices.moveWordLeft ?? fallback.moveWordLeft,
		moveWordRight: customServices.moveWordRight ?? fallback.moveWordRight,
		replaceTabs: customServices.replaceTabs ?? fallback.replaceTabs,
		decodeReencodedPasteControls:
			customServices.decodeReencodedPasteControls ??
			fallback.decodeReencodedPasteControls,
	};
}
