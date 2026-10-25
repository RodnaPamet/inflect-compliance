/**
 * THE OPENSHELL SOURCE — the `runtime` kind (#3936, owner decisions 2026-10-24).
 *
 * A client running agents under NVIDIA OpenShell has, in its gateway, the one
 * inventory that knows which agents RUN, under what network policy, with which
 * credentials attached. This reads it, read-only, and reports one agent per
 * sandbox as `openshell:sandbox:<id>`.
 *
 * Under the EXISTING `runtime` kind, not a new one (decision D1). The contract
 * defines `runtime` as "a deployment, and the secrets it runs with", and
 * `langsmith.ts` set the precedent. Source kinds are a closed list on the wire,
 * so a new kind would need `inflect-agent-harness/4`.
 *
 * ── READ-ONLY, HELD THREE WAYS ──────────────────────────────────────────
 *
 * `OpenShellReadWire` has three methods and no fourth; `scanner-surface.ts`
 * declares those three into the manifest hash; and every one of them requires
 * `sandbox:read` in the proto while every mutation requires `sandbox:write`.
 * The third holds even if this file is wrong, which is why the reader asks for
 * `OPENSHELL_READ_SCOPE` and never widens it. `http.ts` carries the argument.
 *
 * NEVER ProviderClient. That retrieves credential VALUES over mTLS with an
 * `OU=operator` certificate. This source names credentials by reference only,
 * and the runner refuses to sign a report in which any string has a secret's
 * shape.
 *
 * ── WHY AN ABSENT FIELD CAN NEVER SUPPORT A MET VERDICT ─────────────────
 *
 * This is the load-bearing property of the whole source, and it comes from the
 * wire format rather than from a convention here.
 *
 *     enum NetworkEnforcementMode {
 *       NETWORK_ENFORCEMENT_MODE_UNSPECIFIED = 0;  // "log violations and allow traffic"
 *       NETWORK_ENFORCEMENT_MODE_ENFORCE     = 1;
 *       NETWORK_ENFORCEMENT_MODE_AUDIT       = 2;
 *     }
 *
 * In proto3 a field set to its zero value is indistinguishable on the wire from
 * a field never set. So "no operator configured enforcement", "the field was
 * dropped between the gateway and here", and "permissive" are THE SAME BYTES —
 * and the permissive reading is the zero. `landlock.compatibility` is a plain
 * `string`, so unset decodes `""`, not `hard_requirement`.
 *
 * Therefore every mapping below is written so that only an AFFIRMATIVE
 * observation raises a verdict. `ENFORCE` must be read positively on every
 * endpoint; anything else — audit, unspecified, absent, unrecognised — fails.
 * A policy with no `network_policies` at all does not evidence egress control;
 * it evidences nothing, and nothing is `met: false`.
 *
 * ── POINTERS, NOT CONTENT ───────────────────────────────────────────────
 *
 * `GetSandbox` returns `spec.policy` IN FULL: every endpoint, every host, every
 * L7 rule, the filesystem policy and the process identity. The contract says a
 * report "carries identifiers and pointers, not content". So the policy is
 * reduced here to a digest plus the handful of facts a verdict needs, and the
 * rest never reaches an observation, the report or a log line — the discipline
 * `langsmith.ts` states under "WHAT IS NEVER KEPT", and the tests hold it with
 * marker strings in every discarded member.
 *
 * What is kept per sandbox: the sandbox id, the policy digest, each endpoint's
 * enforcement mode (as one of three words), the landlock compatibility mode,
 * whether every endpoint names a host, and each attached provider's name. What
 * is discarded: hosts, ports, protocols, L7 rules, access presets, binaries,
 * middleware configuration, filesystem paths, process identity, and every
 * provider's credential keys and values.
 *
 * ── NO OWNER, AND NO LINK TO THE REGISTER ───────────────────────────────
 *
 * A sandbox carries operator-chosen labels and annotations. Those are labels in
 * the estate being scanned, which an estate administrator could write to hide a
 * shadow agent, so this source reads neither for ownership and reports
 * `owner: null` (see `source.ts`). The onboarding document names the labels an
 * operator may set for a human to read; the scanner does not act on them.
 */
