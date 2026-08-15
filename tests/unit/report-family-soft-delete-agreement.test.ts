/**
 * The report families agree about what a soft delete means.
 *
 * ── Why this exists ─────────────────────────────────────────────────
 *
 * Three report surfaces read overlapping data and only two of them filtered
 * soft-deleted rows:
 *
 *   - `assembleReportData` (risk-report.ts)  filtered risks     — correct
 *   - `getSoA` (soa.ts)                      filtered controls  — correct
 *   - `getRiskRegisterData` (ReportRepository)  filtered NOTHING
 *   - `generateReadinessReport` (coverage.ts)   filtered evidence but NOT controls
 *
 * So the same tenant at the same moment produced different compliance numbers
 * depending on which report an auditor opened — and the two unfiltered ones were
 * the OPTIMISTIC pair: a soft-deleted control kept satisfying the requirement it
 * used to cover, inflating `mapped`, `coveragePercent` and `readinessScore`.
 *
 * Asserted structurally, against the query shapes. A behavioural test would need
 * a real database (these are DB-backed usecases), and the invariant being
 * protected is precisely "the WHERE clause says deletedAt: null" — which is what
 * a future edit would drop.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const REPORT_REPO = read('src/app-layer/repositories/ReportRepository.ts');
const RISK_REPORT = read('src/app-layer/usecases/risk-report.ts');
const COVERAGE = read('src/app-layer/usecases/framework/coverage.ts');
const SOA = read('src/app-layer/usecases/soa.ts');

/**
 * Strip line + block comments.
 *
 * Load-bearing: these assertions describe CODE, and the comments in the files
 * under test quote the very shapes being asserted. Without this, a guard can
 * pass on its own documentation.
 */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** The `controlRequirementLink.findMany({ … })` belonging to one function. */
function linksQueryOf(code: string, fnName: string): string {
    const start = code.indexOf(`export async function ${fnName}`);
    if (start === -1) throw new Error(`function not found: ${fnName}`);
    const q = code.indexOf('controlRequirementLink.findMany', start);
    if (q === -1) throw new Error(`no links query in ${fnName}`);
    return code.slice(q, code.indexOf('const mappedReqIds', q));
}

describe('every report family excludes soft-deleted rows', () => {
    it('the Risk Register PDF filters soft-deleted risks', () => {
        // This was the whole of the where clause: `{ tenantId: ctx.tenantId }`.
        expect(REPORT_REPO).toMatch(/where:\s*\{[^}]*deletedAt:\s*null/);
    });

    it('the risk-report engine filters soft-deleted risks', () => {
        // The family that was already correct — asserted so the two cannot
        // drift apart again from the other direction.
        expect(RISK_REPORT).toMatch(/where:\s*\{[^}]*deletedAt:\s*null/);
    });

    it('readiness filters soft-deleted CONTROLS, not just evidence', () => {
        // The evidence half already filtered, with a comment explaining that the
        // two report families must not diverge on what "counts". The control
        // half of the same query was missed — in BOTH of this file's queries.
        //
        // Asserted per-function against comment-stripped source. Counting
        // matches across the whole file was VACUOUS: the explanatory comments in
        // coverage.ts quote `control: { deletedAt: null }` in prose, so the
        // count stayed at 2 even after a real filter was deleted. A mutation
        // proved it — the guard passed with the bug reintroduced.
        const code = stripComments(COVERAGE);
        for (const fn of ['computeCoverage', 'generateReadinessReport']) {
            expect(linksQueryOf(code, fn)).toMatch(/control:\s*\{\s*deletedAt:\s*null\s*\}/);
        }
        expect(code).toMatch(/evidence:\s*\{\s*deletedAt:\s*null\s*\}/);
    });

    it('the SoA filters soft-deleted controls', () => {
        // Hardened for the same reason as the readiness assertion above, which
        // this half was left out of. `expect(SOA).toMatch(/deletedAt/)` was
        // VACUOUS three times over: soa.ts carries `deletedAt` in a type
        // declaration (:164), in the `select` that feeds this very filter
        // (:194), and in an unrelated comment (:399). Deleting the actual
        // filter left all three — and so the assertion — untouched.
        //
        // Unlike the other three families the SoA filters IN MEMORY, after the
        // query, so there is no WHERE shape to assert; pin the filter itself.
        const code = stripComments(SOA);
        expect(code).toMatch(/\.filter\(\s*\(?\s*[A-Za-z_$][\w$]*\s*\)?\s*=>\s*!\s*[A-Za-z_$][\w$]*\.control\.deletedAt\s*\)/);
    });
});

