/**
 * The pure half of agentic evidence emission — the period, the digest, and the
 * declared map from record kind to obligation.
 *
 * These are the parts a re-derivation depends on. An artefact emitted in August
 * has to be reproducible byte-for-byte during the audit that reads it in March,
 * which means the period arithmetic cannot consult a clock and the digest cannot
 * depend on the order a database happened to return rows in.
 */
import {
    AGENTIC_ARTEFACT_KINDS,
    ARTEFACT_KIND_DECISIONS,
    ARTEFACT_KIND_RECEIPTS,
    EVIDENCE_TARGETS,
    buildDecisionArtefact,
    buildReceiptArtefact,
    buildWithdrawalNotice,
    monthlyPeriod,
    sourcePopulationDigest,
    targetsForKind,
} from '@/lib/agentic/evidence-artefact';

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

describe('the population digest identifies a set, not a sequence', () => {
    const start = new Date('2026-08-01T00:00:00.000Z');

    it('is the same for the same ids in a different order', () => {
        // Row order is not a fact about the population. Without the sort, two
        // runs that read the same month would digest differently and every tick
        // would look like a change.
        const a = sourcePopulationDigest(ARTEFACT_KIND_RECEIPTS, start, ['c', 'a', 'b']);
        const b = sourcePopulationDigest(ARTEFACT_KIND_RECEIPTS, start, ['a', 'b', 'c']);
        expect(a).toBe(b);
    });

    it('changes when the population changes', () => {
        const before = sourcePopulationDigest(ARTEFACT_KIND_RECEIPTS, start, ['a', 'b']);
        const after = sourcePopulationDigest(ARTEFACT_KIND_RECEIPTS, start, ['a', 'b', 'c']);
        expect(after).not.toBe(before);
    });

    it('is bound to the kind and the period', () => {
        const ids = ['a', 'b'];
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