import { createHash } from 'crypto';

import type { CriterionVerdict } from '@/lib/agentic/harness-ladder';

import { OPENSHELL_METHODS, OPENSHELL_PROFILE_SCOPE, OPENSHELL_READ_SCOPE, OPENSHELL_SERVICE, type OpenShellTarget } from '../http';
import {
    isPlainId,
    SourceReadError,
    sourceResult,
    type HarnessSource,
    type Observation,
    type ObservedCredential,
    type SourceContext,
    type SourceRead,
} from '../source';

export { OPENSHELL_METHODS, OPENSHELL_PROFILE_SCOPE, OPENSHELL_READ_SCOPE, OPENSHELL_SERVICE };

/** Most sandboxes one read follows. A listing longer than this is reported, not read forever. */
export const MAX_SANDBOXES = 5_000;

/**
 * The three words an endpoint's enforcement can reduce to here. `unspecified`
 * is its own word rather than being folded into `audit`: both fail every
 * verdict, but a report that called them the same thing would claim the
 * operator chose audit when the wire cannot distinguish that from a field
 * nobody set or one that was dropped.
 */
export type EnforcementWord = 'enforce' | 'audit' | 'unspecified';

/** The facts a verdict needs from one sandbox's policy, and nothing else. */
export interface PolicyFacts {
    /** `sha256:` over the canonical policy as read. The pointer; never the content. */
    readonly digest: string;
    /** One word per endpoint across every named network policy, in read order. */
    readonly enforcement: readonly EnforcementWord[];
    /** `landlock.compatibility` verbatim, or `''` when unset — never defaulted to a safe value. */
    readonly landlock: string;
    /** Whether every endpoint names a host. A hostless endpoint admits any host on its port. */
    readonly everyEndpointHasHost: boolean;
    /** Endpoints seen. Zero means the policy declares no egress control, which evidences nothing. */
    readonly endpoints: number;
    /**
     * Whether a middleware stage is selected over endpoints AND fails closed.
     * `on_error` documents `fail_closed` as its default, so here the zero value
     * is the SAFE one — the opposite of `enforcement`. It is still required
     * affirmatively: one rule, applied uniformly, is worth more than a reading
     * that depends on which field's default happens to be safe.
     */
    readonly payloadsInspected: boolean;
    /** The policy's own declared version, for comparison with the loaded one. */
    readonly declaredVersion: number | null;
}

const ENFORCEMENT_WORDS: Readonly<Record<string, EnforcementWord>> = {
    NETWORK_ENFORCEMENT_MODE_ENFORCE: 'enforce',
    NETWORK_ENFORCEMENT_MODE_AUDIT: 'audit',
    NETWORK_ENFORCEMENT_MODE_UNSPECIFIED: 'unspecified',
    // The numeric forms, for a decoder that hands back the enum's value.
    '1': 'enforce',
    '2': 'audit',
    '0': 'unspecified',
};

/**
 * One endpoint's enforcement, as a word. ANYTHING unrecognised is
 * `unspecified`: a value this reader does not know is not evidence of
 * enforcement, and reading it as one would be the single mistake that turns an
 * unenforced sandbox into a met verdict.
 */
export function enforcementWord(raw: unknown): EnforcementWord {
    if (typeof raw === 'string' && raw in ENFORCEMENT_WORDS) return ENFORCEMENT_WORDS[raw];
    if (typeof raw === 'number' && String(raw) in ENFORCEMENT_WORDS) return ENFORCEMENT_WORDS[String(raw)];
    return 'unspecified';
}

