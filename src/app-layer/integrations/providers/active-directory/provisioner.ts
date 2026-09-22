/**
 * The LIVE Active Directory provisioner — a joiner that actually creates (#2750).
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * `createSnapshotProvisioner` was the only `DirectoryProvisioner` in the tree.
 * It answers `unknown` to every probe and refuses all four create steps by
 * name, which is correct for a DRY_RUN and means no joiner could create an
 * account in any directory, in any mode, for any tenant. The clamp read like
 * the obstacle; the missing arm was.
 *
 * ═══ WHY ACTIVE DIRECTORY FIRST, AND NOT ENTRA ═══
 *
 * Not preference — Entra is blocked and AD is not. Decision 2 of
 * `jml-joiner-design.md:350`: *"Entra Temporary Access Pass; AD gets a random,
 * never-persisted, must-change password."* A TAP needs the
 * authentication-methods policy, which needs `Policy.Read.All` — **not** among
 * the three permissions the connector requests. That is a per-tenant consent
 * decision somebody has to make.
 *
 * AD needs no such consent: the credential is a password this code sets over
 * the LDAPS channel it already holds. So the AD arm could be built today and
 * the Entra arm could not.
 *
 * THIS IS NOT A FALLBACK. The design is explicit that Entra must refuse rather
 * than degrade to a password, and that *"AD keeps its own password arm, which
 * is a different provisioner, not a fallback inside this one."* Nothing here
 * may ever be reached from an Entra create.
 *
 * ═══ THE ORDER IS THE SAFETY ARGUMENT ═══
 *
 * create BLOCKED → assign group → issue credential → enable. Decision 3.
 *
 * The recoverable half is last. An account that exists but nobody can sign
 * into is recoverable by a human; one anyone can sign into with no entitlements
 * is not observable. Every partial failure therefore leaves the person unable
 * to log in, which is the failure you want.
 *
 * ═══ THE AD ENCODINGS THAT ARE EASY TO GET WRONG ═══
 *
 * - `unicodePwd` goes on the wire as the password wrapped in double quotes and
 *   encoded UTF-16LE. AD rejects a plain string, and the quotes are part of the
 *   format rather than decoration.
 * - Setting a password REQUIRES an encrypted channel. The provider's factory
 *   only issues `ldaps://` clients, so that holds by construction — but it is
 *   why this arm cannot be ported to a plaintext bind "just for testing".
 * - `pwdLastSet = 0` is what forces the change at next logon. `-1` means the
 *   opposite; there is no boolean.
 * - `userAccountControl` 514 = NORMAL_ACCOUNT (512) + ACCOUNTDISABLE (2).
 *
 * @module integrations/providers/active-directory/provisioner
 */
import { randomBytes } from 'node:crypto';

import {
    ActiveDirectoryProvider,
    UAC_ACCOUNTDISABLE,
    assertPrivateLdapHost,
    formatObjectGuid,
    type LdapClientLike,
} from './index';
import { objectGuidFilter } from './writer';
import type {
    CreateAccountInput,
    CreateAccountStep,
    DirectoryProvisioner,
    IdentifierProbe,
    ProvisionStep,
} from '@/app-layer/integrations/identity-provisioner';

/** NORMAL_ACCOUNT. The bit every user object carries. */
const UAC_NORMAL_ACCOUNT = 0x200;

/** Created blocked, per decision 3. */
const UAC_CREATED_BLOCKED = UAC_NORMAL_ACCOUNT | UAC_ACCOUNTDISABLE;

/**
 * The namespaces an AD create collides in.
 *
 * `sAMAccountName` is the one that bites: it is unique per DOMAIN, capped at 20
 * characters, and the product persists it nowhere — which is why a plan that
 * found no conflict is not a statement that the name is free. `userPrincipalName`
 * is unique per forest and is what the derived address maps to.
 */
export const AD_COLLISION_NAMESPACES = ['sAMAccountName', 'userPrincipalName'] as const;

export interface ActiveDirectoryProvisionerOptions {
    /** The merged connection bag: url, baseDN, bind credentials. */
    readonly connection: Record<string, unknown>;
    /** The OU new accounts are created in. Required — never guessed. */
    readonly createOU?: string;
    readonly provider?: ActiveDirectoryProvider;
    /** Injected for tests; production uses crypto.randomBytes. */
    readonly generatePassword?: () => string;
}

/** A password nobody keeps: generated, set, never persisted, changed at logon. */
function defaultPassword(): string {
    // 32 bytes of base64 comfortably clears any complexity policy, and the
    // value never leaves this function except onto the wire.
    return `${randomBytes(24).toString('base64')}aA1!`;
}

