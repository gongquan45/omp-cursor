import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * Extracts visible prose text from an AssistantMessage.
 *
 * In OMP / pi-ai, AssistantMessage.content is an array of typed content blocks
 * (text, thinking, tool_call, image, etc.). This helper joins all `text` blocks
 * while ignoring internal thinking blocks, tool calls, and binary attachments.
 * Returns null if no non-empty text block exists (e.g. pure tool execution turns).
 */
export function extractAssistantText(message: unknown): string | null {
	if (!message || typeof message !== "object") return null;
	const msg = message as { role?: string; content?: unknown };
	if (msg.role !== "assistant" || !Array.isArray(msg.content)) return null;

	const textParts: string[] = [];
	for (const block of msg.content) {
		if (
			block &&
			typeof block === "object" &&
			"type" in block &&
			block.type === "text" &&
			"text" in block &&
			typeof block.text === "string"
		) {
			textParts.push(block.text);
		}
	}

	const combined = textParts.join("").trim();
	return combined.length > 0 ? combined : null;
}

/**
 * Session-scoped cache holding the most recent Assistant text reply.
 *
 * Automatically updates when assistant messages complete with displayable text,
 * and clears on session switches/branches to prevent cross-session leakage.
 */
export class AssistantMessageCache {
	#lastText: string | null = null;

	get lastText(): string | null {
		return this.#lastText;
	}

	set lastText(value: string | null) {
		this.#lastText = value;
	}

	clear(): void {
		this.#lastText = null;
	}

	/**
	 * Updates cache if message contains displayable assistant prose.
	 * Returns true if cache was updated, false if message was ignored.
	 */
	updateFromMessage(message: unknown): boolean {
		const text = extractAssistantText(message);
		if (text !== null) {
			this.#lastText = text;
			return true;
		}
		return false;
	}

	/**
	 * Binds cache lifecycle to OMP ExtensionAPI events.
	 */
	bind(pi: ExtensionAPI): void {
		if (typeof pi?.on !== "function") return;
		pi.on("message_end", event => {
			if (event && "message" in event) {
				this.updateFromMessage(event.message);
			}
		});

		const reset = () => this.clear();
		pi.on("session_start", reset);
		pi.on("session_switch", reset);
		pi.on("session_branch", reset);
	}
}

export interface ChatTurn {
	role: "user" | "assistant";
	text: string;
}

/**
 * Extracts and formats a multi-turn conversation transcript from session entries.
 * Extracts user prompts and assistant text responses, preserving chronological flow.
 */
export function formatSessionTranscript(entries: unknown[]): string | null {
	if (!Array.isArray(entries) || entries.length === 0) return null;

	const turns: ChatTurn[] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as { type?: string; message?: unknown };
		if (e.type !== "message" || !e.message || typeof e.message !== "object") continue;

		const msg = e.message as { role?: string; content?: unknown };
		if (msg.role === "user") {
			let text = "";
			if (typeof msg.content === "string") {
				text = msg.content;
			} else if (Array.isArray(msg.content)) {
				for (const item of msg.content) {
					if (
						item &&
						typeof item === "object" &&
						"text" in item &&
						typeof item.text === "string"
					) {
						text += item.text;
					}
				}
			}
			const trimmed = text.trim();
			if (trimmed.length > 0) {
				turns.push({ role: "user", text: trimmed });
			}
		} else if (msg.role === "assistant") {
			const text = extractAssistantText(msg);
			if (text !== null) {
				turns.push({ role: "assistant", text });
			}
		}
	}

	if (turns.length === 0) return null;

	const formattedLines: string[] = [];
	for (const turn of turns) {
		if (turn.role === "user") {
			formattedLines.push(`[You]: ${turn.text}`);
		} else {
			formattedLines.push(`[Assistant]: ${turn.text}`);
		}
		formattedLines.push("");
	}

	return formattedLines.join("\n").trim();
}
