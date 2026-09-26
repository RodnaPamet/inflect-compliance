/**
 * Creating an account in Microsoft Entra ID, and minting its first credential.
 *
 * ═══ WHAT THIS REPLACES, AND WHY THE REFUSAL WAS RIGHT UNTIL NOW ═══
 *
 * `identity-provisioner-factory` refused Entra creates outright, and said why:
 * the joining credential is a Temporary Access Pass, a TAP needs
 * `Policy.Read.All`, and that was *"not among the permissions this connector
 * requests, and a consent decision somebody has to make"*. That refusal was
 * correct for as long as nobody had made the decision. It has now been made
 * (#2878 f11), and the sentence it turned on stays true either way: this does
 * not degrade to a password, because a silent downgrade is a different security
 * posture from the one the tenant configured.
 *
 * ═══ CONSENT IS NECESSARY AND NEVER SUFFICIENT ═══
 *
 * Entra's consent list cannot separate creating from disabling —
 * `User.ReadWrite.All` is itself a member of the writer's `WRITE_ROLES`, and a
 * client-credentials token asks for `.default`, which returns whatever an
 * administrator already consented rather than what this call needs. So a tenant
 * that grants `Policy.Read.All` for any unrelated reason must gain nothing here.
 *
 * The per-connection flag is the only place that separation can be stated, and
 * this factory fails CLOSED on it before it reads anything else — the same
 * shape the Active Directory provisioner uses, and for the same reason its
 * comment gives: so that a reviewed diff lifting the clamp does not ALSO,
 * silently, grant create authority over every connection that had merely
 * consented to disables.
 *
 * ═══ NEVER A PASSWORD, AND NEVER A PASSWORD FALLBACK ═══
 *
 * If the authentication-methods policy has Temporary Access Pass disabled,
 * `issueCredential` REFUSES. It does not fall back, because the fallback would
 * be a password — a credential the tenant's own policy declined to permit, hung
 * on an account this product just created. Active Directory keeps its password
 * arm, which is a different provisioner, not a fallback inside this one.
 */
import { getEntraAccessToken } from './index';
import { assertEntraObjectId } from './writer';
import { directionWriteRefusal, JOINER_CREATE_ROLE, JOINER_CREDENTIAL_ROLE } from './write-direction';
import type {
    CreateAccountInput,
    CreateAccountStep,
    DirectoryProvisioner,
    IdentifierProbe,
    ProvisionRead,
    ProvisionStep,
} from '../../identity-provisioner';
import { randomBytes } from 'node:crypto';
import { resilientFetch } from '../../http-resilience';

const GRAPH = 'https://graph.microsoft.com/v1.0';

/**
 * The namespaces a create collides in here.
 *
 * Declared rather than inferred: Entra enforces uniqueness on
 * `userPrincipalName` and on `mailNickname`, and `proxyAddresses` collides
 * across the tenant even though Graph will not let you filter on it. The third
 * is named because `probeIdentifier` reports what it COULD consult, and a list
 * that quietly omitted one would let an old artefact be re-read as having
 * promised more than it checked.
 */
const COLLISION_NAMESPACES = ['userPrincipalName', 'mailNickname', 'proxyAddresses'] as const;

/** What `probeIdentifier` can actually ask Graph about. */
const PROBED_NAMESPACES = ['userPrincipalName', 'mail'] as const;

export interface EntraIdProvisionerOptions {
    /** Merged connection config and secrets. */
    readonly connection: Record<string, unknown>;
    readonly doFetch?: typeof fetch;
}

function bodyOf(res: Response, text: string): string {
    // Graph error bodies are `{ error: { code, message } }`. The code is the
    // part worth quoting — the message often embeds the object id, which this
    // subsystem does not put in logs.
    try {
        const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
        return parsed.error?.code ?? `${res.status}`;
    } catch {
        return `${res.status}`;
    }
}

