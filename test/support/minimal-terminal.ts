import type { Terminal } from "@oh-my-pi/pi-tui";

export class MinimalTerminal implements Terminal {
	columns = 80;
	rows = 24;
	writes: string[] = [];
	onInput?: (data: string) => void;
	onResize?: () => void;
	onDisconnect?: () => void;

	get kittyProtocolActive(): boolean {
		return false;
	}

	get kittyEnableSequence(): string | null {
		return null;
	}

	get appearance(): "dark" | "light" | undefined {
		return "dark";
	}

	start(
		onInput: (data: string) => void,
		onResize: () => void,
		onDisconnect?: () => void,
	): void {
		this.onInput = onInput;
		this.onResize = onResize;
		this.onDisconnect = onDisconnect;
	}

	stop(): void {}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.writes.push(data);
	}

	hideCursor(): void {}

	showCursor(): void {}

	moveBy(_lines: number): void {}

	clearLine(): void {}

	clearFromCursor(): void {}

	clearScreen(): void {}

	setTitle(_title: string): void {}

	setProgress(_active: boolean): void {}

	onAppearanceChange(
		callback: (appearance: "dark" | "light") => void,
	): void {
		callback("dark");
	}

	sendInput(data: string): void {
		this.onInput?.(data);
	}
}
