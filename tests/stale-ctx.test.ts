/**
 * Tests for deferred callbacks running against a stale ctx.
 *
 * Pi's extension runner invalidates a captured ctx the moment the session is
 * replaced or reloaded (newSession / fork / switchSession / reload). From then
 * on, merely *touching* `ctx.ui` or `ctx.isIdle` throws. Every callback we hand
 * to Pi — compact's onComplete/onError, our setImmediate resume — runs after
 * the event handler that registered it has already returned, so an exception
 * from one has no handler above it: it escapes into Pi's emit chain, the
 * process exits 1, and (for compaction) each resume re-triggers the same
 * crash. These tests pin the total-ness of those callbacks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piUltraCompact, { __resetModuleState } from "../extensions/index";

/** Verbatim shape of Pi's own invalidation error. */
const STALE_MESSAGE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or " +
	"command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For " +
	"newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx " +
	"passed to withSession. For reload, do not use the old ctx after await ctx.reload().";

const staleError = () => new Error(STALE_MESSAGE);

/** Let queued setImmediate callbacks run. */
function flushImmediate(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

const TOOL_CALL = { type: "toolCall", id: "t1", name: "bash", arguments: {} };

/** An assistant message as Pi's agent loop reports it. */
const assistant = (stopReason: string, content: unknown[] = []) => ({
	role: "assistant",
	stopReason,
	content,
	usage: { totalTokens: 200000 },
});

/**
 * A ctx that is live while the event handler runs and can be flipped stale
 * afterwards — the real ordering. `ui` and `isIdle` are getters that throw on
 * access, not methods that throw on call, because that is what Pi does.
 */
function makeCtx(opts: { stale?: boolean; notifyThrows?: boolean } = {}) {
	const state = { stale: opts.stale ?? false, notifyThrows: opts.notifyThrows ?? false };
	const notify = vi.fn(() => {
		if (state.notifyThrows) throw staleError();
	});
	const compactCalls: Array<{
		onComplete?: () => void;
		onError?: (error: Error) => void;
	}> = [];

	const ctx: Record<string, any> = {
		model: { id: "test-model", contextWindow: 262144 },
		getContextUsage: () => ({ tokens: 200000, contextWindow: 262144, percent: 76 }),
		compact: vi.fn((options: (typeof compactCalls)[number]) => {
			compactCalls.push(options);
		}),
		compactCalls,
		notify,
		goStale() {
			state.stale = true;
		},
	};

	Object.defineProperty(ctx, "ui", {
		get() {
			if (state.stale) throw staleError();
			return { notify };
		},
	});
	Object.defineProperty(ctx, "isIdle", {
		get() {
			if (state.stale) throw staleError();
			return () => true;
		},
	});

	return ctx;
}

/** A ctx whose `ui` is simply absent (older Pi, or a non-UI context). */
function makeUiLessCtx() {
	const compactCalls: Array<{
		onComplete?: () => void;
		onError?: (error: Error) => void;
	}> = [];
	const ctx: any = {
		model: { id: "test-model", contextWindow: 262144 },
		getContextUsage: () => ({ tokens: 200000, contextWindow: 262144, percent: 76 }),
		compact: vi.fn((options: (typeof compactCalls)[number]) => {
			compactCalls.push(options);
		}),
		compactCalls,
		isIdle: () => true,
	};
	return ctx;
}

function wire(piOverrides: Record<string, any> = {}) {
	const handlers = new Map<string, Function>();
	const sendUserMessage = vi.fn();
	const pi: Record<string, any> = {
		registerCommand: vi.fn(),
		sendUserMessage,
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
		...piOverrides,
	};
	piUltraCompact(pi, {
		autoCompact: true,
		preemptiveWatermark: 0.7,
		hardWatermark: 0.5,
	});
	return {
		handlers,
		sendUserMessage,
		commandHandler: pi.registerCommand.mock.calls[0][1].handler as (
			args: any,
			ctx: any,
		) => void,
	};
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	__resetModuleState();
	consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	consoleError.mockRestore();
});

