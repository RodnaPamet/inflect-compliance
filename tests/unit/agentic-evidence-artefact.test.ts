/**
 * The pure half of agentic evidence emission — the period, the digest, and the
 * declared map from record kind to obligation.
 *
 * These are the parts a re-derivation depends on. An artefact emitted in August
 * has to be reproducible byte-for-byte during the audit that reads it in March,
 * which means the period arithmetic cannot consult a clock and the digest cannot
 * depend on the order a database happened to return rows in.
 */
import * as fs from 'fs';

import { LEGACY_KEY_FAMILY_URNS } from '@/app-layer/domain/framework-representation';
import {
    AGENTIC_ARTEFACT_KINDS,
    ARTEFACT_KIND_DECISIONS,
    ARTEFACT_KIND_HARNESS_SCANS,
    ARTEFACT_KIND_PASSPORTS,
    ARTEFACT_KIND_RECEIPTS,
    ASI_LIBRARY_URN,
    EVIDENCE_TARGETS,
    HARNESS_SCANNER_CAP,
    buildDecisionArtefact,
    buildHarnessScanArtefact,
    buildReceiptArtefact,
    buildWithdrawalNotice,
    harnessArtefactCompleteness,
    harnessArtefactEvidenceStatus,
    harnessDigestFacts,
    harnessIncompleteReasons,
    harnessStatusCorrection,
    monthlyPeriod,
    periodForKind,
    sourcePopulationDigest,
    targetsForKind,
    type HarnessBoundsFact,
    type HarnessPeriodFacts,
    type HarnessSilentScannersFact,
    type HarnessScanFact,
    type HarnessTallies,
    weeklyPeriod,
    type ReceiptFact,
} from '@/lib/agentic/evidence-artefact';
import { repoFiles } from '../helpers/repo-files';

