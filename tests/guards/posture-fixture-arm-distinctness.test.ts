/**
 * #2246 CLASS B, the forward half — *no derived value is byte-identical to a
 * constant in scope.*
 *
 * The two posture collectors were the filed instance: `cloud-posture.ts` takes
 * a `cloud` parameter and every test passed `'azure-posture'`, so at runtime
 * the parameter and the hard-coded literal were THE SAME STRING and replacing
 * `input.cloud` with the literal survived at every site — at 100% branch
 * coverage. #2245 / #2266 fixed that with a FIXTURE, not with assertions: the
 * suites run over an ARM TABLE pairing a cloud with its own benchmark, its own
 * ids, its own clock, so a literal written at ANY consuming site — including a
 * site added after the tests were written — fails the arm it does not name.
 *
 * What was missing is the part that keeps that true, and the issue is explicit
 * about the failure mode: **round two changed one fixture value and thereby
 * MOVED the coincidence rather than removing it.** Nothing in the tree could
 * notice, because the arm tables were file-local `const`s and the only check on
 * them was one hand-written assertion about ONE axis (`wallSkew`) out of
 * twenty-one — and any axis added later would have been unguarded by
 * construction.
 *
 * So this guard states the property mechanically, over ALL axes at once,
 * derived from the tables rather than from a list of names:
 *
 *   P1  every AXIS is pairwise distinct across arms.
 *   P2  no arm SCALAR is byte-identical to a literal constant in the collector
 *       source that arm drives.
 *   P3  the selections P1, P2 and P4 run over are NON-EMPTY, and the arms agree
 *       on their axis set. An assertion over a filtered set that passes when the
 *       set is empty checks nothing; each of the three properties below is a
 *       loop, so vacuity is the way each of them dies quietly.
 *   P4  no SCALAR anywhere in one arm appears anywhere in another — stronger
 *       than P1, because a coincidence can cross axes (`arm0.conn` equal to
 *       `arm1.exec` re-welds two derivations that P1 reads as distinct).
 *
 * WHY AN AST WALK FOR THE LITERALS. `literalConstantsOf` parses the collector
 * with `ts.createSourceFile` and harvests literal nodes. That is not
 * fastidiousness: a regex over the source text would also harvest the words in
 * the collectors' own long comments — both files discuss `'azure-posture'`,
 * `soc2` and `PASSED` in prose — so P2 would fail on prose and be "fixed" by
 * deleting an arm value that was never in danger. Class A of the same issue is
 * exactly this defect (a guard that reads raw text and lets prose satisfy it);
 * the AST cannot see a comment at all.
 *
 * MUTATION PROOF — each applied alone, this file re-run, and then restored.
 * Recorded here because a passing guard proves nothing:
 *
 *   P1  two arms given the same `wallSkew`                     -> 1 failed
 *       two arms given the same `exec`                         -> 3 failed (P1, P4, and
 *                                                                the suite's own clock test)
 *   P2  cloud arm0 `benchmark` back to `'soc2'`, the collector's
 *       own `config.benchmark ?? 'soc2'` default               -> 2 failed (P2, P4-adjacent)
 *   P4  `arm1.conn` set to `arm0.exec`'s value                 -> 1 failed (P4 only;
 *                                                                P1 stays green, which is
 *                                                                why P4 is not redundant)
 *   P3  `CLOUD_POSTURE_ARMS.slice(0, 1)` — a ONE-arm table     -> 4 failed. Without P3
 *       every per-axis and every cross-arm comparison is over an empty pair set
 *       and P1/P2/P4 all pass on a table that cannot distinguish anything.
 *   P3  the axis floor cut to 0                                -> P3 green, and the
 *       one-arm table above then passes P1/P4 — the floor is what makes them bite.
 *
 * And the two that matter most, because they are why this is a guard rather than
 * one more hand-written axis assertion — an axis that did NOT exist when it was
 * written:
 *
 *   P1/P4  a BRAND-NEW axis added to both cloud arms with one shared value
 *          -> 2 failed, both naming it: `newAxis: "shared-value" | "shared-value"`
 *          and `"shared-value": arm 0 arm.newAxis == arm 1 arm.newAxis`.
 *   P3     a new axis added to ONE arm only -> 1 failed, and only there. This is
 *          the quiet case: the missing side reads `undefined`, the flattener
 *          drops it, and the axis silently stops being compared at all. The
 *          axis-set agreement check is the only thing that sees it.
 *
 * The full round-1 measurements (an independent value-position AST walk of both
 * collectors, and a runtime observation of every derived site) are in
 * `docs/implementation-notes/2026-09-11-posture-derived-value-fixture-arms.md`.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { CLOUD_POSTURE_ARMS, AWS_POSTURE_ARMS } from '../helpers/posture-collector-arms';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Every literal constant the file spells — the values a mutant could write in
 * place of a derivation. Harvested from the AST, so a mention in a comment or a
 * JSDoc block contributes nothing.
 */
