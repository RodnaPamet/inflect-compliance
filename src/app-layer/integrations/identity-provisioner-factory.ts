/**
 * The one seam from an `IntegrationConnection` to a `DirectoryProvisioner` (#2750).
 *
 * ═══ THE GAP THIS CLOSES ═══
 *
 * #2775 built a live Active Directory provisioner. Nothing could reach it.
 * `createSnapshotProvisioner` was still the only arm anything could obtain,
 * and it refuses all four create steps by name — so the live code existed,
 * was tested, and was unreachable from any pass, at any rung, for any tenant.
 * A capability with no resolution path is indistinguishable from an absent
 * one, which is precisely how the joiner could look finished and create
 * nothing.
 *
 * This file is the resolution path, and it is deliberately the SHAPE of
 * `resolveDirectoryWriter` rather than a new idea. Same refusal vocabulary,
 * same cheapest-first ordering, same `mergeConnection`, same allowlisted mode
 * test, same always-present `close`. A reader who knows one knows the other,
 * and a change to how connections are resolved is one change rather than two
 * that can disagree.
 *
 * ═══ WHERE IT DELIBERATELY DIVERGES, AND WHY ═══
 *
 * **1. Two provider sets, not one.** The writer factory has one:
 * `WRITABLE_IDENTITY_PROVIDERS`, and both members have a live writer. Creating
 * is not symmetric with disabling. Entra IS observed, IS writable, and has no
 * live CREATE arm — decision 2 says the joining credential is a Temporary
 * Access Pass, a TAP needs the authentication-methods policy, that needs
 * `Policy.Read.All`, and that is not among the three permissions the connector
 * requests. It is a per-tenant consent decision nobody has made. So
 * `LIVE_PROVISIONER_PROVIDERS` is a strict subset, and asking for a live Entra
 * provisioner refuses `NO_LIVE_PROVISIONER` rather than falling through to
 * something.
 *
 * **NOT falling through is the point.** `resolveDirectoryWriter`'s last arm is
 * an unguarded `createActiveDirectoryWriter(...)`, so a provider added to the
 * writable set without its own branch silently gets an AD writer — CLAUDE.md
 * names that hazard explicitly. Here the equivalent mistake would hand an
 * Entra create to the AD arm, which binds LDAPS to a host an Entra connection
 * does not have and sets a PASSWORD where the design says a TAP or nothing.
 * The design's words are "AD keeps its own password arm, which is a different
 * provisioner, not a fallback inside this one", so this factory dispatches on
 * an EXPLICIT map and refuses an unmapped provider.
 *
 * **2. No readiness report.** `WriterResolution` carries one; this does not.
 * `describeWriteReadiness` answers a DISABLE's question in a disable's words —
 * "every disable is refused with LDAP result 50 and the leaver is not
 * offboarded" — and a create needs a different right entirely (create-child on
 * the target OU, not write-userAccountControl on an existing user object).
 * Reporting the disable readiness beside a create would answer a question
 * nobody asked, in a sentence naming the wrong permission.
 *
 * **3. No `createOU` gate here.** The provisioner itself refuses per-create
 * when no creation OU is configured, and that is the better place: each
 * candidate then gets a journalled `REFUSED` naming the missing setting,
 * instead of the whole run vanishing behind one factory refusal. A second
 * copy of the check here would be a second spelling free to disagree.
 *
 * ═══ THE SNAPSHOT ARM IS UNCHANGED, AND ITS POSITION IS THE SAFETY ═══
 *
 * `mode !== 'AUTOMATIC'` — written as an ALLOWLIST, for the reason the writer
 * factory spells out at length: the live arm used to be reached by EXHAUSTION,
 * and when `PROPOSE` was retired (#2241) a stored `PROPOSE` became an
 * unrecognised mode that took the live arm. An unrecognised mode opening a
 * socket against a customer's directory — to CREATE, here — is the one thing
 * this subsystem cannot have. `getIdentityWritePolicy` coerces such a value
 * long before it arrives; this is the second lock on the door that opens.
 *
 * The snapshot arm sits BELOW `NO_CONNECTION` / `AMBIGUOUS_CONNECTION` and
 * ABOVE `SECRETS_UNREADABLE`, exactly where the writer factory puts it. It
 * needs no connection FIELDS — it answers `unknown` from nothing — but it does
 * need to know WHICH provider's namespaces it could not consult, and a dry run
 * that reported on a provider with no enabled connection would be describing a
 * directory this tenant does not have.
 *
 * @module integrations/identity-provisioner-factory
 */
