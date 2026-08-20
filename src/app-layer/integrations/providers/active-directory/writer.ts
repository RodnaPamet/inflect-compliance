/**
 * Disabling an on-premises Active Directory account, over LDAPS.
 *
 * ═══ THE PROBLEM THIS FILE IS SHAPED AROUND ═══
 *
 * LDAP has no bitwise-set. `userAccountControl` is a single-valued integer, so
 * "set ACCOUNTDISABLE" means writing the WHOLE integer back — and any bit that
 * changed since we read it is silently reverted. A helpdesk ticking
 * DONT_EXPIRE_PASSWORD (0x10000), a GPO applying SMARTCARD_REQUIRED (0x40000),
 * a script clearing PASSWD_NOTREQD: all undone by a disable that reports
 * success, with nothing anywhere saying so.
 *
 * The window is not theoretical and it is not small. Between
 * `DirectoryWriter.readState` and `DirectoryWriter.disable` the orchestrator
 * commits a Postgres row (`beginWrite`), which is a durability point rather
 * than a memory write.
 *
 * So the write is a compare-and-swap, and LDAP gives us one for free:
 *
 *     modify(dn, [
 *       { operation: 'delete', type: 'userAccountControl', values: [prior] },
 *       { operation: 'add',    type: 'userAccountControl', values: [prior | 0x2] },
 *     ])
 *
 * One ModifyRequest, applied atomically by the DC. A value-specific `delete`
 * fails with noSuchAttribute (result 16) when the current value is not exactly
 * `prior` — an optimistic CAS at the cost of zero extra round trips.
 *
 * NOTE, and it is the load-bearing assumption of this design: delete+add on a
 * single-valued attribute inside one ModifyRequest is the documented technique,
 * but it has not been exercised here against a live domain controller. If a DC
 * rejects the pair, this writer refuses every disable — which is the safe
 * direction, and loud. It must NOT be "fixed" by falling back to `replace`:
 * `replace` is precisely the unconditional clobber the CAS exists to prevent.
 *
 * ═══ CAS AGAINST THE JOURNAL, NOT AGAINST A FRESH READ ═══
 *
 * The comparand is the value in `prior.priorState` — the argument
 * `disable(externalUserId, prior)` already receives — and never a re-read taken
 * inside `disable()`. By then the journal row has COMMITTED `prior` as "what
 * this write replaced". Re-reading would make the write succeed while making
 * that claim false, and a restore months later would put back a value that was
 * never there. CAS-against-`prior` makes the journal true by construction, and
 * a CAS miss routes to `FAILED`, whose documented meaning — the directory is
 * unchanged — is then accurate.
 *
 * ═══ ONE CONNECTION, ONE DOMAIN CONTROLLER ═══
 *
 * `ldaps://dc.corp.example.com` conventionally resolves to EVERY DC in the
 * domain, and AD is multi-master with minutes of inter-site replication lag. A
 * client built per call would let the read and the write land on different
 * servers: the CAS would fail spuriously whenever the read DC trailed the write
 * DC, and `uSNChanged` — which is per-DC and comparable only against the same
 * DC — would be meaningless as a change token.
 *
 * So this writer holds ONE bound connection across `readState` + `disable`, and
 * records which DC answered. That also avoids up to 2,000 simple binds per
 * batch (`disableAccountsForLeaver` iterates sequentially over up to
 * MAX_CANDIDATES = 1,000 candidates, twice each).
 *
 * `DirectoryWriter` has no disposal hook, so this factory returns a writer that
 * ALSO exposes `close()`, and the caller is responsible for calling it around a
 * batch. Stated here rather than leaked: a socket per batch is a real leak, and
 * widening the shared interface for one provider's transport is the worse
 * trade.
 *
 * @module integrations/providers/active-directory/writer
 */