/** `sha256:` over a stable rendering of the policy. Changes when the policy does; carries none of it. */
export function policyDigest(policy: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(policy ?? null), 'utf8').digest('hex')}`;
}

/**
 * Reduce one sandbox's policy to the facts a verdict needs. Reads defensively
 * at every step: a policy that is not an object, a `network_policies` that is
 * not a map, a rule without endpoints, an endpoint that is not an object — each
 * contributes nothing rather than throwing, because a malformed policy is a
 * policy that evidences nothing, not a read that failed.
 */
export function policyFacts(policy: unknown): PolicyFacts {
    const digest = policyDigest(policy);
    const p = policy !== null && typeof policy === 'object' ? (policy as Record<string, unknown>) : {};
    const landlockRaw = p.landlock;
    const landlock =
        landlockRaw !== null && typeof landlockRaw === 'object' && typeof (landlockRaw as Record<string, unknown>).compatibility === 'string'
            ? ((landlockRaw as Record<string, unknown>).compatibility as string)
            : '';

    const enforcement: EnforcementWord[] = [];
    let hostless = 0;
    let endpoints = 0;
    const rules = p.network_policies;
    if (rules !== null && typeof rules === 'object') {
        for (const rule of Object.values(rules as Record<string, unknown>)) {
            if (rule === null || typeof rule !== 'object') continue;
            const list = (rule as Record<string, unknown>).endpoints;
            if (!Array.isArray(list)) continue;
            for (const ep of list) {
                if (ep === null || typeof ep !== 'object') continue;
                endpoints += 1;
                const e = ep as Record<string, unknown>;
                enforcement.push(enforcementWord(e.enforcement));
                if (typeof e.host !== 'string' || e.host === '') hostless += 1;
            }
        }
    }
    let payloadsInspected = false;
    const mws = p.network_middlewares;
    if (mws !== null && typeof mws === 'object') {
        for (const mw of Object.values(mws as Record<string, unknown>)) {
            if (mw === null || typeof mw !== 'object') continue;
            const m = mw as Record<string, unknown>;
            const sel = m.endpoints;
            const include =
                sel !== null && typeof sel === 'object' && Array.isArray((sel as Record<string, unknown>).include)
                    ? ((sel as Record<string, unknown>).include as unknown[])
                    : [];
            // Affirmative on both halves: a stage that selects nothing inspects
            // nothing, and one that fails open can be bypassed by making it fail.
            if (include.length > 0 && m.on_error === 'fail_closed') payloadsInspected = true;
        }
    }
    const v = p.version;
    const declaredVersion = typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;

    return {
        digest,
        enforcement,
        landlock,
        everyEndpointHasHost: endpoints > 0 && hostless === 0,
        endpoints,
        payloadsInspected,
        declaredVersion,
    };
}

/**
 * The verdicts one sandbox's policy supports, and only those.
 *
 * `H3.egress_enforced` (phase 2.1) is met only when there is at least one
 * endpoint and EVERY endpoint reads `enforce`. One audit-mode or unspecified
 * endpoint fails it: the agent can reach whatever that weakest endpoint allows,
 * whatever the others are set to.
 *
 * `H2.tools_allowlisted` needs enforcement AND a host on every endpoint. A
 * hostless endpoint admits any host that resolves into its allowed range, which
 * is not an allow-list of the agent's tool hosts.
 *
 * Filesystem confinement is NOT mapped to a criterion here. `best_effort` is
 * not confinement — it may apply in part, or be dropped whole — and
 * `hard_requirement` alone shows the policy ASKED for confinement, not that the
 * kernel granted it. The landlock mode is carried as evidence for a human and
 * for the phase-3 skill to reason about; it raises nothing on its own.
 */
export function verdictsFor(facts: PolicyFacts, opts: { readonly loaded?: boolean; readonly credentialBound?: boolean } = {}): readonly CriterionVerdict[] {
    /*
        LOADED IS A PRECONDITION ON EVERY POLICY-DERIVED VERDICT, not a verdict
        of its own.

        `GetSandboxPolicyStatus.active_version` is the revision the runtime has
        actually loaded. A policy that declares `enforce` on every endpoint and
        is NOT the loaded revision is a policy in a drawer: the sandbox is
        running under something else. So when the loaded version does not match
        the declared one, nothing below is met — the facts describe a document
        rather than the thing in force, which is the distinction the phase-3
        skill is built around.

        `loaded` is undefined when the status could not be read. Undefined is
        NOT treated as loaded: the same rule as everywhere else here, that only
        an affirmative observation raises a verdict.
    */
    const inForce = opts.loaded === true;
    const allEnforce = inForce && facts.endpoints > 0 && facts.enforcement.every((w) => w === 'enforce');
    const pointer = `openshell-policy:${facts.digest}`;
    const verdict = (criterion: string, met: boolean): CriterionVerdict =>
        ({ criterion, met, evidence: met ? pointer : null }) as CriterionVerdict;
    return [
        verdict('H3.egress_enforced', allEnforce),
        verdict('H2.tools_allowlisted', allEnforce && facts.everyEndpointHasHost),
        verdict('H3.payloads_guarded', inForce && facts.payloadsInspected),
        // Only an estate that opted in to reading providers can evidence this;
        // without the opt-in there is no profile to read, so it stays false.
        verdict('H2.credential_bound', opts.credentialBound === true),
    ];
}

/**
 * Whether the runtime has loaded the policy the sandbox declares.
 *
 * `active_version` is the loaded revision. Equal to the declared version means
 * in force. Anything else — a mismatch, an absent field, a status that could
 * not be read, a declared version the policy did not carry — is not evidence
 * that it is, and returns false rather than null, because every caller would
 * have to treat null as false anyway.
 */
export function policyIsLoaded(status: unknown, declaredVersion: number | null): boolean {
    if (declaredVersion === null) return false;
    if (status === null || typeof status !== 'object') return false;
    const active = (status as Record<string, unknown>).active_version;
    return typeof active === 'number' && Number.isInteger(active) && active === declaredVersion;
}

/**
 * Whether a provider's profile scopes its credential to named endpoints.
 *
 * The profile's `endpoints` are `NetworkEndpoint`s, so a scoped credential is
 * one whose profile names at least one endpoint WITH A HOST. A profile with no
 * endpoints binds the credential to nothing in particular, which is the
 * condition `H2.credential_bound` exists to catch.
 */
export function profileBindsCredential(profile: unknown): boolean {
    if (profile === null || typeof profile !== 'object') return false;
    const eps = (profile as Record<string, unknown>).endpoints;
    if (!Array.isArray(eps) || eps.length === 0) return false;
    return eps.every((ep) => ep !== null && typeof ep === 'object' && typeof (ep as Record<string, unknown>).host === 'string' && (ep as Record<string, unknown>).host !== '');
}

/**
 * One attached provider, by reference. Never its credential keys, never a value.
 *
 * Three members are reported as unknown rather than guessed, and each for a
 * reason the listing itself gives:
 *
 *   • `ageDays: null` — `ListSandboxProviders` names the providers attached;
 *     it carries no rotation time. Reading one would mean a credential-metadata
 *     call this source does not make.
 *   • `expires: null` — likewise. A provider MAY have gateway-managed refresh
 *     configured, which this source cannot see without reading refresh state.
 *   • `grant: 'unknown'` — the schema asks whether a NAMED PERSON bounds what
 *     the credential can reach. A provider may be app-only or may be backed by
 *     a human OAuth grant with refresh, and the attachment listing does not
 *     say which. `app-only` would be a guess that happens to look tidier, and
 *     the honest answer is the one that claims least.
 *
 * `boundToAgent: true` is the one thing the listing DOES establish: this
 * provider is attached to this sandbox.
 */
export function credentialOf(provider: unknown, sandboxId: string): ObservedCredential | null {
    if (provider === null || typeof provider !== 'object') return null;
    const name = (provider as Record<string, unknown>).name;
    if (!isPlainId(name)) return null;
    return {
        ref: `openshell://sandbox/${sandboxId}/provider/${name}`,
        ageDays: null,
        expires: null,
        boundToAgent: true,
        grant: 'unknown',
    };
}

