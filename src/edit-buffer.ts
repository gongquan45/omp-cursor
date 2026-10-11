import { EditBuffer as CoreEditBuffer } from "./core/edit-buffer";
import { hostTextServices } from "./host/text-services";
import type { EditBufferOptions } from "./core/types";

export * from "./core/types";
export * from "./core/edit-buffer";

export class EditBuffer extends CoreEditBuffer {
	constructor(initialText: string, options?: EditBufferOptions) {
		super(initialText, {
			...options,
			services: { ...hostTextServices, ...options?.services },
		});
	}
}
