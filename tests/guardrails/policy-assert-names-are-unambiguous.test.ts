/**
 * A file-local `assertCan*` must not reuse an exported policy name.
 *
 * WHY. `src/app-layer/policies/common.ts` exports `assertCanRead`,
 * `assertCanWrite`, `assertCanAdmin` and `assertCanAudit`, all taking a
 * `RequestContext`. `src/app-layer/usecases/org-dashboard-widgets.ts` defines
 * its OWN file-local `assertCanRead` and `assertCanWrite` taking an
 * `OrgContext` — a different type, a different permission model, and a
 * different audit story (org events cannot even be written to `AuditLog`,
 * whose `tenantId` is NOT NULL).
 *
 * Nothing is wrong at runtime: the local binding shadows the import and
 * TypeScript checks both. The hazard is to ANALYSIS. Every audit of "which
 * routes authorize how" in this repo keys on these identifiers, and a
 * name-keyed scan silently conflates the two — reporting an org route as
 * tenant-gated, or counting a `common.ts` change as covering a call site it
 * cannot reach. That mis-measurement is not hypothetical: a survey of the
 * `assertCan*` family had to special-case exactly these two functions after
 * they turned up as false matches, and the correction changed its headline
 * coverage figure.
 *
 * So this is a NAMING rule, enforced structurally: if a function is not the
 * shared policy helper, it must not be called by the shared policy helper's
 * name. Rename it for what it gates (`assertCanReadOrgWidgets`), and any
 * future census means what it says.
 *
 * This does NOT require the domain policy modules to delegate to `common.ts`.
 * Sixteen of them deliberately spell their own predicate; that is a separate
 * architectural question. This only bans REUSING a name that already means
 * something else.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { repoRelativeFiles } from '../helpers/repo-files';

const ROOT = path.resolve(__dirname, '../..');

/** The shared helpers whose names are reserved. */
const RESERVED = new Set(['assertCanRead', 'assertCanWrite', 'assertCanAdmin', 'assertCanAudit']);

const COMMON = 'src/app-layer/policies/common.ts';

/** A local declaration: `function assertCanX(` or `const assertCanX =`. */
const declarationsIn = (src: string): string[] => {
    const out: string[] = [];
    const fn = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(assertCan[A-Za-z]*)\s*\(/g;
    const cn = /(?:^|\n)\s*(?:export\s+)?const\s+(assertCan[A-Za-z]*)\s*[:=]/g;
    for (const re of [fn, cn]) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) out.push(m[1] as string);
    }
    return out;
};

describe('policy assert names are unambiguous', () => {
    const files = repoRelativeFiles().filter(
        (f) => f.startsWith('src/') && f.endsWith('.ts') && !f.endsWith('.d.ts'),
    );

    it('the scan population is plausibly sized (guards against a vacuous pass)', () => {
        // A collapsed file list would make the assertion below pass while
        // examining nothing.
        expect(files.length).toBeGreaterThanOrEqual(200);
        const commonSrc = fs.readFileSync(path.join(ROOT, COMMON), 'utf8');
        // Positive control: the reserved names must actually exist where we
        // think they do, or "no shadowing found" means the wrong thing.
        for (const name of RESERVED) expect(commonSrc).toContain(`function ${name}`);
    });

    it('no file outside common.ts declares a reserved policy assert name', () => {
        const offenders: string[] = [];
        for (const rel of files) {
            if (rel === COMMON) continue;
            const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
            for (const name of declarationsIn(src)) {
                if (RESERVED.has(name)) offenders.push(`${rel}: ${name}`);
            }
        }
        // To fix: rename the local function for what it actually gates, e.g.
        // `assertCanWriteOrgWidgets`. Do NOT add it to RESERVED.
        expect(offenders.sort()).toEqual([]);
    });
});
