/**
 * A tenant removal must leave a record (#3173).
 *
 * Removing a tenant takes an entire customer's workspace off every surface in
 * the product. Measured on production 2026-10-04, it was recorded NOWHERE: nine
 * tenants carried a `deletedAt` and neither audit chain held a row for any of
 * them — `AuditLog` 3,714 rows, `OrgAuditLog` 82, `AuditOutbox` 0. The only
 * trace was a `logger.info` line in container stdout, discarded by the next
 * deploy, so the actor behind seven September removals is unrecoverable.
 *
 * The absence was systemic rather than a slip in one function. `OrgAuditAction`
 * has no member for tenant creation or deletion at all, while a REFUSED removal
 * has been audited since #2147 (`ORG_AUTHZ_DENIED`) — the denial was recorded
 * and the act was not.
 *
 * WHAT THIS GUARD IS FOR: there is exactly one path today, and the risk is a
 * second one appearing. A new tenant-removal path is the most likely way this
 * regresses, because nothing about writing `Tenant.deletedAt` suggests to its
 * author that an audit entry is owed.
 *
 * WHY IT ASSERTS ON THE SOURCE: the write and the append are two statements in
 * one transaction, and a unit test with a mocked client cannot tell a
 * transaction from two (a mock has neither). `org-tenant-delete.test.ts` asserts
 * the grouping for the path that exists; this asserts that no path exists
 * without one.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * Strip comments before looking for a writer.
 *
 * THIS IS NOT TIDINESS — the guard was toothless without it. The first version
 * asked `src.includes('appendOrgAuditEntry')`, and the file it guards contains a
 * COMMENT explaining that `appendOrgAuditEntry` cannot join the transaction. So
 * deleting the actual append left the guard green: it was grading prose about
 * audit writers. Found by mutating at the call site, which is the only thing
 * that would have found it — the guard passed its own suite either way.
 */
function stripComments(src: string): string {
    let out = '';
    let i = 0;
    while (i < src.length) {
        const two = src.slice(i, i + 2);
        if (two === '//') {
            const nl = src.indexOf('\n', i);
            i = nl === -1 ? src.length : nl;
        } else if (two === '/*') {
            const end = src.indexOf('*/', i + 2);
            i = end === -1 ? src.length : end + 2;
        } else {
            out += src[i];
            i++;
        }
    }
    return out;
}

/** Writers that put a row on an audit chain. A `logger.info` is not one. */
const AUDIT_WRITERS = [
    'appendAuditEntryWithin',
    'appendAuditEntryOrQueue',
    'appendAuditEntry',
    'appendOrgAuditEntry',
    'logEvent',
];

/**
 * Tracked source files, from git rather than a glob — a file not in the index
 * is not shipped, and reading the index keeps a half-finished scratch file from
 * failing the build. See `measure-on-a-committed-tree`.
 */
function trackedSources(): string[] {
    return execFileSync('git', ['ls-files', 'src/**/*.ts', 'src/*.ts'], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
    })
        .split('\n')
        .filter(p => p.endsWith('.ts'));
}

/**
 * A site is a `tenant.update`/`updateMany` whose argument block sets
 * `deletedAt` to something other than `null`.
 *
 * The window is bounded on the balanced parentheses of the call rather than a
 * line count: a fixed window is a budget a reformat can exceed, and a call
 * spanning more lines than the constant would silently stop being a site.
 */
function tenantSoftDeleteSites(): Array<{ file: string; line: number; snippet: string }> {
    const found: Array<{ file: string; line: number; snippet: string }> = [];
    for (const file of trackedSources()) {
        const src = readFileSync(file, 'utf8');
        const re = /\.tenant\.(update|updateMany)\s*\(/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) {
            // Walk to the matching close paren.
            let depth = 0;
            let i = m.index + m[0].length - 1;
            for (; i < src.length; i++) {
                if (src[i] === '(') depth++;
                else if (src[i] === ')') {
                    depth--;
                    if (depth === 0) break;
                }
            }
            const block = src.slice(m.index, i + 1);
            // `deletedAt:` assigned anything but null. `deletedAt: null` is a
            // READ filter (the predicate every surface draws), not a removal.
            if (!/deletedAt\s*:\s*(?!null)/.test(block)) continue;
            found.push({
                file,
                line: src.slice(0, m.index).split('\n').length,
                snippet: block.replace(/\s+/g, ' ').slice(0, 90),
            });
        }
    }
    return found;
}

describe('a tenant removal leaves an audit record', () => {
    const sites = tenantSoftDeleteSites();

    /**
     * THE POPULATION CHECK. An empty selection passes every loop below by
     * vacuity, so a detector that silently stops matching would read as a clean
     * build. If this fails, the detector broke — not the codebase.
     */
    it('the detector finds the known removal path', () => {
        // Printed so the denominator is in the output, not inferred from a pass.
        // eslint-disable-next-line no-console
        console.log(`tenant soft-delete sites: ${sites.length}`);
        expect(sites.length).toBeGreaterThanOrEqual(1);
        expect(sites.map(s => s.file)).toContain('src/app-layer/usecases/org-tenants.ts');
    });

    it('every path that writes Tenant.deletedAt also appends an audit entry', () => {
        const unaudited = sites.filter(s => {
            const code = stripComments(readFileSync(s.file, 'utf8'));
            // `w + '('` — a CALL, not a mention. An import names the writer
            // too, and an import with no call site records nothing.
            return !AUDIT_WRITERS.some(w => code.includes(`${w}(`));
        });

        expect(unaudited.map(s => `${s.file}:${s.line} — ${s.snippet}`)).toEqual([]);
    });

    /**
     * A `logger.info` line is what production actually had, and it is why the
     * seven September removals cannot be attributed: the container was recreated
     * and the lines went with it. So "it logs something" must not satisfy this
     * guard, and this is the assertion that says the writer list has teeth.
     */
    it('a log line does not count as an audit record', () => {
        expect(AUDIT_WRITERS).not.toContain('logger');
        expect(AUDIT_WRITERS.some(w => w.toLowerCase().includes('log') && w !== 'logEvent'))
            .toBe(false);
    });

    /**
     * The control for `stripComments`, and it is not hypothetical: without it
     * this guard passed with the append deleted, because `org-tenants.ts`
     * discusses `appendOrgAuditEntry` in a comment. A guard satisfied by prose
     * about the thing it requires is worse than no guard, because it reports
     * compliance.
     */
    it('a writer named only in a comment does not satisfy it', () => {
        const prose = `
            // we could use appendAuditEntryWithin( here one day
            /* appendOrgAuditEntry( is the org equivalent */
            await prisma.tenant.update({ where: { id }, data: { deletedAt: new Date() } });
        `;
        const code = stripComments(prose);
        expect(AUDIT_WRITERS.some(w => code.includes(`${w}(`))).toBe(false);
        // And the control for the control: real code IS still found.
        expect(stripComments('await appendAuditEntryWithin(tx, {})'))
            .toContain('appendAuditEntryWithin(');
    });
});