export function createEntraIdProvisioner(
    options: EntraIdProvisionerOptions,
): DirectoryProvisioner & { close(): Promise<void> } {
    const connection = options.connection;
    const doFetch = options.doFetch ?? resilientFetch;

    // FAIL CLOSED ON THE JOINER FIELD, before anything else is read. A
    // different key from the leaver's, compared strictly, and asked for
    // explicitly so this call site cannot inherit a disable grant by forgetting
    // an argument.
    const refusal = directionWriteRefusal(connection, 'joiner');
    if (refusal) throw new Error(refusal);

    let token: string | null = null;
    async function auth(): Promise<string> {
        if (token) return token;
        token = await getEntraAccessToken(connection, doFetch);
        return token;
    }

    async function graph(
        method: string,
        path: string,
        body?: unknown,
    ): Promise<{ ok: boolean; status: number; text: string }> {
        const t = await auth();
        const res = await doFetch(`${GRAPH}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${t}`,
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = res.status === 204 ? '' : await res.text().catch(() => '');
        return { ok: res.ok, status: res.status, text };
    }

    /**
     * Is a Temporary Access Pass permitted in this directory at all?
     *
     * THREE ANSWERS, AND "COULD NOT READ" IS NOT PERMISSION. A policy this
     * provisioner could not consult is reported as unknown and refuses, for the
     * same reason `probeIdentifier` reports an unread namespace as unknown
     * rather than free: an answer nobody got must never be recorded as a good
     * one. The cost of being wrong in that direction is an account created for
     * a credential the directory will not issue.
     */
    async function tapPolicyState(): Promise<
        { kind: 'enabled' } | { kind: 'disabled' | 'unknown'; detail: string }
    > {
        const res = await graph(
            'GET',
            '/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/TemporaryAccessPass',
        );
        if (res.status === 403) {
            return {
                kind: 'unknown',
                detail:
                    `Refusing to create: this application cannot read the authentication-methods policy, so ` +
                    `whether a Temporary Access Pass can be issued here is unknown. An administrator must ` +
                    `consent ${JOINER_CREDENTIAL_ROLE}. Nothing was created — an account with no issuable ` +
                    'credential is worse than no account.',
            };
        }
        if (!res.ok) {
            return {
                kind: 'unknown',
                detail:
                    'Refusing to create: the authentication-methods policy could not be read, so whether a ' +
                    'Temporary Access Pass can be issued here is unknown. Nothing was created. An answer ' +
                    'nobody got is not permission.',
            };
        }
        let state: string | undefined;
        try {
            state = (JSON.parse(res.text) as { state?: string }).state;
        } catch {
            return {
                kind: 'unknown',
                detail: 'Refusing to create: the authentication-methods policy could not be parsed.',
            };
        }
        if (state !== 'enabled') {
            return {
                kind: 'disabled',
                detail:
                    'Refusing to create: this directory’s authentication-methods policy does not permit a ' +
                    'Temporary Access Pass, which is the only joining credential this product will issue ' +
                    'here. Refusing rather than falling back to a password: that would be a different ' +
                    'security posture from the one the tenant configured. Nothing was created. Enable the ' +
                    'Temporary Access Pass method for the joiner population, or provision this person by hand.',
            };
        }
        return { kind: 'enabled' };
    }

    return {
        provider: 'entra-id',
        collisionNamespaces: COLLISION_NAMESPACES,

        async probeIdentifier(candidate: string): Promise<IdentifierProbe> {
            const value = candidate.trim();
            if (!value) {
                return {
                    kind: 'unknown',
                    namespacesUnavailable: [...PROBED_NAMESPACES],
                    detail: 'No identifier was supplied, so nothing could be asked about.',
                };
            }
            // Graph rejects unescaped single quotes in an OData literal, and a
            // candidate is a caller-shaped string.
            const escaped = value.replace(/'/g, "''");
            const filter = encodeURIComponent(
                `userPrincipalName eq '${escaped}' or mail eq '${escaped}'`,
            );
            const res = await graph('GET', `/users?$filter=${filter}&$select=id,userPrincipalName&$top=1`);
            if (!res.ok) {
                // UNKNOWN, NOT FREE. A namespace that could not be read is
                // recorded as unread — treating a failed probe as availability
                // is the positive negative this subsystem has been bitten by.
                return {
                    kind: 'unknown',
                    namespacesUnavailable: [...PROBED_NAMESPACES],
                    detail: `Graph did not answer the collision read (${bodyOf({ status: res.status } as Response, res.text)}).`,
                };
            }
            let hit: { id?: string } | undefined;
            try {
                hit = (JSON.parse(res.text) as { value?: Array<{ id?: string }> }).value?.[0];
            } catch {
                return {
                    kind: 'unknown',
                    namespacesUnavailable: [...PROBED_NAMESPACES],
                    detail: 'Graph returned a collision read this provisioner could not parse.',
                };
            }
            if (hit) {
                return {
                    kind: 'taken',
                    namespace: 'userPrincipalName',
                    externalUserId: hit.id ?? null,
                    detail: 'An account already holds this identifier in this directory.',
                };
            }
            // HONEST ABOUT WHAT IT CHECKED. `mailNickname` and `proxyAddresses`
            // are declared collision namespaces that Graph will not filter on,
            // so a create can still fail on them. Reporting only what was
            // consulted is what keeps a later artefact from being read as
            // having promised more.
            return { kind: 'free', namespacesChecked: [...PROBED_NAMESPACES] };
        },

        async createBlockedAccount(input: CreateAccountInput): Promise<CreateAccountStep> {
            // ═══ THE POLICY IS READ BEFORE ANYTHING IS CREATED ═══
            //
            // `issueCredential` refuses when the tenant's authentication-methods
            // policy declines a Temporary Access Pass, and that refusal is
            // correct — but it arrives THIRD, after an account has been created
            // and added to its entitlement group. What it leaves behind is an
            // account that exists, is entitled, has no credential and cannot
            // sign in: recoverable, but recoverable by a human who has to work
            // out what happened.
            //
            // Asking first turns that into a refusal with nothing to clean up.
            // It is also the SECOND GATE naming this credential specifically —
            // `joinerWritesEnabled` says the tenant wants joiner writes here,
            // and this says their directory will actually permit the credential
            // those writes depend on. Consent, opt-in, and capability are three
            // different statements.
            //
            // It costs one GET per create, on a path that is already several
            // round trips, and it is the read `Policy.Read.All` was consented
            // for. A policy that cannot be READ is not treated as permission —
            // see below.
            const policy = await tapPolicyState();
            if (policy.kind !== 'enabled') {
                return { kind: 'refused', detail: policy.detail };
            }

            // ═══ THE IDENTIFIER MUST BE A QUALIFIED userPrincipalName ═══
            //
            // The earlier version of this guard was `!upn || !nickname`, and it
            // did not hold: `'pj151326'.split('@')[0]` is `'pj151326'`, so a
            // bare name passed both halves and became the UPN verbatim.
            //
            // The joiner proving run against the lab DC (#2880) produced
            // exactly that on the Active Directory side — an account with
            // `userAccountControl: 512` and a UPN of `pj151326`, created,
            // entitled, ENABLED and impossible to sign in as. Graph is no
            // stricter about it than LDAP was. The check is spelled here the
            // way it is spelled there, and for the same reason: an account
            // nobody can authenticate as looks finished, so nothing downstream
            // ever reports it.
            const upn = input.identifier.trim();
            const at = upn.indexOf('@');
            if (at <= 0 || at !== upn.lastIndexOf('@') || !upn.slice(at + 1).includes('.')) {
                return {
                    kind: 'refused',
                    detail:
                        `Refusing to create an account for "${upn}": a userPrincipalName needs a local part ` +
                        'and a dotted domain suffix. The account would be created, enabled, and impossible ' +
                        'to sign in as.',
                };
            }
            const nickname = upn.slice(0, at);
            const res = await graph('POST', '/users', {
                // BLOCKED, and that is the whole safety argument: the sequence
                // exists so the recoverable half is last. An account nobody can
                // sign into is recoverable by a human.
                accountEnabled: false,
                displayName: input.displayName,
                mailNickname: nickname,
                userPrincipalName: upn,
                // Required by Graph even for a blocked account. Left
                // unusable on purpose — the real credential is the Temporary
                // Access Pass minted two steps later, and this must never be
                // the thing somebody signs in with.
                passwordProfile: {
                    forceChangePasswordNextSignIn: true,
                    password: unusablePassword(),
                },
            });
            if (res.status === 403) {
                return {
                    kind: 'refused',
                    detail:
                        `Graph refused the create. An administrator must consent ${JOINER_CREATE_ROLE} to ` +
                        'this application; the read permissions do not permit it.',
                };
            }
            if (!res.ok) {
                const code = bodyOf({ status: res.status } as Response, res.text);
                // A create that got no answer is INDETERMINATE, not failed: the
                // account may exist. Saying refused would assert it does not.
                if (res.status >= 500 || res.status === 0) {
                    return { kind: 'indeterminate', detail: `Graph did not report the create (${code}).` };
                }
                return { kind: 'refused', detail: `Graph refused the create (${code}).` };
            }
            let id: string | undefined;
            try {
                id = (JSON.parse(res.text) as { id?: string }).id;
            } catch {
                /* fall through to the indeterminate below */
            }
            if (!id) {
                return {
                    kind: 'indeterminate',
                    detail: 'Graph accepted the create but returned no object id, so the account cannot be addressed.',
                };
            }
            return { kind: 'applied', externalUserId: id };
        },

        async assignGroup(externalUserId: string, groupId: string): Promise<ProvisionStep> {
            const id = assertEntraObjectId(externalUserId);
            const res = await graph('POST', `/groups/${encodeURIComponent(groupId)}/members/$ref`, {
                '@odata.id': `${GRAPH}/directoryObjects/${id}`,
            });
            if (res.ok) return { kind: 'applied' };
            // Graph answers an existing membership with 400
            // `One or more added object references already exist`. Idempotent
            // in effect, so it is applied rather than refused — a retry after a
            // lost response must not report failure for work already done.
            if (res.status === 400 && /already exist/i.test(res.text)) {
                return { kind: 'applied', detail: 'The account was already a member of the group.' };
            }
            const code = bodyOf({ status: res.status } as Response, res.text);
            if (res.status >= 500) return { kind: 'indeterminate', detail: `Graph did not report the group add (${code}).` };
            return { kind: 'refused', detail: `Graph refused the group add (${code}).` };
        },

        async issueCredential(externalUserId: string): Promise<ProvisionStep> {
            const id = assertEntraObjectId(externalUserId);
            const res = await graph(
                'POST',
                `/users/${encodeURIComponent(id)}/authentication/temporaryAccessPassMethods`,
                { isUsableOnce: true },
            );
            if (res.ok) {
                // The pass itself is NOT returned, logged, or journalled. It is
                // a bearer credential for this person; the product's job is to
                // mint it into the directory, not to carry it around. An
                // administrator reads it from Entra.
                return { kind: 'applied', detail: 'A Temporary Access Pass was issued.' };
            }
            if (res.status === 403) {
                return {
                    kind: 'refused',
                    detail:
                        `Graph refused to mint a Temporary Access Pass. An administrator must consent ` +
                        `${JOINER_CREDENTIAL_ROLE} to this application — a pass is governed by the ` +
                        'authentication-methods policy and cannot be issued without reading it.',
                };
            }
            if (res.status === 400 && /not enabled|disabled|policy/i.test(res.text)) {
                // REFUSED, NOT DEGRADED. The tenant's own policy has declined
                // this credential type. Falling back to a password would hang a
                // credential the policy did not permit on an account this
                // product just created.
                return {
                    kind: 'refused',
                    detail:
                        'This directory’s authentication-methods policy does not permit a Temporary Access ' +
                        'Pass for this account. Refusing rather than falling back to a password: that would ' +
                        'be a different security posture from the one the tenant configured. Enable the ' +
                        'Temporary Access Pass method for the joiner population, or provision this person by hand.',
                };
            }
            const code = bodyOf({ status: res.status } as Response, res.text);
            if (res.status >= 500) return { kind: 'indeterminate', detail: `Graph did not report the credential (${code}).` };
            return { kind: 'refused', detail: `Graph refused the credential (${code}).` };
        },

        async readAccountState(externalUserId: string): Promise<ProvisionRead> {
            const id = assertEntraObjectId(externalUserId);
            const res = await graph('GET', `/users/${encodeURIComponent(id)}?$select=id,accountEnabled,onPremisesSyncEnabled`);
            if (!res.ok) {
                const code = bodyOf({ status: res.status } as Response, res.text);
                return { kind: 'refused', detail: `Graph did not return the account state (${code}).` };
            }
            let parsed: { accountEnabled?: boolean; onPremisesSyncEnabled?: boolean | null };
            try {
                parsed = JSON.parse(res.text) as typeof parsed;
            } catch {
                return { kind: 'refused', detail: 'Graph returned an account state this provisioner could not parse.' };
            }
            if (parsed.accountEnabled === undefined) {
                // The enable below is derived from this value, and a default
                // here would make the capture a record of our assumption.
                return {
                    kind: 'refused',
                    detail: 'Graph did not report accountEnabled, so there is nothing to capture before the enable.',
                };
            }
            return {
                kind: 'read',
                priorState: {
                    provider: 'entra-id',
                    accountEnabled: parsed.accountEnabled,
                    onPremisesSyncEnabled: parsed.onPremisesSyncEnabled ?? null,
                },
            };
        },

        async enableAccount(externalUserId: string, prior: Record<string, unknown>): Promise<ProvisionStep> {
            const id = assertEntraObjectId(externalUserId);
            if (prior.onPremisesSyncEnabled === true) {
                // Mastered on-premises: this write is reverted at the next
                // Azure AD Connect cycle, so the account would report enabled
                // and then disable itself, with a trail saying onboarding
                // succeeded. The same refusal the writer makes on the way down.
                return {
                    kind: 'refused',
                    detail:
                        `Refusing to enable ${id} through Graph: it is directory-synced, so it is mastered ` +
                        'on-premises and this write would be reverted at the next Azure AD Connect cycle.',
                };
            }
            const res = await graph('PATCH', `/users/${encodeURIComponent(id)}`, { accountEnabled: true });
            if (res.ok) return { kind: 'applied' };
            const code = bodyOf({ status: res.status } as Response, res.text);
            if (res.status >= 500) return { kind: 'indeterminate', detail: `Graph did not report the enable (${code}).` };
            return { kind: 'refused', detail: `Graph refused the enable (${code}).` };
        },

        async close(): Promise<void> {
            // Nothing to close — Graph is stateless HTTP, unlike the LDAP
            // socket the Active Directory provisioner holds. The method exists
            // so callers can treat the two alike.
            token = null;
        },
    };
}

/**
 * A password Graph will accept and nobody will ever use.
 *
 * FROM `node:crypto`, NOT `Math.random`. It is never signed in with — the real
 * credential is the Temporary Access Pass minted two steps later, and the
 * account is created sign-in blocked — but a predictable string in a
 * `passwordProfile` is a predictable password on a real account for the window
 * between the create and the enable, and "nobody uses it" is an argument about
 * intent rather than about reachability.
 */
function unusablePassword(): string {
    return `${randomBytes(24).toString('base64url')}Aa1!`;
}
