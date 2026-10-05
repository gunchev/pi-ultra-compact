import { afterEach, describe, expect, it, vi } from "vitest";
import piUltraCompact, { __resetModuleState } from "../extensions/index";

/** Let queued setImmediate callbacks run. */
function flushImmediate(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * ctx.compact() aborts the running agent and Pi never resumes the turn it
 * aborted, so the auto trigger has to send a follow-up itself. These two
 * tests pin that contract: idle after compaction means nudge, busy means stay
 * quiet so a user-typed message is not raced.
 */
describe("auto-compaction follow-up", () => {
	afterEach(() => __resetModuleState());

	function wire() {
		const handlers = new Map<string, Function>();
		const sendUserMessage = vi.fn();
		const fakePi = {
			registerCommand: vi.fn(),
			sendUserMessage,
			on(event: string, handler: Function) {
				handlers.set(event, handler);
			},
		};
		piUltraCompact(fakePi, {
			autoCompact: true,
			preemptiveWatermark: 0.7,
			hardWatermark: 0.5,
		});
		return { handlers, sendUserMessage };
	}

	const overWatermarkCtx = (isIdle: boolean) => ({
		model: { id: "test-model", contextWindow: 262144 },
		ui: { notify: vi.fn() },
		getContextUsage: () => ({
			tokens: 200000,
			contextWindow: 262144,
			percent: 76.3,
		}),
		isIdle: () => isIdle,
		compact: (opts: { onComplete?: () => void }) => opts.onComplete?.(),
	});

	it("nudges the agent when compaction leaves it idle", async () => {
		const { handlers, sendUserMessage } = wire();

		await handlers.get("agent_end")?.({ messages: [] }, overWatermarkCtx(true));
		await flushImmediate();

		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		expect(sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("Continue with the current task"),
		);
	});

	it("stays quiet when something already drives a turn", async () => {
		const { handlers, sendUserMessage } = wire();

		await handlers.get("agent_end")?.({ messages: [] }, overWatermarkCtx(false));
		await flushImmediate();

		expect(sendUserMessage).not.toHaveBeenCalled();
	});
});

function makeMessage() {
	return {
		id: "message-1",
		role: "user",
		content: "Keep this conversation intact.",
		timestamp: Date.now(),
	};
}

describe("piUltraCompact extension", () => {
	it("uses ctx.model.contextWindow instead of the generic fallback", async () => {
		const handlers = new Map<string, Function>();
		const fakePi = {
			registerCommand: vi.fn(),
			on(event: string, handler: Function) {
				handlers.set(event, handler);
			},
		};

		piUltraCompact(fakePi);

		await handlers.get("session_start")?.(
			{ reason: "startup" },
			{
				model: {
					id: "gpt-5.5",
					contextWindow: 272000,
				},
			},
		);

		const result = await handlers.get("session_before_compact")?.(
			{
				preparation: {
					tokensBefore: 100000,
					messagesToSummarize: [makeMessage()],
					firstKeptEntryId: "entry-1",
				},
			},
			{
				model: {
					id: "gpt-5.5",
					contextWindow: 272000,
				},
				ui: { notify: vi.fn() },
			},
		);

		expect(result).toBeUndefined();
	});

	it("does not write normal startup messages to stdout", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const handlers = new Map<string, Function>();
		const fakePi = {
			registerCommand: vi.fn(),
			on(event: string, handler: Function) {
				handlers.set(event, handler);
			},
		};

		try {
			piUltraCompact(fakePi);
			await handlers.get("session_start")?.(
				{ reason: "startup" },
				{
					model: {
						id: "gpt-5.5",
						contextWindow: 272000,
					},
				},
			);

			expect(log).not.toHaveBeenCalled();
			expect(warn).not.toHaveBeenCalled();
			expect(error).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
			warn.mockRestore();
			error.mockRestore();
		}
	});
});
