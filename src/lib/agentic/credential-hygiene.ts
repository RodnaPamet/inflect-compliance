/**
 * AGENT CREDENTIAL HYGIENE — the rules, decided purely (#3670, step 2b).
 *
 * A daily pass reads every live API key and every external MCP server
 * connection in a tenant and raises a Finding for each weakness below. It
 * WRITES NO CREDENTIAL: it does not revoke, rotate, expire or rebind anything.
 * A weak credential is somebody's decision to fix, and the finding is how they
 * are told; an automatic revocation would take an integration down on a rule
 * nobody chose for that key.
 *
 * ## The five rules
 *
 * | Rule | Fires when | Severity |
 * |---|---|---|
 * | `KEY_UNUSED_30_DAYS` | a live key last used more than 30 days ago, or never used and created more than 30 days ago | MEDIUM |
 * | `KEY_NO_EXPIRY` | a live key with `expiresAt` NULL | MEDIUM |
 * | `KEY_OLDER_THAN_ROTATION_AGE` | a live key created longer ago than the rotation age | MEDIUM |
 * | `KEY_NOT_BOUND_TO_AGENT` | a live key the `/api/mcp` gate would admit, with `agentId` NULL | LOW |
 * | `CONNECTION_APP_ONLY_NO_OWNER` | an `mcp-server` connection whose grant is app-only and which names no accountable owner | HIGH |
 *
 * "Live" is `revokedAt IS NULL` and not past `expiresAt` — the set the
 * authenticator would accept. A revoked or expired key cannot be used, so it is
 * not hygiene's subject, and a finding on one is resolved.
 *
 * ## The population is AGENT credentials, not every key
 *
 * A key rule reads only a key that is bound to a registered agent or that the
 * `/api/mcp` capability gate would admit (`admitsMcpEndpoint`, the gate's own
 * predicate). Most keys are integrations — a CI job with `controls:read` — and
 * the schema says binding them to an agent "would make the register a lie", so
 * `KEY_NOT_BOUND_TO_AGENT` on every one of them would be a finding nobody can
 * act on. A key that can reach the agent surface and names no agent is the real
 * weakness: an agent using it is an unregistered principal. A key outside the
 * population fires nothing, and an open finding on it resolves — a complete
 * read that shows the key is not an agent credential is evidence the rule no
 * longer applies.
 *
 * ## The rotation age: there is no tenant setting, and the rule says so
 *
 * Nothing on `TenantSecuritySettings` holds a key rotation age. The rule uses
 * `DEFAULT_KEY_ROTATION_DAYS` (90) for every tenant and records
 * `rotationAgeSource: 'DEFAULT_NO_TENANT_SETTING'` on the pass row and in each
 * finding's text, so nobody reads the number as a tenant's own policy. 90 days
 * is the conservative choice of the two available: skipping the rule would make
 * a key that has never been rotated indistinguishable from a compliant one.
 * A per-tenant age is an open question for the owner, not something this pass
 * invents a column for.
 *
 * ## The connection rule
 *
 * The accountable owner is `IntegrationConnection.ownerUserId` (integration
 * passport field P11, step 2d), counted only while that person holds an ACTIVE
 * membership — the passport's own rule. An app-only `mcp-server` connection
 * with no such owner fires: an app-only grant is a token no person bounds, and
 * nobody is named to answer for it. The grant kind
 * is resolved by the runtime's own resolver, `resolveMcpCredentials`, and only
 * the kind is kept — the passport's "one secret read, presence only" rule.
 *
 * ## Resolution is on positive evidence only
 *
 * A finding closes when a COMPLETE read shows its rule no longer fires: the key
 * is no longer live, or is live and passes; the connection is gone, or its grant
 * is no longer app-only, or it names an owner. A connection whose grant kind
 * could not be resolved is HELD — neither raised nor resolved — and reported on
 * the row, because "could not read" is not evidence of anything.
 *
 * @module lib/agentic/credential-hygiene
 */
import { admitsMcpEndpoint } from '@/lib/mcp/endpoint-scope';

/** `Finding.sourceKind` for every hygiene finding. */
export const HYGIENE_FINDING_SOURCE_KIND = 'AGENT_CREDENTIAL_HYGIENE';

/** `IntegrationExecution.automationKey` for a hygiene pass row. */
export const HYGIENE_AUTOMATION_KEY = 'agentic.credential_hygiene';

/** Days without use before a live key is reported. */
export const KEY_UNUSED_DAYS = 30;

/** The rotation age applied while no tenant setting exists. See the header. */
export const DEFAULT_KEY_ROTATION_DAYS = 90;

/** Where the rotation age came from, recorded on every row. */
export const ROTATION_AGE_SOURCE = 'DEFAULT_NO_TENANT_SETTING';

/** Reads past this many rows of one kind refuse the pass rather than trim it. */
export const MAX_HYGIENE_READ = 5_000;