import { logger } from '@/lib/observability/logger';
import { runInTenantContext } from '@/lib/db-context';
import type { RequestContext } from '../types';
import {
    createSnapshotProvisioner,
    type ProvisionerRefusal,
    type ProvisionerResolution,
} from './identity-provisioner';
import { mergeConnection } from './identity-writer-factory';
import { isWritesNotEnabledRefusal } from './providers/write-refusal';
import {
    AD_COLLISION_NAMESPACES,
    createActiveDirectoryProvisioner,
} from './providers/active-directory/provisioner';
import { createEntraIdProvisioner } from './providers/entra-id/provisioner';
import {
    WRITABLE_IDENTITY_PROVIDERS,
    isWritableIdentityProvider,
} from './identity-writable-providers';

const NOOP_CLOSE = async (): Promise<void> => {};

/**
 * The namespaces an Entra create collides in.
 *
 * Named here because this factory is the only place that has to hand them to
 * the snapshot arm, and because until #2750 they existed in `src/` ONLY as
 * prose — the same sentence in three docblocks, and nowhere as a value. A dry
 * run's artefact names the namespaces it could not consult, so that list has
 * to BE something.
 *
 * `proxyAddresses` is in the list even though it is multi-valued and Entra
 * enforces uniqueness ACROSS it rather than on it: what the artefact promises
 * is the set of namespaces a plan did not check, and omitting one because it
 * is awkwardly shaped is how a plan gets re-read as having promised more than
 * it checked.
 */
export const ENTRA_COLLISION_NAMESPACES = [
    'userPrincipalName',
    'mailNickname',
    'proxyAddresses',
] as const;

/**
 * Collision namespaces per provider, for the snapshot arm.
 *
 * Keyed by the writable set rather than the live one: a DRY_RUN plan is
 * drivable for EITHER directory, and Entra's inability to create live does not
 * make its namespaces unknowable.
 */
const COLLISION_NAMESPACES: Record<string, readonly string[]> = {
    'entra-id': ENTRA_COLLISION_NAMESPACES,
    'active-directory': AD_COLLISION_NAMESPACES,
};

/**
 * The providers with a LIVE create arm.
 *
 * TWO MEMBERS SINCE #2878 f11. The asymmetry was never an unfinished port — it
 * was a consent decision, recorded in this module's header: an Entra joiner
 * needs a Temporary Access Pass, a pass needs `Policy.Read.All`, and nobody had
 * decided whether to ask customers for it. That decision has been made, and the
 * permission is now requested in the setup guide alongside a SEPARATE
 * per-connection opt-in, because Entra's consent list cannot hold creating and
 * disabling apart.
 *
 * Adding a member still means adding a branch in `buildLiveProvisioner` below;
 * there is no fall-through arm, so a name added here alone refuses loudly
 * instead of silently getting another provider's.
 */
export const LIVE_PROVISIONER_PROVIDERS = ['active-directory', 'entra-id'] as const;

export function hasLiveProvisioner(provider: string): boolean {
    return (LIVE_PROVISIONER_PROVIDERS as readonly string[]).includes(provider);
}

export interface ResolveProvisionerInput {
    readonly ctx: RequestContext;
    readonly provider: string;
    /**
     * The rung this pass is running at. ONLY `AUTOMATIC` gets a live
     * provisioner — see the allowlist below, deliberately written that way
     * round.
     *
     * `string` rather than `IdentityWriteMode` because this is the boundary a
     * STORED value crosses, and the arm below is what makes an unrecognised
     * one harmless instead of live.
     */
    readonly mode: string;
}

/**
 * Build the one live arm this seam has. No fall-through — see the header.
 *
 * Throws on an unmapped provider rather than returning null, so the caller's
 * single try/catch turns a constructor refusal and a missing branch into the
 * same named refusal instead of two shapes.
 */
function buildLiveProvisioner(
    provider: string,
    connection: Record<string, unknown>,
): { provisioner: ReturnType<typeof createActiveDirectoryProvisioner> } {
    if (provider === 'active-directory') {
        return { provisioner: createActiveDirectoryProvisioner({ connection }) };
    }
    if (provider === 'entra-id') {
        // Fails CLOSED on `joinerWritesEnabled` inside the factory, before it
        // reads a credential — so a tenant that consented Policy.Read.All for
        // any other reason still gets a refusal here, not a provisioner.
        return { provisioner: createEntraIdProvisioner({ connection }) };
    }
    throw new Error(
        `No live provisioner is wired for ${provider}. This is a wiring bug rather than a ` +
            'directory condition: the provider passed the LIVE_PROVISIONER_PROVIDERS check and ' +
            'then found no branch to build.',
    );
}

/**
 * Resolve the provisioner for one (tenant, provider), or say precisely why not.
 *
 * Refusals are ordered cheapest-first: an unsupported provider costs nothing to
 * reject, and the connection read only happens for a provider that could have
 * had a provisioner at all.
 */
