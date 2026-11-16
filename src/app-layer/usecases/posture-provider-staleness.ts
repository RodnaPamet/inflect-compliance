import { FindingRepository } from '@/app-layer/repositories/FindingRepository';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { postureProviderName } from '@/app-layer/integrations/cloud-posture/provider-name';
import {
    reportsStaleness,
    type ProviderStalenessVerdict,
} from '@/app-layer/integrations/cloud-posture/provider-staleness';
import type { PrismaTx } from '@/lib/db-context';
import type { RequestContext } from '@/app-layer/types';

/**
 * REPORTING THAT A POSTURE CONNECTION'S GATEWAY PROVIDER IS BEHIND — #5476,
 * acceptance criterion 4 as renegotiated: detect and report.
 *
 * The operator provisions a gateway provider holding the connection's cloud
 * credential; the product attaches it by name and never writes it. So a
 * credential rotated in the product leaves the gateway holding the previous one,
 * under the same name, and every scan afterwards benchmarks an account the
 * tenant no longer has on record. This raises the one finding that says so.
 *
 * ── Nothing here ever closes it, and that is the decision ───────────────
 *
 * The product cannot confirm the fix: #5739's readiness observation says
 * `credentials_installed`, not which credential. Closing on the next successful
 * scan would close on the OLD credential working perfectly well, so there is no
 * positive evidence to close on. Owner decision (2026-11-16): a person closes it
 * once they have re-provisioned.
 *
 * ── One OPEN finding per connection, not one per rotation ───────────────
 *
 * `sourceRef` is the connection id, so the `[tenantId, sourceKind, sourceRef]`
 * index is the dedupe key and a second rotation while one is open adds nothing.
 * The alternative — a `sourceRef` carrying a timestamp — would be literally one
 * per rotation and would pile up exactly as the owner's reasoning said it should
 * not: the fact is the same fact, "the gateway is behind", however many times the
 * credential moved. The later rotation still reaches the audit trail through the
 * ordinary connection-update row.
 *
 * ── Why `FindingRepository` and not `createFinding` ─────────────────────
 *
 * The same reason the integration passport sweep uses it: `createFinding` has a
 * gate of its own, and reaching it here would add `findings.create` to the
 * permission an admin needs to SAVE A CONNECTION — a new requirement on an
 * existing action, for a side effect they did not ask for. The write is still
 * sanitised and audited by the caller's own transaction.
 */

/** Distinguishes these from every other derived finding source. */
export const POSTURE_PROVIDER_STALE_SOURCE_KIND = 'POSTURE_PROVIDER_STALE';

/**
 * MEDIUM, and the reasoning matters more than the value.
 *
 * It is not the acute case #5251 refused — that was every tenant sharing one
 * credential, so a scan could report a completely unrelated organisation's
 * posture as yours. Here the account is one this tenant did configure; what has
 * drifted is that it is no longer the credential of record, so the evidence and
 * the connection disagree until somebody re-provisions. Serious, and not an
 * emergency.
 */
export const POSTURE_PROVIDER_STALE_SEVERITY = 'MEDIUM' as const;
/** The control is operating differently from its design, so not an OBSERVATION. */
export const POSTURE_PROVIDER_STALE_TYPE = 'NONCONFORMITY' as const;

/**
 * Raise the finding if this save left the gateway behind, and do nothing
 * otherwise. Returns the finding's id when one was opened.
 *
 * Call inside the connection update's own transaction, so a refused save reports
 * nothing. `ownerUserId` is the connection's accountable owner as
 * `setIntegrationConnectionOwner` records it; `null` leaves the finding
 * unassigned rather than inventing an assignee, which is the rule the passport
 * sweep follows for the same column.
 */
export async function reportPostureProviderStaleness(
    db: PrismaTx,
    ctx: RequestContext,
    input: {
        readonly verdict: ProviderStalenessVerdict;
        readonly connectionId: string;
        readonly provider: string;
        readonly ownerUserId: string | null;
    },
): Promise<string | null> {
    if (!reportsStaleness(input.verdict)) return null;

    // One OPEN finding per connection. A CLOSED one is not reopened here: the
    // person who closed it did so having re-provisioned, and a later rotation
    // raises a fresh one because the closed row no longer matches `status: OPEN`.
    const existing = await db.finding.findFirst({
        where: {
            tenantId: ctx.tenantId,
            sourceKind: POSTURE_PROVIDER_STALE_SOURCE_KIND,
            sourceRef: input.connectionId,
            status: { not: 'CLOSED' },
        },
        select: { id: true },
    });
    if (existing) return null;

    const providerName = postureProviderName({
        tenantId: ctx.tenantId,
        connectionId: input.connectionId,
    });

    /*
        THE PROVIDER NAME IS IN THE BODY ON PURPOSE, and it is safe.

        It is the one thing the reader has to act on — it is what they pass to
        `provider create` — and it is an opaque digest of two row ids, carrying no
        slug, account or credential. The same name already appears in
        `SandboxLease` rows and, for an opted-in estate, in harness observations.

        The CREDENTIAL is not here, in any form: not its value, not its length,
        not a digest of it. The finding says that it moved, never what it is.
    */
    const created = await FindingRepository.create(db, ctx, {
        severity: POSTURE_PROVIDER_STALE_SEVERITY,
        type: POSTURE_PROVIDER_STALE_TYPE,
        status: 'OPEN',
        sourceKind: POSTURE_PROVIDER_STALE_SOURCE_KIND,
        sourceRef: input.connectionId,
        assigneeUserId: input.ownerUserId,
        title: sanitizePlainText(
            `Re-provision the sandbox credential provider for this ${input.provider} connection`,
        ),
        description: sanitizePlainText(
            input.verdict === 'UNREADABLE_PREVIOUS'
                ? 'This connection\'s previous credential could not be read, so the product cannot '
                    + 'show that the gateway\'s credential provider still matches it. Sandboxed '
                    + `posture collection attaches the provider named ${providerName}, which only an `
                    + 'operator can write. Re-provision it with this connection\'s current credential, '
                    + 'then close this finding — the product cannot confirm which credential the '
                    + 'gateway holds, so nothing closes it automatically.'
                : 'This connection\'s credential was changed in the product. Sandboxed posture '
                    + `collection attaches the gateway credential provider named ${providerName}, `
                    + 'which only an operator can write, so it still holds the previous credential '
                    + 'and every scan benchmarks that account. Re-provision it with the current '
                    + 'credential, then close this finding — the product cannot confirm which '
                    + 'credential the gateway holds, so nothing closes it automatically.',
        ),
    });
    return created.id;
}
