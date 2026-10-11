import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	AssistantMessageCache,
	extractAssistantText,
} from "../src/host/message-cache";

describe("AssistantMessageCache", () => {
	it("extracts text while ignoring thinking blocks, tool calls, and attachments", () => {
		const message = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Internal reasoning details..." },
				{ type: "text", text: "Here is the first answer part. " },
				{ type: "tool_call", id: "call_1", name: "read", arguments: {} },
				{ type: "text", text: "And here is the conclusion." },
			],
		};

		const text = extractAssistantText(message);
		expect(text).toBe(
			"Here is the first answer part. And here is the conclusion.",
		);
	});

	it("returns null for non-assistant or pure tool-call turns", () => {
		// User message
		expect(
			extractAssistantText({
				role: "user",
				content: [{ type: "text", text: "hello" }],
			}),
		).toBeNull();

		// Pure tool execution turn
		expect(
			extractAssistantText({
				role: "assistant",
				content: [
					{ type: "tool_call", id: "c1", name: "bash", arguments: {} },
				],
			}),
		).toBeNull();

		// Malformed
		expect(extractAssistantText(null)).toBeNull();
		expect(extractAssistantText({})).toBeNull();
	});

	it("updates cache on text messages and preserves existing text on tool-only messages", () => {
		const cache = new AssistantMessageCache();
		expect(cache.lastText).toBeNull();

		// First response with text
		cache.updateFromMessage({
			role: "assistant",
			content: [{ type: "text", text: "First response text" }],
		});
		expect(cache.lastText).toBe("First response text");

		// Tool-only response should NOT clobber previous text
		const updated = cache.updateFromMessage({
			role: "assistant",
			content: [
				{ type: "tool_call", id: "t1", name: "edit", arguments: {} },
			],
		});
		expect(updated).toBe(false);
		expect(cache.lastText).toBe("First response text");

		// Second response with text updates cache
		cache.updateFromMessage({
			role: "assistant",
			content: [{ type: "text", text: "Second response text" }],
		});
		expect(cache.lastText).toBe("Second response text");
	});

	it("binds to ExtensionAPI events and clears on session switches/branches", () => {
		const handlers: Record<string, ((event: unknown) => void)[]> = {};
		const stubApi = {
			on: (event: string, handler: (e: unknown) => void) => {
				handlers[event] = handlers[event] || [];
				handlers[event].push(handler);
			},
		} as unknown as ExtensionAPI;

		const cache = new AssistantMessageCache();
		cache.bind(stubApi);

		expect(handlers["message_end"]?.length).toBe(1);
		expect(handlers["session_start"]?.length).toBe(1);
		expect(handlers["session_switch"]?.length).toBe(1);
		expect(handlers["session_branch"]?.length).toBe(1);

		// Trigger message_end
		handlers["message_end"]![0]!({
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Delivered via event" }],
			},
		});
		expect(cache.lastText).toBe("Delivered via event");

		// Trigger session_switch -> cache cleared
		handlers["session_switch"]![0]!({});
		expect(cache.lastText).toBeNull();
	});
});
