/**
 * pi-ultra-compact
 *
 * Advanced compaction extension for Pi with:
 * - /ultracompact command for manual compaction
 * - Automatic threshold-based compaction
 * - Hierarchical summarization
 * - Critical context preservation
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { UltraCompactEngine } from "./engine";
import { messageContent, summaryHasContent } from "./utils";
import { EvictionLevel } from "./types";
import type { UltraCompactConfig } from "./types";

/** Track current model at runtime (updated by session_start and model_select events) */
let currentModel: { id?: string; contextWindow?: number } | undefined;
/** Circuit breaker state (module-level for __resetModuleState access) */
let compactionFailures = 0;
let breakerTrippedAtTurn: number | null = null;
let currentTurn = 0;
/** Proactive trigger state: prevents stacked/duplicate auto-compactions */
let autoCompactionInFlight = false;
let agentRounds = 0;
let lastAutoTriggerRound = -Infinity;

/** Default configuration — thresholdTokens omitted so engine auto-detects from model context window */
const DEFAULT_CONFIG: UltraCompactConfig = {
	keepPercentage: 0.3,
	maxKeepTokens: 30000,
	autoCompact: true,
};

/**
 * Pi calls extension factories with ONE argument (the API) — the package
 * settings block from settings.json never reaches `config`. Read it from
 * disk here so user watermarks (preemptiveWatermark/hardWatermark),
 * keepPercentage, maxKeepTokens, cacheAware and maxEvictionLevel actually
 * take effect.
 */
function loadUserSettings(): Partial<UltraCompactConfig> {
	try {
		const envDir = process.env.PI_CODING_AGENT_DIR;
		const agentDir = envDir ? envDir : join(homedir(), ".pi", "agent");
		const raw = readFileSync(join(agentDir, "settings.json"), "utf8");
		const settings = JSON.parse(raw) as Record<string, unknown>;
		const block = settings["pi-ultra-compact"];
		if (!block || typeof block !== "object") return {};
		const cfg = block as Record<string, unknown>;
		const out: Partial<UltraCompactConfig> = {};
		if (typeof cfg.autoCompact === "boolean") out.autoCompact = cfg.autoCompact;
		if (typeof cfg.cacheAware === "boolean") out.cacheAware = cfg.cacheAware;
		if (typeof cfg.keepPercentage === "number") out.keepPercentage = cfg.keepPercentage;
		if (typeof cfg.maxKeepTokens === "number") out.maxKeepTokens = cfg.maxKeepTokens;
		if (typeof cfg.preemptiveWatermark === "number") out.preemptiveWatermark = cfg.preemptiveWatermark;
		if (typeof cfg.hardWatermark === "number") out.hardWatermark = cfg.hardWatermark;
		if (typeof cfg.outputHeadroom === "number") out.outputHeadroom = cfg.outputHeadroom;
		if (typeof cfg.useLLM === "boolean") out.useLLM = cfg.useLLM;
		if (typeof cfg.thresholdTokens === "number") out.thresholdTokens = cfg.thresholdTokens;
		const eviction = sanitizeEvictionLevel(cfg.maxEvictionLevel);
		if (eviction !== undefined) out.maxEvictionLevel = eviction;
		return out;
	} catch {
		return {};
	}
}

/**
 * settings.json carries PI-NATIVE eviction names (e.g.
 * "SUMMARIZE_OLD_CONVERSATION"), not this extension's numeric enum — a
 * string against the `maxLevel >= EvictionLevel.X` comparisons silently
 * disabled eviction entirely. Map native names to the strongest extension
 * equivalent and drop unknown values.
 */
function sanitizeEvictionLevel(value: unknown): EvictionLevel | undefined {
	if (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= EvictionLevel.STRIP_REASONING &&
		value <= EvictionLevel.FULL_REMOVAL
	) {
		return value as EvictionLevel;
	}
	if (typeof value === "string") {
		const nativeMap: Record<string, EvictionLevel> = {
			SUMMARIZE_OLD_CONVERSATION: EvictionLevel.FULL_REMOVAL,
			STRIP_OLD_TOOL_OUTPUT: EvictionLevel.STRIP_ARTIFACTS,
			SUMMARIZE_OLD_TOOL_OUTPUT: EvictionLevel.STRIP_BULK_OUTPUT,
			KEEP_ALL: EvictionLevel.STRIP_REASONING,
		};
		if (value in nativeMap) return nativeMap[value];
	}
	return undefined;
}


