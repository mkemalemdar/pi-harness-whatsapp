/**
 * What to do when the WhatsApp socket closes. Pure so it can be tested.
 * Status codes are Baileys' DisconnectReason values.
 */

export const CODES = {
	connectionClosed: 428,
	connectionLost: 408,
	connectionReplaced: 440,
	loggedOut: 401,
	badSession: 500,
	restartRequired: 515,
	multideviceMismatch: 411,
	forbidden: 403,
	unavailableService: 503,
} as const;

export type CloseDecision =
	| { action: "reconnect"; delayMs: number }
	/** The login is gone: clear saved credentials and ask for a new QR scan. */
	| { action: "repair"; reason: string }
	/** Stop without retrying. */
	| { action: "stop"; reason: string };

export const INITIAL_DELAY_MS = 5_000;
export const MAX_DELAY_MS = 120_000;

export interface CloseContext {
	statusCode: number | undefined;
	/** Consecutive failed attempts so far (0 for the first retry). */
	attempt: number;
	/** We were showing a QR and never logged in. */
	pairing: boolean;
	/** 0..1, injectable for tests. */
	random?: () => number;
}

export function backoffDelay(attempt: number, random: () => number = Math.random): number {
	const base = Math.min(MAX_DELAY_MS, INITIAL_DELAY_MS * 2 ** attempt);
	// ±20% jitter so many clients don't reconnect in lockstep.
	return Math.round(base * (0.8 + random() * 0.4));
}

export function decideOnClose({ statusCode, attempt, pairing, random }: CloseContext): CloseDecision {
	switch (statusCode) {
		case CODES.restartRequired:
			// Normal right after scanning the QR: WhatsApp asks for a fresh connection.
			return { action: "reconnect", delayMs: 0 };
		case CODES.loggedOut:
			return { action: "repair", reason: "WhatsApp logged this device out" };
		case CODES.multideviceMismatch:
			return { action: "repair", reason: "the saved WhatsApp login is no longer valid" };
		case CODES.connectionReplaced:
			return { action: "stop", reason: "another WhatsApp Web session with this login took over" };
		case CODES.forbidden:
			return { action: "stop", reason: "WhatsApp refused the connection (403); the number may be restricted" };
	}
	if (pairing) {
		// The QR codes expired without a scan; wait for the user to ask again.
		return { action: "stop", reason: "the QR code expired without being scanned" };
	}
	return { action: "reconnect", delayMs: backoffDelay(attempt, random) };
}
