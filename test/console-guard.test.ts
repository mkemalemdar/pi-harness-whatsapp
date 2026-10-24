import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
		assert.equal(calledFromLibsignal(fromLibsignal), true);
		assert.equal(calledFromLibsignal(fromElsewhere), false);
		assert.equal(calledFromLibsignal(undefined), false);
	});
});