function literalConstantsOf(rel: string): Set<string> {
    const abs = path.join(REPO_ROOT, rel);
    const src = ts.createSourceFile(abs, fs.readFileSync(abs, 'utf8'), ts.ScriptTarget.ES2022, true);
    const out = new Set<string>();
    const visit = (n: ts.Node): void => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.add(n.text);
        else if (ts.isNumericLiteral(n)) out.add(n.text.replace(/_/g, ''));
        else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
            // A template's fixed pieces are literals too: `${cloud}.unknown`
            // makes `.unknown` writable, and a fixture value equal to a fixed
            // piece is the same coincidence one interpolation deep.
            if (n.text) out.add(n.text);
        }
        n.forEachChild(visit);
    };
    src.forEachChild(visit);
    return out;
}

/**
 * Flatten one arm to the scalars it actually contributes, keyed by value so a
 * collision can be reported with the axis path that produced it. A `Date` is
 * three scalars, because the collectors derive three different things from the
 * injected instant: the ISO string, the day cut out of it, and the epoch
 * milliseconds.
 */
function armScalars(arm: unknown): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (v: unknown, at: string): void => {
        if (v === null || v === undefined) return;
        if (v instanceof Date) {
            out.set(v.toISOString(), at);
            out.set(v.toISOString().slice(0, 10), `${at} (day)`);
            out.set(String(v.getTime()), `${at} (epoch ms)`);
            return;
        }
        if (typeof v === 'object') {
            for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, `${at}.${k}`);
            return;
        }
        out.set(String(v), at);
    };
    walk(arm, 'arm');
    return out;
}

/**
 * Scalars two arms are ALLOWED to share, each with the reason. P4 is otherwise
 * total. Adding an entry here is a decision somebody reviews; the staleness
 * test below refuses an entry that is no longer a real collision, so the list
 * cannot accumulate.
 */
const SHARED_SCALAR_EXEMPTIONS: Array<{ table: string; value: string; reason: string }> = [
    {
        table: 'AWS_POSTURE_ARMS',
        value: 'CC7.1',
        reason:
            "`trailingCodes` is the crosswalk the arm's trailing control resolves under, and both " +
            'arms deliberately land on one SOC 2 code so every framework-resolution assertion holds ' +
            'unchanged under either arm — the varying part is the control id, which P1 still checks. ' +
            'The codes reach the collector only inside `code: { in: codes }`, and the ARRAYS differ, ' +
            'so no single literal is byte-identical to either arm\'s value.',
    },
];

/** Axes two arms are ALLOWED to agree on. Empty, and it should stay empty. */
const SHARED_AXIS_EXEMPTIONS: Array<{ table: string; axis: string; reason: string }> = [];

interface Table {
    name: string;
    arms: readonly Record<string, unknown>[];
    source: string;
    /** Measured floors — see P3. Raise them when the table grows; never lower. */
    minAxes: number;
    minScalars: number;
    minSourceLiterals: number;
}

const TABLES: Table[] = [
    {
        name: 'CLOUD_POSTURE_ARMS',
        arms: CLOUD_POSTURE_ARMS as unknown as readonly Record<string, unknown>[],
        source: 'src/app-layer/usecases/cloud-posture.ts',
        minAxes: 21,
        minScalars: 48,
        minSourceLiterals: 32,
    },
    {
        name: 'AWS_POSTURE_ARMS',
        arms: AWS_POSTURE_ARMS as unknown as readonly Record<string, unknown>[],
        source: 'src/app-layer/usecases/aws-posture.ts',
        minAxes: 21,
        minScalars: 55,
        minSourceLiterals: 33,
    },
];

