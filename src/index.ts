import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { copyToClipboard } from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import { MouseEditModal } from "./mouse-edit-modal";
import { AssistantMessageCache } from "./host/message-cache";

export interface ModalResult {
	saved: boolean;
	text?: string;
}

export default function activate(pi: ExtensionAPI): void {
	const messageCache = new AssistantMessageCache();
	messageCache.bind(pi);

	pi.registerShortcut("alt+e", {
		description: "Open mouse-driven full-screen editor overlay for current draft",
		handler: async (ctx: ExtensionContext) => {
			if (!ctx.hasUI || !ctx.ui || typeof ctx.ui.custom !== "function") {
				return;
			}

			const original = ctx.ui.getEditorText();

			await ctx.ui.custom<ModalResult | undefined>(
				(tui, _theme, _keybindings, done) => {
					const modal = new MouseEditModal(tui, original, {
						contextReply: messageCache.lastText,
						onSave: (newText: string) => {
							const current = ctx.ui.getEditorText();
							if (current !== original) {
								modal.setErrorMessage("草稿在后台发生变化，未覆盖；按 Esc 退出");
								return false;
							}
							try {
								ctx.ui.setEditorText(newText);
								done({ saved: true, text: newText });
								return true;
							} catch (err: unknown) {
								const message = err instanceof Error ? err.message : String(err);
								modal.setErrorMessage(`保存失败: ${message}`);
								return false;
							}
						},
						onCancel: () => {
							done({ saved: false });
						},
						copy: async (text: string) => {
							await copyToClipboard(text);
						},
						setInterval: (callback: () => void, ms: number) => ctx.setInterval(callback, ms),
						clearTimer: (timer: unknown) => {
							// Forward to ctx.clearTimer, handling NodeJS.Timeout or number
							ctx.clearTimer(timer as Parameters<typeof ctx.clearTimer>[0]);
						},
						now: () => Date.now(),
					});
					return modal;
				},
				{
					overlay: true,
					overlayOptions: {
						fullscreen: true,
						mouseTracking: true,
						anchor: "top-left",
						width: "100%",
						margin: 0,
					},
				},
			);
		},
	});
}
