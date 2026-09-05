/**
 * The TOOL MANIFEST — the set of tools ONE invocation may load, fixed at the
 * moment that invocation was assembled.
 *
 * ## What "the session" is in this codebase
 *
 * There is no long-lived MCP session object here. An `McpInvocation` IS the
 * session: `buildMcpInvocation` assembles one per HTTP request to `/api/mcp`,
 * and `resolveMcpInvocation` assembles one per workflow-run SEGMENT, which then
 * drives every step of that segment. Every authorization term an invocation
 * carries — the agent's grants, the in-force policy card, the autonomy ceiling —
 * is read once, at assembly. So "mid-session" means precisely: after an
 * invocation was assembled and before it stops making calls. For a direct tool
 * call that window is one request; for the workflow engine it is a whole run
 * segment, up to `ENGINE_CAPS.MAX_STEPS` tool calls long.
 *
 * ## What a mid-session tool addition means here, and why it is refused by
 * construction rather than detected
 *
 * This product is an MCP SERVER, not a client: it does not connect out to a
 * third-party server that could hand it a new tool. So the literal ASI04
 * rug-pull — a remote peer adding a tool after the client approved the list —
 * has no direct analogue. What DOES vary while an invocation is in flight is the
 * set of names the process is willing to resolve, and that set was, until this
 * module, read at CALL time straight out of the module-level registry arrays
 * (`READ_TOOLS.find(...)` / `PROPOSE_TOOLS.find(...)`). A name that entered the
 * registry — by any route, including one this build does not anticipate —
 * became resolvable to an invocation that was never authorized against it.
 *
 * The fix is not to detect the addition. It is to make RESOLUTION ENUMERATE THE
 * MANIFEST rather than the registry: `offered` is a snapshot taken at assembly,
 * and a name absent from that snapshot cannot be loaded no matter what the
 * registry now holds. Nothing has to notice the change for the refusal to
 * happen, which is the only version of this property that survives a mechanism
 * nobody predicted. The same pin is what a future MCP CLIENT integration — a
 * third-party server's catalogue, fetched once — would inherit for free, which
 * is why `offered` is an INPUT here rather than a module import.
 *
 * ## The three lists, and why an absent list is not an empty one
 *
 *   `offered`        what this build/peer put on the table at assembly.
 *   `grantedTools`   `RegisteredAgentTool` — deny-by-default, `null` when the
 *                    credential is bound to no live ACTIVE agent (a human, an
 *                    ordinary integration key, or a tenant with the register
 *                    switched off). See `agent-tool-exposure.ts` for why that
 *                    `null` is not an exposure bypass.
 *   `permittedTools` the in-force policy card's list, `null` when the agent has
 *                    no card.
 *
 * `null` contributes NO term; an EMPTY ARRAY/SET forbids everything. Those two
 * must never be collapsed, in either direction. Reading an absent card as "may
 * do nothing" would make writing the register's own governance artefact the
 * thing that takes a working agent dark — the composition failure this
 * subsystem has now written down three times. Reading an empty grant list as
 * "unset, so allow" would delete the deny-by-default property outright.
 *
 * ## No imports
 *
 * Deliberately a leaf, apart from `node:crypto` for the digest. `authorize.ts`
 * imports it; it must never import `authorize.ts` back, or the invocation type
 * and the manifest that describes it become a cycle. The adapters that take an
 * `McpInvocation` live there, not here.
 */
import { createHash } from 'node:crypto';

/**
 * The three lists an invocation's loadable set is the intersection of, pinned at
 * assembly. See the module docstring for why each `null` is a missing TERM and
 * never an empty one.
 */
export interface LoadableToolSet {
    /** The catalogue snapshot taken when this invocation was assembled. */
    readonly offered: readonly string[];
    /** The agent's deny-by-default grants, or `null` for no agent. */
    readonly grantedTools: ReadonlySet<string> | null;
    /** The in-force policy card's permitted tools, or `null` for no card. */
    readonly permittedTools: readonly string[] | null;
}

/**
 * Was this name on the table when the invocation was assembled?
 *
 * The whole of the mid-session property. A tool the registry acquired later
 * fails here, before it is resolved to an object, without anything having
 * noticed that it arrived.
 */
export function toolWasOffered(manifest: LoadableToolSet, name: string): boolean {
    return manifest.offered.includes(name);
}

/**
 * May this invocation LOAD this tool at all?
 *
 * offered ∧ granted ∧ permitted-by-card. This is a DERIVATION over state the
 * invocation already pins — not a second copy of the grant list or the card, and
 * not a fourth policy. The per-call gate in `authorizeToolCall` still re-checks
 * the grant (step 3) and the card (step 5) individually, because each of those
 * refusals has to name its own rule to an operator; this function is the same
 * conjunction expressed as a set, for the two callers that need the SET rather
 * than a verdict: the `tools/list` catalogue and the loader.
 */
export function toolIsLoadable(manifest: LoadableToolSet, name: string): boolean {
    if (!toolWasOffered(manifest, name)) return false;
    if (manifest.grantedTools !== null && !manifest.grantedTools.has(name)) return false;
    if (manifest.permittedTools !== null && !manifest.permittedTools.includes(name)) return false;
    return true;
}

/** Every name this invocation may load, in a stable order. */
export function loadableTools(manifest: LoadableToolSet): string[] {
    return manifest.offered.filter((n) => toolIsLoadable(manifest, n)).sort();
}

/**
 * A short, stable fingerprint of the loadable SET — pinned into the audit row of
 * every tool invocation and every not-offered refusal.
 *
 * Two calls in one run that report different digests are the signal this module
 * exists for: the set of tools this agent could load changed underneath it.
 * A digest rather than the list because an audit row is not a place to
 * accumulate payload, and because the question an operator asks of it is "same
 * or different", which a fingerprint answers exactly.
 *
 * Sorted before hashing, so the digest is a property of the SET and does not
 * move when a registry declaration is reordered.
 */
export function loadableToolsDigest(manifest: LoadableToolSet): string {
    return createHash('sha256').update(loadableTools(manifest).join('\n')).digest('hex').slice(0, 16);
}