export interface OpenShellOptions {
    readonly target: OpenShellTarget;
    /**
     * Whether the estate opted in to reading attached providers. OFF BY
     * DEFAULT, and 1.1b is the reason: `ListSandboxProviders` returns a
     * `Provider` whose `credentials` map is marked secret in the proto, so it
     * is a secret-bearing read in shape whether or not the gateway redacts it
     * — which is NOT established. `langsmith.ts` gates `readDeployments` the
     * same way and for the same reason.
     *
     * With it off: sandboxes are reported with no credentials, and
     * `H2.credential_bound` is unevidenced. With it on: credentials by
     * reference, the criterion becomes answerable, and the token needs
     * `OPENSHELL_PROFILE_SCOPE` as well.
     */
    readonly readProviders?: boolean;
}

/**
 * The source. One sandbox becomes one observation; a listing that stops early is
 * INCOMPLETE with the wire's reason, never COMPLETE-and-empty.
 */
export function openShellSource(opts: OpenShellOptions): HarnessSource {
    return {
        kind: 'runtime',
        product: 'openshell',
        async read(ctx: SourceContext): Promise<SourceRead> {
            const observations: Observation[] = [];
            let rows = 0;
            try {
                let cursor: string | null = null;
                const seen = new Set<string>();
                do {
                    const page = await ctx.openshell.listSandboxes(opts.target, cursor);
                    for (const raw of page.sandboxes) {
                        rows += 1;
                        if (rows > MAX_SANDBOXES) {
                            throw new SourceReadError('BYTE_CAP', 'the sandbox listing ran past the cap');
                        }
                        const id = sandboxIdOf(raw);
                        if (id === null) continue;
                        if (seen.has(id)) {
                            throw new SourceReadError('PAGINATION_TORN', 'the listing served one sandbox twice');
                        }
                        seen.add(id);
                        observations.push(await observe(ctx, opts.target, id, opts.readProviders === true));
                    }
                    cursor = page.nextCursor;
                } while (cursor !== null);
                return sourceResult('runtime', rows, observations, null);
            } catch (err) {
                return sourceResult('runtime', rows, observations, err);
            }
        },
    };
}

