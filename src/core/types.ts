export interface SelectionRange {
	start: number;
	end: number;
}

export interface TokenRange {
	start: number;
	end: number;
	text: string;
}

export type WordNavKind = "whitespace" | "delimiter" | "cjk" | "word" | "other";

export interface TextServices {
	visibleWidth: (str: string) => number;
	getWordNavKind: (segment: string) => WordNavKind;
	moveWordLeft: (text: string, cursor: number) => number;
	moveWordRight: (text: string, cursor: number) => number;
	replaceTabs: (text: string) => string;
	decodeReencodedPasteControls: (text: string) => string;
}

export interface EditBufferOptions {
	now?: () => number;
	services?: Partial<TextServices>;
}