describe('every report family excludes deprecated requirements', () => {
    /** The `frameworkRequirement.findMany({ … })` belonging to one function. */
    function requirementsQueryOf(code: string, fnName: string): string {
        const start = code.indexOf(`export async function ${fnName}`);
        if (start === -1) throw new Error(`function not found: ${fnName}`);
        const q = code.indexOf('frameworkRequirement.findMany', start);
        if (q === -1) throw new Error(`no requirements query in ${fnName}`);
        return code.slice(q, code.indexOf('controlRequirementLink.findMany', q));
    }

    it('all three requirement reads filter deprecatedAt', () => {
        // The same divergence as the soft-delete family above, on the other
        // side of the join, and it survived that whole reconciliation:
        // `generateReadinessReport` and `getSoA` filtered deprecated
        // requirements, `computeCoverage` did not — so a field with the same
        // NAME (`coveragePercent`) and the same formula was computed over a
        // bigger denominator on the Frameworks page than in the two reports.
        //
        // Deprecation is default-on (`library-importer` ships
        // `deprecateMissing: true`), and a deprecated requirement can never be
        // mapped, so the gap only ever widened.
        const coverage = stripComments(COVERAGE);
        for (const fn of ['computeCoverage', 'generateReadinessReport']) {
            expect(requirementsQueryOf(coverage, fn)).toMatch(/deprecatedAt:\s*null/);
        }
        expect(requirementsQueryOf(stripComments(SOA), 'getSoA')).toMatch(/deprecatedAt:\s*null/);
    });
});

describe('the report family has ONE implementation per report', () => {
    it('no module outside framework/coverage.ts exports computeCoverage or listTemplates', () => {
        // `framework/install.ts` carried a dead second copy of both. Nothing in
        // src/ could reach it — the barrel re-exports from ./coverage — but it
        // was a FORK, not a mirror: both the soft-deleted-control fix and the
        // deprecated-requirement fix were applied to the live copy only, so the
        // twin still produced the two wrong compliance numbers, and its own
        // tests asserted that behaviour was correct.
        //
        // That is the failure mode this whole file exists to prevent, arriving
        // by copy rather than by drift. A duplicate is how a one-sided fix
        // happens; forbid the duplicate.
        const dir = path.join(ROOT, 'src/app-layer/usecases/framework');
        const offenders: string[] = [];
        for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'coverage.ts' && f !== 'index.ts')) {
            const src = stripComments(read(path.join('src/app-layer/usecases/framework', f)));
            for (const fn of ['computeCoverage', 'listTemplates']) {
                if (new RegExp(`export\\s+(async\\s+)?function\\s+${fn}\\b`).test(src)) {
                    offenders.push(`${f} exports ${fn}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});

describe('report reads are bounded', () => {
    it('the Risk Register PDF caps its rows', () => {
        // No `take` at all, on a query that feeds a rendered PDF.
        expect(REPORT_REPO).toMatch(/take:\s*RISK_REGISTER_MAX_ROWS/);
    });

    it('readiness bounds the per-control graph it materialises', () => {
        // It walked link -> control -> ALL tasks -> ALL evidence links ->
        // exceptions with no take anywhere.
        // coverage.ts has TWO controlRequirementLink.findMany queries —
        // computeCoverage's and generateReadinessReport's. Slice from the
        // SECOND, which is the one that walks the per-control graph. (Writing
        // this assertion is what surfaced that computeCoverage had the same
        // missing deletedAt filter, which the finding never mentioned.)
        // Anchor on the function DEFINITION, not the first textual mention of
        // its name — the name appears earlier in a comment, which silently
        // pointed this slice at computeCoverage's simpler query instead.
        const links = linksQueryOf(stripComments(COVERAGE), 'generateReadinessReport');
        // `[^}]*` would stop at the inner `select: { … }` brace before ever
        // reaching `take`, so the class has to span braces.
        expect(links).toMatch(/tasks:\s*\{[\s\S]*?take:\s*\d+/);
        expect(links).toMatch(/evidenceControlLinks:\s*\{[\s\S]*?take:\s*\d+/);
        // Only `.length > 0` is read from exceptions, so one row settles it.
        expect(links).toMatch(/exceptions:\s*\{[\s\S]*?take:\s*1/);
    });

    it('the latest-test-result lookup has both a row cap and a date bound', () => {
        // It pulled EVERY completed run for every mapped control and kept the
        // first per control in JS — the query grew without limit over a tenant's
        // lifetime while the answer stayed one row per control.
        expect(SOA).toMatch(/TEST_RESULT_MAX_ROWS/);
        expect(SOA).toMatch(/TEST_RESULT_LOOKBACK_DAYS/);
        expect(SOA).toMatch(/executedAt:\s*\{\s*gte:\s*since\s*\}/);
    });
});

describe('report routes declare a duration budget', () => {
    // Generation is synchronous inside the request, so the platform default cuts
    // it off mid-flight and leaves a ReportRun stranded in GENERATING with no
    // worker to settle it. pdf/generate was the only route that said so.
    it.each([
        'src/app/api/t/[tenantSlug]/reports/readiness/route.ts',
        'src/app/api/t/[tenantSlug]/reports/soa/route.ts',
        'src/app/api/t/[tenantSlug]/reports/soa/export.csv/route.ts',
        'src/app/api/t/[tenantSlug]/risks/reports/route.ts',
        'src/app/api/t/[tenantSlug]/reports/pdf/generate/route.ts',
    ])('%s exports maxDuration', (route) => {
        expect(read(route)).toMatch(/export const maxDuration\s*=\s*\d+/);
    });
});
