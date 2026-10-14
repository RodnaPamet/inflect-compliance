/**
 * The sub-processor register and the code constants say the same thing.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT A LITERAL PIN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two tests used to assert `TYPESAFE_SUBPROCESSOR_ACTIVE === false` and one
 * asserted `LEGACY_MATCH_PROCESSOR.EXTERNAL.region === 'EU'`. Both are the same
 * mistake in different clothes: a constant compared against a literal written
 * beside it. That notices an accidental edit and nothing else. In particular it
 * cannot notice the two failures that actually reach somebody outside this
 * repository:
 *
 *   - the register saying "proposed; inactive — nothing is sent today" while the
 *     code is live. The register is what a customer or an auditor is shown.
 *   - the region constant disagreeing with the register's Region column. That
 *     string is written into the HASH-CHAINED, IMMUTABLE `AuditLog` by
 *     `tenant-security-settings.ts`, on the one event built to answer "when did
 *     our data start going to a third party, and which one". A wrong value there
 *     cannot be corrected later, only compensated.
 *
 * The region pin was not a hypothetical: it stood at `'EU'` while three separate
 * documents said US West Coast (#3419), almost certainly read off the design
 * document's "the DPA uses EU Standard Contractual Clauses" — the SCCs being the
 * instrument that permits the transfer, needed precisely BECAUSE the destination
 * is outside the EU. A test comparing the constant to the register would have
 * caught it the day it was written. A test comparing the constant to `'EU'`
 * locked it in.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WAIVER ARM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `docs/sub-processor-change-policy.md` requires four steps before activation.
 * NOTHING in CI enforced them: activation is a one-line constant change, and a
 * pull request flipping it while the register read "Notice sent: pending" would
 * have gone green. TypeSafe was in fact activated on 2026-10-11 by owner
 * decision with steps 2 and 3 not performed.
 *
 * So this guard does not require the steps to be complete — that is a decision
 * the owner is entitled to make and a test cannot overrule. It requires the
 * register to SAY SO: if the status is active while any step is incomplete,
 * a dated activation waiver must be present. The failure mode being closed is
 * not "somebody skipped a step", it is "the register still reads *pending* next
 * to a live transfer", which is the state that misleads a reader who trusts it.
 *
 * @module guardrails/sub-processor-record-agrees-with-code
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    LEGACY_MATCH_PROCESSOR,
    TYPESAFE_SUBPROCESSOR_ACTIVE,
} from '@/lib/legacy-access/adjudication-mode';

const ROOT = path.resolve(__dirname, '../..');
const REGISTER = 'docs/sub-processors.md';

/** The inventory table's columns, in order. */
const REGION_COLUMN = 3; // Name | Data shared | Purpose | **Region** | Retention | Operator-optional
const INVENTORY_COLUMNS = 6;

export interface RegisterFacts {
    readonly status: 'active' | 'proposed-inactive' | null;
    readonly region: string | null;
    readonly regionColumnCount: number;
    readonly incompleteSteps: readonly string[];
    readonly stepCount: number;
    readonly waiverDate: string | null;
}

/**
 * Everything this guard needs from the register, read in one pass.
 *
 * A pure function of the text so the detector proofs at the bottom can feed it
 * synthetic registers. Every field is nullable rather than defaulted: a parse
 * that finds nothing must be distinguishable from a parse that found a real
 * value, because "not found" satisfies most negative assertions.
 */
