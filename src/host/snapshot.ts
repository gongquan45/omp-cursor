import type { TUI } from "@oh-my-pi/pi-tui";

export interface ViewportSnapshot {
	lines: readonly string[];
	screenTop: number;
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
				const height = tui.terminal.rows;
				let screenTop = 0;
				if (paint.lines.length < height) {
					const viewport =
						typeof tui.getMutableViewport === "function"
							? tui.getMutableViewport()
							: { top: 0, length: 0 };
					screenTop = Math.max(0, viewport.top ?? 0);
				}
				return {
					lines: paint.lines,
					screenTop,
					altScreen: false,
				};
			}
		} catch {
			return undefined;
		}
	}
	return undefined;
}