function captureModel(model: any): void {
	if (!model) return;

	const id =
		typeof model === "string"
			? model
			: model.id || model.name || model.model || undefined;
	const contextWindow =
		typeof model === "object" && typeof model.contextWindow === "number"
			? model.contextWindow
			: undefined;

	if (id || contextWindow) {
		currentModel = { id, contextWindow };
	}
}

function notify(
	ctx: any,
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	if (typeof ctx?.ui?.notify === "function") {
		ctx.ui.notify(message, type);
	}
}

/**
 * Reconfigure the engine to match the current model before a compaction operation.
 * Ensures the threshold adapts even if the user changed models mid-session.
 */
function reconfigureEngineForCurrentModel(engine: UltraCompactEngine): void {
	engine.reconfigure(currentModel?.id, currentModel?.contextWindow);
}

/**
 * Handle /ultracompact command — manual compaction request.
 * Triggers Pi's native compaction flow via ctx.compact().
 * Our session_before_compact hook intercepts and applies ultra-compact logic.
 */
function handleUltracompactCommand(
	engine: UltraCompactEngine,
): (_args: any, ctx: any) => void {
	return (_args: any, ctx: any) => {
		// Guard against missing ctx or ctx.compact
		if (typeof ctx?.compact !== "function") {
			console.warn("Ultra-compact warning: ctx.compact unavailable");
			return;
		}

		// Notify user that compaction is starting
		notify(ctx, "Starting Ultra-compact compaction...", "info");

		// Reconfigure engine to current model before compaction
		reconfigureEngineForCurrentModel(engine);

		// Use Pi's built-in compact() API with a marker so our
		// session_before_compact hook applies ultra-compact logic
		ctx.compact({
			customInstructions: "ultracompact",
			onComplete: () => {
				notify(ctx, "Ultra-compact compaction complete!", "info");
			},
			onError: (error: Error) => {
				if (typeof ctx?.ui?.notify === "function") {
					notify(ctx, `Ultra-compact failed: ${error.message}`, "error");
				} else {
					console.error("Ultra-compact failed:", error.message);
				}
			},
		});
	};
}

/**
 * Was the agent cut off with work still queued when `agent_end` fired?
 *
 * Pi's loop emits `agent_end` from three places, and only two of them can
 * leave unfinished work behind:
 *
 *   1. the stream ended `error` or `aborted` — nothing to resume, and in the
 *      `aborted` case the operator pressed Esc, so nudging fights them;
 *   2. `shouldStopAfterTurn` stopped the loop while the last assistant
 *      message still held tool calls — real work, genuinely interrupted;
 *   3. normal completion — the loop drained every tool call and found no
 *      steering or follow-up message, so the agent said its piece and is
 *      waiting for the operator.
 *
 * Case 3 is the overwhelmingly common one, and it is the reason a nudge
 * cannot be unconditional. "Continue with the current task" after a turn
 * that finished invents a task that does not exist: the agent wakes with no
 * pending work, re-reads the transcript to find one, and reports on work it
 * already reported. Compaction itself is still worth running in case 3 —
 * reclaiming context while the session is idle is the whole point of the
 * proactive trigger — but it must stay silent.
 *
 * The signal is the last assistant message. A `toolUse` stop, or a message
 * still holding a tool-call block, means work was outstanding; `stop`,
 * `error` and `aborted` mean it was not. An empty list, or one with no
 * assistant message, is no evidence of unfinished work, so it does not
 * nudge either.
 */
export function hadPendingWork(messages: unknown): boolean {
	if (!Array.isArray(messages)) return false;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as
			| { role?: string; stopReason?: string; content?: unknown }
			| undefined;
		if (message?.role !== "assistant") continue;
		const stop = message.stopReason;
		// An abort is the operator pressing Esc, and an error is not ours to
		// retry. Neither wants a nudge, whatever the message body holds — so
		// these are settled before the content is consulted.
		if (stop === "aborted" || stop === "error") return false;
		if (stop === "toolUse" || stop === "length") return true;
		// No recognised stop reason: fall back to whether a tool call is still
		// sitting in the message.
		if (!Array.isArray(message.content)) return false;
		return message.content.some((block) => (block as { type?: string })?.type === "toolCall");
	}
	return false;
}

