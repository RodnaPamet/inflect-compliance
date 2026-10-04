/**
 * A job that picks its own tenants must not mail a removed one (#3178).
 *
 * THE CLASS. A tenant's memberships SURVIVE its soft-delete — 88 of production's
 * 105 `ACTIVE` memberships belong to the seven tenants removed in September 2026
 * — and recipient resolution selects on exactly those rows
 * (`{ tenantId, status: 'ACTIVE', role: 'ADMIN' }`). So any job that chooses its
 * own tenant set and then resolves memberships to human addresses has to
 * establish that the tenant still exists. Nothing else does it: a tenant
 * soft-delete does not cascade, so `deletedAt: null` on the ENTITY (Evidence,
 * AccessReview, AuditCycle) is satisfied by rows in a removed workspace.
 *
 * WHY A GUARD. Four jobs are in this class and THREE of them shipped without the
 * predicate — `compliance-digest` (#3169), `digest-dispatcher` (#3176), then
 * `retention-notifications` and `access-review-overdue-escalation` (#3178). Three
 * independent instances is a class, not a coincidence, and the next one will be
 * written by someone for whom nothing about joining `TenantMembership` suggests a
 * tenant-liveness check is owed.
 *
 * WHAT IT CANNOT DO, said plainly: it cannot decide whether a NEW file belongs in
 * the class. "Chooses its own tenants" is a judgement about intent, and 11 more
 * files under these directories query memberships without resolving them to
 * people. So this is a CENSUS: the membership of the class is pinned, and a new
 * entrant fails the count and asks a human to classify it. What it checks
 * mechanically is the predicate, for the files already classified.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * Files that resolve a tenant membership to a human recipient, in the layers
 * that choose their own tenants (jobs and notification fan-out).
 *
 * Derived, not hand-listed — a hand-listed set goes stale silently, and the
 * population check below is what makes an addition visible.
 */
function recipientResolvers(): string[] {
    const files = execFileSync(
        'git',
        ['ls-files', 'src/app-layer/jobs/*.ts', 'src/app-layer/notifications/*.ts'],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    )
        .split('\n')
        .filter(p => p.endsWith('.ts'));

    return files.filter(f => {
        const src = readFileSync(f, 'utf8');
        return (
            /tenantMembership\.(findMany|findFirst)/.test(src)
            // Reaching a PERSON is what makes liveness matter. A membership read
            // that never resolves a user is a count or a permission check.
            && /user:\s*\{\s*select|user:\s*\{$/m.test(src)
        );
    });
}

/** The call block starting at `from`, bounded on balanced parentheses. */
function callBlock(src: string, from: number): string {
    let depth = 0;
    let i = src.indexOf('(', from);
    if (i === -1) return '';
    for (let j = i; j < src.length; j++) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')') {
            depth--;
            if (depth === 0) return src.slice(i, j + 1);
        }
    }
    return src.slice(i);
}

/**
 * The two shapes that establish liveness, both in use:
 *
 *   1. a RELATION filter — `tenant: { deletedAt: null }` on the entity query
 *      (`retention-notifications`, `access-review-overdue-escalation`)
 *   2. resolving the live tenants itself — a `tenant.findMany`/`findFirst` whose
 *      own where carries `deletedAt: null` (`compliance-digest`,
 *      `digest-dispatcher` via `resolveLiveTenants`)
 *
 * Matching the SHAPE rather than a literal string, because the literal differs
 * by a comma between call sites and a needle pinned to one spelling goes blind
 * at the first reformat. My first attempt did exactly that and scored
 * `compliance-digest` — which has been correct since #3169 — as non-compliant,
 * because it writes `deletedAt: null }` with no trailing comma.
 */
function establishesLiveness(src: string): boolean {
    if (/tenant:\s*\{\s*deletedAt:\s*null\s*\}/.test(src)) return true;
    const re = /\.tenant\.(findMany|findFirst)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
        if (/deletedAt:\s*null/.test(callBlock(src, m.index))) return true;
    }
    return false;
}

/**
 * Exempt, with the reason — not an allowlist of known-bad sites.
 *
 * An exemption that does not say why is indistinguishable from a site nobody
 * looked at, which is how the two #3178 defects survived three reviews.
 */
const EXEMPT: Record<string, string> = {
    'src/app-layer/notifications/leaver.ts':
        'Resolves admins from ctx.tenantId — a SINGLE tenant handed to it by its '
        + 'caller, not a tenant set it chose. Liveness is the caller\'s to '
        + 'establish, and requiring a predicate here would be a false alarm.',
};

describe('cross-tenant recipient resolution requires a live tenant', () => {
    const files = recipientResolvers();

    /**
     * THE POPULATION CHECK, and it is the load-bearing half. Every assertion
     * below is a loop over `files`; an empty or shrunken selection passes them
     * all by vacuity, so a detector that quietly stopped matching would read as
     * a clean build. Pinned to the exact set, so a NEW job joining the class
     * fails here and gets classified by a human rather than slipping in.
     */
    it('the class has exactly the members we have classified', () => {
        // eslint-disable-next-line no-console
        console.log(`recipient-resolving jobs: ${files.length}\n  ${files.join('\n  ')}`);
        expect(files.sort()).toEqual([
            'src/app-layer/jobs/access-review-overdue-escalation.ts',
            'src/app-layer/jobs/compliance-digest.ts',
            'src/app-layer/jobs/retention-notifications.ts',
            'src/app-layer/notifications/digest-dispatcher.ts',
            'src/app-layer/notifications/leaver.ts',
        ]);
    });

    it('every member either establishes liveness or is exempt with a reason', () => {
        const offenders = files.filter(
            f => !EXEMPT[f] && !establishesLiveness(readFileSync(f, 'utf8')),
        );
        expect(offenders).toEqual([]);
    });

    it('every exemption names a file that is still in the class', () => {
        // A stale exemption is worse than none: it silently excuses a file that
        // may have changed shape entirely since someone justified it.
        expect(Object.keys(EXEMPT).filter(f => !files.includes(f))).toEqual([]);
    });

    /**
     * The control for the detector. Without it, `establishesLiveness` returning
     * `true` unconditionally would satisfy every assertion above — a detector
     * whose live side is a constant is zero evidence.
     */
    it('the detector rejects an entity-only filter, which is the defect itself', () => {
        const entityOnly = `
            const where: Prisma.EvidenceWhereInput = {
                retentionUntil: { not: null }, isArchived: false, deletedAt: null,
            };
            await prisma.evidence.findMany({ where });
        `;
        expect(establishesLiveness(entityOnly)).toBe(false);

        // And accepts each shape actually in use — including the spelling with
        // no trailing comma, which a literal needle missed.
        expect(establishesLiveness('where: { tenant: { deletedAt: null } }')).toBe(true);
        expect(establishesLiveness(
            'await prisma.tenant.findMany({ where: { id: x, deletedAt: null }, select: {} })',
        )).toBe(true);
    });
});