describe('posture collector arm tables keep every derived value distinguishable from a constant', () => {
    // ── P3, first, because it is what stops the other three being vacuous ──
    it('P3: both tables exist, carry at least two arms, and agree on their axis set', () => {
        expect(TABLES.map((t) => t.name)).toEqual(['CLOUD_POSTURE_ARMS', 'AWS_POSTURE_ARMS']);
        for (const t of TABLES) {
            expect(t.arms.length).toBeGreaterThanOrEqual(2);
            const axisSets = t.arms.map((a) => Object.keys(a).sort().join(','));
            // One arm holding a key the other lacks would shrink the compared
            // set silently: the missing side reads `undefined`, which the
            // flattener drops, so the axis would stop being checked at all.
            expect(new Set(axisSets).size).toBe(1);
            expect(Object.keys(t.arms[0]).length).toBeGreaterThanOrEqual(t.minAxes);
        }
    });

    it.each(TABLES)('P3: $name and $source both yield a non-empty population', (t) => {
        const literals = literalConstantsOf(t.source);
        expect(literals.size).toBeGreaterThanOrEqual(t.minSourceLiterals);
        for (const arm of t.arms) {
            expect(armScalars(arm).size).toBeGreaterThanOrEqual(Math.floor(t.minScalars / t.arms.length));
        }
        const all = new Set<string>();
        for (const arm of t.arms) for (const v of armScalars(arm).keys()) all.add(v);
        expect(all.size).toBeGreaterThanOrEqual(t.minScalars);
    });

    // ── P1 — per-axis distinctness ──
    it.each(TABLES)('P1: every axis of $name differs across every arm', (t) => {
        const exempt = new Set(SHARED_AXIS_EXEMPTIONS.filter((e) => e.table === t.name).map((e) => e.axis));
        const offenders: string[] = [];
        for (const axis of Object.keys(t.arms[0])) {
            if (exempt.has(axis)) continue;
            const spellings = t.arms.map((a) => JSON.stringify(a[axis]));
            if (new Set(spellings).size !== spellings.length) offenders.push(`${axis}: ${spellings.join(' | ')}`);
        }
        expect(offenders).toEqual([]);
    });

    // ── P2 — no arm value is a constant the collector already spells ──
    it.each(TABLES)('P2: no scalar in $name is byte-identical to a literal in $source', (t) => {
        const literals = literalConstantsOf(t.source);
        const offenders: string[] = [];
        t.arms.forEach((arm, i) => {
            for (const [value, at] of armScalars(arm)) {
                if (literals.has(value)) offenders.push(`arm ${i} ${at} = ${JSON.stringify(value)}`);
            }
        });
        expect(offenders).toEqual([]);
    });

    // ── P4 — cross-axis, cross-arm disjointness ──
    it.each(TABLES)('P4: no scalar of one $name arm appears anywhere in another', (t) => {
        const exempt = new Set(SHARED_SCALAR_EXEMPTIONS.filter((e) => e.table === t.name).map((e) => e.value));
        const flats = t.arms.map((a) => armScalars(a));
        const offenders: string[] = [];
        for (let i = 0; i < flats.length; i++) {
            for (let j = i + 1; j < flats.length; j++) {
                for (const [value, at] of flats[i]) {
                    if (exempt.has(value)) continue;
                    const other = flats[j].get(value);
                    if (other !== undefined) offenders.push(`${JSON.stringify(value)}: arm ${i} ${at} == arm ${j} ${other}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    // ── the allowlists cannot accumulate ──
    it('every SHARED_SCALAR_EXEMPTION is still a real collision, and carries a reason', () => {
        for (const e of SHARED_SCALAR_EXEMPTIONS) {
            expect(e.reason.length).toBeGreaterThan(60);
            const t = TABLES.find((x) => x.name === e.table);
            expect(t).toBeDefined();
            const flats = t!.arms.map((a) => armScalars(a));
            const holders = flats.filter((f) => f.has(e.value)).length;
            // Still shared by two or more arms — otherwise the exemption is
            // dead weight and hides the next real one.
            expect(holders).toBeGreaterThanOrEqual(2);
        }
    });

    it('every SHARED_AXIS_EXEMPTION is still a real collision, and carries a reason', () => {
        for (const e of SHARED_AXIS_EXEMPTIONS) {
            expect(e.reason.length).toBeGreaterThan(60);
            const t = TABLES.find((x) => x.name === e.table)!;
            const spellings = t.arms.map((a) => JSON.stringify(a[e.axis]));
            expect(new Set(spellings).size).not.toBe(spellings.length);
        }
    });
});