/** A sandbox's id, when the listing row carries a plain one. */
export function sandboxIdOf(raw: unknown): string | null {
    if (raw === null || typeof raw !== 'object') return null;
    const id = (raw as Record<string, unknown>).id ?? (raw as Record<string, unknown>).sandbox_id;
    return isPlainId(id) ? id : null;
}

async function observe(
    ctx: SourceContext,
    target: OpenShellTarget,
    id: string,
    readProviders: boolean,
): Promise<Observation> {
    const sandbox = await ctx.openshell.getSandbox(target, id);
    const spec = sandbox !== null && typeof sandbox === 'object' ? (sandbox as Record<string, unknown>).spec : null;
    const policy = spec !== null && typeof spec === 'object' ? (spec as Record<string, unknown>).policy : null;
    const facts = policyFacts(policy);

    const status = await ctx.openshell.getSandboxPolicyStatus(target, id);
    const loaded = policyIsLoaded(status, facts.declaredVersion);

    // Both provider calls sit behind the one opt-in: the listing because it is
    // secret-bearing in shape, the profile because it needs a second scope.
    let credentials: ObservedCredential[] = [];
    let credentialBound = false;
    if (readProviders) {
        const { providers } = await ctx.openshell.listSandboxProviders(target, id);
        credentials = providers.map((p) => credentialOf(p, id)).filter((c): c is ObservedCredential => c !== null);
        const types = providers
            .map((p) => (p !== null && typeof p === 'object' ? (p as Record<string, unknown>).type : null))
            .filter((v): v is string => isPlainId(v));
        // Bound only when EVERY attached provider's profile scopes it. One
        // unscoped credential is one the agent can point anywhere.
        credentialBound = types.length > 0 && types.length === providers.length;
        for (const type of types) {
            if (!profileBindsCredential(await ctx.openshell.getProviderProfile(target, type))) {
                credentialBound = false;
            }
        }
    }

    return {
        discoveredId: `openshell:sandbox:${id}`,
        // A label in the estate is something its administrator could write.
        owner: null,
        credentials,
        verdicts: verdictsFor(facts, { loaded, credentialBound }),
    };
}
