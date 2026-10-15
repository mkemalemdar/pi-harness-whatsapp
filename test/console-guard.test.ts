import { describe, expect, it } from "vitest";
import { calledFromLibsignal } from "../src/wa/console-guard.ts";

describe("calledFromLibsignal", () => {
	it("spots calls coming from libsignal and ignores everything else", () => {
		const fromLibsignal = [
			"Error",
			"    at console.info (/x/src/wa/console-guard.ts:30:10)",
			"    at SessionRecord.closeSession (/x/node_modules/libsignal/src/session_record.js:273:17)",
		].join("\n");
		const fromElsewhere = [
			"Error",
			"    at console.info (/x/src/wa/console-guard.ts:30:10)",
			"    at somethingElse (/x/node_modules/other-extension/index.js:1:1)",
		].join("\n");
		expect(calledFromLibsignal(fromLibsignal)).toBe(true);
		expect(calledFromLibsignal(fromElsewhere)).toBe(false);
		expect(calledFromLibsignal(undefined)).toBe(false);
	});
});
