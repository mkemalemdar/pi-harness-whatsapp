/**
 * "Remove everything": once the extension's data is deleted, nothing may write
 * files again in this Pi process (log, settings, recent chats, login, speech
 * files), or the cleanup would leave new leftovers. The flag lives on
 * globalThis so it also holds if Pi loads the extension again (/new, /reload).
 */

const state = globalThis as typeof globalThis & { __piHarnessWhatsAppRemoved?: boolean };

export function markRemoved(): void {
	state.__piHarnessWhatsAppRemoved = true;
}

/** True after "Remove everything" ran in this process: the extension stays inert. */
export function isRemoved(): boolean {
	return state.__piHarnessWhatsAppRemoved === true;
}