export async function resolveDirectoryProvisioner(
    input: ResolveProvisionerInput,
): Promise<ProvisionerResolution> {
    const { ctx, provider, mode } = input;

    if (!isWritableIdentityProvider(provider)) {
        return {
            kind: 'none',
            refusal: 'UNSUPPORTED_PROVIDER',
            detail:
                `${provider} is not a directory this product writes to. Only ` +
                `${WRITABLE_IDENTITY_PROVIDERS.join(' and ')} are, and only ` +
                `${LIVE_PROVISIONER_PROVIDERS.join(' and ')} can create.`,
        };
    }

    const conns = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findMany({
            where: { tenantId: ctx.tenantId, provider, isEnabled: true },
            select: { id: true, configJson: true, secretEncrypted: true },
            orderBy: { id: 'asc' },
            // Three is enough to tell "one" from "more than one" without
            // reading a directory's worth of connections to say so.
            take: 3,
        }),
    );

    if (conns.length === 0) {
        return {
            kind: 'none',
            refusal: 'NO_CONNECTION',
            detail: `No enabled ${provider} connection for this tenant.`,
        };
    }
    if (conns.length > 1) {
        return {
            kind: 'none',
            refusal: 'AMBIGUOUS_CONNECTION',
            detail:
                `${conns.length} enabled ${provider} connections. A provisioner is resolved per ` +
                '(tenant, provider), so one of them would have to be chosen for every create — and ' +
                'a create is worse to misdirect than a disable: the account would be made in the ' +
                'wrong forest, under a name the right forest has not reserved, and the leaver pass ' +
                'would later look for it where it is not. Leave one connection enabled.',
        };
    }

    // THE SNAPSHOT ARM. `!== 'AUTOMATIC'` is an allowlist on purpose — see the
    // module header, and `identity-writer-factory` for the incident that made
    // it one. Nothing below this line is reached by a tenant at DISABLED or
    // DRY_RUN, and no socket is opened for them.
    if (mode !== 'AUTOMATIC') {
        return {
            kind: 'snapshot',
            provisioner: createSnapshotProvisioner(
                provider,
                COLLISION_NAMESPACES[provider] ?? [],
            ),
            close: NOOP_CLOSE,
        };
    }

    // ONLY AUTOMATIC REACHES HERE, so this is where "Entra cannot create" has
    // to be said. It is said AFTER the snapshot arm rather than beside
    // UNSUPPORTED_PROVIDER, because an Entra tenant must still be able to run a
    // DRY_RUN joiner pass end to end — refusing it at the top would make the
    // seven-day observation window unavailable for the directory most tenants
    // actually have.
    if (!hasLiveProvisioner(provider)) {
        return {
            kind: 'none',
            refusal: 'NO_LIVE_PROVISIONER',
            detail:
                `${provider} can be observed and disabled but not created in. Only ` +
                `${LIVE_PROVISIONER_PROVIDERS.join(' and ')} have a live create arm.`,
        };
    }

    let connection: Record<string, unknown>;
    try {
        connection = mergeConnection(conns[0]);
    } catch (err) {
        return {
            kind: 'none',
            refusal: 'SECRETS_UNREADABLE',
            detail: `The ${provider} connection's secrets could not be decrypted: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    try {
        const { provisioner } = buildLiveProvisioner(provider, connection);
        return {
            kind: 'live',
            provisioner,
            // A REAL obligation, unlike the snapshot arm's. The AD provisioner
            // holds an LDAP bind; `close()` is documented never to throw, and
            // the caller's finally is unconditional, so a leaked bind needs
            // both of those to fail at once.
            close: () => provisioner.close(),
        };
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        // Classified, not hardcoded — mirroring `identity-writer-factory`. A
        // connection that deliberately did not opt in to joiner writes is an
        // OPERATOR STATE, and reporting it as an unexplained `WRITER_REFUSED`
        // sends somebody to debug a directory that is behaving exactly as
        // configured. `WRITES_NOT_ENABLED` is already in `ProvisionerRefusal`
        // via `WriterRefusal`; only the classification was missing.
        const refusal: ProvisionerRefusal = isWritesNotEnabledRefusal(detail)
            ? 'WRITES_NOT_ENABLED'
            : 'WRITER_REFUSED';
        // Logged WITHOUT the detail. A constructor refusal's message can quote
        // connection fields, and this line is the one thing about a failed
        // create that reaches the ordinary log stream.
        logger.warn('directory provisioner could not be constructed', {
            component: 'identity-provisioner-factory',
            tenantId: ctx.tenantId,
            provider,
            refusal,
        });
        return { kind: 'none', refusal, detail };
    }
}