export const HYGIENE_RULES = [
    'KEY_UNUSED_30_DAYS',
    'KEY_NO_EXPIRY',
    'KEY_OLDER_THAN_ROTATION_AGE',
    'KEY_NOT_BOUND_TO_AGENT',
    'CONNECTION_APP_ONLY_NO_OWNER',
] as const;
export type HygieneRule = (typeof HYGIENE_RULES)[number];

export type HygieneSeverity = 'LOW' | 'MEDIUM' | 'HIGH';

export const RULE_SEVERITY: Readonly<Record<HygieneRule, HygieneSeverity>> = {
    KEY_UNUSED_30_DAYS: 'MEDIUM',
    KEY_NO_EXPIRY: 'MEDIUM',
    KEY_OLDER_THAN_ROTATION_AGE: 'MEDIUM',
    KEY_NOT_BOUND_TO_AGENT: 'LOW',
    CONNECTION_APP_ONLY_NO_OWNER: 'HIGH',
};

const DAY_MS = 86_400_000;

/** The facts about one API key the rules read. */
export interface KeyFacts {
    id: string;
    name: string;
    keyPrefix: string;
    createdAt: Date;
    lastUsedAt: Date | null;
    expiresAt: Date | null;
    revokedAt: Date | null;
    agentId: string | null;
    /** The key's scope strings, as stored. Decides membership of the population. */
    scopes: readonly string[];
}

/**
 * The grant a connection holds, as `resolveMcpCredentials` classifies it, plus
 * `unreadable` for a secret that could not be decrypted or parsed.
 */
export type ConnectionGrantKind =
    | 'delegated'
    | 'app-only'
    | 'static-header'
    | 'none'
    | 'invalid'
    | 'unreadable';

/** The facts about one external MCP server connection the rules read. */
export interface ConnectionFacts {
    id: string;
    name: string;
    grantKind: ConnectionGrantKind;
    /** `IntegrationConnection.ownerUserId` when that person is an ACTIVE member here, else null (passport P11). */
    namedOwnerUserId: string | null;
}

/** Would the authenticator accept this key now? */
export function isLiveKey(key: Pick<KeyFacts, 'revokedAt' | 'expiresAt'>, now: Date): boolean {
    if (key.revokedAt !== null) return false;
    return key.expiresAt === null || key.expiresAt.getTime() > now.getTime();
}

/**
 * Is this key an agent credential — hygiene's population? Bound to an agent, or
 * admitted by the `/api/mcp` gate. See the header.
 */
export function isAgentCredential(key: Pick<KeyFacts, 'agentId' | 'scopes'>): boolean {
    return key.agentId !== null || admitsMcpEndpoint(key.scopes);
}

/**
 * Every key rule this key fires. A key that is not live, or is not an agent
 * credential, fires none.
 */
export function keyRuleHits(key: KeyFacts, now: Date, rotationDays: number): HygieneRule[] {
    if (!isLiveKey(key, now)) return [];
    if (!isAgentCredential(key)) return [];
    const hits: HygieneRule[] = [];
    const unusedSince = key.lastUsedAt ?? key.createdAt;
    if (now.getTime() - unusedSince.getTime() > KEY_UNUSED_DAYS * DAY_MS) hits.push('KEY_UNUSED_30_DAYS');
    if (key.expiresAt === null) hits.push('KEY_NO_EXPIRY');
    if (now.getTime() - key.createdAt.getTime() > rotationDays * DAY_MS) {
        hits.push('KEY_OLDER_THAN_ROTATION_AGE');
    }
    if (key.agentId === null) hits.push('KEY_NOT_BOUND_TO_AGENT');
    return hits;
}

/**
 * Can the rules judge this connection at all?
 *
 * `invalid` IS judgeable: the resolver read the configuration and refused it as
 * partial, which is a definite answer — no token of either grant can be minted
 * from it, so it is not an app-only grant. `unreadable` is not: the secret
 * could not be decrypted, and nothing was learned about the grant.
 */
export function isConnectionJudgeable(conn: Pick<ConnectionFacts, 'grantKind'>): boolean {
    return conn.grantKind !== 'unreadable';
}

/** Every connection rule this connection fires. An unjudgeable one fires none. */
export function connectionRuleHits(conn: ConnectionFacts): HygieneRule[] {
    if (!isConnectionJudgeable(conn)) return [];
    return conn.grantKind === 'app-only' && conn.namedOwnerUserId === null
        ? ['CONNECTION_APP_ONLY_NO_OWNER']
        : [];
}

export type CredentialKind = 'api_key' | 'connection';

/** The idempotency key of one (rule, credential) finding. */
export function hygieneSourceRef(rule: HygieneRule, kind: CredentialKind, id: string): string {
    return `${rule}:${kind}:${id}`;
}

/** The inverse of `hygieneSourceRef`, or null for a ref this module did not write. */
export function parseHygieneSourceRef(
    ref: string,
): { rule: HygieneRule; kind: CredentialKind; id: string } | null {
    const [rule, kind, ...rest] = ref.split(':');
    const id = rest.join(':');
    if (!(HYGIENE_RULES as readonly string[]).includes(rule)) return null;
    if (kind !== 'api_key' && kind !== 'connection') return null;
    if (id.length === 0) return null;
    return { rule: rule as HygieneRule, kind, id };
}