// ─── /ultracompact command callbacks ──────────────────────────────

describe("/ultracompact callbacks on a stale ctx", () => {
	it("swallows a stale-ctx throw from onComplete", () => {
		const { commandHandler } = wire();
		const ctx = makeCtx({ stale: true });

		expect(() => commandHandler({}, ctx)).not.toThrow();
		expect(ctx.compactCalls).toHaveLength(1);
		expect(() => ctx.compactCalls[0].onComplete?.()).not.toThrow();
	});

	it("swallows a stale-ctx throw from onError and still reports the failure", () => {
		const { commandHandler } = wire();
		const ctx = makeCtx({ stale: true });

		commandHandler({}, ctx);

		expect(() => ctx.compactCalls[0].onError?.(new Error("compaction timed out"))).not.toThrow();
		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining("compaction timed out"),
		);
	});

	it("survives a ctx that goes stale between the command and its callbacks", () => {
		const { commandHandler } = wire();
		const ctx = makeCtx();

		commandHandler({}, ctx);
		expect(ctx.notify).toHaveBeenCalledWith("Starting Ultra-compact compaction...", "info");

		ctx.goStale();

		expect(() => ctx.compactCalls[0].onComplete?.()).not.toThrow();
		expect(() => ctx.compactCalls[0].onError?.(new Error("timeout"))).not.toThrow();
	});

	it("survives ui.notify itself throwing", () => {
		const { commandHandler } = wire();
		const ctx = makeCtx({ notifyThrows: true });

		expect(() => commandHandler({}, ctx)).not.toThrow();
		expect(() => ctx.compactCalls[0].onComplete?.()).not.toThrow();
		expect(() => ctx.compactCalls[0].onError?.(new Error("boom"))).not.toThrow();
		// The error still reaches the operator, just not through the UI.
		expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("boom"));
	});

	it("treats an onError payload that is not an Error as a message", () => {
		const { commandHandler } = wire();
		const ctx = makeCtx({ stale: true });

		commandHandler({}, ctx);

		expect(() => ctx.compactCalls[0].onError?.("provider exploded" as any)).not.toThrow();
		expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("provider exploded"));
	});
});

// ─── notify fallbacks with a live ctx ─────────────────────────────

describe("notify keeps its behaviour on a fresh ctx", () => {
	it("notifies through ctx.ui.notify for every level", () => {
		const { commandHandler } = wire();
		const ctx = makeCtx();

		commandHandler({}, ctx);
		ctx.compactCalls[0].onComplete?.();
		ctx.compactCalls[0].onError?.(new Error("kaboom"));

		expect(ctx.notify).toHaveBeenCalledWith("Starting Ultra-compact compaction...", "info");
		expect(ctx.notify).toHaveBeenCalledWith("Ultra-compact compaction complete!", "info");
		expect(ctx.notify).toHaveBeenCalledWith(
			expect.stringContaining("kaboom"),
			"error",
		);
		expect(consoleError).not.toHaveBeenCalled();
	});

	it("falls back to console.error for errors when ctx.ui is missing", () => {
		const { commandHandler } = wire();
		const ctx = makeUiLessCtx();

		expect(() => commandHandler({}, ctx)).not.toThrow();
		expect(() => ctx.compactCalls[0].onError?.(new Error("no ui here"))).not.toThrow();

		expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("no ui here"));
	});

	it("stays silent for non-error levels when ctx.ui is missing", () => {
		const { commandHandler } = wire();
		const ctx = makeUiLessCtx();

		expect(() => commandHandler({}, ctx)).not.toThrow();
		expect(() => ctx.compactCalls[0].onComplete?.()).not.toThrow();
		expect(consoleError).not.toHaveBeenCalled();
	});
});

// ─── auto-compaction path ─────────────────────────────────────────

