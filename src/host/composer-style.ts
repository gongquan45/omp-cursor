import {
	getComposerStyle,
	isBuiltinComposerStyle,
} from "@oh-my-pi/pi-tui/components/composer/registry";
import type {
	ComposerBox,
	ComposerChromeContext,
	ComposerStyle,
} from "@oh-my-pi/pi-tui/components/composer/types";
import { visibleWidth } from "@oh-my-pi/pi-tui";

const DEFAULT_ROUND_BOX: ComposerBox = {
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	horizontal: "─",
	vertical: "│",
};

export interface NativeComposerChrome {
	style: ComposerStyle;
	paddingX: number;
	topLine?: string;
	bottomLine?: string;
}

/**
 * Builds native OMP composer chrome (top line, borders, bottom line) using
 * the official pi-tui getComposerStyle registry and theme box definition.
 */
export function buildNativeComposerChrome(options: {
	shape?: string;
	width: number;
	themeBox?: ComposerBox;
	borderColor?: (str: string) => string;
	badgeText?: string;
}): NativeComposerChrome {
	const shape = options.shape || "box";
	const style = getComposerStyle(shape);
	const box = options.themeBox ?? DEFAULT_ROUND_BOX;
	const paddingX = style.defaultPaddingX(2);
	const borderColor = options.borderColor ?? ((s: string) => s);
	const accentColor = borderColor;
	const surfaceColor = (s: string) => s;

	const topBorder = options.badgeText
		? {
				content: options.badgeText,
				width: visibleWidth(options.badgeText),
			}
		: undefined;

	const chromeCtx: ComposerChromeContext = {
		width: options.width,
		paddingX,
		borderColor,
		accentColor,
		surfaceColor,
		box,
		topBorder,
	};

	const topLine = style.renderTop(chromeCtx);
	const defaultBottomLine = borderColor(
		`${box.bottomLeft}${box.horizontal.repeat(Math.max(0, options.width - 2))}${box.bottomRight}`,
	);
	const bottomLine = style.renderBottom?.(chromeCtx) ?? defaultBottomLine;

	return {
		style,
		paddingX,
		topLine,
		bottomLine,
	};
}