/** One finding the pass asserts. Title and description are sanitised by the caller. */
export interface PlannedHygieneFinding {
    sourceRef: string;
    rule: HygieneRule;
    severity: HygieneSeverity;
    credentialKind: CredentialKind;
    credentialId: string;
    title: string;
    description: string;
}

function keyLabel(key: KeyFacts): string {
    return `API key "${key.name}" (${key.keyPrefix}…)`;
}

function describeKeyRule(rule: HygieneRule, key: KeyFacts, rotationDays: number): { title: string; description: string } {
    const label = keyLabel(key);
    switch (rule) {
        case 'KEY_UNUSED_30_DAYS':
            return {
                title: `${label} has not been used for ${KEY_UNUSED_DAYS} days`,
                description:
                    `${label} is live and has not authenticated for more than ${KEY_UNUSED_DAYS} days` +
                    `${key.lastUsedAt === null ? ' — it has never been used' : ''}. A live credential ` +
                    'nobody uses is standing access: revoke it, or record why it must stay.',
            };
        case 'KEY_NO_EXPIRY':
            return {
                title: `${label} never expires`,
                description:
                    `${label} carries no expiry, so it stays valid until somebody revokes it. ` +
                    'Issue a replacement with an expiry and revoke this one.',
            };
        case 'KEY_OLDER_THAN_ROTATION_AGE':
            return {
                title: `${label} is older than the ${rotationDays}-day rotation age`,
                description:
                    `${label} was created more than ${rotationDays} days ago and has not been rotated. ` +
                    `The rotation age is the product default (${rotationDays} days) because this ` +
                    'workspace has no rotation-age setting of its own. Rotate the key.',
            };
        case 'KEY_NOT_BOUND_TO_AGENT':
            return {
                title: `${label} is bound to no registered agent`,
                description:
                    `${label} names no registered agent, so an agent using it acts as an ` +
                    'unregistered principal and its actions are attributed to no accountable owner. ' +
                    'Bind it to the agent that uses it, or record that no agent does.',
            };
        default:
            return { title: label, description: label };
    }
}

/**
 * Plan one tenant's pass: what to assert, what to resolve, what to hold.
 *
 * `openRefs` are the source refs of the tenant's hygiene findings that are not
 * CLOSED. Every one of them ends in exactly one of `assert` (still fires),
 * `resolve` (positive evidence it no longer does) or `held` (its connection
 * could not be judged on this read).
 */
export function planHygiene(input: {
    keys: readonly KeyFacts[];
    connections: readonly ConnectionFacts[];
    openRefs: readonly string[];
    now: Date;
    rotationDays: number;
}): {
    assert: PlannedHygieneFinding[];
    resolve: string[];
    held: string[];
    unjudgeableConnectionIds: string[];
} {
    const assert: PlannedHygieneFinding[] = [];
    for (const key of input.keys) {
        for (const rule of keyRuleHits(key, input.now, input.rotationDays)) {
            const { title, description } = describeKeyRule(rule, key, input.rotationDays);
            assert.push({
                sourceRef: hygieneSourceRef(rule, 'api_key', key.id),
                rule,
                severity: RULE_SEVERITY[rule],
                credentialKind: 'api_key',
                credentialId: key.id,
                title,
                description,
            });
        }
    }

    const unjudgeableConnectionIds: string[] = [];
    for (const conn of input.connections) {
        if (!isConnectionJudgeable(conn)) {
            unjudgeableConnectionIds.push(conn.id);
            continue;
        }
        for (const rule of connectionRuleHits(conn)) {
            assert.push({
                sourceRef: hygieneSourceRef(rule, 'connection', conn.id),
                rule,
                severity: RULE_SEVERITY[rule],
                credentialKind: 'connection',
                credentialId: conn.id,
                title: `MCP server connection "${conn.name}" uses an app-only grant and names no owner`,
                description:
                    `The external MCP server connection "${conn.name}" authenticates with an app-only ` +
                    'grant — a token no person bounds — and no accountable owner is named for it. ' +
                    "Name one on the connection's admin page (integration passport field P11); until " +
                    "then the workspace's OWNERs answer for it.",
            });
        }
    }

    const asserted = new Set(assert.map((f) => f.sourceRef));
    const unjudgeable = new Set(unjudgeableConnectionIds);
    const resolve: string[] = [];
    const held: string[] = [];
    for (const ref of input.openRefs) {
        if (asserted.has(ref)) continue;
        const parsed = parseHygieneSourceRef(ref);
        // A ref this module cannot parse was not written by it, so this read
        // has no evidence about it either way.
        if (!parsed) {
            held.push(ref);
            continue;
        }
        if (parsed.kind === 'connection' && unjudgeable.has(parsed.id)) {
            held.push(ref);
            continue;
        }
        resolve.push(ref);
    }

    return { assert, resolve, held, unjudgeableConnectionIds };
}
