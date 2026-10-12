import { describe, expect, it } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionCustomOptions,
	ExtensionUIContext,
	KeybindingsManager,
	Theme,
} from "@oh-my-pi/pi-coding-agent";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { TUI as PiTui } from "@oh-my-pi/pi-tui";
import { MinimalTerminal } from "./support/minimal-terminal";
import activate, { type ModalResult } from "../src/index";
import { MouseEditModal } from "../src/mouse-edit-modal";

describe("Extension Entrypoint (src/index.ts)", () => {
	it("registers the alt+e shortcut with description", () => {
		let registeredKey = "";
		let registeredDesc = "";
		let registeredHandler: ((ctx: ExtensionContext) => Promise<void> | void) | null = null;

		const stubApi = {
			registerShortcut: (
				shortcut: string,
				options: {
					description?: string;
					handler: (ctx: ExtensionContext) => Promise<void> | void;
				},
			) => {
				registeredKey = shortcut;
				registeredDesc = options.description ?? "";
				registeredHandler = options.handler;
			},
		} as unknown as ExtensionAPI;

		activate(stubApi);

		expect(registeredKey).toBe("alt+e");
		expect(registeredDesc.length > 0).toBe(true);
		expect(typeof registeredHandler).toBe("function");
	});

	it("exits cleanly in headless / no-UI environment", async () => {
		let registeredHandler: ((ctx: ExtensionContext) => Promise<void> | void) | null = null;
		const stubApi = {
			registerShortcut: (
				_shortcut: string,
				options: { handler: (ctx: ExtensionContext) => Promise<void> | void },
			) => {
				registeredHandler = options.handler;
			},
		} as unknown as ExtensionAPI;

		activate(stubApi);
		expect(registeredHandler).not.toBeNull();

		// Context without UI
		const noUiContext = {
			hasUI: false,
		} as unknown as ExtensionContext;

		await registeredHandler!(noUiContext);

		// Context with ui but without custom
		const partialUiContext = {
			hasUI: true,
			ui: {},
		} as unknown as ExtensionContext;

		await registeredHandler!(partialUiContext);
	});

	it("passes exact fullscreen overlay options and writes back on save", async () => {
		let registeredHandler: ((ctx: ExtensionContext) => Promise<void> | void) | null = null;
		const stubApi = {
			registerShortcut: (
				_shortcut: string,
				options: { handler: (ctx: ExtensionContext) => Promise<void> | void },
			) => {
				registeredHandler = options.handler;
			},
		} as unknown as ExtensionAPI;

		activate(stubApi);

		let editorText = "initial draft text";
		let receivedOptions: ExtensionCustomOptions | undefined;
		let modalResult: ModalResult | undefined;

		const term = new MinimalTerminal();
		const tui = new PiTui(term);

		const stubUi = {
			getEditorText: () => editorText,
			setEditorText: (text: string) => {
				editorText = text;
			},
			custom: async <T>(
				factory: (
					tui: TUI,
					theme: Theme,
					keybindings: KeybindingsManager,
					done: (result: T) => void,
				) => Component | Promise<Component>,
				options?: ExtensionCustomOptions,
			): Promise<T> => {
				receivedOptions = options;
				const { promise, resolve } = Promise.withResolvers<T>();
				const component = (await factory(
					tui as unknown as TUI,
					{} as Theme,
					{} as KeybindingsManager,
					res => {
						resolve(res);
					},
				)) as MouseEditModal;

				// Drive the component:
				component.render(80);
				// Add text
				component.buffer.replaceSelection(" added");
				// Press Esc to auto-save
				component.handleInput("\x1b");

				const result = await promise;
				modalResult = result as ModalResult;
				return result;
			},
		} as unknown as ExtensionUIContext;

		const stubContext = {
			hasUI: true,
			ui: stubUi,
			setInterval: () => 0,
			clearTimer: () => {},
		} as unknown as ExtensionContext;

		await registeredHandler!(stubContext);

		// Assert options matches plan
		expect(receivedOptions).toEqual({
			overlay: true,
			overlayOptions: {
				fullscreen: true,
				mouseTracking: true,
				anchor: "top-left",
				width: "100%",
				margin: 0,
			},
		});

		// Assert write-back occurred
		expect(editorText).toBe("initial draft text added");
		expect(modalResult).toEqual({
			saved: true,
			text: "initial draft text added",
		});
	});

	it("cancels without writing back on Ctrl+D", async () => {
		let registeredHandler: ((ctx: ExtensionContext) => Promise<void> | void) | null = null;
		const stubApi = {
			registerShortcut: (
				_shortcut: string,
				options: { handler: (ctx: ExtensionContext) => Promise<void> | void },
			) => {
				registeredHandler = options.handler;
			},
		} as unknown as ExtensionAPI;

		activate(stubApi);

		let editorText = "unchanged original";
		let setCalled = false;
		let modalResult: ModalResult | undefined;

		const term = new MinimalTerminal();
		const tui = new PiTui(term);

		const stubUi = {
			getEditorText: () => editorText,
			setEditorText: () => {
				setCalled = true;
			},
			custom: async <T>(
				factory: (
					tui: TUI,
					theme: Theme,
					keybindings: KeybindingsManager,
					done: (result: T) => void,
				) => Component | Promise<Component>,
			): Promise<T> => {
				const { promise, resolve } = Promise.withResolvers<T>();
				const component = (await factory(
					tui as unknown as TUI,
					{} as Theme,
					{} as KeybindingsManager,
					res => {
						resolve(res);
					},
				)) as MouseEditModal;

				component.render(80);
				component.handleInput("X");
				// Press Ctrl+D
				component.handleInput("\x04");

				const result = await promise;
				modalResult = result as ModalResult;
				return result;
			},
		} as unknown as ExtensionUIContext;

		const stubContext = {
			hasUI: true,
			ui: stubUi,
			setInterval: () => 0,
			clearTimer: () => {},
		} as unknown as ExtensionContext;

		await registeredHandler!(stubContext);

		expect(setCalled).toBe(false);
		expect(editorText).toBe("unchanged original");
		expect(modalResult).toEqual({ saved: false });
	});

	it("blocks save when background draft changes and sets error message", async () => {
		let registeredHandler: ((ctx: ExtensionContext) => Promise<void> | void) | null = null;
		const stubApi = {
			registerShortcut: (
				_shortcut: string,
				options: { handler: (ctx: ExtensionContext) => Promise<void> | void },
			) => {
				registeredHandler = options.handler;
			},
		} as unknown as ExtensionAPI;

		activate(stubApi);

		let editorText = "initial draft";
		let setCalled = false;
		let modalInstance: MouseEditModal | undefined;

		const term = new MinimalTerminal();
		const tui = new PiTui(term);

		const stubUi = {
			getEditorText: () => editorText,
			setEditorText: () => {
				setCalled = true;
			},
			custom: async <T>(
				factory: (
					tui: TUI,
					theme: Theme,
					keybindings: KeybindingsManager,
					done: (result: T) => void,
				) => Component | Promise<Component>,
			): Promise<T> => {
				const { promise, resolve } = Promise.withResolvers<T>();
				const component = (await factory(
					tui as unknown as TUI,
					{} as Theme,
					{} as KeybindingsManager,
					res => {
						resolve(res);
					},
				)) as MouseEditModal;
				modalInstance = component;

				component.render(80);
				component.buffer.replaceSelection(" edit in modal");

				// Background change happens!
				editorText = "background drift occurred";

				// User tries to save with Esc
				component.handleInput("\x1b");

				// User cancels with Ctrl+D after seeing error
				component.handleInput("\x04");

				const result = await promise;
				return result;
			},
		} as unknown as ExtensionUIContext;

		const stubContext = {
			hasUI: true,
			ui: stubUi,
			setInterval: () => 0,
			clearTimer: () => {},
		} as unknown as ExtensionContext;

		await registeredHandler!(stubContext);

		expect(setCalled).toBe(false);
		expect(editorText).toBe("background drift occurred");
		expect(modalInstance?.errorMessage).toBe("草稿在后台发生变化，未覆盖；按 Esc 退出");
	});

	it("extracts sessionManager entries and supplies formatted multi-turn context to modal", async () => {
		let registeredHandler: ((ctx: ExtensionContext) => Promise<void> | void) | null = null;
		const stubApi = {
			registerShortcut: (
				_shortcut: string,
				options: { handler: (ctx: ExtensionContext) => Promise<void> | void },
			) => {
				registeredHandler = options.handler;
			},
		} as unknown as ExtensionAPI;

		activate(stubApi);

		const term = new MinimalTerminal();
		const tui = new PiTui(term);
		let modalRenderedLines: readonly string[] = [];

		const stubUi = {
			getEditorText: () => "draft",
			setEditorText: () => {},
			custom: async <T>(
				factory: (
					tui: TUI,
					theme: Theme,
					keybindings: KeybindingsManager,
					done: (result: T) => void,
				) => Component | Promise<Component>,
			): Promise<T> => {
				const { promise, resolve } = Promise.withResolvers<T>();
				const component = (await factory(
					tui as unknown as TUI,
					{} as Theme,
					{} as KeybindingsManager,
					res => {
						resolve(res);
					},
				)) as MouseEditModal;

				modalRenderedLines = component.render(80);
				component.handleInput("\x1b");
				return await promise;
			},
		} as unknown as ExtensionUIContext;

		const stubSessionManager = {
			getEntries: () => [
				{
					type: "message",
					message: { role: "user", content: "How do I optimize code?" },
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Profile before optimizing." }],
					},
				},
			],
		};

		const stubContext = {
			hasUI: true,
			ui: stubUi,
			sessionManager: stubSessionManager,
			setInterval: () => 0,
			clearTimer: () => {},
		} as unknown as ExtensionContext;

		await registeredHandler!(stubContext);

		// Verify the rendered modal contains the multi-turn session context!
		expect(
			modalRenderedLines.some(l => l.includes("[You]: How do I optimize code?")),
		).toBe(true);
		expect(
			modalRenderedLines.some(l =>
				l.includes("[Assistant]: Profile before optimizing."),
			),
		).toBe(true);
	});
});
