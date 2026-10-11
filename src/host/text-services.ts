import {
	getWordNavKind as tuiGetWordNavKind,
	moveWordLeft as tuiMoveWordLeft,
	moveWordRight as tuiMoveWordRight,
	replaceTabs as tuiReplaceTabs,
	visibleWidth as tuiVisibleWidth,
} from "@oh-my-pi/pi-tui";
import { decodeReencodedPasteControls as tuiDecodeControls } from "@oh-my-pi/pi-tui/bracketed-paste";
import type { TextServices, WordNavKind } from "../core/types";

export const hostTextServices: TextServices = {
	visibleWidth: tuiVisibleWidth,
	getWordNavKind: tuiGetWordNavKind as (segment: string) => WordNavKind,
	moveWordLeft: tuiMoveWordLeft,
	moveWordRight: tuiMoveWordRight,
	replaceTabs: tuiReplaceTabs,
	decodeReencodedPasteControls: tuiDecodeControls,
};
