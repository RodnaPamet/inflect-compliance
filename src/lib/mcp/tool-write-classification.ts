/**
 * Does a tool's own declaration say it may WRITE? (#2861)
 *
 * ONE definition, imported by the three places that ask: the catalogue an
 * operator reads, the setter that validates a prior-state pairing, and the
 * dispatch that decides whether the rung's write semantics apply. Three copies of
 * this predicate would be three chances to disagree about whether a given tool is
 * a write, and the one that mattered would be the quiet one — which is exactly
 * how #2957 happened, two seams evaluating the same fact differently.
 *
 * ## What this is NOT
 *
 * It is not a security boundary, and nothing in this subsystem treats it as one.
 * `readOnlyHint` is supplied by the FAR END. Pinning it (#2941) makes it STABLE —
 * a change is detectable — but never HONEST: a server that declares read-only and
 * writes anyway passes this predicate and always will.
 *
 * That is why the owner's decision of 2026-09-27 put REACHABILITY on the rung
 * instead, which does not consult the hint at all: `DISABLED` means an agent
 * cannot call the connection, whatever its tools claim. This predicate only
 * decides which of the rung's semantics apply ABOVE that gate — whether a
 * permitted call is recorded-and-not-sent, queued, or dispatched. A lying server
 * can therefore get a "read" sent at `DRY_RUN`, which it could equally get at
 * `AUTOMATIC`; what it cannot do is reach a connection nobody granted it.
 *
 * ## Why unknown counts as a WRITE
 *
 * A tool that declares nothing is treated as a write, and the consequence is
 * real: a server that declares no annotations at all has every tool classified as
 * a write, so every tool needs a prior-state pairing before it can be dispatched.
 * That is conservative to the point of being inconvenient.
 *
 * It is still the right direction. The alternative — unknown means read — lets
 * any server opt out of the write path by saying nothing, which is a weaker
 * default than saying `readOnlyHint: false` honestly. A refusal that names the
 * missing declaration is a thing an operator can act on; a write dispatched
 * because a server stayed silent is not.
 */

/** The annotation keys MCP defines. Only `readOnlyHint` is read here. */
export interface McpToolAnnotations {
    readonly readOnlyHint?: unknown;
    readonly destructiveHint?: unknown;
    readonly idempotentHint?: unknown;
    readonly openWorldHint?: unknown;
}

/**
 * True when the tool is NOT declared read-only — including when it declares
 * nothing at all.
 *
 * The comparison is against the literal `true`, not truthiness: a server sending
 * `readOnlyHint: "true"` or `readOnlyHint: 1` has not made the declaration MCP
 * defines, and coercing a near-miss into a read is the direction that lets a
 * write through.
 */
export function declaresWrite(annotations?: McpToolAnnotations | Record<string, unknown> | null): boolean {
    if (!annotations || typeof annotations !== 'object') return true;
    return (annotations as { readOnlyHint?: unknown }).readOnlyHint !== true;
}

/** The inverse, spelled out where a caller reads better asking for a read. */
export function declaresReadOnly(
    annotations?: McpToolAnnotations | Record<string, unknown> | null,
): boolean {
    return !declaresWrite(annotations);
}
