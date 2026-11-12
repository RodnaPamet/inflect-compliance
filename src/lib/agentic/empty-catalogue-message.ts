/**
 * WHAT A RUN SAYS WHEN IT REACHED NO TOOLS — chosen from WHY (#5045).
 *
 * Both reasoning engines settle `EMPTY_CATALOGUE` when the offered tool set is
 * empty. They used to write `EMPTY_TOOLSET_MESSAGE` whatever the cause, and
 * that sentence blames the GRANTS: "this agent holds no MCP tool grants". It
 * is true only when the agent holds none. An agent with three granted read
 * tools whose policy card permitted none of them was told the same thing, and
 * the operator was sent to a Tools tab that looked fine.
 *
 * A run's catalogue is the result of several terms, and the run is empty when
 * any of them removes everything:
 *
 *   • the GRANT and the POLICY CARD (`loadableSetOf`, applied inside the
 *     candidate list, so `offerToolSet` never sees a tool either removed);
 *   • the build's catalogue snapshot and the acting context's permission keys
 *     (`canSee`), also applied inside the candidate list;
 *   • scope, autonomy, a read-only connection, an unconvertible schema and a
 *     read-only workflow, each named in `offered.omitted`;
 *   • a profile's narrowing, named as `PROFILE_TOOL_NOT_GRANTED`.
 *
 * The first two leave no `omitted` entry, so this RE-DERIVES them from the
 * invocation's own pinned lists (`grantedTools`, the card's `permittedTools`
 * and `offeredTools`) — the same three lists `toolIsLoadable` intersects —
 * rather than adding a reason inside the offer. Derived, not re-decided: no
 * tool is offered or withheld here; only the sentence is chosen.
 *
 * `EMPTY_TOOLSET_MESSAGE` stays the sentence for the one case it describes —
 * an agent with no grants at all — byte for byte, because
 * `ad-hoc-question-result.ts` compares stored rows against it. It is also the
 * fallback when the invocation carries no grant list and nothing was named,
 * which is what the engines wrote before.
 *
 * What the sentence may carry: tool NAMES and the reason, never a tool's
 * description (an external tool's description is a far server's text). The
 * names are bounded, so a large grant set cannot make the stored message
 * unbounded.
 */
import type { ToolOmissionReason } from '@/lib/agentic/engine-tools/offer-tools';
import { EMPTY_TOOLSET_MESSAGE } from '@/lib/agentic/flue/empty-toolset-message';

/** The engine whose run settled, which names the message's code. */
export type EmptyCatalogueEngine = 'flue' | 'tool_runner';

/**
 * Why a granted tool did not reach the run. The offer's own reasons, plus the
 * three terms applied before the offer saw the tool.
 */
export type EmptyCatalogueReason = ToolOmissionReason | 'POLICY_CARD' | 'NOT_IN_CATALOGUE' | 'PERMISSION';

/** What the engine knows when its offered set comes back empty. */
export interface EmptyCatalogueFacts {
    /** The agent's grants, as the invocation pinned them; `null`/absent for no agent. */
    readonly grantedTools?: ReadonlySet<string> | null;
    /** The policy card's permitted tools, or `null`/absent for no card. */
    readonly permittedTools?: readonly string[] | null;
    /** The catalogue snapshot the invocation was assembled with. */
    readonly offeredTools?: readonly string[] | null;
    /** `offered.omitted` from `offerToolSet`. */
    readonly omitted: ReadonlyArray<{ readonly name: string; readonly reason: ToolOmissionReason }>;
    /** The profile's tools, when the run executes an agent profile. */
    readonly profileTools?: readonly string[];
}

/** The order the terms apply in, which is the order the sentence names them. */
const ORDER: readonly EmptyCatalogueReason[] = [
    'PROFILE_TOOL_NOT_GRANTED',
    'NOT_IN_CATALOGUE',
    'POLICY_CARD',
    'PERMISSION',
    'SCOPE',
    'AUTONOMY',
    'CONNECTION_READ_ONLY',
    'READ_ONLY_WORKFLOW',
    'UNCONVERTIBLE_SCHEMA',
];

/** At most this many names per reason; the rest are counted. */
const NAMES_PER_REASON = 8;

/**
 * Which term withheld each granted tool. Pure; exported for the tests and for
 * any surface that wants the reasons rather than the sentence.
 */
