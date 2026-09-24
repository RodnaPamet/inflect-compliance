/**
 * The joiner's create verb — #2714.
 *
 * A DISABLE IS ONE PATCH. A CREATE IS THREE WRITES, AND THE WRITE-BACK MAKES
 * FOUR. That asymmetry is the whole reason this module exists instead of a
 * method on the leaver path: each write can fail independently, and each
 * failure leaves the account in a DIFFERENT real-world condition that a human
 * has to resolve differently. `PARTIAL_NO_GROUP`, `PARTIAL_NO_CREDENTIAL` and
 * `PARTIAL_NO_HRIS_WRITEBACK` have no leaver analogue.
 *
 * THE SEQUENCE IS OWNER DECISION 3 (2026-09-19), NOT THE DESIGN'S SKETCH:
 *
 *     create BLOCKED  →  assign GROUP  →  mint CREDENTIAL  →  ENABLE
 *
 * "the pass is issued through Entra — after adding the user to the security
 * group. after that it's SSO login." `docs/jml-joiner-design.md` sketched the
 * opposite (credential before group) and was corrected in the same PR as this
 * file. The orderings are not cosmetic variants: they decide whether a
 * credential can exist for an account that holds no entitlements yet.
 *
 * The design's own safety argument AGREES with the decision and is preserved:
 * sequence so the RECOVERABLE half is last. An account nobody can sign into is
 * recoverable by a human. One anyone can sign into with no entitlements is not
 * OBSERVABLE — nothing about it looks wrong. Under decision 3 the credential is
 * last, which is the recoverable half.
 *
 * ROLLBACK IS DECISION 4: disable the created account. It reuses the
 * live-proven `disable()` on `DirectoryWriter` and adds NO new destructive
 * capability — there is deliberately no delete verb anywhere in this seam.
 */
import type { RequestContext } from '../types';
import type {
    CreateAccountInput,
    DirectoryProvisioner,
} from '@/app-layer/integrations/identity-provisioner';
import { beginWrite, type WriteHandle } from './identity-write-journal';
import type { IdentityWriteMode } from './identity-write-policy';

/**
 * Where a create STOPPED, named by what the account is missing.
 *
 * Named by the CONDITION THE ACCOUNT IS LEFT IN, not by which call threw. A
 * reader of this value has to decide what to do about a real person on their
 * first morning; "step 3 failed" does not help them and "the account exists and
 * is entitled but has no credential" does.
 */
export type CreateOutcome =
    /** All four writes landed, including the HRIS write-back. */
    | { readonly kind: 'APPLIED'; readonly externalUserId: string }
    /**
     * Nothing was created. The directory is unchanged and there is nothing to
     * roll back — distinct from every PARTIAL below.
     */
    | { readonly kind: 'REFUSED'; readonly detail: string }
    /**
     * The account exists and is SIGN-IN BLOCKED, with no group. The least
     * useful account possible, and the safest: nobody can use it.
     */
    | {
          readonly kind: 'PARTIAL_NO_GROUP';
          readonly externalUserId: string;
          readonly detail: string;
          readonly rolledBack: boolean;
      }
    /**
     * The account exists and is entitled, but has no credential and is still
     * blocked. The person cannot sign in; an operator can finish this by hand.
     */
    | {
          readonly kind: 'PARTIAL_NO_CREDENTIAL';
          readonly externalUserId: string;
          readonly detail: string;
          readonly rolledBack: boolean;
      }
    /**
     * The account is created, entitled, credentialled and enabled — the person
     * can work — but the system of record does not know the address.
     *
     * THE LEAST SEVERE OF THE THREE, AND THE ONLY SAFELY RETRYABLE ONE, which
     * is why it sequences last and is NOT rolled back: disabling a working
     * account because a downstream write failed would turn a bookkeeping gap
     * into an outage for the person.
     */
    | {
          readonly kind: 'PARTIAL_NO_HRIS_WRITEBACK';
          readonly externalUserId: string;
          readonly detail: string;
      }
    /**
     * A write did not report back. We do not know whether the directory
     * changed, so we neither claim success nor roll back — a rollback here
     * could disable an account we never created.
     */
    | {
          readonly kind: 'INDETERMINATE';
          readonly detail: string;
          readonly externalUserId: string | null;
      };

export interface CreateAccountRequest {
    readonly provisioner: DirectoryProvisioner;
    readonly candidate: CreateAccountInput;
    /** The group #2713's entitlement map resolved for this person. */
    readonly groupId: string;
    readonly mode: IdentityWriteMode;
    /**
     * Undo — decision 4. Disabling the account we just created, through the
     * live-proven leaver verb. Injected rather than imported so this module
     * adds no new authority of its own.
     */
    readonly disableCreated: (externalUserId: string) => Promise<void>;
    /**
     * The HRIS write-back (#2716). ABSENT TODAY, and its absence is reported
     * as `PARTIAL_NO_HRIS_WRITEBACK` rather than swallowed: a create whose
     * address never reaches the system of record is a real, nameable state,
     * and pretending otherwise is how the next HRIS upsert mints a duplicate
     * employee row.
     */
    readonly writeBackToHris?: (externalUserId: string) => Promise<void>;
}

