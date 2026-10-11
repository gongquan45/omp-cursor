import type { TUI } from "@oh-my-pi/pi-tui";

export interface ViewportSnapshot {
	lines: readonly string[];
	windowTop: number;
	altScreen?: boolean;
}

/**
 * Safely inspects the last viewport paint from the TUI host without throwing,
 * providing graceful degradation if OMP refactors or removes getDebugPaint.
 */
export function captureHostSnapshot(tui: TUI): ViewportSnapshot | undefined {
	if (typeof tui.getDebugPaint === "function") {
		try {
			const paint = tui.getDebugPaint();
			if (paint && Array.isArray(paint.lines) && paint.altScreen !== true) {
				return {
					lines: paint.lines,
					windowTop: paint.windowTop ?? 0,
					altScreen: false,
				};
			}
		} catch {
			return undefined;
		}
	}
	return undefined;
}
