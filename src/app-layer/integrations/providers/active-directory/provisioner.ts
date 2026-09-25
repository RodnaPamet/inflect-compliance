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
import { DN } from 'ldapts';

import {
    ActiveDirectoryProvider,
    UAC_ACCOUNTDISABLE,
    assertPrivateLdapHost,
    formatObjectGuid,
    type LdapClientLike,
} from './index';
import {
    PROVEN_REFUSAL_RESULT_CODES,
    objectGuidFilter,
    resultCodeOf,
} from './writer';
import type {
    CreateAccountInput,
    CreateAccountStep,
    DirectoryProvisioner,
    IdentifierProbe,
    ProvisionRead,
    ProvisionStep,
} from '@/app-layer/integrations/identity-provisioner';
import { isUnderBaseDn } from './dn-containment';
import { adDirectionWriteRefusal } from './write-direction';

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

/**
 * `entryAlreadyExists`. An ADD that gets this created NOTHING.
 *
 * Not in the writer's shared list and deliberately not added to it: 68 arrives
 * from an AddRequest, and the shared list is what a MODIFY response is read
 * against. A code that proves one operation landed nowhere proves nothing about
 * the other.
 */
const LDAP_ENTRY_ALREADY_EXISTS = 68;

/** The modify list plus the one code only an add can earn. */
const PROVEN_ADD_REFUSAL_RESULT_CODES: ReadonlySet<number> = new Set([
    ...PROVEN_REFUSAL_RESULT_CODES,
    LDAP_ENTRY_ALREADY_EXISTS,
]);

/**
 * REFUSED or INDETERMINATE — the one bit the caller cannot infer.
 *
 * `createDirectoryAccount` does different things with the two, and they are not
 * shades of the same answer. `refused` settles the journal row FAILED and
 * positively asserts the directory did not change; `indeterminate` settles it
 * INDETERMINATE, which is the file both `findRestorableState` and the operator
 * sweep read. Collapsing everything into `indeterminate` — which this module
 * did until #2750 — told an operator "an account may or may not exist" for a
 * create the domain controller had plainly declined with result 50, and put a
 * row that needs no human in the queue that only humans clear.
 *
 * The default is INDETERMINATE and every unrecognised shape keeps it. A
 * transport failure (ETIMEDOUT, ECONNRESET, an abort) carries no LDAP result
 * code at all, because the DC's answer — if it ever sent one — never arrived.
 */
