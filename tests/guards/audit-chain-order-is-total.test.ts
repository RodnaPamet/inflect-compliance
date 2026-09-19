/**
 * The audit chain's BUILD order and VERIFY order must be the same total order.
 *
 * `appendAuditEntry` chains each row onto the one it finds with
 * `ORDER BY "createdAt" DESC LIMIT 1`; `verifyAuditChain` and
 * `verify.ts` walk the chain with `ORDER BY "createdAt" ASC`. If those two
 * orders can disagree, the chain either forks on write or reads as tampered
 * with on verification — and both look identical to a real integrity failure.
 *
 * ═══ WHY `createdAt` ALONE IS NOT A TOTAL ORDER ═══
 *
 * `appendAuditEntry` takes `pg_advisory_xact_lock(hashtext(tenantId))` and its
 * comment states that this yields "distinct, ordered timestamps". Serialised
 * is not distinct. `new Date()` is millisecond resolution and `createdAt` is
 * `DateTime @default(now())`, so appends completing inside one millisecond —
 * which is what a fast machine does — share a value. `ORDER BY "createdAt"`
 * then has no defined winner among the tied rows, and Postgres is free to
 * return them differently to the two queries.
 *
 * The tiebreaker is not there to be chronological. cuid is not time-ordered.
 * It is there so both queries compute the SAME order, whatever that order is.
 *
 * ═══ WHY THIS IS A SOURCE GUARD AND NOT A REPRODUCTION ═══
 *
 * Stated rather than hidden: the defect is a nondeterminism, so a test that
 * reproduces it cannot be made reliably red — tied rows often come back in
 * insertion order by luck, and a test that passes on the broken code proves
 * nothing. What IS deterministic is that every query participating in the
 * chain carries a tiebreaker, and that is what this asserts.
 *
 * `org-audit-writer.ts` is the reference rather than an invention: it has
 * carried `ORDER BY "occurredAt" DESC, "id" DESC` / `ASC, "id" ASC` since it
 * was written. The tenant writer is the one that diverged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../helpers/repo-files';

const FILES = [
    'src/lib/audit/audit-writer.ts',
    'src/lib/audit/verify.ts',
    'src/lib/audit/org-audit-writer.ts',
];

/**
 * Every `ORDER BY` clause in a file, normalised to one line.
 *
 * COMMENTS ARE STRIPPED FIRST. The first run of this guard failed on the
 * docblock above, which quotes the broken clause in order to explain it — so
 * the guard reported the explanation as the defect. A guard that cannot tell
 * code from prose about code is measuring the wrong artifact.
 */
function orderBys(rel: string): string[] {
    const raw = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
    const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments and docblocks
        .replace(/^\s*\/\/[^\n]*$/gm, '')     // whole-line // comments
        .replace(/^\s*--[^\n]*$/gm, '');      // whole-line SQL comments
    return [...code.matchAll(/ORDER BY ([^`\n]+)/gi)].map((m) => m[1].trim().replace(/\s+/g, ' '));
}

/** Guards the stripper: it must remove prose without eating SQL. */
function strippedSample(): { prose: number; code: number } {
    const raw = fs.readFileSync(path.join(REPO_ROOT, 'src/lib/audit/audit-writer.ts'), 'utf-8');
    return {
        prose: (raw.match(/ORDER BY/gi) ?? []).length,
        code: orderBys('src/lib/audit/audit-writer.ts').length,
    };
}

describe('the audit chain is ordered by a total order (both ends)', () => {
    it('strips prose without eating SQL (positive control)', () => {
        // The file mentions ORDER BY more often than it executes it, because
        // the docblock explains the bug. Both numbers are asserted: >0 code
        // clauses proves the stripper did not eat everything, and fewer code
        // than total proves it stripped something.
        const { prose, code } = strippedSample();
        expect(code).toBeGreaterThan(0);
        expect(code).toBeLessThan(prose);
    });

    it('finds the ORDER BY clauses it means to guard (positive control)', () => {
        // Without this, a renamed file or a reworded query would empty the
        // population and pass everything below by vacuity.
        const all = FILES.flatMap(orderBys);
        expect(all.length).toBeGreaterThanOrEqual(5);
        expect(all.some((o) => /createdAt/i.test(o))).toBe(true);
        expect(all.some((o) => /occurredAt/i.test(o))).toBe(true);
    });

    it.each(FILES)('%s orders every chain query by a tiebreaker', (rel) => {
        // A chain query is one ordering on the timestamp the chain is built
        // over. Any such clause must also name a second column, or two
        // queries over tied rows can disagree.
        const untiebroken = orderBys(rel)
            .filter((o) => /"(createdAt|occurredAt)"/.test(o))
            .filter((o) => !/,\s*"id"\s+(ASC|DESC)/i.test(o));
        expect(untiebroken).toEqual([]);
    });

    it('the tenant writer now matches the org writer it diverged from', () => {
        // The asymmetry WAS the bug: same job, same hazard, one had the fix.
        const tenant = orderBys('src/lib/audit/audit-writer.ts').filter((o) => /"createdAt"/.test(o));
        const org = orderBys('src/lib/audit/org-audit-writer.ts').filter((o) => /"occurredAt"/.test(o));
        expect(tenant.length).toBeGreaterThanOrEqual(2);
        expect(org.length).toBeGreaterThanOrEqual(2);
        const shape = (o: string) => o.replace(/"(createdAt|occurredAt)"/, 'TS').replace(/`,?$/, '');
        expect(new Set(tenant.map(shape))).toEqual(new Set(org.map(shape)));
    });
});
