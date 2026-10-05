/**
 * Regression tests for summary construction with pi's real message shape.
 *
 * pi stores `message.content` as an ARRAY of blocks (`text`, `thinking`,
 * `toolCall`), not a plain string. Measured on a real session: 1414 of 1415
 * messages use the array form.
 *
 * Before the fix, three summary builders guarded on
 * `typeof m.content === "string"`, which is false for every array-content
 * message, so each rendered as an empty stub:
 *
 *   "[user]: "  "[assistant]: "  "[toolResult]: "
 *
 * In the MICRO branch the `summary.trim().length === 0` guard did not catch
 * it — the role labels and newlines make the string non-empty, so a
 * contentless summary was committed as if it were real. In the circuit-breaker
 * fallback, `.filter(Boolean)` dropped the empty lines outright, leaving only
 * the truncation marker.
 *
 * All three now go through `messageContent()`, which handles both shapes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import piUltraCompact, { __resetModuleState } from "../extensions/index";
import { UltraCompactEngine } from "../extensions/engine";
import { summaryHasContent } from "../extensions/utils";

/** Small window so a compact fixture still lands in a predictable tier band. */
const WIN = 1000;

/** pi-shaped message: content is an array of blocks. */
function arrayMessage(i: number, repeat: number) {
	return {
		id: `m${i}`,
		role: i % 2 ? "assistant" : "user",
		content: [
			{
				type: "text",
				text:
					`MARKER_${i}_ ` +
					"The quick brown fox jumps over the lazy dog. ".repeat(repeat),
			},
		],
		timestamp: 1,
	};
}

/** 4 x ~800 chars => ~720 est tokens => ratio 0.72 against WIN => MICRO. */
function microFixture() {
	return [0, 1, 2, 3].map((i) => arrayMessage(i, 18));
}

function drive(handler: Function | undefined, msgs: any[], tokensBefore: number) {
	return handler?.(
		{
			preparation: {
				tokensBefore,
				messagesToSummarize: msgs,
				firstKeptEntryId: "entry-1",
			},
		},
		{
			model: { id: "test-model", contextWindow: WIN },
			ui: { notify: vi.fn() },
		},
	);
}

function register(config: any = {}) {
	const handlers = new Map<string, Function>();
	piUltraCompact(
		{
			registerCommand: vi.fn(),
			on(event: string, fn: Function) {
				handlers.set(event, fn);
			},
		},
		config,
	);
	return handlers;
}

describe("MICRO summary preserves array-content messages", () => {
	beforeEach(() => {
		__resetModuleState();
		vi.restoreAllMocks();
	});

	it("fixture lands in the MICRO band", () => {
		const engine = new UltraCompactEngine({ contextWindow: WIN } as any);
		const msgs = microFixture() as any;
		const ratio = engine.estimateTokens(msgs) / WIN;
		// Self-validating: if the band assumption drifts this fails loudly
		// instead of silently testing the wrong branch.
		expect(ratio).toBeGreaterThanOrEqual(0.6);
		expect(ratio).toBeLessThan(0.9);
		expect(engine.determineTier(msgs)).toBe(1); // CompactionTier.MICRO
	});

	it("summary contains the real message text", async () => {
		const handlers = register();
		await handlers.get("session_start")?.(
			{ reason: "startup" },
			{ model: { id: "test-model", contextWindow: WIN } },
		);

		const result: any = await drive(
			handlers.get("session_before_compact"),
			microFixture(),
			700,
		);

		expect(result?.compaction).toBeDefined();
		const summary: string = result.compaction.summary;
		expect(summary).toContain("## Chat"); // confirms the MICRO branch ran
		for (let i = 0; i < 4; i++) {
			expect(summary).toContain(`MARKER_${i}_`);
		}
	});

	it("emits no empty role stubs", async () => {
		const handlers = register();
		await handlers.get("session_start")?.(
			{ reason: "startup" },
			{ model: { id: "test-model", contextWindow: WIN } },
		);

		const result: any = await drive(
			handlers.get("session_before_compact"),
			microFixture(),
			700,
		);

		const summary: string = result.compaction.summary;
		const emptyStubs = summary.split("\n").filter((l) => /^\[[^\]]+\]:\s*$/.test(l));
		expect(emptyStubs).toEqual([]);
	});

	it("still handles plain-string content", async () => {
		const handlers = register();
		await handlers.get("session_start")?.(
			{ reason: "startup" },
			{ model: { id: "test-model", contextWindow: WIN } },
		);

		const msgs = [0, 1, 2, 3].map((i) => ({
			id: `s${i}`,
			role: i % 2 ? "assistant" : "user",
			content: `PLAIN_${i}_ ` + "lorem ipsum dolor sit amet consectetur. ".repeat(28),
			timestamp: 1,
		}));

		const result: any = await drive(handlers.get("session_before_compact"), msgs as any, 700);

		const summary: string = result.compaction.summary;
		for (let i = 0; i < 4; i++) {
			expect(summary).toContain(`PLAIN_${i}_`);
		}
	});
});