/**
 * Proactive auto-compaction trigger.
 *
 * Pi's NATIVE compaction only fires at `contextWindow - reserveTokens`
 * (~98% of the window); this extension is otherwise just an interceptor of
 * that event, so user watermarks like 0.35/0.40 could never fire on their
 * own. This handler hooks `agent_end` (emitted after every model round),
 * reads the live context usage, and starts a compaction through
 * ctx.compact() when the projected usage crosses the configured watermarks.
 * Fire-and-forget on purpose: awaiting ctx.compact() inside the agent_end
 * emit chain would deadlock the extension runner.
 *
 * `ctx.compact()` aborts the running agent and, per Pi's own contract, never
 * resumes the interrupted turn — threshold compaction is `willRetry: false`
 * too. So when the agent *was* interrupted, `onComplete` sends a follow-up
 * to restart it. When it was not — the normal case, per `hadPendingWork` —
 * no follow-up is sent, because there is nothing to resume. The decision is
 * taken from the `agent_end` payload at trigger time and carried into the
 * closure; by the time `onComplete` runs the transcript has been compacted
 * and can no longer answer the question.
 *
 * The `setImmediate` defers past Pi's `compaction_end` flush of user-typed
 * messages; checking `isIdle()` after that avoids racing that flush and
 * throwing "Agent is already processing".
 */
function handleAgentEnd(
	pi: any,
	engine: UltraCompactEngine,
): (event: any, ctx: any) => void {
	return (event: any, ctx: any) => {
		agentRounds++;
		if (autoCompactionInFlight) return;
		// Cooldown after the last auto trigger (in model rounds).
		const AUTO_COOLDOWN_ROUNDS = 8;
		if (agentRounds - lastAutoTriggerRound < AUTO_COOLDOWN_ROUNDS) return;
		if (typeof ctx?.compact !== "function") return;

		// Capture the model at runtime so the threshold adapts on switch.
		if (ctx?.model) {
			captureModel(ctx.model);
		}
		reconfigureEngineForCurrentModel(engine);

		// Authoritative live context usage (the same source as the TUI
		// meter): { tokens, contextWindow, percent }. Sync the engine's
		// window to it when available (defense in depth against stale
		// model tables).
		const usageInfo =
			typeof ctx?.getContextUsage === "function"
				? ctx.getContextUsage()
				: undefined;
		let contextTokens = usageInfo?.tokens ?? 0;
		if (
			usageInfo &&
			typeof usageInfo.contextWindow === "number" &&
			usageInfo.contextWindow > 0
		) {
			engine.reconfigure(currentModel?.id, usageInfo.contextWindow);
		}
		// Fallback: last assistant message with valid usage.
		if (contextTokens <= 0) {
			const messages = Array.isArray(event?.messages) ? event.messages : [];
			for (let i = messages.length - 1; i >= 0; i--) {
				const message = messages[i];
				if (message?.role !== "assistant" || !message.usage) continue;
				const usage = message.usage;
				const tokens =
					usage.totalTokens ||
					(usage.input || 0) +
						(usage.output || 0) +
						(usage.cacheRead || 0) +
						(usage.cacheWrite || 0);
				if (tokens > 0) {
					contextTokens = tokens;
					break;
				}
			}
		}
		if (contextTokens === 0) return;

		const outputHeadroom = engine["config"]?.outputHeadroom ?? 4096;
		if (!engine.shouldCompact(contextTokens + outputHeadroom)) return;

		autoCompactionInFlight = true;
		lastAutoTriggerRound = agentRounds;
		// Taken now, not in onComplete: this is the last moment the pre-compaction
		// transcript still exists to answer it.
		const resumeNeeded = hadPendingWork(event?.messages);
		notify(
			ctx,
			`Context at ${Math.round(contextTokens / 1000)}k tokens — starting Ultra-compact…`,
			"info",
		);
		void ctx.compact({
			customInstructions: "ultracompact",
			onComplete: () => {
				autoCompactionInFlight = false;
				notify(ctx, "Ultra-compact auto-compaction complete!", "info");
				// Only a turn that was cut short needs restarting. A turn that
				// finished on its own has nothing to continue, and nudging it
				// manufactures work. Stay quiet when nothing else is driving a
				// turn and there is nothing queued to drive one with.
				if (!resumeNeeded) return;
				setImmediate(() => {
					if (typeof ctx?.isIdle === "function" && !ctx.isIdle()) return;
					if (typeof pi?.sendUserMessage !== "function") return;
					pi.sendUserMessage(
						"Ultra-compact ran. Continue with the current task.",
					);
				});
			},
			onError: (error: Error) => {
				autoCompactionInFlight = false;
				notify(
					ctx,
					`Ultra-compact auto-compaction failed: ${error.message}`,
					"error",
				);
			},
		});
	};
}

/**
 * Handle session_before_compact event — automatic compaction intercept.
 * Also fired when the /ultracompact command calls ctx.compact().
 *
 * Features:
 * - Preemptive trigger: fires at 70% watermark by projecting next turn
 * - Tier-aware: uses micro (no LLM) at 60-90%, full at 90%+
 * - Circuit breaker: trips after N failures, falls back to lossy truncation
 * - Cache-aware: appends to previous summary (keeps prefix stable)
 */
