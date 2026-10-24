// Loads, checks and atomically saves config.json (the global settings), and tells listeners about changes. After
// "Remove everything" nothing is written.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defaultSettings, type GlobalSettings, isRecord, normalizeSettings } from "./core/settings.ts";
import { isRemoved } from "./removed.ts";

export type SettingsListener = (settings: Readonly<GlobalSettings>) => void;

/** Loads, validates and atomically saves config.json. */
export class SettingsStore {
	private settings: GlobalSettings = defaultSettings();
	private readonly listeners = new Set<SettingsListener>();
	/** The file is from a version without the voice switches (see Controller.migrateVoice). */
	private olderFile = false;

	private readonly filePath: string;

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	/** Reads the file. A corrupt file is kept as config.json.bad-<time> and replaced by defaults. */
	load(): Readonly<GlobalSettings> {
		this.olderFile = false;
		if (!existsSync(this.filePath)) {
			this.settings = defaultSettings();
			return this.settings;
		}
		try {
			const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
			this.olderFile = isRecord(raw) && !("voice" in raw);
			this.settings = normalizeSettings(raw);
		} catch {
			try {
				renameSync(this.filePath, `${this.filePath}.bad-${Date.now()}`);
			} catch {
				// Keeping a copy of the broken file is best-effort.
			}
			this.settings = defaultSettings();
		}
		return this.settings;
	}

	get(): Readonly<GlobalSettings> {
		return this.settings;
	}

	/** True when the loaded file was saved before voice became optional. */
	isFromOlderVersion(): boolean {
		return this.olderFile;
	}

	/**
	 * Applies a change, re-validates, saves and notifies listeners. Starts from
	 * the file on disk, so a change made by another Pi process isn't overwritten.
	 */
	update(change: (draft: GlobalSettings) => void): Readonly<GlobalSettings> {
		const draft = structuredClone(this.fromDisk() ?? this.settings);
		change(draft);
		this.settings = normalizeSettings(draft);
		this.save();
		for (const listener of this.listeners) listener(this.settings);
		return this.settings;
	}

	/** The saved settings, or undefined when there is no readable file. */
	private fromDisk(): GlobalSettings | undefined {
		try {
			return normalizeSettings(JSON.parse(readFileSync(this.filePath, "utf8")));
		} catch {
			return undefined;
		}
	}

	onChange(listener: SettingsListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private save(): void {
		if (isRemoved()) return;
		mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
		const temporary = `${this.filePath}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(this.settings, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporary, this.filePath);
	}
}

/** The last saved session state on the current branch, or `fallback` when there is none. */