describe("summaryHasContent — content-level guard", () => {
	it("rejects an empty or missing summary", () => {
		expect(summaryHasContent("")).toBe(false);
		expect(summaryHasContent("   \n  ")).toBe(false);
		expect(summaryHasContent(undefined)).toBe(false);
		expect(summaryHasContent(null)).toBe(false);
	});

	it("rejects bare role labels — the shape the old guard let through", () => {
		// 480 characters, non-empty by trim(), and says nothing.
		const stubs = ["[user]: ", "[assistant]: ", "[toolResult]: ", "[user]: "]
			.join("\n")
			.padEnd(480, " ");
		expect(stubs.trim().length).toBeGreaterThan(0);
		expect(summaryHasContent(stubs)).toBe(false);
	});

	it("rejects headers plus bare role labels (the exact MICRO bug shape)", () => {
		const buggy = ["## Chat", "[user]: ", "[assistant]: ", "[toolResult]: "].join("\n");
		expect(summaryHasContent(buggy)).toBe(false);
	});

	it("accepts a summary with real content", () => {
		expect(summaryHasContent("The user asked for X and we did Y.")).toBe(true);
		expect(
			summaryHasContent(
				"## Chat\n[user]: implement the parser\n[assistant]: done, tests green",
			),
		).toBe(true);
	});

	it("accepts a single meaningful line among scaffolding", () => {
		expect(
			summaryHasContent("## Goals\n[user]: \n[assistant]: \n- shipped stage 3 with 42 tests"),
		).toBe(true);
	});
});

describe("circuit-breaker lossy fallback preserves array-content messages", () => {
	beforeEach(() => {
		__resetModuleState();
		vi.restoreAllMocks();
	});

	it("keeps tail content instead of only the truncation marker", async () => {
		// Force the FULL branch and make it fail so the breaker trips on the
		// first failure and the lossy truncation runs.
		vi.spyOn(UltraCompactEngine.prototype, "generateSummary").mockRejectedValue(
			new Error("forced failure"),
		);

		const handlers = register({ circuitBreakerMaxFailures: 1 });
		await handlers.get("session_start")?.(
			{ reason: "startup" },
			{ model: { id: "test-model", contextWindow: WIN } },
		);

		// Small enough to sit below the MICRO band, so FULL is selected.
		const msgs = [10, 11, 12].map((i) => ({
			id: `t${i}`,
			role: "user" as const,
			content: [{ type: "text", text: `TAIL_${i}_ short and distinct` }],
			timestamp: 1,
		}));

		const result: any = await drive(handlers.get("session_before_compact"), msgs as any, 700);

		expect(result?.compaction).toBeDefined();
		expect(result.compaction.details.circuitBreakerEngaged).toBe(true);

		const summary: string = result.compaction.summary;
		expect(summary).toContain("circuit breaker engaged");
		// Before the fix `.filter(Boolean)` removed every empty line and the
		// summary was nothing but the marker above.
		for (const i of [10, 11, 12]) {
			expect(summary).toContain(`TAIL_${i}_`);
		}
	});
});