function handleBeforeCompact(
	engine: UltraCompactEngine,
): (event: any, ctx: any) => Record<string, any> | undefined {
	// Circuit breaker state (per-session)

	return async (event: any, ctx: any) => {
		currentTurn++;

		// ── Circuit breaker check ───────────────────────────────────────
		if (breakerTrippedAtTurn !== null) {
			const COOLDOWN_TURNS = engine["config"]?.circuitBreakerCooldown ?? 5;
			if (currentTurn - breakerTrippedAtTurn < COOLDOWN_TURNS) {
				notify(
					ctx,
					"Ultra-compact circuit breaker open; using default compaction",
					"warning",
				);
				return undefined; // Fall back to Pi default
			}
			// Cool-down expired, reset breaker
			compactionFailures = 0;
			breakerTrippedAtTurn = null;
		}

		// Capture model from ctx at runtime
		if (ctx?.model) {
			captureModel(ctx.model);
		}
		reconfigureEngineForCurrentModel(engine);

		const preparation = event?.preparation;
		if (!preparation) {
			return undefined;
		}

		const currentTokens = preparation.tokensBefore;
		const messagesToCompact = preparation.messagesToSummarize;
		const isManual = event?.customInstructions === "ultracompact";
		// Manual trigger already notified by handleUltracompactCommand

		if (!Array.isArray(messagesToCompact) || messagesToCompact.length === 0) {
			return undefined;
		}

		// ── Preemptive trigger ──────────────────────────────────────────
		// Project next turn's token usage (current + headroom for tool result + output)
		const outputHeadroom = engine["config"]?.outputHeadroom ?? 4096;
		const projectedTokens = currentTokens + outputHeadroom;

		// Use preemptive check for auto, reactive for manual
		const effectiveTokens = isManual ? currentTokens : projectedTokens;

		if (!isManual && !engine.shouldCompact(effectiveTokens)) {
			return undefined; // No compaction needed
		}

		// ── Snapshot ────────────────────────────────────────────────────
		const snapshot = JSON.parse(JSON.stringify(messagesToCompact));
		let snapshotPreviousSummary = preparation.previousSummary;

		try {
			// ── Cache-Aware: append instead of rewrite ──────────────────
			// When cache-aware is enabled, the previous summary is kept as-is
			// and only the NEW content is summarized. This keeps the prefix stable
			// for prompt caching.
			const isCacheAware = engine["config"]?.cacheAware ?? false;
			let cacheAwarePrefix = "";

			if (isCacheAware && snapshotPreviousSummary) {
				// Keep the previous summary block immutable — append new content
				cacheAwarePrefix = snapshotPreviousSummary;
				snapshotPreviousSummary = undefined; // Don't re-summarize
			}

			// ── Tier-aware compaction ───────────────────────────────────
			let result: import("./types").CompactionResult;

			if (
				!isManual &&
				engine.determineTier(messagesToCompact) === 1 // MICRO
			) {
				// Micro-compaction: no LLM, just strip tool outputs
				const micro = engine.microCompact(messagesToCompact);
				const conversationText = micro.messages
					.map((m: any) => `[${m.role}]: ${messageContent(m).substring(0, 200)}`)
					.join("\n");
				result = {
					summary: isCacheAware
						? cacheAwarePrefix + "\n\n## Chat\n" + conversationText
						: "## Chat\n" + conversationText,
					tokensBefore: currentTokens,
					tokensAfter: engine.estimateTokens(micro.messages),
					compressionRatio: 0,
					readFiles: [],
					modifiedFiles: [],
					timestamp: Date.now(),
				};
			} else {
				// Full compaction
				result = await engine.generateSummary(
					snapshot,
					snapshotPreviousSummary,
				);
				if (isCacheAware && cacheAwarePrefix) {
					result.summary = cacheAwarePrefix + "\n\n" + result.summary;
				}
			}

			// ── Validate output ─────────────────────────────────────────
			if (!summaryHasContent(result.summary)) {
				throw new Error("Empty summary returned from compaction");
			}

			// Success — reset circuit breaker
			compactionFailures = 0;

			return {
				compaction: {
					summary: result.summary,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					details: {
						readFiles: result.readFiles,
						modifiedFiles: result.modifiedFiles,
						ultracompact: true,
						compressionRatio: result.compressionRatio,
					},
				},
			};
		} catch {
			// ── Circuit breaker ─────────────────────────────────────────
			compactionFailures++;
			notify(
				ctx,
				`Ultra-compact failed (${compactionFailures}/${engine["config"]?.circuitBreakerMaxFailures ?? 3})`,
				"warning",
			);

			if (
				compactionFailures >= (engine["config"]?.circuitBreakerMaxFailures ?? 3)
			) {
				breakerTrippedAtTurn = currentTurn;
				notify(
					ctx,
					"Ultra-compact circuit breaker tripped; emergency truncation applied",
					"error",
				);

				// ── Lossy truncation (last resort) ──────────────────────
				const tailKeep = 10;
				const system = snapshot.filter((m: any) => m.role === "system");
				const nonSystem = snapshot.filter((m: any) => m.role !== "system");
				const tail = nonSystem.slice(-tailKeep);

				const lossySummary = [
					...system.map((m: any) => `[System]: ${messageContent(m)}`),
					"",
					"[earlier history truncated — circuit breaker engaged]",
					"",
					...tail.map(
						(m: any) => `[${m.role}]: ${messageContent(m).substring(0, 500)}`,
					),
				]
					.filter(Boolean)
					.join("\n");

				return {
					compaction: {
						summary: lossySummary,
						firstKeptEntryId: preparation.firstKeptEntryId,
						tokensBefore: preparation.tokensBefore,
						details: {
							ultracompact: true,
							circuitBreakerEngaged: true,
						},
					},
				};
			}

			// Fall back to Pi's default compaction
			return undefined;
		}
	};
}

