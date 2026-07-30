/**
 * Who a scheduled report may be delivered to.
 *
 * ── Why this module exists ──────────────────────────────────────────
 *
 * `recipients` on a ReportSchedule was validated for RFC email SHAPE only
 * (`z.array(z.string().email())`), with no count cap and no check on WHO the
 * addresses belong to, and `deliverReportByEmail` then did
 * `to: recipients.join(', ')` unfiltered. Any caller who could write could aim
 * the tenant's board-risk PDF at an arbitrary address, weekly, forever.
 *
 * Two independent gates now stand in the way, either of which stops that:
 *
 *   1. **Every recipient must resolve.** An address is acceptable only if it
 *      belongs to an ACTIVE member of the tenant, or matches the tenant's
 *      configured external allowlist. Anything else is rejected by name.
 *   2. **Aiming off-tenant is an elevation.** If any recipient is a non-member,
 *      the caller needs `reports.schedule_external` (OWNER/ADMIN), because a
 *      schedule keeps sending long after its author loses access.
 *
 * The allowlist lives on `TenantSecuritySettings` — an admin surface — rather
 * than being supplied with the schedule, so approving an external destination
 * and using one are different acts by different people.
 *
 * Membership alone would have been simpler and wrong: external auditors
 * receiving a recurring SoA or risk report is a legitimate, common GRC flow.
 * Refusing it outright would have pushed users to forward the PDFs by hand,
 * which is strictly worse than a reviewed allowlist.
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, forbidden } from '@/lib/errors/types';

/**
 * Hard cap on recipients per schedule.
 *
 * There was none. The cap is not about the mail server — it is about blast
 * radius: a single accepted schedule row should not be able to fan one
 * attachment out to an arbitrary list.
 */
export const MAX_SCHEDULE_RECIPIENTS = 20;

/**
 * Hard cap on an emailed report attachment.
 *
 * `mailer.ts` has no size logic, so an unbounded artefact was handed straight to
 * the transport: a large tenant's Deep Dive PDF could exceed provider limits and
 * fail the whole delivery silently, or succeed and mail tens of megabytes to
 * every recipient. 15 MB sits under the common 20–25 MB provider ceilings with
 * headroom for MIME encoding overhead (~33% for base64).
 */
export const MAX_EMAIL_ATTACHMENT_BYTES = 15 * 1024 * 1024;

const norm = (e: string) => e.trim().toLowerCase();

/**
 * Parse the tenant's allowlist into exact addresses and domain suffixes.
 *
 * Accepts `"auditor@kpmg.com"` (exact) and `"@kpmg.com"` (any address at that
 * domain). A bare `"kpmg.com"` is read as a domain too — operators write it both
 * ways and silently ignoring one form would fail closed in a confusing way.
 */
export function parseRecipientAllowlist(raw: unknown): {
    exact: Set<string>;
    domains: Set<string>;
} {
    const exact = new Set<string>();
    const domains = new Set<string>();
    if (!Array.isArray(raw)) return { exact, domains };
    for (const entry of raw) {
        if (typeof entry !== 'string') continue;
        const v = norm(entry);
        if (!v) continue;
        if (v.startsWith('@')) domains.add(v.slice(1));
        else if (v.includes('@')) exact.add(v);
        else domains.add(v);
    }
    return { exact, domains };
}

function domainOf(email: string): string {
    const at = email.lastIndexOf('@');
    return at === -1 ? '' : email.slice(at + 1);
}

export interface ResolvedRecipients {
    /** Normalised, de-duplicated, order-preserving. */
    recipients: string[];
    /** Addresses that belong to an ACTIVE member of this tenant. */
    internal: string[];
    /** Addresses accepted only because the tenant allowlists them. */
    external: string[];
}

/**
 * Validate a schedule's recipient list against tenant membership + allowlist,
 * and require `reports.schedule_external` if any recipient is off-tenant.
 *
 * Throws `badRequest` naming the offending address (the caller supplied it, so
 * echoing it back leaks nothing) and `forbidden` for the missing elevation.
 */
export async function resolveScheduleRecipients(
    ctx: RequestContext,
    recipients: string[],
): Promise<ResolvedRecipients> {
    // De-duplicate case-insensitively but keep the caller's order, so the
    // rejection message below points at the address they actually typed.
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const r of recipients) {
        const v = norm(r);
        if (!v || seen.has(v)) continue;
        seen.add(v);
        unique.push(v);
    }

    if (unique.length > MAX_SCHEDULE_RECIPIENTS) {
        throw badRequest(
            `A schedule may have at most ${MAX_SCHEDULE_RECIPIENTS} recipients (got ${unique.length}).`,
        );
    }
    if (unique.length === 0) return { recipients: [], internal: [], external: [] };

    const [members, settings] = await Promise.all([
        // Bounded by the recipient cap above, and matched in the DATABASE rather
        // than by loading the membership list — a large tenant's roster is not
        // something a schedule save should pull into memory.
        runInTenantContext(ctx, (db) =>
            db.tenantMembership.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    status: 'ACTIVE',
                    user: { email: { in: unique, mode: 'insensitive' } },
                },
                select: { user: { select: { email: true } } },
                take: MAX_SCHEDULE_RECIPIENTS,
            }),
        ),
        runInTenantContext(ctx, (db) =>
            db.tenantSecuritySettings.findUnique({
                where: { tenantId: ctx.tenantId },
                select: { reportRecipientAllowlistJson: true },
            }),
        ),
    ]);

    const memberEmails = new Set(
        members
            .map((m: { user: { email: string | null } | null }) => m.user?.email)
            .filter((e): e is string => typeof e === 'string')
            .map(norm),
    );
    const { exact, domains } = parseRecipientAllowlist(
        settings?.reportRecipientAllowlistJson,
    );

    const internal: string[] = [];
    const external: string[] = [];
    for (const r of unique) {
        if (memberEmails.has(r)) {
            internal.push(r);
        } else if (exact.has(r) || domains.has(domainOf(r))) {
            external.push(r);
        } else {
            throw badRequest(
                `"${r}" is not a member of this tenant and is not on the report-recipient allowlist. ` +
                    `Add it under Security settings, or remove it from the schedule.`,
            );
        }
    }

    if (external.length > 0 && !ctx.appPermissions.reports.schedule_external) {
        throw forbidden(
            'Sending scheduled reports outside this tenant requires an administrator. ' +
                'Remove the external recipients, or ask an administrator to create the schedule.',
        );
    }

    return { recipients: unique, internal, external };
}