function classifyProvisionFailure(
    err: unknown,
    what: string,
    provenRefusalCodes: ReadonlySet<number> = PROVEN_REFUSAL_RESULT_CODES,
): { kind: 'refused'; detail: string } | { kind: 'indeterminate'; detail: string } {
    const code = resultCodeOf(err);
    const detail = err instanceof Error ? err.message : String(err);
    if (code !== null && provenRefusalCodes.has(code)) {
        return {
            kind: 'refused',
            detail:
                `Active Directory refused ${what} with LDAP result ${code}. The directory parsed the ` +
                `request and declined it, so nothing was written and there is nothing to undo: ${detail}`,
        };
    }
    return {
        kind: 'indeterminate',
        detail:
            `${what} did not report a usable outcome${code === null ? '' : ` (LDAP result ${code})`}: ` +
            `${detail}. Whether the directory changed is UNKNOWN — verify before retrying.`,
    };
}

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

    // Fail CLOSED on the JOINER field — a different key from the leaver's, read
    // strictly, and asked for explicitly so this call site cannot inherit a
    // disable grant by forgetting an argument.
    //
    // This refuses for EVERY connection today, because `AD_JOINER_WRITES_FIELD`
    // is deliberately not on the connection form while `JOINER_MAX_MODE` is
    // `DRY_RUN` (see `write-direction.ts`). That costs nothing now and is the
    // point: `resolveDirectoryProvisioner` builds a live provisioner only at
    // `AUTOMATIC`, and an AUTOMATIC joiner pass is already refused at the clamp
    // before this factory is reached — so the arm is unreachable in both
    // directions, and the gate is here so that the reviewed diff which lifts the
    // clamp does not ALSO, silently, grant create authority over every AD
    // connection that had merely consented to disables.
    const writesRefusal = adDirectionWriteRefusal(connection, 'joiner');
    if (writesRefusal) throw new Error(writesRefusal);

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
            const v = escapeFilterValue(candidate);
            // The local part is what becomes sAMAccountName; the whole value is
            // the UPN. Both are asked because both can collide independently.
            const local = escapeFilterValue(candidate.split('@')[0] ?? candidate);
            let searchEntries: Array<Record<string, unknown>>;
            try {
                const c = await session();
                ({ searchEntries } = await c.search(baseDN, {
                    scope: 'sub',
                    filter: `(|(userPrincipalName=${v})(sAMAccountName=${local}))`,
                    attributes: ['sAMAccountName', 'userPrincipalName', 'objectGUID'],
                    sizeLimit: 2,
                }));
            } catch (err) {
                // A FAILED PROBE IS UNKNOWN, NEVER FREE, and never a throw.
                //
                // The seam's contract says so in as many words, and the live arm
                // was the one implementation that could not honour it: a bind
                // refusal, an unresolvable host or a dropped socket propagated
                // out of here as an exception. A caller that caught it broadly
                // would have had to invent an answer, and the only answers on
                // offer are "free" (the create proceeds into a collision) and a
                // crashed pass. `unknown` NAMES the namespaces it could not
                // consult, so the artefact says which question went unanswered.
                return {
                    kind: 'unknown',
                    namespacesUnavailable: [...AD_COLLISION_NAMESPACES],
                    detail:
                        `The directory could not be asked whether ${JSON.stringify(candidate)} is ` +
                        `claimable: ${err instanceof Error ? err.message : String(err)}. Reported as ` +
                        `UNKNOWN rather than free — "we could not look" must not read as "it is ` +
                        `available".`,
                };
            }
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
            // RFC 4514 via ldapts, NOT a hand-rolled replace. Escaping only `,`
        // is worse than escaping nothing: a displayName of `A\,B` became
        // `A\\,B`, where the first backslash escapes ITSELF and the comma is
        // then a live RDN separator — the attacker picks where the DN splits
        // and which OU the account lands in. `+ " = < > ; #` and edge spaces
        // are all live here too. Only `createOU` is concatenated raw, and that
        // is operator configuration, never user input.
        const dn = `${new DN().addPairRDN('CN', input.displayName).toString()},${createOU}`;
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
                // But a create the DC PARSED AND DECLINED is refused — above all
                // result 68, `entryAlreadyExists`, which is the race the probe
                // structurally cannot close. Reporting that as indeterminate
                // leaves a human to establish by hand what the DC already said.
                return classifyProvisionFailure(
                    err,
                    `the create of ${dn}`,
                    PROVEN_ADD_REFUSAL_RESULT_CODES,
                );
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
            // THE GROUP DN IS CONTAINED, TOO — #2843 finding 51.
            //
            // Every other DN in this file comes from `dnFor()`, which is a
            // search scoped to `baseDN` and therefore contained by
            // construction. `groupId` is not: it arrives from the entitlement
            // map and reaches `c.modify()` as a DN unchecked, so a value naming
            // a group in another naming context — a different domain in the
            // forest, the configuration partition — would be written to without
            // complaint, adding this account to a group nobody scoped.
            //
            // The same suffix test the leaver writer applies to the account it
            // disables, and fail-closed for the same reason: anything it cannot
            // place confidently reads as not contained, and the remedy for a
            // false refusal is a correctly formed `baseDN` on the connection.
            if (!isUnderBaseDn(groupId, baseDN)) {
                return {
                    kind: 'refused',
                    detail:
                        `Refusing to add ${dn} to a group outside this connection's base DN. The ` +
                        `group named is not under ${baseDN}, so it belongs to a naming context this ` +
                        'connection was not scoped to — and a membership grant is exactly the write ' +
                        'that should not reach one.',
                };
            }

            try {
                // Membership lives on the GROUP in AD, not on the user.
                await c.modify(groupId, [{ operation: 'add', type: 'member', values: [dn] }]);
                return { kind: 'applied' };
            } catch (err) {
                return classifyProvisionFailure(err, `adding ${dn} to ${groupId}`);
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
                // A ConstraintViolation here is the password failing the domain's
                // complexity or history policy — declined, nothing written, and a
                // configuration problem rather than a mystery.
                return classifyProvisionFailure(err, `setting a credential on ${dn}`);
            }
        },

        /**
         * Capture `userAccountControl` before the enable touches it — #2840.
         *
         * This exists because the enable below is a READ-MODIFY-WRITE and not a
         * replace, and a read-modify-write needs somewhere honest to put the
         * value it read. That somewhere is the journal row, which is why the
         * capture is its own call: `beginWrite` commits the prior state BEFORE
         * the write is attempted, and a method that read and wrote together
         * could never satisfy that ordering.
         *
         * `indeterminate` when the search itself fails, `refused` when the
         * account does not resolve. The difference is not pedantry: a failed
         * search means we do not know the account's state, and recording "not
         * found" for an account we simply could not look at would let a later
         * restore act on a fact nobody established.
         */
        async readAccountState(externalUserId: string): Promise<ProvisionRead> {
            const c = await session();
            const dn = await dnFor(externalUserId);
            if (!dn) {
                return {
                    kind: 'refused',
                    detail: `No single account resolved for ${externalUserId} under ${baseDN}.`,
                };
            }
            try {
                const { searchEntries } = await c.search(baseDN, {
                    scope: 'sub',
                    filter: objectGuidFilter(externalUserId),
                    attributes: ['userAccountControl'],
                });
                if (searchEntries.length !== 1) {
                    return {
                        kind: 'indeterminate',
                        detail:
                            `Reading userAccountControl for ${externalUserId} returned ` +
                            `${searchEntries.length} entries, so the account's prior state is ` +
                            'unknown. Refusing to enable from a state nobody read.',
                    };
                }
                const raw = searchEntries[0].userAccountControl;
                const uac = Number(raw);
                if (!Number.isFinite(uac)) {
                    return {
                        kind: 'indeterminate',
                        detail:
                            `userAccountControl for ${externalUserId} did not parse as a number, ` +
                            'so there is no value to clear a bit from.',
                    };
                }
                return { kind: 'read', priorState: { userAccountControl: uac } };
            } catch (err) {
                return classifyProvisionFailure(err, `reading prior state for ${dn}`);
            }
        },

        /**
         * Unblock sign-in by CLEARING THE DISABLE BIT, not by replacing the word.
         *
         * Until #2840 this replaced `userAccountControl` with the literal
         * `UAC_NORMAL_ACCOUNT` (0x200). That destroys every other flag on the
         * account — `PASSWORD_NEVER_EXPIRES`, `SMARTCARD_REQUIRED`,
         * `DONT_EXPIRE_PASSWORD`, anything a GPO or an administrator set — and
         * because nothing captured the prior value first, there was no record
         * to restore them from. The account came back usable and quietly
         * differently configured.
         *
         * The leaver writer already refuses that shape in this codebase, in as
         * many words: an unconditional replace "silently reverts every other bit
         * that changed since the read". This is the same verb one direction
         * along, and it now behaves the same way.
         *
         * The prior value comes from `readAccountState` rather than a read here,
         * so the number in the journal and the number this arithmetic is applied
         * to are the same number.
         */
        async enableAccount(
            externalUserId: string,
            prior: Record<string, unknown>,
        ): Promise<ProvisionStep> {
            const c = await session();
            if (!c.modify) return { kind: 'refused', detail: 'This LDAP client cannot modify entries.' };
            const dn = await dnFor(externalUserId);
            if (!dn) {
                return {
                    kind: 'refused',
                    detail: `No single account resolved for ${externalUserId} under ${baseDN}.`,
                };
            }

            // Fail CLOSED on a capture that is missing or unusable. An enable
            // that invents a base value is the unconditional replace wearing a
            // read-modify-write's clothes.
            const priorUac = Number(prior.userAccountControl);
            if (!Number.isFinite(priorUac)) {
                return {
                    kind: 'refused',
                    detail:
                        `Refusing to enable ${dn} without a captured userAccountControl. Without ` +
                        'it there is no value to clear the disable bit FROM, and the only ' +
                        'alternative — replacing the whole word — silently discards every other ' +
                        'flag on the account with nothing journalled to restore them from.',
                };
            }

            const next = priorUac & ~UAC_ACCOUNTDISABLE;
            if (next === priorUac) {
                // Already enabled. Saying so beats writing the same value and
                // reporting a change that did not happen.
                return {
                    kind: 'applied',
                    detail: `${dn} was already enabled (userAccountControl ${priorUac}); no write was needed.`,
                };
            }

            try {
                await c.modify(dn, [
                    {
                        operation: 'replace',
                        type: 'userAccountControl',
                        values: [String(next)],
                    },
                ]);
                return {
                    kind: 'applied',
                    detail: `Cleared ACCOUNTDISABLE on ${dn}: ${priorUac} → ${next}.`,
                };
            } catch (err) {
                return classifyProvisionFailure(err, `enabling ${dn}`);
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
