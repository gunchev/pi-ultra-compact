import { afterEach, describe, expect, it, vi } from "vitest";
import piUltraCompact, { __resetModuleState, hadPendingWork } from "../extensions/index";

/** Let queued setImmediate callbacks run. */
function flushImmediate(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * ctx.compact() aborts the running agent and Pi never resumes the turn it
 * aborted, so a turn that was cut short has to be restarted by us. But most
 * agent_ends are a turn that finished normally, and nudging one invents a task
 * that is not there. These tests pin both halves: nudge when work was
 * outstanding, stay quiet when it was not, and never race a turn that is
 * already being driven.
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

	/** An assistant message as Pi's agent loop reports it. */
	const assistant = (stopReason: string, content: unknown[] = []) => ({
		role: "assistant",
		stopReason,
		content,
		usage: { totalTokens: 200000 },
	});

	const TOOL_CALL = { type: "toolCall", id: "t1", name: "bash", arguments: {} };

	const run = async (messages: unknown, isIdle = true) => {
		const { handlers, sendUserMessage } = wire();
		await handlers.get("agent_end")?.({ messages }, overWatermarkCtx(isIdle));
		await flushImmediate();
		return sendUserMessage;
	};

	it("nudges when a tool call was still outstanding", async () => {
		const sendUserMessage = await run([assistant("toolUse", [TOOL_CALL])]);

		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		expect(sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("Continue with the current task"),
		);
	});

	it("nudges when the response was truncated mid-generation", async () => {
		const sendUserMessage = await run([assistant("length")]);

		expect(sendUserMessage).toHaveBeenCalledTimes(1);
	});

	it("stays quiet after a turn that finished normally", async () => {
		// The case that produced the spurious nudge: the agent delivered its
		// answer, agent_end fired over the watermark, compaction ran, and the
		// follow-up woke it with nothing left to do.
		const sendUserMessage = await run([
			assistant("stop", [{ type: "text", text: "Review complete." }]),
		]);

		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("stays quiet when the operator aborted the turn", async () => {
		const sendUserMessage = await run([assistant("aborted")]);

		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("stays quiet after an errored response", async () => {
		const sendUserMessage = await run([assistant("error")]);

		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("stays quiet when there is no assistant message to judge", async () => {
		const sendUserMessage = await run([]);

		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("stays quiet when something already drives a turn", async () => {
		const sendUserMessage = await run([assistant("toolUse", [TOOL_CALL])], false);

		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("still compacts when the finished turn needs no nudge", async () => {
		// Suppressing the nudge must not suppress the compaction itself —
		// reclaiming context on an idle session is the whole trigger.
		let compacted = false;
		const handlers = new Map<string, Function>();
		const fakePi = {
			registerCommand: vi.fn(),
			sendUserMessage: vi.fn(),
			on(event: string, handler: Function) {
				handlers.set(event, handler);
			},
		};
		piUltraCompact(fakePi, {
			autoCompact: true,
			preemptiveWatermark: 0.7,
			hardWatermark: 0.5,
		});
		const ctx = overWatermarkCtx(true);
		ctx.compact = (opts: { onComplete?: () => void }) => {
			compacted = true;
			opts.onComplete?.();
		};

		await handlers.get("agent_end")?.({ messages: [assistant("stop")] }, ctx);
		await flushImmediate();

		expect(compacted).toBe(true);
		expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
	});
});

describe("hadPendingWork", () => {
	const a = (stopReason: string, content: unknown[] = []) => ({
		role: "assistant",
		stopReason,
		content,
	});
	const tool = { type: "toolCall", id: "t1", name: "bash", arguments: {} };

	it.each([
		["toolUse with a tool call", [a("toolUse", [tool])], true],
		["length", [a("length")], true],
		["stop with text", [a("stop", [{ type: "text", text: "done" }])], false],
		["stop with no content", [a("stop")], false],
		["aborted", [a("aborted", [tool])], false],
		["error", [a("error", [tool])], false],
		["no assistant message", [{ role: "user", content: "hi" }], false],
		["empty", [], false],
		["not an array", "nope", false],
		["undefined", undefined, false],
	])("%s -> %s", (_label, messages, expected) => {
		expect(hadPendingWork(messages)).toBe(expected);
	});

	it("judges the last assistant message, not an earlier one", () => {
		expect(hadPendingWork([a("toolUse", [tool]), a("stop", [{ type: "text" }])])).toBe(false);
		expect(hadPendingWork([a("stop"), a("toolUse", [tool])])).toBe(true);
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