describe("auto-compaction with a stale ctx", () => {
	it("still triggers compaction and never throws when agent_end's ctx is stale", async () => {
		const { handlers, sendUserMessage } = wire();
		const ctx = makeCtx({ stale: true });

		expect(() =>
			handlers.get("agent_end")?.({ messages: [assistant("toolUse", [TOOL_CALL])] }, ctx),
		).not.toThrow();

		expect(ctx.compactCalls).toHaveLength(1);
		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("swallows a stale-ctx throw from the auto onComplete", async () => {
		const { handlers, sendUserMessage } = wire();
		const ctx = makeCtx({ stale: true });

		await handlers.get("agent_end")?.({ messages: [assistant("toolUse", [TOOL_CALL])] }, ctx);

		expect(() => ctx.compactCalls[0].onComplete?.()).not.toThrow();
		await flushImmediate();
		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("swallows a stale-ctx throw from the deferred resume after onComplete", async () => {
		// The exact headless failure: compaction ran against a live ctx, the
		// session was replaced while it was in flight, and the resume then
		// touched the dead ctx from a setImmediate.
		const { handlers, sendUserMessage } = wire();
		const ctx = makeCtx();

		await handlers.get("agent_end")?.({ messages: [assistant("toolUse", [TOOL_CALL])] }, ctx);
		ctx.goStale();
		ctx.compactCalls[0].onComplete?.();

		await expect(flushImmediate()).resolves.not.toThrow();
		expect(sendUserMessage).not.toHaveBeenCalled();
		expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("stale"));
	});

	it("swallows a throw from pi.sendUserMessage in the deferred resume", async () => {
		const sendUserMessage = vi.fn(() => {
			throw new Error("Agent is already processing");
		});
		const { handlers } = wire({ sendUserMessage });
		const ctx = makeCtx();

		await handlers.get("agent_end")?.({ messages: [assistant("toolUse", [TOOL_CALL])] }, ctx);
		ctx.compactCalls[0].onComplete?.();

		await expect(flushImmediate()).resolves.not.toThrow();
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		// The ctx is still live, so the failure reaches the operator in the UI
		// instead of on stderr.
		expect(ctx.notify).toHaveBeenCalledWith(
			expect.stringContaining("Agent is already processing"),
			"error",
		);
		expect(consoleError).not.toHaveBeenCalled();
	});

	it("releases the in-flight flag when a stale onError cannot notify", async () => {
		// A stuck `autoCompactionInFlight` would disable auto-compaction for
		// the rest of the session, so the onError path must reset it even
		// when the notification itself blows up.
		const { handlers } = wire();
		const staleCtx = makeCtx({ stale: true });
		const freshCtx = makeCtx();

		await handlers.get("agent_end")?.({ messages: [assistant("error")] }, staleCtx);
		expect(staleCtx.compactCalls).toHaveLength(1);
		expect(() => staleCtx.compactCalls[0].onError?.(new Error("timeout"))).not.toThrow();

		// Burn the 8-round auto-cooldown; the next round must be able to fire.
		for (let i = 0; i < 8; i++) {
			await handlers.get("agent_end")?.({ messages: [assistant("stop")] }, freshCtx);
		}

		expect(freshCtx.compactCalls).toHaveLength(1);
	});

	it("still resumes a fresh ctx after auto-compaction", async () => {
		const { handlers, sendUserMessage } = wire();
		const ctx = makeCtx();

		await handlers.get("agent_end")?.({ messages: [assistant("toolUse", [TOOL_CALL])] }, ctx);
		ctx.compactCalls[0].onComplete?.();
		await flushImmediate();

		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		expect(sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("Continue with the current task"),
		);
		expect(ctx.notify).toHaveBeenCalledWith(
			"Ultra-compact auto-compaction complete!",
			"info",
		);
		expect(consoleError).not.toHaveBeenCalled();
	});
});
