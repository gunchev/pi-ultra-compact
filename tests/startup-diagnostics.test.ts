/**
 * Startup diagnostics are opt-in.
 *
 * pi owns stdout for its TUI, so the effective-config dump added with the
 * settings.json loader must not print unconditionally — that is what
 * extension.test.ts's "does not write normal startup messages to stdout"
 * guards. These tests pin both halves: silent by default, and still reachable
 * via ULTRA_COMPACT_DEBUG when someone needs to see resolved config.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import piUltraCompact from "../extensions/index";

function fakePi() {
	return { registerCommand: vi.fn(), on: vi.fn() };
}

describe("ULTRA_COMPACT_DEBUG", () => {
	afterEach(() => {
		delete process.env.ULTRA_COMPACT_DEBUG;
		vi.restoreAllMocks();
	});

	it("dumps the effective config when the flag is set", () => {
		process.env.ULTRA_COMPACT_DEBUG = "1";
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		piUltraCompact(fakePi() as any);

		expect(log).toHaveBeenCalledTimes(1);
		const [label, payload] = log.mock.calls[0] as [string, string];
		expect(label).toBe("[ultra-compact] effective config:");
		expect(JSON.parse(payload)).toHaveProperty("autoCompact");
	});
});