import {
    ActiveDirectoryProvider,
    UAC_ACCOUNTDISABLE,
    assertPrivateLdapHost,
    formatObjectGuid,
    type LdapClientLike,
    type LdapModification,
} from './index';
import {
    DirectoryWriteError,
    InsufficientDirectoryPermission,
    type DirectoryAccountState,
    type DirectoryWriter,
} from '@/app-layer/usecases/identity-disable-account';
import { logger } from '@/lib/observability/logger';

/** The provider id this writer answers for. Must match `ActiveDirectoryProvider.id`. */
export const AD_PROVIDER_ID = 'active-directory';

/**
 * Tag on every capture this writer produces.
 *
 * A restore reads `priorStateJson` out of a row that may be a year old and was
 * written by some earlier version of this file. Without a shape marker it has
 * to guess, and the guess it would make on a thin or foreign capture is to
 * write whatever integer it finds into `userAccountControl`.
 */
export const AD_PRIOR_STATE_SCHEMA = 'ad-account-v1';

/** Attributes captured for the account being disabled. */
const CAPTURE_ATTRIBUTES = [
    'objectGUID',
    'distinguishedName',
    'userAccountControl',
    'uSNChanged',
    'whenChanged',
    'sAMAccountName',
    'userPrincipalName',
    // Diagnostic only — see the AdminSDHolder note in `describeAccessDenied`.
    'adminCount',
];

/**
 * LDAP result codes that PROVE the directory was not mutated.
 *
 * Each of these arrives inside a ModifyResponse, which means the DC parsed the
 * request, evaluated it, and declined — and the whole ModifyRequest is atomic,
 * so a declined one changed nothing.
 *
 * The list is deliberately an allowlist and deliberately short. `busy` (51),
 * `unavailable` (52) and `other` (80) are NOT here: they are plausibly
 * pre-execution refusals, but "plausibly" is the wrong standard for a flag
 * whose false value costs an operator one look, and whose wrong TRUE value
 * files the row under the one outcome that both the restore path
 * (`findRestorableState`, which reads APPLIED / INDETERMINATE) and the operator
 * sweep (`listUnsettledWrites`, which reads PENDING / INDETERMINATE) exclude.
 * Anything absent from this list — including every transport failure, which
 * carries no result code at all — leaves `definitivelyNotApplied` false.
 */
const PROVEN_REFUSAL_RESULT_CODES: ReadonlySet<number> = new Set([
    8, // strongerAuthRequired
    12, // unavailableCriticalExtension
    16, // noSuchAttribute — the CAS miss
    17, // undefinedAttributeType
    19, // constraintViolation
    20, // attributeOrValueExists
    21, // invalidAttributeSyntax
    32, // noSuchObject
    34, // invalidDNSyntax
    49, // invalidCredentials
    50, // insufficientAccessRights
    53, // unwillingToPerform
    65, // objectClassViolation
]);

const LDAP_NO_SUCH_ATTRIBUTE = 16;
const LDAP_NO_SUCH_OBJECT = 32;
const LDAP_INSUFFICIENT_ACCESS = 50;

/**
 * The permission an AD disable actually needs, spelled narrowly on purpose.
 *
 * An operator told only "the account needs write access" reaches for Account
 * Operators or Domain Admins, and granting the unattended sync credential
 * domain-wide admin so that it can disable leavers is the worst available
 * outcome of shipping this writer.
 */
const NEEDED_PERMISSION =
    'Write permission on the userAccountControl property of user objects, delegated at the OU that holds ' +
    'them (Delegation of Control → custom task → user objects → property-specific → Write userAccountControl). ' +
    'Explicitly NOT Account Operators and NOT Domain Admins';

/** A writer that owns a connection, and therefore has to be closed. */
export interface ClosableDirectoryWriter extends DirectoryWriter {
    /**
     * Release the bound connection. Safe to call more than once, and never
     * throws — a failed unbind must not turn a completed batch into an error.
     */
    close(): Promise<void>;
}