describe('the period is the UTC month containing the instant', () => {
    it('is half-open — the first instant of the next month is not in it', () => {
        const period = monthlyPeriod(new Date('2026-08-14T09:00:00.000Z'));
        expect(period.start.toISOString()).toBe('2026-08-01T00:00:00.000Z');
        expect(period.end.toISOString()).toBe('2026-09-01T00:00:00.000Z');
        expect(period.label).toBe('2026-08');
    });

    it('rolls the year over in December', () => {
        // The arithmetic is `Date.UTC(y, m + 1, 1)`, which is only correct
        // because Date.UTC normalises month 12 into January of the next year.
        // Hard-coding `${y}-${m+2}` would produce a "2026-13" label here.
        const period = monthlyPeriod(new Date('2026-12-31T23:59:59.999Z'));
        expect(period.start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
        expect(period.end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
        expect(period.label).toBe('2026-12');
    });

    it('puts the boundary instant itself in the month it starts', () => {
        expect(monthlyPeriod(new Date('2026-08-01T00:00:00.000Z')).label).toBe('2026-08');
        expect(monthlyPeriod(new Date('2026-07-31T23:59:59.999Z')).label).toBe('2026-07');
    });

    it('pads the month to two digits', () => {
        expect(monthlyPeriod(new Date('2026-01-15T00:00:00.000Z')).label).toBe('2026-01');
        expect(monthlyPeriod(new Date('2026-10-15T00:00:00.000Z')).label).toBe('2026-10');
    });
});

describe('the weekly period is the ISO 8601 week containing the instant, in UTC', () => {
    const at = (iso: string) => weeklyPeriod(new Date(iso));

    it('runs Monday 00:00 UTC to the next Monday, end exclusive', () => {
        // The sweep's own slot: Sunday 05:45 lands on the last day of the week
        // it evidences.
        const w = at('2026-10-18T05:45:00.000Z');
        expect(w.label).toBe('2026-W42');
        expect(w.start.toISOString()).toBe('2026-10-12T00:00:00.000Z');
        expect(w.end.toISOString()).toBe('2026-10-19T00:00:00.000Z');
    });

    it('puts the Monday boundary instant in the week it starts', () => {
        expect(at('2026-10-19T00:00:00.000Z').label).toBe('2026-W43');
        expect(at('2026-10-19T00:00:00.000Z').start.toISOString()).toBe('2026-10-19T00:00:00.000Z');
        expect(at('2026-10-18T23:59:59.999Z').label).toBe('2026-W42');
    });

    it('names the ISO week-year, which is the year of the week\'s Thursday', () => {
        // 2026 starts on a Thursday, so it has 53 ISO weeks and its last one
        // runs into January 2027.
        expect(at('2026-12-31T12:00:00.000Z').label).toBe('2026-W53');
        expect(at('2027-01-03T23:59:59.999Z').label).toBe('2026-W53');
        expect(at('2027-01-04T00:00:00.000Z').label).toBe('2027-W01');
        // …and the other direction: the last days of December in week 1.
        expect(at('2024-12-30T00:00:00.000Z').label).toBe('2025-W01');
        expect(at('2026-01-01T00:00:00.000Z').label).toBe('2026-W01');
        expect(at('2025-12-29T00:00:00.000Z').start.toISOString()).toBe('2025-12-29T00:00:00.000Z');
    });

    it('pads the week to two digits', () => {
        expect(at('2026-01-07T00:00:00.000Z').label).toBe('2026-W02');
    });
});

describe('an artefact\'s period follows its kind', () => {
    const start = new Date('2026-10-12T00:00:00.000Z');

    it('is the ISO week for integration passports', () => {
        expect(periodForKind('INTEGRATION_PASSPORTS', start).label).toBe('2026-W42');
    });

    it('is the month for every other kind, including one this build does not know', () => {
        expect(periodForKind(ARTEFACT_KIND_RECEIPTS, start).label).toBe('2026-10');
        expect(periodForKind(ARTEFACT_KIND_DECISIONS, start).label).toBe('2026-10');
        expect(periodForKind('A_KIND_FROM_A_LATER_BUILD', start).label).toBe('2026-10');
    });
});


/** A minimal receipt fact, so the digest tests name a fact rather than an id. */
const rf = (id: string, over: Partial<ReceiptFact> = {}): ReceiptFact => ({
    id,
    toolName: 'list_risks',
    decisionVerdict: 'allow',
    verified: true,
    auditLogId: `audit-${id}`,
    toolProvenance: 'inflect:builtin',
    ...over,
});

describe('the population digest identifies a set, not a sequence', () => {
    const start = new Date('2026-08-01T00:00:00.000Z');

    it('is the same for the same ids in a different order', () => {
        // Row order is not a fact about the population. Without the sort, two
        // runs that read the same month would digest differently and every tick
        // would look like a change.
        const a = sourcePopulationDigest(ARTEFACT_KIND_RECEIPTS, start, [rf('c'), rf('a'), rf('b')]);
        const b = sourcePopulationDigest(ARTEFACT_KIND_RECEIPTS, start, [rf('a'), rf('b'), rf('c')]);
        expect(a).toBe(b);
    });

    it('changes when the population changes', () => {
        const before = sourcePopulationDigest(ARTEFACT_KIND_RECEIPTS, start, [rf('a'), rf('b')]);
        const after = sourcePopulationDigest(ARTEFACT_KIND_RECEIPTS, start, [rf('a'), rf('b'), rf('c')]);
        expect(after).not.toBe(before);
    });

    it('is bound to the kind and the period', () => {
        const ids = [rf('a'), rf('b')];
        const receipts = sourcePopulationDigest(ARTEFACT_KIND_RECEIPTS, start, ids);
        const decisions = sourcePopulationDigest(ARTEFACT_KIND_DECISIONS, start, ids);
        const nextMonth = sourcePopulationDigest(
            ARTEFACT_KIND_RECEIPTS,
            new Date('2026-09-01T00:00:00.000Z'),
            ids,
        );
        // Otherwise a digest could be mistaken for one of a different
        // population that happens to hold the same ids.
        expect(new Set([receipts, decisions, nextMonth]).size).toBe(3);
    });

    it('is a hex SHA-256', () => {
        expect(sourcePopulationDigest(ARTEFACT_KIND_RECEIPTS, start, [])).toMatch(
            /^[0-9a-f]{64}$/,
        );
    });
});

describe('the kind → obligation map', () => {
    it('gives every kind at least one obligation', () => {
        for (const kind of AGENTIC_ARTEFACT_KINDS) {
            expect(targetsForKind(kind).length).toBeGreaterThan(0);
        }
    });

    it('names each obligation once per kind', () => {
        // A duplicate would resolve to one control twice and collide on the
        // artefact identity rather than emitting two artefacts.
        const seen = EVIDENCE_TARGETS.map(
            (t) => `${t.kind}::${t.familyUrn}::${t.requirementCode}`,
        );
        expect(new Set(seen).size).toBe(seen.length);
    });

    it('evidences the integration passport on supplier and access obligations in three families (#3672)', () => {
        // ASI-only would leave every ISO 27001 and SOC 2 tenant with nothing
        // emitted, and so with no prior week for its drift to be compared with.
        expect(
            targetsForKind(ARTEFACT_KIND_PASSPORTS)
                .map((t) => `${t.familyUrn}#${t.requirementCode}`)
                .sort(),
        ).toEqual([
            'urn:inflect:library:iso27001-2022#A.5.15',
            'urn:inflect:library:iso27001-2022#A.5.19',
            'urn:inflect:library:owasp-agentic-top10#ASI03',
            'urn:inflect:library:owasp-agentic-top10#ASI04',
            'urn:inflect:library:soc2-2017#CC6.1',
            'urn:inflect:library:soc2-2017#CC9.1',
        ]);
    });

    it("names, for ISO 27001 and SOC 2, the seeded key the representation module maps to that family", () => {
        // A legacy key the representation module does not know reaches no row
        // a pre-urn database holds, silently.
        for (const t of targetsForKind(ARTEFACT_KIND_PASSPORTS)) {
            const known = Object.entries(LEGACY_KEY_FAMILY_URNS)
                .filter(([, urn]) => urn === t.familyUrn)
                .map(([key]) => key);
            if (known.length === 0) continue; // ASI: its legacy keys are the target's own
            expect(t.legacyKeys).toEqual(known);
        }
    });

    it('lists exactly the kinds the newest migration CHECK allows', () => {
        // The DB CHECK on `kind` is DROP + ADD in each migration that widens
        // it, so the one that sorts LAST is the one in force. Two branches
        // widening it in parallel must re-list each other's kind; this fails
        // the branch that merges second until it does.
        const migrations = repoFiles({ under: 'prisma/migrations', extensions: ['.sql'] })
            .filter((f) => fs.readFileSync(f, 'utf8').includes('"AgenticEvidenceArtefact_kind_known"'))
            .sort();
        const newest = fs.readFileSync(migrations[migrations.length - 1], 'utf8');
        const check = /ADD CONSTRAINT "AgenticEvidenceArtefact_kind_known"\s+CHECK \("kind" IN \(([^)]*)\)\)/.exec(newest);
        expect(check).not.toBeNull();
        const allowed = check![1].split(',').map((k) => k.trim().replace(/^'|'$/g, '')).sort();
        expect(allowed).toEqual([...AGENTIC_ARTEFACT_KINDS].sort());
    });

    it('carries a written reason on every entry', () => {
        // "Which risk does this receipt evidence" is a compliance judgement, and
        // an entry nobody justified is a claim nobody made.
        for (const target of EVIDENCE_TARGETS) {
            expect(target.reason.length).toBeGreaterThan(40);
        }
    });
});

describe('the artefact body', () => {
    const period = monthlyPeriod(new Date('2026-08-14T00:00:00.000Z'));

    it('separates verified-and-linked from verified and from recorded', () => {
        const body = buildReceiptArtefact(
            period,
            [
                { id: '1', toolName: 'list_risks', decisionVerdict: 'allow', verified: true, auditLogId: 'a1', toolProvenance: 'inflect:builtin' },
                { id: '2', toolName: 'list_risks', decisionVerdict: 'block', verified: false, auditLogId: null, toolProvenance: null },
                { id: '3', toolName: 'other', decisionVerdict: 'allow', verified: true, auditLogId: null, toolProvenance: 'unattested' },
            ],
            'd'.repeat(64),
        );
        expect(body.content).toContain('Mediated agent actions recorded: 3');
        expect(body.content).toContain('verified and linked to the hash-chained audit trail: 1');
        expect(body.content).toContain('verified but not linked: 1');
        expect(body.content).toContain(
            'signature did not verify (recorded, flagged, never trusted): 1',
        );
        // An absent provenance is reported as unrecorded rather than dropped —
        // "we do not know which definition was in front of it" is the fact.
        expect(body.content).toContain('unrecorded: 1');
    });

    it('declares what it deliberately omits', () => {
        const body = buildDecisionArtefact(period, [], 'e'.repeat(64));
        expect(body.content).toContain('REDACTION CONTRACT');
        expect(body.title).toContain('EU AI Act Art 12');
    });

    describe('an AUTONOMOUS decision is not an Art 14 outcome (#2861)', () => {
        const fact = (humanOutcome: string) => ({
            id: `d-${humanOutcome}`,
            feature: 'external-write-automatic',
            provider: 'mcp-agent',
            guardVerdict: null,
            humanOutcome,
        });

        it('counts it in its own bucket, never as "reached a human-oversight outcome"', () => {
            // `reviewed` was `facts.length - pending.length`, which was exact
            // while every non-PENDING value was a review verdict. The external
            // -write ladder's AUTOMATIC rung writes rows that reached NOBODY,
            // and the subtraction counted each of them as supervised — on the
            // artefact an assessor reads precisely to ask how much was.
            const body = buildDecisionArtefact(
                period,
                [fact('ACCEPTED'), fact('AUTONOMOUS'), fact('AUTONOMOUS'), fact('PENDING')],
                'a'.repeat(64),
            );
            expect(body.content).toContain('AI invocations recorded (EU AI Act Art 12 automatic record-keeping): 4');
            expect(body.content).toContain('reached a human-oversight outcome (Art 14): 1');
            expect(body.content).toContain('still pending review: 1');
            expect(body.content).toContain(
                'dispatched autonomously, with no human review by design: 2',
            );
        });

        it('states the autonomous line even at zero — absence is a finding', () => {
            // A line that disappears when the count is nil reads as a feature
            // the product does not have, rather than as a period in which
            // nothing was dispatched unattended.
            const body = buildDecisionArtefact(period, [fact('ACCEPTED')], 'b'.repeat(64));
            expect(body.content).toContain(
                'dispatched autonomously, with no human review by design: 0',
            );
            expect(body.content).toContain('reached a human-oversight outcome (Art 14): 1');
        });

        it('says so when it meets an outcome it has no bucket for', () => {
            // The three named counts must ADD UP. A sixth enum member would
            // otherwise land in whichever bucket a subtraction favoured, which
            // is the defect this section replaces — so the shortfall is printed
            // as a defect in the artefact rather than silently absorbed.
            const body = buildDecisionArtefact(
                period,
                [fact('PENDING'), fact('SOMETHING_NEW')],
                'c'.repeat(64),
            );
            expect(body.content).toMatch(/NOT CLASSIFIED by this artefact \(1\)/);
            // And the raw tally still names it, so the fact is recoverable.
            expect(body.content).toMatch(/Human outcomes —.*SOMETHING_NEW/);
        });

        it('prints no such line when every outcome IS classified — the control', () => {
            const body = buildDecisionArtefact(
                period,
                [fact('PENDING'), fact('EDITED'), fact('AUTONOMOUS')],
                'd'.repeat(64),
            );
            expect(body.content).not.toMatch(/NOT CLASSIFIED/);
        });
    });

    it('replaces the counts with a dated notice on withdrawal', () => {
        const notice = buildWithdrawalNotice(
            period,
            'CONTROL_REMOVED',
            new Date('2026-09-02T10:00:00.000Z'),
            'f'.repeat(64),
        );
        expect(notice).toContain('WITHDRAWN 2026-09-02T10:00:00.000Z — CONTROL_REMOVED');
        expect(notice).toContain('f'.repeat(64));
        // The counts it withdrew must not survive alongside the notice.
        expect(notice).not.toContain('Mediated agent actions recorded');
    });
});


// ── Harness scans (#3687) ───────────────────────────────────────────────────

const NO_BOUNDS: HarnessBoundsFact = {
    bounds: true,
    scansTruncated: false,
    tallyTruncated: false,
    scannersTruncated: false,
};

const tallies = (over: Partial<HarnessTallies> = {}): HarnessTallies => ({
    levels: { H0: 1, H1: 0, H2: 2, H3: 0, H4: 0, H5: 0 },
    reach: { READ_ONLY: 1, WRITE_OR_EXTERNAL: 2, UNKNOWN: 0 },
    belowBar: 1,
    notInRegister: 1,
    ...over,
});

/** A scan fact: by default its scanner's latest, COMPLETE, three agents, tallied. */
const scan = (id: string, over: Partial<HarnessScanFact> = {}): HarnessScanFact => ({
    id,
    scanRef: `ref-${id}`,
    scannerAgentId: 'scanner-a',
    scannerVersion: '0.1.0',
    asOf: '2026-10-10T03:00:00.000Z',
    reportDigest: 'd'.repeat(64),
    latestForScanner: true,
    completeness: 'COMPLETE',
    sources: [{ kind: 'entra-sp', status: 'COMPLETE', rows: 10, reason: null }],
    agentCount: 3,
    tallies: tallies(),
    ...over,
});

const NO_SILENT: HarnessSilentScannersFact = { silentScanners: true, agentIds: [], truncated: false };

const period = (
    f: HarnessScanFact[],
    bounds: Partial<HarnessBoundsFact> = {},
    silent: Partial<HarnessSilentScannersFact> = {},
): HarnessPeriodFacts => ({
    scans: f,
    bounds: { ...NO_BOUNDS, ...bounds },
    silent: { ...NO_SILENT, ...silent },
});

describe('harness scans become evidence against ASI10 and ASI03 only', () => {
    it('targets exactly the inventory and the access obligations, on the ASI family', () => {
        // ASI02/04/06/09 are other kinds' obligations; a harness scan is not
        // evidence of tool mediation or of Art 14 oversight.
        const targets = targetsForKind(ARTEFACT_KIND_HARNESS_SCANS);
        expect(targets.map((t) => t.requirementCode).sort()).toEqual(['ASI03', 'ASI10']);
        expect(targets.every((t) => t.familyUrn === ASI_LIBRARY_URN)).toBe(true);
        expect(AGENTIC_ARTEFACT_KINDS).toContain(ARTEFACT_KIND_HARNESS_SCANS);
    });
});

describe('a harness month is COMPLETE only when every scanner\'s LATEST scan is complete and non-empty', () => {
    it('reads a month with no scan as NO_SCAN, not as complete or as zero agents', () => {
        expect(harnessArtefactCompleteness(period([]))).toBe('NO_SCAN');
    });

    it('is COMPLETE for one complete, non-empty, tallied latest scan', () => {
        expect(harnessArtefactCompleteness(period([scan('s1')]))).toBe('COMPLETE');
    });

    it('is INCOMPLETE when the latest scan did not read a source in full', () => {
        expect(harnessArtefactCompleteness(period([scan('s1', { completeness: 'INCOMPLETE' })]))).toBe('INCOMPLETE');
    });

    it('is INCOMPLETE when the latest scan found nobody — zero is never complete', () => {
        expect(
            harnessArtefactCompleteness(period([scan('s1', { completeness: 'EMPTY', agentCount: 0 })])),
        ).toBe('INCOMPLETE');
    });

    it('judges each scanner by its LATEST scan, not its first or its best', () => {
        const olderComplete = scan('old', { asOf: '2026-10-01T03:00:00.000Z', latestForScanner: false, tallies: null });
        const latestIncomplete = scan('new', { completeness: 'INCOMPLETE' });
        expect(harnessArtefactCompleteness(period([olderComplete, latestIncomplete]))).toBe('INCOMPLETE');

        const olderIncomplete = scan('old', {
            asOf: '2026-10-01T03:00:00.000Z',
            latestForScanner: false,
            completeness: 'INCOMPLETE',
            tallies: null,
        });
        expect(harnessArtefactCompleteness(period([olderIncomplete, scan('new')]))).toBe('COMPLETE');
    });

    it('needs EVERY scanner complete: a second scanner\'s complete scan does not cover the first one\'s gap', () => {
        const a = scan('a1');
        const b = scan('b1', { scannerAgentId: 'scanner-b', completeness: 'INCOMPLETE' });
        expect(harnessArtefactCompleteness(period([a, b]))).toBe('INCOMPLETE');
    });

    it.each(['scansTruncated', 'tallyTruncated', 'scannersTruncated'] as const)(
        'is INCOMPLETE when the emitter hit a bound (%s)',
        (bound) => {
            expect(harnessArtefactCompleteness(period([scan('s1')], { [bound]: true }))).toBe('INCOMPLETE');
        },
    );

    it('is INCOMPLETE when a scanner held a trusted key in the period and sent nothing — and names it', () => {
        // Scanner A's complete scan says nothing about the sources the silent
        // scanner B reads; a month B never reported in is not a month B found
        // nothing in.
        const facts = period([scan('a1')], {}, { agentIds: ['scanner-b'] });
        expect(harnessArtefactCompleteness(facts)).toBe('INCOMPLETE');
        expect(harnessIncompleteReasons(facts)).toEqual([
            'scanner scanner-b held a trusted key in the period but reported no scan in it, so the sources it reads are unevidenced',
        ]);
        const body = buildHarnessScanArtefact(monthlyPeriod(new Date('2026-10-14T00:00:00.000Z')), facts, 'e'.repeat(64));
        expect(body.title).toBe('Agent harness scans — 2026-10 — INCOMPLETE');
        expect(body.content).toContain('Scanners that held a trusted key in the period and reported no scan: scanner-b');
    });

    it('is INCOMPLETE when the key holders were read only up to the bound', () => {
        expect(harnessArtefactCompleteness(period([scan('a1')], {}, { truncated: true }))).toBe('INCOMPLETE');
    });

    it('is INCOMPLETE when a complete latest scan could not be tallied', () => {
        expect(harnessArtefactCompleteness(period([scan('s1', { tallies: null })]))).toBe('INCOMPLETE');
    });

    it('is INCOMPLETE when no scan is marked as its scanner\'s latest', () => {
        expect(harnessArtefactCompleteness(period([scan('s1', { latestForScanner: false })]))).toBe('INCOMPLETE');
    });

    it('never reads the level: an estate read in full that is all H0 is COMPLETE evidence of exactly that', () => {
        // The ladder is report-only. A status gated on a level would make a
        // bad estate impossible to evidence, which is the opposite of the point.
        const allH0 = scan('s1', {
            tallies: tallies({
                levels: { H0: 3, H1: 0, H2: 0, H3: 0, H4: 0, H5: 0 },
                belowBar: 3,
            }),
        });
        expect(harnessArtefactCompleteness(period([allH0]))).toBe('COMPLETE');
    });

    it('maps completeness to the Evidence status: APPROVED only when COMPLETE', () => {
        expect(harnessArtefactEvidenceStatus('COMPLETE')).toBe('APPROVED');
        expect(harnessArtefactEvidenceStatus('INCOMPLETE')).toBe('NEEDS_REVIEW');
        expect(harnessArtefactEvidenceStatus('NO_SCAN')).toBe('NEEDS_REVIEW');
    });
});

describe('the harness digest covers what the body renders', () => {
    const start = new Date('2026-10-01T00:00:00.000Z');
    const digestOf = (f: HarnessPeriodFacts) =>
        sourcePopulationDigest(ARTEFACT_KIND_HARNESS_SCANS, start, harnessDigestFacts(f));

    it('changes when only a scanner goes silent, so the body is rewritten to say so', () => {
        expect(digestOf(period([scan('s1')]))).not.toBe(digestOf(period([scan('s1')], {}, { agentIds: ['scanner-b'] })));
    });

    it('changes when only a scan\'s completeness changes', () => {
        // Otherwise the `unchanged` branch skips the rewrite and a month that
        // went incomplete keeps saying it was complete.
        expect(digestOf(period([scan('s1')]))).not.toBe(
            digestOf(period([scan('s1', { completeness: 'INCOMPLETE' })])),
        );
    });

    it('changes when only a bound trips', () => {
        expect(digestOf(period([scan('s1')]))).not.toBe(digestOf(period([scan('s1')], { tallyTruncated: true })));
    });

    it('does not depend on the order the scans were read in', () => {
        const a = scan('a1');
        const b = scan('b1', { scannerAgentId: 'scanner-b' });
        expect(digestOf(period([a, b]))).toBe(digestOf(period([b, a])));
    });
});

describe('the harness artefact body', () => {
    const p = monthlyPeriod(new Date('2026-10-14T00:00:00.000Z'));

    it('names a complete month in the title without a suffix, and states every level including zeros', () => {
        const body = buildHarnessScanArtefact(p, period([scan('s1')]), 'e'.repeat(64));
        expect(body.completeness).toBe('COMPLETE');
        expect(body.title).toBe('Agent harness scans — 2026-10');
        expect(body.content).toContain('Artefact completeness: COMPLETE');
        expect(body.content).toContain('Agents: 3 · by level — H0: 1 · H1: 0 · H2: 2 · H3: 0 · H4: 0 · H5: 0');
        expect(body.content).toContain('Reach — READ_ONLY: 1 · WRITE_OR_EXTERNAL: 2 · UNKNOWN: 0');
        expect(body.content).toContain('Below the report-only bar: 1 · Not in the agent register as of this emission: 1');
        expect(body.content).toContain('REDACTION CONTRACT');
        expect(body.content).toContain('e'.repeat(64));
    });

    it('says INCOMPLETE in the title and names the scanner and the source that fell short', () => {
        const body = buildHarnessScanArtefact(
            p,
            period([
                scan('s1', {
                    completeness: 'INCOMPLETE',
                    sources: [
                        { kind: 'entra-sp', status: 'COMPLETE', rows: 10, reason: null },
                        { kind: 'mcp', status: 'INCOMPLETE', rows: 1, reason: 'TIME_BOX' },
                    ],
                }),
            ]),
            'e'.repeat(64),
        );
        expect(body.completeness).toBe('INCOMPLETE');
        expect(body.title).toBe('Agent harness scans — 2026-10 — INCOMPLETE');
        expect(body.content).toContain(
            "Artefact completeness: INCOMPLETE — scanner scanner-a's latest scan (ref-s1) did not read all of its sources in full",
        );
        expect(body.content).toContain('Sources — entra-sp: COMPLETE (10 rows) · mcp: INCOMPLETE — TIME_BOX (1 rows)');
    });

    it('says an empty scan evidences nothing', () => {
        const body = buildHarnessScanArtefact(
            p,
            period([scan('s1', { completeness: 'EMPTY', agentCount: 0, tallies: tallies({
                levels: { H0: 0, H1: 0, H2: 0, H3: 0, H4: 0, H5: 0 },
                reach: { READ_ONLY: 0, WRITE_OR_EXTERNAL: 0, UNKNOWN: 0 },
                belowBar: 0,
                notInRegister: 0,
            }) })]),
            'e'.repeat(64),
        );
        expect(body.title).toContain('— INCOMPLETE');
        expect(body.content).toContain('Completeness: EMPTY — no agent found; an empty population evidences nothing');
        expect(body.content).toContain('found no agent — an empty population evidences nothing');
    });

    it('says NO SCAN RECEIVED for an empty month, and that the inventory is unevidenced', () => {
        const body = buildHarnessScanArtefact(p, period([]), 'e'.repeat(64));
        expect(body.completeness).toBe('NO_SCAN');
        expect(body.title).toBe('Agent harness scans — 2026-10 — NO SCAN RECEIVED');
        expect(body.content).toContain(
            'NO SCAN RECEIVED — the agent inventory is UNEVIDENCED for 2026-10; a period with no scan is not a period with no agents',
        );
        expect(body.content).toContain('Harness scans described in the period: 0');
    });

    it('prints a BOUNDED line, and withholds tallies it could not vouch for', () => {
        const body = buildHarnessScanArtefact(
            p,
            period([scan('s1', { tallies: null })], { tallyTruncated: true }),
            'e'.repeat(64),
        );
        expect(body.content).toContain('BOUNDED: the emitter stopped reading at its bound for agent tallies');
        expect(body.content).toContain('tallies withheld');
        expect(body.content).not.toContain('by level —');
    });

    it('lists every scan in the period with its own completeness, and tallies at most the scanner cap', () => {
        const latest = Array.from({ length: HARNESS_SCANNER_CAP + 2 }, (_, i) =>
            scan(`s${String(i).padStart(2, '0')}`, { scannerAgentId: `scanner-${i}` }),
        );
        const body = buildHarnessScanArtefact(p, period(latest, { scannersTruncated: true }), 'e'.repeat(64));
        expect(body.content).toContain(`Harness scans described in the period: ${HARNESS_SCANNER_CAP + 2}`);
        expect(body.content).toContain('(+2 further scanners, listed below and not tallied)');
        expect(body.content.match(/^Scanner scanner-/gm)).toHaveLength(HARNESS_SCANNER_CAP);
    });
});

describe('the emitter corrects a harness Evidence status in ONE direction only', () => {
    type Planned = 'APPROVED' | 'NEEDS_REVIEW';
    const correct = (planned: Planned, current: string, previousPlanned: Planned | null) =>
        harnessStatusCorrection({ planned, current, previousPlanned });

    it('always puts an incomplete month found APPROVED back to NEEDS_REVIEW, whoever approved it', () => {
        expect(correct('NEEDS_REVIEW', 'APPROVED', 'NEEDS_REVIEW')).toBe('NEEDS_REVIEW');
        expect(correct('NEEDS_REVIEW', 'APPROVED', 'APPROVED')).toBe('NEEDS_REVIEW');
        expect(correct('NEEDS_REVIEW', 'APPROVED', null)).toBe('NEEDS_REVIEW');
    });

    it('raises a NEEDS_REVIEW only when it was the emitter\'s own incompleteness verdict', () => {
        expect(correct('APPROVED', 'NEEDS_REVIEW', 'NEEDS_REVIEW')).toBe('APPROVED');
        // The stale-review sweep's NEEDS_REVIEW on a month that was already
        // complete is the sweep's: raising it would flip the row every morning.
        expect(correct('APPROVED', 'NEEDS_REVIEW', 'APPROVED')).toBeNull();
        expect(correct('APPROVED', 'NEEDS_REVIEW', null)).toBeNull();
    });

    it.each(['SUBMITTED', 'REJECTED', 'DRAFT'])('never rewrites a review decision (%s), in either plan', (current) => {
        expect(correct('APPROVED', current, 'NEEDS_REVIEW')).toBeNull();
        expect(correct('NEEDS_REVIEW', current, 'NEEDS_REVIEW')).toBeNull();
    });

    it('leaves a status that already agrees with the plan', () => {
        expect(correct('APPROVED', 'APPROVED', 'APPROVED')).toBeNull();
        expect(correct('NEEDS_REVIEW', 'NEEDS_REVIEW', 'NEEDS_REVIEW')).toBeNull();
    });
});
