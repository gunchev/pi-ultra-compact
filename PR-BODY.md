## Problem

pi stores `message.content` as an **array of blocks** (`text`, `thinking`, `toolCall`), not a plain string — measured on a real session: **1414 of 1415 messages use the array form**.

Three summary builders guarded on `typeof m.content === "string"`, which is false for every array-content message, so each rendered an empty stub:

```
"[user]: "  "[assistant]: "  "[toolResult]: "
```

Two places where that escaped detection:

**MICRO tier** — the output guard was `!result.summary || result.summary.trim().length === 0`. That validates *characters*, not *content*. The role labels and newlines make the string non-empty, so a contentless summary was committed as though it were a real one.

**Circuit-breaker fallback** — `.filter(Boolean)` drops the empty lines outright. The "emergency truncation" meant to preserve the last 10 messages preserves nothing but the truncation marker.

## Evidence

Driving the real `session_before_compact` handler with real session messages, forced into the MICRO band (`tokens(messagesToSummarize) / contextWindow` in `[0.6, 0.9)`):

| | summary | empty stub lines |
|---|---|---|
| before | 480 chars | 33 / 33 |
| after | 3,958 chars | 15 / 33 |

The 15 remaining are `toolCall`-only assistant messages that genuinely have no text block.

The fallback failure mode, from the regression test against the unfixed code:

```
AssertionError: expected '[earlier history truncated — circuit …' to contain 'TAIL_10_'
```

i.e. the summary was nothing but the marker line.

## Fix

**Commit 1 — route all three call sites through `messageContent()`** from `utils.ts`, which already handles both shapes and is what `estimateTokens()` uses.

```diff
-import { UltraCompactEngine } from "./engine";
+import { messageContent } from "./utils";

-  .map((m: any) =>
-    `[${m.role}]: ${typeof m.content === "string" ? m.content.substring(0, 200) : ""}`)
+  .map((m: any) => `[${m.role}]: ${messageContent(m).substring(0, 200)}`)

-  ...system.map((m: any) => `[System]: ${typeof m.content === "string" ? m.content : ""}`)
+  ...system.map((m: any) => `[System]: ${messageContent(m)}`)

-  ...tail.map((m: any) =>
-    `${typeof m.content === "string" ? `[${m.role}]: ${m.content.substring(0, 500)}` : ""}`)
+  ...tail.map((m: any) => `[${m.role}]: ${messageContent(m).substring(0, 500)}`)
```

**Commit 2 — make the output guard validate content rather than length.** Adds `summaryHasContent()`: a summary must contain at least one line that is neither a bare role stub (`"[user]: "`) nor a markdown header (`"## Chat"`). Scaffolding alone no longer counts.

```diff
-if (!result.summary || result.summary.trim().length === 0) {
+if (!summaryHasContent(result.summary)) {
     throw new Error("Empty summary returned from compaction");
 }
```

This is defense in depth, not a restatement of commit 1. Verified by reverting *only* the MICRO call site to the content-blind ternary while keeping the guard: the handler then throws and returns `undefined`, so pi falls back to its own compaction instead of committing a contentless summary. Without the guard, that same revert silently commits.

## Tests

`tests/micro-summary-content.test.ts` — 10 tests: MICRO band validation, real-text preservation, empty-stub guard, plain-string regression, circuit-breaker fallback preservation, and 5 unit tests for `summaryHasContent`.

- **Red against the unfixed code** (3 of the first 5 fail), green after — they test the fix, not the fixture.
- Full suite unchanged: **10 pre-existing failures before and after, 0 new** (the `generateSummary` section-format expectations noted in #49).
- `tsc --noEmit` clean; lint 0 errors (27 pre-existing `no-explicit-any` warnings).
- New/changed test and utils files are prettier-clean. `extensions/index.ts` was already prettier-dirty on `main` before this change, so it was left alone rather than inflating the diff.

## Reachability

MICRO fires when `tokens(messagesToSummarize) / contextWindow` is in `[0.6, 0.9)`. In one fleet's 71 recorded compactions it never fired — max ratio 0.481 against a 512K window — because `determineTier` measures the *summarize chunk*, not total context. So the MICRO path is latent rather than live, but a long enough session reaches it, and the circuit-breaker path is reachable independently of the band.

## Relationship to #49 and #48

**#49** is orthogonal — it changes `shouldCompact` (trigger watermarks) and model window pins, not `determineTier` or the summary construction. One cosmetic note: both branches add an import immediately after `import { UltraCompactEngine } from "./engine"`, so whichever merges second hits a trivial one-line conflict.

**#48** ("Stream ended without finish_reason") is a different problem — this PR does not address it.
