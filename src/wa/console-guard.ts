/**
 * libsignal (WhatsApp's encryption layer, used by Baileys) prints internal
 * session state — including key material — straight to the console with
 * console.info/warn/error. In Pi that tears up the terminal UI. This guard
 * drops console output that comes from libsignal and leaves everything else
 * alone. The content is never logged anywhere.
 */

import { createLogger } from "../log.ts";

const log = createLogger("console-guard");
const METHODS = ["log", "info", "warn", "error", "debug"] as const;
const SOURCE = /[\\/]libsignal[\\/]/;

const state = globalThis as typeof globalThis & { __piHarnessWhatsAppConsoleGuard?: boolean };

/** True when the console call is coming from libsignal's code. */
export function calledFromLibsignal(stack: string | undefined): boolean {
	if (!stack) return false;
	// Skip the first lines (Error + this guard) and look at the caller frames.
	return stack
		.split("\n")
		.slice(2)
		.some((frame) => SOURCE.test(frame));
}

/** Installs the guard once per process; safe to call many times. */
export function installConsoleGuard(): void {
	if (state.__piHarnessWhatsAppConsoleGuard) return;
	state.__piHarnessWhatsAppConsoleGuard = true;
	let dropped = 0;
	for (const method of METHODS) {
		const original = console[method].bind(console);
		console[method] = (...args: unknown[]) => {
			if (calledFromLibsignal(new Error().stack)) {
				dropped++;
				if (dropped === 1 || dropped % 100 === 0) log.debug(`hid ${dropped} console message(s) from libsignal`);
				return;
			}
			original(...args);
		};
	}
}
