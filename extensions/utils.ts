/**
 * Shared utilities for pi-ultra-compact
 *
 * Centralizes duplicated logic: message content extraction, pattern-based
 * information extraction, error detection, and result construction.
 */

import type { CompactionResult, Message, TextContent } from "./types";

/**
 * Normalize message content to string, handling both plain text and structured arrays.
 */
/**
 * Normalize message content to string, handling both plain text and structured arrays.
 *
 * Non-text blocks are described with a `[type]` tag rather than dropped, so a
 * message made entirely of images or tool calls stays visible to token counting
 * and extraction instead of reading as empty.
 */
export function messageContent(msg: Message): string {
	const c = msg.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		const text = c
			.filter((block): block is TextContent => block?.type === "text")
			.map((block) => block.text ?? "")
			.join(" ");
		const other = c
			.filter((block: any): boolean => block?.type !== "text")
			.map((block: any): string => `[${block?.type ?? "unknown"}]`)
			.join(" ");
		return (text + " " + other).trim();
	}
	return String(c ?? "");
}

/**
 * Shared keyword patterns used for both importance scoring and information extraction.
 * Each entry maps a category to its regex and weight.
 */
export const KEYWORD_PATTERNS = {
	goal: {
		pattern: /\b(?:GOAL|OBJECTIVE|TARGET|WANT TO|TRYING TO)\b:?\s*(.+)/i,
		weight: 1.0,
	},
	decision: {
		pattern: /\b(?:DECISION|DECIDED|CHOSE|SELECTED)\b:?\s*(.+)/i,
		weight: 0.95,
	},
	error: {
		pattern: /\b(?:ERROR|FAILED|BUG|ISSUE|PROBLEM|CRASH)\b:?\s*(.+)/i,
		weight: 0.9,
	},
	solution: {
		pattern: /\b(?:SOLUTION|FIX|RESOLVED|FIXED|WORKAROUND)\b:?\s*(.+)/i,
		weight: 0.85,
	},
	discovery: {
		pattern: /\b(?:DISCOVERED|FOUND|LEARNED|INSIGHT|REALIZED)\b:?\s*(.+)/i,
		weight: 0.8,
	},
	constraint: {
		pattern: /\b(?:CONSTRAINT|REQUIREMENT|REQUIRED|MUST)\b:?\s*(.+)/i,
		weight: 0.75,
	},
	file: {
		pattern: /\b(?:FILE|PATH|DIRECTORY|MODULE)\b:?\s*(.+)/i,
		weight: 0.7,
	},
	change: {
		pattern: /\b(?:ADDED|REMOVED|MODIFIED|CHANGED|UPDATED|CREATED|DELETED)\b:?\s*(.+)/i,
		weight: 0.65,
	},
	next: {
		pattern: /\b(?:TODO|NEXT|SHOULD|PLAN TO|NEED TO)\b:?\s*(.+)/i,
		weight: 0.6,
	},
} as const;

export type KeywordCategory = keyof typeof KEYWORD_PATTERNS;

/**
 * Extract matching text from messages for a given keyword category.
 * Returns deduplicated results.
 */
export function extractByPattern(messages: Message[], category: KeywordCategory): string[] {
	const { pattern } = KEYWORD_PATTERNS[category];
	const results: string[] = [];

	for (const msg of messages) {
		const text = messageContent(msg);
		const match = text.match(pattern);
		if (match) {
			results.push(match[1].trim());
		}
	}

	return [...new Set(results)];
}

/**
 * Check if content contains error indicators.
 * Used by both tool output stripping and summarization.
 */
export function containsErrorIndicators(content: string): boolean {
	return (
		content.includes("Error:") ||
		content.includes("error:") ||
		content.includes("failed") ||
		content.includes("Failed") ||
		content.includes("exit code") ||
		content.includes("exit status") ||
		content.includes("SyntaxError") ||
		content.includes("TypeError")
	);
}

/**
 * Create an empty CompactionResult with default values.
 */
export function emptyCompactionResult(previousSummary?: string): CompactionResult {
	return {
		summary: previousSummary || "",
		tokensBefore: 0,
		tokensAfter: 0,
		compressionRatio: 1,
		readFiles: [],
		modifiedFiles: [],
		timestamp: Date.now(),
	};
}

/** A line that is only a role label with nothing after it, e.g. "[user]: ". */
const EMPTY_ROLE_STUB = /^\[[^\]]*\]:\s*$/;

/** A markdown header line, e.g. "## Chat". Scaffolding, not content. */
const MARKDOWN_HEADER = /^#{1,6}\s+\S.*$/;

/**
 * A bare v1.3.0 compressed section marker, e.g. "#C", "#Prev", "#G:".
 *
 * Scaffolding in the same sense as MARKDOWN_HEADER, but written without the space
 * after the hashes, so MARKDOWN_HEADER does not catch it. Only the *bare* form
 * counts: a marker with text after it ("#G: Build the gateway") carries the
 * extracted value and must still read as content.
 */
const BARE_COMPRESSED_MARKER = /^#[A-Za-z]{1,6}:?\s*$/;

/**
 * Whether a summary carries actual content rather than only structure.
 *
 * A summary can be non-empty in characters yet say nothing: bare role labels
 * ("[user]: ") plus section headers ("## Chat", or the v1.3.0 compressed
 * markers "#C" / "#Prev") are scaffolding. The old
 * `summary.trim().length === 0` check passed a 480-character string of
 * nothing but role labels, so a contentless summary was committed in place of
 * a real one. This treats a summary with no non-scaffolding line as empty, so
 * it trips the circuit breaker instead.
 */
export function summaryHasContent(summary: string | undefined | null): boolean {
	if (!summary || summary.trim().length === 0) return false;
	return summary
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.some(
			(line) =>
				!EMPTY_ROLE_STUB.test(line) &&
				!MARKDOWN_HEADER.test(line) &&
				!BARE_COMPRESSED_MARKER.test(line),
		);
}