export function readRegister(md: string, vendorCell = 'TypeSafe AI (Jev)'): RegisterFacts {
    const lines = md.split('\n');

    // ── the inventory row ──
    let region: string | null = null;
    let regionColumnCount = 0;
    for (const line of lines) {
        if (!line.startsWith(`| ${vendorCell} |`)) continue;
        // Drop the leading and trailing empty fields a markdown row produces.
        const cells = line.split('|').slice(1, -1).map((c) => c.trim());
        regionColumnCount = cells.length;
        // Only trust the column if the row has the shape we think it has. A
        // pipe inside a cell would shift every column right and hand back a
        // plausible-looking wrong answer, which is worse than no answer.
        if (cells.length === INVENTORY_COLUMNS) region = cells[REGION_COLUMN] ?? null;
        break;
    }

    // ── the machine-readable status ──
    const statusMatch = /\*\*Activation status:\*\*\s*(active|proposed-inactive)\b/.exec(md);
    const status = (statusMatch?.[1] as RegisterFacts['status']) ?? null;

    // ── the policy-progress table ──
    // Rows look like: `| 2 — compliance / legal review | **Not performed** … |`
    // A step counts as complete only when its state cell says so. Anything else
    // — pending, not performed, blank — is incomplete. Read the STATE cell, not
    // the line: the step's own label contains the word "complete" in step 4's
    // description elsewhere in the document.
    const incompleteSteps: string[] = [];
    let stepCount = 0;
    for (const line of lines) {
        const m = /^\|\s*(\d)\s*—\s*([^|]+?)\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
        if (!m) continue;
        stepCount += 1;
        const state = (m[3] ?? '').replace(/\*/g, '').trim();
        if (!/^complete\b/i.test(state)) incompleteSteps.push(`${m[1]} — ${(m[2] ?? '').trim()}`);
    }

    // ── the waiver ──
    const waiver = /\*\*Activation waiver\s*—\s*(\d{4}-\d{2}-\d{2})\*\*/.exec(md);

    return {
        status,
        region,
        regionColumnCount,
        incompleteSteps,
        stepCount,
        waiverDate: waiver?.[1] ?? null,
    };
}