/**
 * Roll back, and report whether it actually happened. Never throws.
 *
 * JOURNALLED since #2840. The undo is a real directory write — it disables an
 * account that exists — and it was the third write in this file with no row of
 * its own. That is the worst one to leave unrecorded: a rollback runs precisely
 * when something has already gone wrong, so it is the write most likely to
 * matter to whoever reads the artefacts afterwards, and the one most likely to
 * fail on its way.
 *
 * `beginWrite` is best-effort here, and deliberately so. If opening the row
 * throws, the undo still runs: an account left ENABLED in a customer's
 * directory because this function could not reach its own database is a worse
 * outcome than an unjournalled disable. The failure is not silent — the caller
 * still reports `rolledBack`, and the create's own rows are already unsettled.
 */
async function rollback(
    ctx: RequestContext,
    provisioner: DirectoryProvisioner,
    mode: IdentityWriteMode,
    disableCreated: (id: string) => Promise<void>,
    externalUserId: string,
): Promise<boolean> {
    let handle: WriteHandle | null = null;
    try {
        handle = await beginWrite(ctx, {
            provider: provisioner.provider,
            externalUserId,
            action: 'DISABLE_ACCOUNT',
            mode,
            priorState: {
                accountCreatedInThisPass: true,
                enabled: false,
                note:
                    'undo of a create that failed partway; the account was created blocked and ' +
                    'never successfully enabled by this pass',
            },
        });
    } catch {
        // Deliberately swallowed — see the docblock. The undo matters more than
        // its record, and the record is not the only one: the step that failed
        // has already left an unsettled row.
        handle = null;
    }

    try {
        await disableCreated(externalUserId);
        await handle?.applied();
        return true;
    } catch (err) {
        // A failed rollback is worse than no rollback only if it is silent.
        // The caller records `rolledBack: false` and the account stays in the
        // journal as unsettled, which is what puts a human on it.
        await handle?.indeterminate(
            `The undo disable failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
    }
}

/**
 * Run the create sequence.
 *
 * Every step is journalled BEFORE it is attempted — `beginWrite` captures prior
 * state and commits it, and there is deliberately no variant that captures
 * afterwards.
 *
 * THAT SENTENCE WAS FALSE FROM THE DAY IT WAS WRITTEN UNTIL #2840. `beginWrite`
 * appeared twice in this file, for CREATE_ACCOUNT and ASSIGN_GROUP. The
 * credential step and the enable step — three and four of four — opened
 * nothing, and neither did the rollback's disable. All five writes are now
 * journalled, so the claim above is a description rather than an aspiration.
 *
 * It is worth naming how it survived: `tests/unit/identity-create-account.test.ts`
 * had a green `describe('every write is journalled BEFORE it is attempted')`
 * whose only assertion was `expect(begun).toEqual(['CREATE_ACCOUNT',
 * 'ASSIGN_GROUP'])`. The test was honest — its `it` says "the two verbs" — but
 * the heading asserted the invariant and a reader scanning describe names would
 * have taken it as proof. A heading is not an assertion, and this one guarded
 * the gap it was named for.
 */
export async function createDirectoryAccount(
    ctx: RequestContext,
    req: CreateAccountRequest,
): Promise<CreateOutcome> {
    const { provisioner, candidate, groupId, mode, disableCreated } = req;

    // ── 1. CREATE, SIGN-IN BLOCKED.
    //
    // `priorState` is REQUIRED and rejected when empty, because an empty
    // capture cannot be told apart from "there was nothing to capture". For a
    // create there genuinely IS no prior account — so the truthful capture is
    // that fact, stated, rather than `{}`. A restore reading this row can tell
    // "no account existed, so undo means disable what we made" from "we failed
    // to record what was there".
    const createHandle: WriteHandle = await beginWrite(ctx, {
        provider: provisioner.provider,
        externalUserId: candidate.identifier,
        action: 'CREATE_ACCOUNT',
        mode,
        priorState: {
            accountExisted: false,
            identifier: candidate.identifier,
            employeeId: candidate.employeeId,
            collisionNamespaces: provisioner.collisionNamespaces,
        },
    });

    const created = await provisioner.createBlockedAccount(candidate);
    if (created.kind === 'refused') {
        await createHandle.failed(created.detail);
        return { kind: 'REFUSED', detail: created.detail };
    }
    if (created.kind === 'indeterminate') {
        await createHandle.indeterminate(created.detail);
        // No rollback: we do not know there is anything to roll back, and
        // disabling an id we may never have created is its own incident.
        return { kind: 'INDETERMINATE', detail: created.detail, externalUserId: null };
    }
    await createHandle.applied();
    const externalUserId = created.externalUserId;

    // ── 2. GROUP, before the credential. Decision 3.
    const groupHandle = await beginWrite(ctx, {
        provider: provisioner.provider,
        externalUserId,
        action: 'ASSIGN_GROUP',
        mode,
        priorState: { groups: [], note: 'account created blocked in this same pass' },
    });

    const grouped = await provisioner.assignGroup(externalUserId, groupId);
    if (grouped.kind !== 'applied') {
        await (grouped.kind === 'refused'
            ? groupHandle.failed(grouped.detail)
            : groupHandle.indeterminate(grouped.detail));
        const rolledBack = await rollback(ctx, provisioner, mode, disableCreated, externalUserId);
        return {
            kind: 'PARTIAL_NO_GROUP',
            externalUserId,
            detail: grouped.detail,
            rolledBack,
        };
    }
    await groupHandle.applied();

    // ── 3. CREDENTIAL, after the group. Never a password fallback.
    //
    // JOURNALLED since #2840. It was not, and this is the step whose absence
    // cost the most: minting the credential is what makes the account USABLE,
    // so a credential issued against an account whose enable then fails is the
    // exact half-landed state the unsettled sweep exists to surface — and with
    // no row opened, the sweep could not see it. The prior state is the one
    // truthful thing there is to say: this pass created the account blocked,
    // moments ago, and nothing has been minted for it.
    const credentialHandle = await beginWrite(ctx, {
        provider: provisioner.provider,
        externalUserId,
        action: 'ISSUE_CREDENTIAL',
        mode,
        priorState: {
            credentialIssued: false,
            note: 'account created blocked in this same pass; no credential had been minted',
        },
    });

    const credential = await provisioner.issueCredential(externalUserId);
    if (credential.kind !== 'applied') {
        await (credential.kind === 'refused'
            ? credentialHandle.failed(credential.detail)
            : credentialHandle.indeterminate(credential.detail));
        const rolledBack = await rollback(ctx, provisioner, mode, disableCreated, externalUserId);
        return {
            kind: 'PARTIAL_NO_CREDENTIAL',
            externalUserId,
            detail: credential.detail,
            rolledBack,
        };
    }
    await credentialHandle.applied();

    // ── 4. ENABLE. Last, because it is the step that makes the account usable.
    //
    // CAPTURE FIRST, and the capture is not a formality. Until #2840 this
    // replaced `userAccountControl` with a literal, destroying every other flag
    // on the account, with nothing journalled to restore them from. The read is
    // a separate call so that the value lands in the journal BEFORE the write
    // is attempted — the ordering the journal's docblock promises — and so the
    // number the row holds is the number the arithmetic is applied to.
    const priorRead = await provisioner.readAccountState(externalUserId);
    if (priorRead.kind !== 'read') {
        // No capture, no enable. Fail closed rather than enable from a value
        // nobody read: that is the unconditional replace this fix removed.
        const rolledBack = await rollback(ctx, provisioner, mode, disableCreated, externalUserId);
        return {
            kind: 'PARTIAL_NO_CREDENTIAL',
            externalUserId,
            detail:
                'Credential minted but the account could not be enabled: its prior state could ' +
                `not be captured, so there is nothing to clear the disable bit from — ${priorRead.detail}`,
            rolledBack,
        };
    }

    const enableHandle = await beginWrite(ctx, {
        provider: provisioner.provider,
        externalUserId,
        action: 'ENABLE_ACCOUNT',
        mode,
        priorState: priorRead.priorState,
    });

    const enabled = await provisioner.enableAccount(externalUserId, priorRead.priorState);
    if (enabled.kind !== 'applied') {
        await (enabled.kind === 'refused'
            ? enableHandle.failed(enabled.detail)
            : enableHandle.indeterminate(enabled.detail));
        const rolledBack = await rollback(ctx, provisioner, mode, disableCreated, externalUserId);
        return {
            kind: 'PARTIAL_NO_CREDENTIAL',
            externalUserId,
            detail: `Credential minted but the account could not be enabled: ${enabled.detail}`,
            rolledBack,
        };
    }
    await enableHandle.applied();

    // ── 5. THE WRITE-BACK (#2716). Not rolled back on failure — see the
    // docblock on PARTIAL_NO_HRIS_WRITEBACK.
    if (!req.writeBackToHris) {
        return {
            kind: 'PARTIAL_NO_HRIS_WRITEBACK',
            externalUserId,
            detail:
                'The account is created, entitled, credentialled and enabled, but no HRIS ' +
                'write-back is wired (#2716). The system of record does not hold this address. ' +
                'Reported rather than swallowed: the joiner must NOT write Employee.workEmail ' +
                'directly, because the next HRIS upsert would miss its tenantId_workEmail key ' +
                'and mint a duplicate employee row.',
        };
    }
    try {
        await req.writeBackToHris(externalUserId);
    } catch (e) {
        return {
            kind: 'PARTIAL_NO_HRIS_WRITEBACK',
            externalUserId,
            detail: `HRIS write-back failed: ${e instanceof Error ? e.message : String(e)}`,
        };
    }

    return { kind: 'APPLIED', externalUserId };
}