export function emptyCatalogueReasons(facts: EmptyCatalogueFacts): Map<EmptyCatalogueReason, string[]> {
    const granted = facts.grantedTools ?? null;
    const permitted = facts.permittedTools ?? null;
    const offered = facts.offeredTools ?? null;
    const profile = facts.profileTools === undefined ? null : new Set(facts.profileTools);
    const out = new Map<EmptyCatalogueReason, Set<string>>();
    const add = (reason: EmptyCatalogueReason, name: string) => {
        const names = out.get(reason) ?? new Set<string>();
        names.add(name);
        out.set(reason, names);
    };

    // A name the offer accounted for, under a reason it can name itself. The
    // profile term is re-read below: the offer reports a profile tool the
    // candidates lacked as "not granted", and a candidate list is already the
    // grant AND the card AND the catalogue AND the permissions.
    const named = new Set<string>();
    for (const o of facts.omitted) {
        if (o.reason === 'PROFILE_TOOL_NOT_GRANTED') continue;
        add(o.reason, o.name);
        named.add(o.name);
    }

    // What the candidate list removed before the offer saw it. A tool is
    // considered when the agent holds it (and the profile names it) or the
    // profile names it at all.
    const considered = new Set<string>();
    if (granted !== null) for (const g of granted) if (profile === null || profile.has(g)) considered.add(g);
    if (profile !== null) for (const p of profile) considered.add(p);

    for (const name of [...considered].sort()) {
        if (named.has(name)) continue;
        if (granted !== null && !granted.has(name)) {
            add('PROFILE_TOOL_NOT_GRANTED', name);
        } else if (offered !== null && !offered.includes(name)) {
            add('NOT_IN_CATALOGUE', name);
        } else if (permitted !== null && !permitted.includes(name)) {
            add('POLICY_CARD', name);
        } else if (granted !== null || profile !== null) {
            // Granted, in the catalogue and permitted by the card, yet not a
            // candidate: the remaining candidate term is the acting context's
            // permission keys.
            add('PERMISSION', name);
        }
    }

    const sorted = new Map<EmptyCatalogueReason, string[]>();
    for (const reason of ORDER) {
        const names = out.get(reason);
        if (names && names.size > 0) sorted.set(reason, [...names].sort());
    }
    return sorted;
}

function clause(
    reason: EmptyCatalogueReason,
    names: readonly string[],
    opts: { readonly isProfile: boolean; readonly only: boolean },
): string {
    const shown = names.slice(0, NAMES_PER_REASON).join(', ');
    const list = names.length > NAMES_PER_REASON ? `${shown} and ${names.length - NAMES_PER_REASON} more` : shown;
    switch (reason) {
        case 'PROFILE_TOOL_NOT_GRANTED':
            return `the profile names tools the agent is not granted (${list})`;
        case 'NOT_IN_CATALOGUE':
            return `not in this run's tool catalogue (${list}); an external tool drops out when its definition changed after it was accepted`;
        case 'POLICY_CARD':
            return opts.only
                ? `none of its granted tools is permitted by its policy card (${list}); check the agent's Policy card tab`
                : `not permitted by its policy card (${list}); check the agent's Policy card tab`;
        case 'PERMISSION':
            return `the run acts for someone without the permission these tools need (${list})`;
        case 'SCOPE':
            return `outside the credential's scopes (${list})`;
        case 'AUTONOMY':
            return `above the agent's autonomy ceiling (${list})`;
        case 'CONNECTION_READ_ONLY':
            return `write tools whose connection is set to read-only (${list})`;
        case 'READ_ONLY_WORKFLOW':
            if (!opts.isProfile) return `propose tools, which this read-only workflow is not offered (${list})`;
            return opts.only
                ? `the profile names only propose tools, and this run is read-only, as a Test run or an answer-only profile is (${list})`
                : `propose tools, which this read-only run is not offered (${list})`;
        case 'UNCONVERTIBLE_SCHEMA':
            return `an input schema this engine cannot express (${list})`;
    }
}

/**
 * The `errorMessage` an `EMPTY_CATALOGUE` run settles with.
 *
 * `EMPTY_TOOLSET_MESSAGE` when the agent holds no grants (or nothing else can
 * be named); otherwise `<engine>_no_tools_offered: …` naming each term that
 * withheld the agent's tools, and which tools it withheld.
 */
export function emptyCatalogueMessage(engine: EmptyCatalogueEngine, facts: EmptyCatalogueFacts): string {
    const granted = facts.grantedTools ?? null;
    if (granted !== null && granted.size === 0) return EMPTY_TOOLSET_MESSAGE;
    const reasons = emptyCatalogueReasons(facts);
    if (reasons.size === 0) {
        // Nothing to name. With grants this cannot be reached through the
        // engines (every granted tool lands under some term); without a grant
        // list it is what the engines always wrote.
        if (granted === null) return EMPTY_TOOLSET_MESSAGE;
        return (
            `${engine}_no_tools_offered: this agent holds ${granted.size} MCP tool grant${granted.size === 1 ? '' : 's'}, ` +
            'but none of them could be offered to this run, so the run had nothing to read and its conclusion is ' +
            'based on no data.'
        );
    }
    const opts = { isProfile: facts.profileTools !== undefined, only: reasons.size === 1 };
    const clauses = [...reasons.entries()].map(([reason, names]) => clause(reason, names, opts));
    const holds =
        granted === null
            ? 'no tool reached this run'
            : `this agent holds ${granted.size} MCP tool grant${granted.size === 1 ? '' : 's'}, but none reached this run`;
    return (
        `${engine}_no_tools_offered: ${holds}, so the run had nothing to read and its conclusion is based on no ` +
        `data. Withheld: ${clauses.join('; ')}.`
    );
}