/** `"password"` in UTF-16LE — the only form AD accepts for unicodePwd. */
export function encodeUnicodePwd(password: string): Buffer {
    return Buffer.from(`"${password}"`, 'utf16le');
}

/** Escape a value for use inside an LDAP filter (RFC 4515). */
export function escapeFilterValue(v: string): string {
    return v.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

export function createActiveDirectoryProvisioner(
    options: ActiveDirectoryProvisionerOptions,
): DirectoryProvisioner & { close(): Promise<void> } {
    const connection = options.connection;
    const provider = options.provider ?? new ActiveDirectoryProvider();
    const url = String(connection.url ?? '').trim();
    const baseDN = String(connection.baseDN ?? '').trim();
    const createOU = String(options.createOU ?? connection.createOU ?? '').trim();
    const bindDN = String(connection.writeBindDN ?? connection.bindDN ?? '').trim();
    const bindPassword = String(connection.writeBindPassword ?? connection.bindPassword ?? '');
    const generatePassword = options.generatePassword ?? defaultPassword;

    let client: LdapClientLike | null = null;

    async function session(): Promise<LdapClientLike> {
        if (client && client.isBound !== false) return client;
        if (!url) throw new Error('Active Directory provisioner needs an LDAPS URL.');
        if (!baseDN) throw new Error('Active Directory provisioner needs a base DN.');
        if (!bindDN || !bindPassword) {
            throw new Error('Active Directory provisioner needs bind credentials.');
        }
        // Same refusal the writer makes, and for the same reason: a create
        // issued to an attacker-chosen LDAP server answers success, and the
        // journal then records an account that does not exist.
        await assertPrivateLdapHost(url, 'directory-write');
        const c = await provider.makeClient(connection);
        await c.bind(bindDN, bindPassword);
        client = c;
        return c;
    }

    /** Resolve an objectGUID to its DN — every step after create needs one. */
    async function dnFor(externalUserId: string): Promise<string | null> {
        const c = await session();
        const { searchEntries } = await c.search(baseDN, {
            scope: 'sub',
            filter: objectGuidFilter(externalUserId),
            attributes: ['distinguishedName'],
            sizeLimit: 2,
        });
        if (searchEntries.length !== 1) return null;
        return String(searchEntries[0].distinguishedName ?? '') || null;
    }

    return {
        provider: 'active-directory',
        collisionNamespaces: [...AD_COLLISION_NAMESPACES],

        async probeIdentifier(candidate: string): Promise<IdentifierProbe> {
            const c = await session();
            const v = escapeFilterValue(candidate);
            // The local part is what becomes sAMAccountName; the whole value is
            // the UPN. Both are asked because both can collide independently.
            const local = escapeFilterValue(candidate.split('@')[0] ?? candidate);
            const { searchEntries } = await c.search(baseDN, {
                scope: 'sub',
                filter: `(|(userPrincipalName=${v})(sAMAccountName=${local}))`,
                attributes: ['sAMAccountName', 'userPrincipalName', 'objectGUID'],
                sizeLimit: 2,
            });
            if (searchEntries.length === 0) {
                return { kind: 'free', namespacesChecked: [...AD_COLLISION_NAMESPACES] };
            }
            // `taken` names WHICH namespace held it, not merely that something
            // did. The two have different remedies: a `sAMAccountName` clash
            // is a 20-character truncation collision and usually needs a
            // different derivation, while a `userPrincipalName` clash means
            // the person may already have an account.
            const hit = searchEntries[0];
            const upnMatched =
                String(hit.userPrincipalName ?? '').toLowerCase() === candidate.toLowerCase();
            return {
                kind: 'taken',
                namespace: upnMatched ? 'userPrincipalName' : 'sAMAccountName',
                externalUserId: formatObjectGuid(hit.objectGUID as never) ?? null,
                detail: `An account already holds ${candidate} in this directory.`,
            };
        },

        async createBlockedAccount(input: CreateAccountInput): Promise<CreateAccountStep> {
            if (!createOU) {
                return {
                    kind: 'refused',
                    detail:
                        'No creation OU is configured for this connection. A create must land in an OU ' +
                        'the operator chose — guessing one would put a new account somewhere nobody ' +
                        'delegated, and outside whatever the leaver pass is scoped to.',
                };
            }
            const c = await session();
            if (!c.add) {
                return {
                    kind: 'refused',
                    detail: 'This LDAP client cannot create entries (no add support).',
                };
            }
            const sam = (input.identifier.split('@')[0] ?? input.identifier).slice(0, 20);
            const dn = `CN=${input.displayName.replace(/,/g, '\\,')},${createOU}`;
            try {
                await c.add(dn, {
                    objectClass: ['top', 'person', 'organizationalPerson', 'user'],
                    cn: input.displayName,
                    displayName: input.displayName,
                    sAMAccountName: sam,
                    userPrincipalName: input.identifier,
                    // BLOCKED. Decision 3 — the account exists but nobody can
                    // sign in until `enableAccount` runs, last.
                    userAccountControl: String(UAC_CREATED_BLOCKED),
                });
            } catch (err) {
                // A create that may or may not have landed is INDETERMINATE, not
                // refused: the caller must not retry blindly into a duplicate.
                return {
                    kind: 'indeterminate',
                    detail: `Active Directory did not confirm the create: ${(err as Error).message}`,
                };
            }
            const { searchEntries } = await c.search(baseDN, {
                scope: 'sub',
                filter: `(sAMAccountName=${escapeFilterValue(sam)})`,
                attributes: ['objectGUID'],
                sizeLimit: 2,
            });
            const guid =
                searchEntries.length === 1
                    ? formatObjectGuid(searchEntries[0].objectGUID as never)
                    : undefined;
            if (!guid) {
                return {
                    kind: 'indeterminate',
                    detail:
                        'The account was created but its objectGUID could not be read back, so nothing ' +
                        'downstream can address it. It exists and is sign-in blocked.',
                };
            }
            return { kind: 'applied', externalUserId: guid };
        },

        async assignGroup(externalUserId: string, groupId: string): Promise<ProvisionStep> {
            const c = await session();
            if (!c.modify) return { kind: 'refused', detail: 'This LDAP client cannot modify entries.' };
            const dn = await dnFor(externalUserId);
            if (!dn) {
                return {
                    kind: 'refused',
                    detail: `No single account resolved for ${externalUserId} under ${baseDN}.`,
                };
            }
            try {
                // Membership lives on the GROUP in AD, not on the user.
                await c.modify(groupId, [{ operation: 'add', type: 'member', values: [dn] }]);
                return { kind: 'applied' };
            } catch (err) {
                return {
                    kind: 'indeterminate',
                    detail: `Group add not confirmed: ${(err as Error).message}`,
                };
            }
        },

        async issueCredential(externalUserId: string): Promise<ProvisionStep> {
            const c = await session();
            if (!c.modify) return { kind: 'refused', detail: 'This LDAP client cannot modify entries.' };
            const dn = await dnFor(externalUserId);
            if (!dn) {
                return {
                    kind: 'refused',
                    detail: `No single account resolved for ${externalUserId} under ${baseDN}.`,
                };
            }
            const password = generatePassword();
            try {
                await c.modify(dn, [
                    // The Buffer is the point — see the module docblock.
                    {
                        operation: 'replace',
                        type: 'unicodePwd',
                        values: [encodeUnicodePwd(password) as unknown as string],
                    },
                    // 0 forces a change at next logon. -1 means the opposite.
                    { operation: 'replace', type: 'pwdLastSet', values: ['0'] },
                ]);
                // The password is NEVER returned, logged or persisted. It is set
                // and forgotten; the person changes it at first logon. A
                // credential this code could hand back is one it could leak.
                return {
                    kind: 'applied',
                    detail: 'A random must-change password was set and not retained.',
                };
            } catch (err) {
                return {
                    kind: 'indeterminate',
                    detail: `Credential not confirmed: ${(err as Error).message}`,
                };
            }
        },

        async enableAccount(externalUserId: string): Promise<ProvisionStep> {
            const c = await session();
            if (!c.modify) return { kind: 'refused', detail: 'This LDAP client cannot modify entries.' };
            const dn = await dnFor(externalUserId);
            if (!dn) {
                return {
                    kind: 'refused',
                    detail: `No single account resolved for ${externalUserId} under ${baseDN}.`,
                };
            }
            try {
                await c.modify(dn, [
                    {
                        operation: 'replace',
                        type: 'userAccountControl',
                        values: [String(UAC_NORMAL_ACCOUNT)],
                    },
                ]);
                return { kind: 'applied' };
            } catch (err) {
                return {
                    kind: 'indeterminate',
                    detail: `Enable not confirmed: ${(err as Error).message}`,
                };
            }
        },

        async close(): Promise<void> {
            try {
                await client?.unbind?.();
            } catch {
                // A leaked bind is not worth failing a completed create over.
            }
            client = null;
        },
    };
}