/**
 * Pi extension factory function
 */
export default function piUltraCompact(
	pi: any,
	config: UltraCompactConfig = {},
): void {
	const mergedConfig = {
		...DEFAULT_CONFIG,
		...loadUserSettings(),
		...config,
	};
	// Diagnostics only. pi owns stdout for its TUI, so unconditional startup
	// logging breaks the "no normal startup messages to stdout" contract that
	// tests/extension.test.ts asserts. Opt in with ULTRA_COMPACT_DEBUG=1.
	if (process.env.ULTRA_COMPACT_DEBUG) {
		console.log(
			"[ultra-compact] effective config:",
			JSON.stringify({
				autoCompact: mergedConfig.autoCompact,
				preemptiveWatermark: mergedConfig.preemptiveWatermark,
				hardWatermark: mergedConfig.hardWatermark,
				keepPercentage: mergedConfig.keepPercentage,
				maxKeepTokens: mergedConfig.maxKeepTokens,
				cacheAware: mergedConfig.cacheAware,
				maxEvictionLevel: mergedConfig.maxEvictionLevel,
			}),
		);
	}

	const engine = new UltraCompactEngine({
		...mergedConfig,
	});

	// Guard: ensure required Pi APIs are available
	if (typeof pi?.registerCommand !== "function") {
		console.error(
			"pi.registerCommand is unavailable",
		);
		return;
	}

	// Register /ultracompact command
	pi.registerCommand("ultracompact", {
		description:
			"Ultra-compact compaction with maximum compression while preserving critical context.",
		handler: handleUltracompactCommand(engine),
	});

	// Track model changes at runtime so compaction adapts when user switches models
	if (typeof pi.on === "function") {
		pi.on("session_start", (_event: any, ctx: any) => {
			captureModel(ctx?.model);
			reconfigureEngineForCurrentModel(engine);
		});

		pi.on("model_select", (event: any, _ctx: any) => {
			if (event?.model) {
				const id = typeof event.model === "string"
					? event.model
					: event.model.id || event.model.name || undefined;
				captureModel(event.model);
				reconfigureEngineForCurrentModel(engine);
				if (id) {
					console.log("Model updated: " + id);
				}
			}
		});
	}

	// Register automatic compaction hooks (single handler + proactive trigger)
	if (mergedConfig.autoCompact) {
		pi.on("session_before_compact", handleBeforeCompact(engine));
		pi.on("agent_end", handleAgentEnd(pi, engine));
	}
}

// Export engine for programmatic use
export { UltraCompactEngine } from "./engine";
export type { UltraCompactConfig, CompactionResult } from "./types";

/**
 * @internal — Reset module-level state for testing isolation.
 * Vitest caches modules across test files, so shared state must be
 * explicitly reset between suites.
 */
export function __resetModuleState(): void {
	currentModel = undefined;
	compactionFailures = 0;
	breakerTrippedAtTurn = null;
	currentTurn = 0;
	autoCompactionInFlight = false;
	agentRounds = 0;
	lastAutoTriggerRound = -Infinity;
}