describe('the sub-processor register agrees with the code', () => {
    const md = fs.readFileSync(path.join(ROOT, REGISTER), 'utf8');
    const facts = readRegister(md);

    it('the register parses at all — the denominator beside every result below', () => {
        // Each assertion after this one would pass over a failed parse: a null
        // status compared to nothing, an empty incomplete-step list, an absent
        // region. This is the test that turns a silent parse failure loud.
        expect(facts.regionColumnCount).toBe(INVENTORY_COLUMNS);
        expect(facts.region).not.toBeNull();
        expect(facts.status).not.toBeNull();
        expect(facts.stepCount).toBe(4);
    });

    it('the activation status matches TYPESAFE_SUBPROCESSOR_ACTIVE', () => {
        expect(facts.status).toBe(TYPESAFE_SUBPROCESSOR_ACTIVE ? 'active' : 'proposed-inactive');
    });

    it('the Region column matches the constant written into the audit log', () => {
        expect(facts.region).toBe(LEGACY_MATCH_PROCESSOR.EXTERNAL.region);
    });

    it('the region is not described as EU, which the SCCs rule out rather than imply', () => {
        // Belt and braces over the agreement above: the two could agree on a
        // wrong value if somebody "fixed" the register to match the code. The
        // transfer impact assessment and the Standard Contractual Clauses in the
        // register exist because the destination is OUTSIDE the EU, so an EU
        // region here would contradict the same document's Transfer section.
        expect(LEGACY_MATCH_PROCESSOR.EXTERNAL.region).not.toMatch(/\bEU\b|Europe/);
        expect(facts.region).not.toMatch(/\bEU\b|Europe/);
    });

    it('an active status with incomplete policy steps carries a dated waiver', () => {
        if (facts.status !== 'active') return;
        if (facts.incompleteSteps.length === 0) return;
        // Steps 2 and 3 were waived by owner decision on 2026-10-11. The guard
        // does not object to that; it objects to it being unrecorded.
        expect(facts.waiverDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('records which steps are outstanding, so the waiver cannot be a blanket one', () => {
        // Asserting the CURRENT shape on purpose. If somebody later completes
        // step 2 or 3, or activates a different sub-processor without a record,
        // this fails and the waiver prose has to be brought up to date with it.
        expect(facts.incompleteSteps.map((s) => s.split(' — ')[0]).sort()).toEqual(['2', '3']);
    });
});

/**
 * Prose in `src/` may not state a value the constant does not have.
 *
 * The register and the constant were already checked against each other above.
 * Nothing checked the SENTENCES, and on 2026-10-11 the constant flipped to
 * `true` while three places in `src/` went on saying it was `false`:
 *
 *   - `src/env.ts`, beside `TYPESAFE_API_KEY`: "TypeSafe is a PROPOSED,
 *     INACTIVE sub-processor ... so setting this key does NOT make the provider
 *     reachable for tenant work."
 *   - `jev-provider.ts`: "It is inert until somebody activates the
 *     sub-processor. TYPESAFE_SUBPROCESSOR_ACTIVE is `false`."
 *   - `identity-match/index.ts`: "must be true, and it is false."
 *
 * Each was true when written. None broke. They expired, and they expired in the
 * direction that matters: all three tell a reader the external path is inert,
 * when it is live and gated only by a per-tenant mode. An operator deciding
 * whether installing the key has consequences, or auditing what leaves the
 * deployment, gets the wrong answer from the most authoritative-looking place.
 *
 * WHY A LINE-SCOPED CLAIM RATHER THAN A WORD SEARCH. "inactive" and "proposed"
 * appear legitimately as HISTORY — "Step 6a registered TypeSafe as proposed,
 * inactive" is a true sentence about the past and must stay sayable, as must a
 * quotation of the very claim this guard exists for. So the subject is narrow: a
 * line naming the constant AND asserting a boolean of it. A scar is not a wound.
 */
describe('prose in src/ agrees with TYPESAFE_SUBPROCESSOR_ACTIVE', () => {
    /** Lines that name the constant and assert a value for it. */
    function assertedValues(src: string): readonly boolean[] {
        const out: boolean[] = [];
        for (const line of src.split('\n')) {
            if (!line.includes('TYPESAFE_SUBPROCESSOR_ACTIVE')) continue;
            // The assertion forms actually used in this repo, and only those:
            // "is false", "is `true`", "must be true, and it is false".
            const after = line.slice(line.indexOf('TYPESAFE_SUBPROCESSOR_ACTIVE'));
            const saysFalse = /\bis\s+`?false`?/i.test(after) || /and it is false/i.test(after);
            const saysTrue = /\bis\s+`?true`?/i.test(after) || /and it is true/i.test(after);
            if (saysFalse && !saysTrue) out.push(false);
            else if (saysTrue && !saysFalse) out.push(true);
        }
        return out;
    }

    const SOURCES = [
        'src/env.ts',
        'src/app-layer/ai/identity-match/jev-provider.ts',
        'src/app-layer/ai/identity-match/index.ts',
        'src/lib/legacy-access/adjudication-mode.ts',
        'src/app-layer/usecases/tenant-security-settings.ts',
    ] as const;

    it('reads a non-empty population, so a clean run is not an empty one', () => {
        // The denominator beside the result: if these files stopped naming the
        // constant, the assertion below would pass over nothing.
        const claims = SOURCES.flatMap((rel) =>
            assertedValues(fs.readFileSync(path.join(ROOT, rel), 'utf8')),
        );
        expect(claims.length).toBeGreaterThan(0);
    });

    it('every stated value matches the constant', () => {
        const wrong: string[] = [];
        for (const rel of SOURCES) {
            for (const stated of assertedValues(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) {
                if (stated !== TYPESAFE_SUBPROCESSOR_ACTIVE) {
                    wrong.push(`${rel}: prose says ${stated}, constant is ${TYPESAFE_SUBPROCESSOR_ACTIVE}`);
                }
            }
        }
        expect(wrong).toEqual([]);
    });

    describe('detector proof — on synthetic sources', () => {
        it('catches the exact sentence that shipped', () => {
            const bad = ' * {@link TYPESAFE_SUBPROCESSOR_ACTIVE} is `false`, and so the path is inert.';
            expect(assertedValues(bad)).toEqual([false]);
        });

        it('catches the other shipped form', () => {
            const bad = ' * 2. `TYPESAFE_SUBPROCESSOR_ACTIVE` must be true, and it is false.';
            expect(assertedValues(bad)).toEqual([false]);
        });

        it('reads a true claim as true', () => {
            const good = ' * {@link TYPESAFE_SUBPROCESSOR_ACTIVE} is `true` since #3409.';
            expect(assertedValues(good)).toEqual([true]);
        });

        it('says NOTHING about history that names no value', () => {
            // Must stay sayable: this is a true sentence about Step 6a.
            const history = ' * Step 6a registered TypeSafe as *proposed, inactive*; a notice window closed.';
            expect(assertedValues(history)).toEqual([]);
        });

        it('says nothing about a QUOTATION of the stale claim', () => {
            // The fix for this class cites the old wording. A word search would
            // flag the citation and make the lesson unwritable.
            const quoted = ' * Until #3409 this read "and it is false", which inverted the one fact.';
            expect(assertedValues(quoted)).toEqual([]);
        });

        it('ignores a line that names the constant without asserting a value', () => {
            const neutral = 'import { TYPESAFE_SUBPROCESSOR_ACTIVE } from "@/lib/legacy-access/adjudication-mode";';
            expect(assertedValues(neutral)).toEqual([]);
        });
    });
});

describe('detector proof — on synthetic registers, so a clean run means something', () => {
    const row = (region: string) =>
        `| TypeSafe AI (Jev) | data | purpose | ${region} | Zero retention | Yes |`;
    const steps = (s2: string) => [
        '| Step | State |',
        '|------|-------|',
        '| 1 — engineering proposes | Complete |',
        `| 2 — compliance / legal review | ${s2} |`,
        '| 3 — customer notice (30 days) | Complete |',
        '| 4 — activation | Complete |',
    ].join('\n');

    it('reads the Region column out of the inventory row', () => {
        expect(readRegister(row('US (West Coast)')).region).toBe('US (West Coast)');
    });

    it('refuses the column when a pipe inside a cell shifts the row', () => {
        // The failure this prevents: a cell containing `a | b` makes the row
        // seven fields wide, and blindly taking index 3 returns a neighbouring
        // column that LOOKS like an answer.
        const shifted = '| TypeSafe AI (Jev) | data | with | a pipe | purpose | EU | Zero | Yes |';
        const f = readRegister(shifted);
        expect(f.regionColumnCount).not.toBe(6);
        expect(f.region).toBeNull();
    });

    it('reads both status values, and nothing else', () => {
        expect(readRegister('- **Activation status:** active').status).toBe('active');
        expect(readRegister('- **Activation status:** proposed-inactive').status)
            .toBe('proposed-inactive');
        // Not a status at all, and specifically not defaulted to one.
        expect(readRegister('- **Activation status:** maybe').status).toBeNull();
        expect(readRegister('nothing here').status).toBeNull();
    });

    it('classifies a pending step as incomplete and a complete one as complete', () => {
        expect(readRegister(steps('Pending — recorded on the pull request')).incompleteSteps)
            .toHaveLength(1);
        expect(readRegister(steps('Complete')).incompleteSteps).toHaveLength(0);
        expect(readRegister(steps('**Not performed** — waived')).incompleteSteps)
            .toHaveLength(1);
    });

    it('reads the STATE cell, not the line — a step whose LABEL says complete is still pending', () => {
        // The bug this exists for: matching /complete/i against the whole line
        // marks `| 4 — activation requires steps 1–3 complete | Pending |`
        // as done, which is the one row where getting it wrong matters most.
        const md = [
            '| Step | State |',
            '|------|-------|',
            '| 1 — proposes | Complete |',
            '| 2 — review | Complete |',
            '| 3 — notice | Complete |',
            '| 4 — activation requires steps 1–3 complete with no objection | Pending |',
        ].join('\n');
        expect(readRegister(md).incompleteSteps.map((s) => s.split(' — ')[0])).toEqual(['4']);
    });

    it('finds a dated waiver, and does not accept an undated one', () => {
        expect(readRegister('**Activation waiver — 2026-10-11**').waiverDate).toBe('2026-10-11');
        expect(readRegister('**Activation waiver — soon**').waiverDate).toBeNull();
        expect(readRegister('we waived it, honestly').waiverDate).toBeNull();
    });

    it('the whole shape this guard refuses: active, a step pending, no waiver', () => {
        const bad = [
            '- **Activation status:** active',
            row('US (West Coast)'),
            steps('Pending — recorded on the pull request'),
        ].join('\n\n');
        const f = readRegister(bad);
        expect(f.status).toBe('active');
        expect(f.incompleteSteps.length).toBeGreaterThan(0);
        expect(f.waiverDate).toBeNull(); // <- the assertion in the suite above fails on this
    });
});
