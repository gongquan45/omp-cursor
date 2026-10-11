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