export interface ActiveDirectoryWriterOptions {
    /**
     * Connection config merged with its decrypted secrets, exactly as
     * `identity-sync` assembles it (`{ ...config, ...secrets }`).
     */
    readonly connection: Record<string, unknown>;
    /**
     * The provider instance whose `makeClient` builds the connection. Injected
     * so a test can supply a fake LDAP client through the SAME factory the live
     * path uses — the `ldaps://` scheme check and the TLS-bypass host condition
     * are then exercised rather than bypassed.
     */
    readonly provider?: ActiveDirectoryProvider;
}

// ─── small local coercions (LDAP attributes arrive string | string[] | Buffer) ──

function firstValue(v: unknown): string | undefined {
    if (typeof v === 'string') return v;
    if (Array.isArray(v) && v.length > 0) return firstValue(v[0]);
    if (Buffer.isBuffer(v)) return v.toString('utf8');
    return undefined;
}

function parseUac(v: unknown): number | null {
    const raw = firstValue(v);
    if (raw === undefined || raw.trim() === '') return null;
    const n = Number.parseInt(raw, 10);
    // Every decision made from this value is a bit test, so a non-integer or a
    // negative is not something to coerce past.
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * DOM errors that carry a LEGACY NUMERIC `code`, which collides with LDAP's.
 *
 * Found by the test that asserts an abort is not a refusal: `new
 * DOMException(msg, 'AbortError').code` is 20, and LDAP result 20 is
 * `attributeOrValueExists` — a proven refusal. So an aborted request, which is
 * the archetypal LOST response, read as proof the directory was untouched. That
 * is the exact wrong answer for the exact wrong reason, and it arrives without
 * anything looking odd.
 *
 * Node's own system errors are safe by contrast: theirs are strings
 * (`ETIMEDOUT`, `ECONNRESET`). It is the DOM family that overlaps, so it is
 * named and excluded rather than the numeric check being loosened.
 */
const DOM_LEGACY_CODE_ERROR_NAMES: ReadonlySet<string> = new Set([
    'AbortError',
    'TimeoutError',
    'NetworkError',
    'InvalidStateError',
    'NotSupportedError',
    'SecurityError',
]);

/**
 * The LDAP result code, when the error carries one and could plausibly have got
 * it from a domain controller.
 *
 * A numeric `code` alone is NOT evidence — see the collision above.
 */
function resultCodeOf(err: unknown): number | null {
    if (typeof err !== 'object' || err === null) return null;

    if (typeof DOMException !== 'undefined' && err instanceof DOMException) return null;
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string' && DOM_LEGACY_CODE_ERROR_NAMES.has(name)) return null;

    const code = (err as { code?: unknown }).code;
    return typeof code === 'number' && Number.isInteger(code) ? code : null;
}

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Render a canonical GUID string as an LDAP search-filter assertion.
 *
 * The inverse of `formatObjectGuid`: AD stores the first three groups
 * little-endian and the last two big-endian, so the byte order has to be undone
 * before it goes on the wire as `\xx\xx…`.
 */
export function objectGuidFilter(guid: string): string {
    const hex = guid.replace(/-/g, '');
    const b: string[] = [];
    for (let i = 0; i < 16; i += 1) b.push(hex.slice(i * 2, i * 2 + 2));
    const ordered = [b[3], b[2], b[1], b[0], b[5], b[4], b[7], b[6], ...b.slice(8)];
    return `(objectGUID=${ordered.map((x) => `\\${x}`).join('')})`;
}

/**
 * Everything this writer captures, and everything a restore is entitled to read
 * back.
 *
 * A `type` rather than an `interface` so it satisfies the journal's
 * `Record<string, unknown>` without a cast — an interface has no implicit index
 * signature, and the cast that would paper over that is the kind that survives
 * a later field rename.
 */
export type AdPriorState = {
    readonly schema: typeof AD_PRIOR_STATE_SCHEMA;
    readonly provider: typeof AD_PROVIDER_ID;
    /**
     * The whole STORED integer, which is the only thing a restore writes back.
     *
     * Explicitly not `msDS-User-Account-Control-Computed` — that attribute
     * carries derived bits (LOCKOUT 0x10, PASSWORD_EXPIRED 0x800000) that do
     * not exist in the stored value, and writing one back corrupts the account.
     * It is not captured here at all, so no future restore can reach for the
     * wrong one by mistake.
     */
    readonly userAccountControl: number;
    /**
     * Captured explicitly even though it usually equals `externalUserId`,
     * because `externalUserId` is not reliably a GUID: `normalizeAdEntry` falls
     * back to the DN whenever `formatObjectGuid` returns undefined, which
     * happens when the 16 raw bytes decode cleanly as UTF-8 and arrive as a
     * string that cannot be round-tripped back to 16 bytes. `null` records that
     * this account is one of those, rather than leaving a restore to discover
     * it.
     */
    readonly objectGUID: string | null;
    /**
     * The DN as read AT CAPTURE TIME, which is stale by design — offboarding
     * commonly moves the object into a Disabled Users OU afterwards, by this
     * tool or by IT. Its value to a restore is telling a human the object
     * moved; the restore itself re-resolves by GUID.
     */
    readonly distinguishedName: string;
    readonly sAMAccountName: string | null;
    readonly userPrincipalName: string | null;
    /**
     * Change token. Per-DC, and comparable only against `capturedFromDc`.
     * Without one, a restore weeks later cannot tell "nothing happened since"
     * from "three legitimate changes happened since", and writing the captured
     * integer back would clobber all three — the same defect the CAS prevents,
     * one direction later. A mismatch means a human decides, not overwrite.
     */
    readonly uSNChanged: string | null;
    /**
     * Replicated change token. 1-second granular and not monotonic across DCs,
     * so it is a companion to `uSNChanged` rather than a replacement: one
     * survives a DC change and the other is precise.
     */
    readonly whenChanged: string | null;
    /** Which DC actually answered. `uSNChanged` means nothing without it. */
    readonly capturedFromDc: string | null;
    readonly capturedAt: string;
    /**
     * Diagnostic, never restored. Non-zero marks an account whose ACL is
     * overwritten from AdminSDHolder, which is why a delegated permission can
     * work everywhere else and fail here.
     */
    readonly adminCount: number | null;
};

/** Narrow an arbitrary journalled capture back to a capture this writer made. */
function asAdPriorState(state: Record<string, unknown>): AdPriorState | null {
    if (state.schema !== AD_PRIOR_STATE_SCHEMA) return null;
    if (state.provider !== AD_PROVIDER_ID) return null;
    const uac = state.userAccountControl;
    const dn = state.distinguishedName;
    if (typeof uac !== 'number' || !Number.isSafeInteger(uac) || uac < 0) return null;
    if (typeof dn !== 'string' || dn.trim() === '') return null;
    return state as unknown as AdPriorState;
}

/**
 * Build the operator-facing message for an access denial.
 *
 * Two different denials wear the same result code, and they need different
 * runbook pages:
 *
 *  • An ordinary account → the delegation was never granted. Name exactly which
 *    right, narrowly, so that nobody reaches for Domain Admin.
 *
 *  • An account with adminCount set → the delegation WAS granted and SDProp
 *    threw it away. Members of AD protected groups have their ACL overwritten
 *    from the AdminSDHolder template roughly hourly, and OU-level delegated
 *    permissions are discarded on those objects. This provider's own
 *    DEFAULT_ADMIN_GROUPS is 'Domain Admins, Enterprise Admins, Administrators,
 *    Schema Admins' — every one of them protected — so the writer works for
 *    ordinary staff and fails on precisely the privileged leavers whose
 *    offboarding matters most. Without naming AdminSDHolder this reads as a
 *    flaky integration, and the cheapest-looking fix is escalating the service
 *    account to Domain Admin.
 */
function describeAccessDenied(prior: AdPriorState): string {
    const base = new InsufficientDirectoryPermission(AD_PROVIDER_ID, NEEDED_PERMISSION).message;
    if (prior.adminCount === null || prior.adminCount === 0) return base;
    return (
        `${base} This account additionally carries adminCount=${prior.adminCount}, so it is (or was) a member ` +
        'of an AD protected group and its ACL is overwritten from the AdminSDHolder template by SDProp roughly ' +
        'hourly. OU-level delegated permissions are DISCARDED on such objects, so a delegation that works for ' +
        'ordinary staff will not apply here. Disable this account by hand, or change the AdminSDHolder template ' +
        'deliberately — do NOT escalate the service account to Domain Admin to work around it.'
    );
}

/**
 * Create a writer bound to one AD connection.
 *
 * The connection is opened lazily on first use and reused for every subsequent
 * call, so a batch performs one bind. Call `close()` when the batch is done.
 */
export function createActiveDirectoryWriter(
    options: ActiveDirectoryWriterOptions,
): ClosableDirectoryWriter {
    const connection = options.connection;
    const provider = options.provider ?? new ActiveDirectoryProvider();

    const url = String(connection.url ?? '').trim();
    const baseDN = String(connection.baseDN ?? '').trim();

    // The write credential, when one is configured. Falling back to the read
    // bind is supported because every connection provisioned before this writer
    // existed has only that one — but which is in play changes what a result 50
    // means, so it is remembered rather than inferred.
    const writeBindDN = String(connection.writeBindDN ?? '').trim();
    const writeBindPassword = String(connection.writeBindPassword ?? '');
    const usingDedicatedWriteBind = writeBindDN !== '';
    const bindDN = usingDedicatedWriteBind ? writeBindDN : String(connection.bindDN ?? '').trim();
    const bindPassword = usingDedicatedWriteBind
        ? writeBindPassword
        : String(connection.bindPassword ?? '');

    let client: LdapClientLike | null = null;
    let connecting: Promise<LdapClientLike> | null = null;
    /** RootDSE `dnsHostName` — which DC this socket is actually talking to. */
    let boundDc: string | null = null;

    /** Ask the connection which DC it reached. Best effort; a null is recorded honestly. */
    async function readRootDseDc(c: LdapClientLike): Promise<string | null> {
        try {
            const { searchEntries } = await c.search('', {
                scope: 'base',
                filter: '(objectClass=*)',
                attributes: ['dnsHostName', 'serverName'],
            });
            const root = searchEntries[0];
            if (!root) return null;
            return firstValue(root.dnsHostName) ?? firstValue(root.serverName) ?? null;
        } catch {
            // A RootDSE that will not answer is not a reason to abandon the
            // disable. It costs the change token its comparability, and the
            // capture says so by carrying null rather than by carrying a guess.
            return null;
        }
    }

    async function connect(): Promise<LdapClientLike> {
        if (client) return client;
        // Shared promise: two overlapping callers must not open two sockets to
        // two different DCs, which is the exact split this writer exists to
        // avoid.
        if (connecting) return connecting;

        connecting = (async () => {
            if (!url) throw new Error('Active Directory writer needs an LDAPS URL.');
            if (!baseDN) throw new Error('Active Directory writer needs a base DN.');
            if (!bindDN || !bindPassword) {
                throw new Error(
                    'Active Directory writer needs bind credentials: either writeBindDN / writeBindPassword for ' +
                        'the offboarding write, or the connection bindDN / bindPassword.',
                );
            }

            // UNCONDITIONAL on the write path, unlike the read path where
            // `makeClient` applies this only when TLS verification is being
            // disabled. `rejectUnauthorized: true` proves the host is who its
            // certificate says it is — it does not prove the host is the
            // CUSTOMER's domain controller, and `url` is unvalidated
            // tenant-admin config with no allowlist possible (an AD host is
            // customer infrastructure, so there is no suffix to allow).
            //
            // On a read that is credential and directory disclosure. On a write
            // it is the failure `resolveWriteTarget` exists to prevent arriving
            // through a different door: the disable is issued to an
            // attacker-chosen LDAP server, which answers success, the journal
            // settles APPLIED, and the offboarding audit trail records a leaver
            // as disabled while the real account is untouched.
            //
            // A DC reachable only over a public address therefore cannot be
            // written to. That is a deliberate, stated refusal, and the remedy
            // is a VPN or private link — not a config toggle, which would
            // restore the hole in one form submission.
            await assertPrivateLdapHost(url);

            // Through the provider's factory, never around it: that is where
            // the ldaps:// scheme check lives, and a second factory here would
            // silently lose it.
            const c = await provider.makeClient(connection);
            await c.bind(bindDN, bindPassword);
            boundDc = await readRootDseDc(c);
            client = c;
            return c;
        })();

        try {
            return await connecting;
        } finally {
            connecting = null;
        }
    }

    async function findAccount(externalUserId: string): Promise<Record<string, unknown>> {
        const c = await connect();
        const id = externalUserId.trim();
        if (!id) throw new Error('Active Directory writer was given an empty account id.');

        // `normalizeAdEntry` sets externalUserId to the objectGUID, or falls
        // back to the DN when the GUID could not be formatted. Both shapes are
        // in the database, so both have to resolve.
        const { searchEntries } = GUID_PATTERN.test(id)
            ? await c.search(baseDN, {
                  scope: 'sub',
                  filter: objectGuidFilter(id),
                  attributes: CAPTURE_ATTRIBUTES,
                  sizeLimit: 2,
              })
            : await c.search(id, {
                  scope: 'base',
                  filter: '(objectClass=*)',
                  attributes: CAPTURE_ATTRIBUTES,
              });

        if (searchEntries.length === 0) {
            throw new Error(
                `Active Directory has no account matching ${id}. It may have been deleted, or moved outside the ` +
                    `configured base DN (${baseDN}). Nothing was written.`,
            );
        }
        if (searchEntries.length > 1) {
            // Refusing beats picking. Two matches for an objectGUID should be
            // impossible, so it means the identifier is not what we think it
            // is — and disabling the wrong person is the failure mode here.
            throw new Error(
                `Active Directory returned ${searchEntries.length} accounts for ${id}. Refusing to guess which ` +
                    'one the leaver is; nothing was written.',
            );
        }
        return searchEntries[0];
    }

    return {
        provider: AD_PROVIDER_ID,

        async readState(externalUserId: string): Promise<DirectoryAccountState> {
            const entry = await findAccount(externalUserId);

            const uac = parseUac(entry.userAccountControl);
            if (uac === null) {
                // Every decision below is a bit test on this integer, including
                // the one deciding whether the account is already disabled. A
                // missing or unparseable value is not something to default.
                throw new Error(
                    `Active Directory returned no readable userAccountControl for ${externalUserId}. Refusing to ` +
                        'disable an account whose current state could not be read.',
                );
            }

            const trimmedId = externalUserId.trim();
            const dn =
                firstValue(entry.distinguishedName) ??
                (GUID_PATTERN.test(trimmedId) ? undefined : trimmedId);
            if (!dn) {
                throw new Error(
                    `Active Directory returned no distinguishedName for ${externalUserId}; a modify would have ` +
                        'nowhere to be addressed.',
                );
            }

            const adminCountRaw = firstValue(entry.adminCount);
            const adminCountParsed =
                adminCountRaw === undefined ? Number.NaN : Number.parseInt(adminCountRaw, 10);

            const priorState: AdPriorState = {
                schema: AD_PRIOR_STATE_SCHEMA,
                provider: AD_PROVIDER_ID,
                userAccountControl: uac,
                objectGUID: formatObjectGuid(entry.objectGUID) ?? null,
                distinguishedName: dn,
                sAMAccountName: firstValue(entry.sAMAccountName) ?? null,
                userPrincipalName: firstValue(entry.userPrincipalName) ?? null,
                uSNChanged: firstValue(entry.uSNChanged) ?? null,
                whenChanged: firstValue(entry.whenChanged) ?? null,
                capturedFromDc: boundDc,
                capturedAt: new Date().toISOString(),
                adminCount: Number.isFinite(adminCountParsed) ? adminCountParsed : null,
            };

            return {
                // Derived from the SAME integer the CAS will compare against —
                // not from msDS-User-Account-Control-Computed, not from
                // accountExpires, and not from the ConnectedIdentityAccount row
                // the caller already holds, which may be hours old. The
                // orchestrator's already-disabled short-circuit exists to stop a
                // second disable journalling a prior state of "disabled", which
                // a later restore would then restore TO. That guard is only
                // worth anything if `enabled` and the captured integer are two
                // views of one read.
                enabled: (uac & UAC_ACCOUNTDISABLE) === 0,
                priorState,
            };
        },

        async disable(externalUserId: string, prior: DirectoryAccountState): Promise<void> {
            const captured = asAdPriorState(prior.priorState);
            if (!captured) {
                // Nothing has been sent, so this genuinely proves the directory
                // is unchanged. It is also the one refusal here that is a bug in
                // US rather than a condition in the directory.
                throw new DirectoryWriteError(
                    'Refusing to disable an Active Directory account from a prior-state capture this writer did ' +
                        'not produce. Without the journalled userAccountControl there is no value to ' +
                        'compare-and-swap against, and the only alternative — an unconditional replace — silently ' +
                        'reverts every other bit that changed since the read.',
                    { definitivelyNotApplied: true },
                );
            }

            if ((captured.userAccountControl & UAC_ACCOUNTDISABLE) !== 0 || !prior.enabled) {
                throw new DirectoryWriteError(
                    'Refusing to disable an account whose captured prior state is already disabled: journalling ' +
                        '"disabled" as the prior state is what a later restore would restore TO, permanently ' +
                        'destroying the real prior state.',
                    { definitivelyNotApplied: true },
                );
            }

            const c = await connect();
            if (!c.modify) {
                throw new DirectoryWriteError(
                    'The configured Active Directory client cannot perform a modify, so no disable was attempted.',
                    { definitivelyNotApplied: true },
                );
            }

            if (
                captured.capturedFromDc !== null &&
                boundDc !== null &&
                captured.capturedFromDc !== boundDc
            ) {
                // The capture came from a different domain controller than this
                // socket is bound to. AD is multi-master and eventually
                // consistent, so the comparand may simply not have replicated
                // here — a CAS against it would fail spuriously, or (worse, if
                // it HAS replicated while a later change has not) succeed while
                // reverting something this DC has not seen yet.
                throw new DirectoryWriteError(
                    `Refusing to disable: the prior state was captured from ${captured.capturedFromDc} but this ` +
                        `connection is bound to ${boundDc}. Active Directory is multi-master, so a ` +
                        'compare-and-swap across two domain controllers is not a comparison. Retry the batch on a ' +
                        'single connection.',
                    { definitivelyNotApplied: true },
                );
            }

            const target = captured.userAccountControl | UAC_ACCOUNTDISABLE;
            const changes: readonly LdapModification[] = [
                // Value-specific delete: fails with noSuchAttribute (16) unless
                // the stored value is EXACTLY the one we journalled. This half
                // is the compare.
                {
                    operation: 'delete',
                    type: 'userAccountControl',
                    values: [String(captured.userAccountControl)],
                },
                // And this half is the swap. One ModifyRequest, so the DC
                // applies both or neither.
                { operation: 'add', type: 'userAccountControl', values: [String(target)] },
            ];

            try {
                await c.modify(captured.distinguishedName, changes);
            } catch (err) {
                throw classifyModifyFailure(err, captured, usingDedicatedWriteBind);
            }

            logger.info('active directory account disabled', {
                component: 'integration-active-directory-writer',
                provider: AD_PROVIDER_ID,
                externalUserId,
                priorUserAccountControl: captured.userAccountControl,
                userAccountControl: target,
                dc: boundDc,
            });
        },

        async close(): Promise<void> {
            const c = client;
            client = null;
            boundDc = null;
            if (!c) return;
            try {
                await c.unbind();
            } catch {
                /* already closed, or never opened — a failed unbind is not an outcome */
            }
        },
    };
}

/**
 * Turn a modify failure into the one bit the orchestrator cannot infer.
 *
 * The default is false and every unrecognised shape keeps it. A transport
 * failure — ETIMEDOUT, ECONNRESET, EPIPE, an abort, a socket closed mid-request
 * — carries no LDAP result code at all, because the DC's answer (if it ever
 * sent one) never arrived. Those are epistemically identical to crashing here:
 * the write may well have landed.
 */
export function classifyModifyFailure(
    err: unknown,
    prior: AdPriorState,
    usingDedicatedWriteBind: boolean,
): DirectoryWriteError {
    const code = resultCodeOf(err);
    const detail = err instanceof Error ? err.message : String(err);

    if (code === LDAP_NO_SUCH_ATTRIBUTE) {
        return new DirectoryWriteError(
            `Refused: userAccountControl on ${prior.distinguishedName} is no longer ${prior.userAccountControl}, ` +
                'so the compare-and-swap did not match and nothing was written. Something changed the account ' +
                'since it was read — a helpdesk action, a GPO, or a script — and writing the disable anyway ' +
                'would have reverted that change silently. Re-read and retry. (If this recurs for every account, ' +
                'suspect the read and the write landing on different domain controllers.)',
            { definitivelyNotApplied: true },
        );
    }

    if (code === LDAP_NO_SUCH_OBJECT) {
        return new DirectoryWriteError(
            `Refused: ${prior.distinguishedName} no longer exists at that DN — the object was moved or deleted ` +
                'between the read and the write. Nothing was written. Re-resolve the account by objectGUID (' +
                `${prior.objectGUID ?? 'not captured'}) and retry.`,
            { definitivelyNotApplied: true },
        );
    }

    if (code === LDAP_INSUFFICIENT_ACCESS) {
        const bindNote = usingDedicatedWriteBind
            ? ''
            : ' This connection has no separate write bind configured, so the write was attempted with the ' +
              'enumeration account — which the setup guide asks operators to provision as READ-ONLY. Configure ' +
              'writeBindDN / writeBindPassword carrying the delegated right, rather than widening the credential ' +
              'that every scheduled sync binds with.';
        return new DirectoryWriteError(
            `${describeAccessDenied(prior)}${bindNote} (LDAP result 50: ${detail})`,
            { definitivelyNotApplied: true },
        );
    }

    if (code !== null && PROVEN_REFUSAL_RESULT_CODES.has(code)) {
        return new DirectoryWriteError(
            `Active Directory refused the disable of ${prior.distinguishedName} with LDAP result ${code}: ${detail}`,
            { definitivelyNotApplied: true },
        );
    }

    // Everything else. A result code we do not recognise is not a result code we
    // can reason about, and no result code at all means the answer was lost.
    return new DirectoryWriteError(
        `The disable of ${prior.distinguishedName} did not report a usable outcome${
            code === null ? '' : ` (LDAP result ${code})`
        }: ${detail}. Whether userAccountControl was changed is UNKNOWN — verify in the directory before ` +
            'retrying, because a blind retry would compare against a value that may already have moved.',
    );
}
