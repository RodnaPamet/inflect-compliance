/**
 * AUDIT PROCEDURE LIBRARY v1 (#3676) — the pure rules every procedure handler
 * stands on: the config a plan carries, the catalogue's conclusion order, the
 * keyed sample and its reproducibility, the auditor's remit, and what a
 * finding proposal may say.
 */
import {
    AUDIT_PROCEDURE_LIBRARY_V1,
    AUDITOR_TOOL_REMIT,
    auditSampleSeedPurpose,
    auditSampleSize,
    decideConclusion,
    drawAuditSample,
    EXCEPTION_SEVERITY,
    exceptionFindingProposal,
    judgeUnit,
    latestEndedPeriod,
    LIBRARY_V1_PROCEDURE_IDS,
    LIBRARY_V1_STATUS,
    parseAuditProcedureConfig,
    periodSettled,
    SEED_FINGERPRINT_LABEL,
    seedFingerprint,
    toolsOutsideAuditorRemit,
    unsetParameters,
    type UnitJudgement,
} from '@/lib/agentic/audit-procedure-library';
import {
    AUDIT_PROCEDURE_IDS,
    CODE,
    RecordAuditWorkpaperSchema,
} from '@/lib/agentic/audit-workpaper';
import { MCP_PROPOSE_TOOL_NAMES, MCP_READ_TOOL_NAMES } from '@/lib/mcp/tool-catalogue';
import { assertGrantWithinAuditorRemit, AUDITOR_REMIT_EXCEEDED } from '@/app-layer/usecases/auditor-remit';
import { ConflictError } from '@/lib/errors/types';

const pass = (unitId: string): UnitJudgement => judgeUnit(unitId, [{ attribute: 'X1', result: 'MET' }]);

describe('library v1', () => {
    it('is the first five procedures of catalogue version 1, each with a definition', () => {
        expect([...LIBRARY_V1_PROCEDURE_IDS]).toEqual(AUDIT_PROCEDURE_IDS.slice(0, 5));
        expect(Object.keys(AUDIT_PROCEDURE_LIBRARY_V1).sort()).toEqual([...LIBRARY_V1_PROCEDURE_IDS].sort());
        for (const def of Object.values(AUDIT_PROCEDURE_LIBRARY_V1)) {
            expect(def.populationDefinition.length).toBeLessThanOrEqual(2000);
            expect(def.attributes.every((a) => CODE.test(a))).toBe(true);
            expect(def.controls.length).toBeGreaterThan(0);
        }
    });

    it('is PROPOSED, with internal audit, PwC and every PwC reference still open', () => {
        expect(LIBRARY_V1_STATUS).toEqual({
            catalogueVersion: 1,
            status: 'PROPOSED',
            internalAuditApproval: 'OPEN',
            pwcAgreement: 'OPEN',
            pwcMethodologyReference: 'OPEN',
            recordedOn: '#3663',
        });
    });
});

describe('a plan configuration', () => {
    const ok = { procedure: 'iam.leaver_timeliness', auditorAgentId: 'agt_1', parameters: { leaverWindowHours: 72 } };

    it('is not ours unless it names a procedure', () => {
        expect(parseAuditProcedureConfig({ check: 'AGENTIC_KILL_SWITCH_DRILL' })).toEqual({ kind: 'NOT_OURS' });
        expect(parseAuditProcedureConfig(null)).toEqual({ kind: 'NOT_OURS' });
    });

    it('reads a well-formed one, period optional', () => {
        expect(parseAuditProcedureConfig({ ...ok, periodLabel: '2027-03', sampleSize: 30 })).toEqual({
            kind: 'OK',
            config: { ...ok, sampleSize: 30, periodLabel: '2027-03' },
        });
    });

    it.each([
        [{ ...ok, procedure: 'agent.stop_control' }, 'PROCEDURE_NOT_IN_LIBRARY_V1'],
        [{ ...ok, auditorAgentId: 'a b' }, 'AUDITOR_AGENT_ID_INVALID'],
        [{ ...ok, parameters: { leaverWindowHours: 0 } }, 'PARAMETER_OUT_OF_RANGE:leaverWindowHours'],
        [{ ...ok, parameters: { remediationWindowDays: 3 } }, 'PARAMETER_UNKNOWN:remediationWindowDays'],
        [{ ...ok, periodLabel: '2027-Q1' }, 'PERIOD_KIND_MISMATCH'],
        [{ ...ok, summary: 'free text' }, 'UNKNOWN_KEY:summary'],
        [{ ...ok, sampleSize: 0 }, 'SAMPLE_SIZE_INVALID'],
    ])('refuses a malformed one by name (%#)', (config, reason) => {
        expect(parseAuditProcedureConfig(config)).toEqual({ kind: 'INVALID', reason });
    });

    it('leaves a missing parameter to the PARAMETER_UNSET precondition', () => {
        const parsed = parseAuditProcedureConfig({ procedure: 'iam.leaver_timeliness', auditorAgentId: 'agt_1' });
        expect(parsed.kind).toBe('OK');
        if (parsed.kind === 'OK') expect(unsetParameters(parsed.config)).toEqual(['leaverWindowHours']);
    });
});

describe('periods', () => {
    it('audits the latest period that has ended, never the one now is in', () => {
        expect(latestEndedPeriod('MONTH', new Date('2027-03-15T00:00:00Z'))).toBe('2027-02');
        expect(latestEndedPeriod('MONTH', new Date('2027-01-01T00:00:00Z'))).toBe('2026-12');
        expect(latestEndedPeriod('QUARTER', new Date('2027-05-02T00:00:00Z'))).toBe('2027-Q1');
        expect(latestEndedPeriod('QUARTER', new Date('2027-02-02T00:00:00Z'))).toBe('2026-Q4');
    });

    it('settles only after the margin', () => {
        expect(periodSettled('2027-02', 24, new Date('2027-03-01T23:00:00Z'))).toBe(false);
        expect(periodSettled('2027-02', 24, new Date('2027-03-02T00:00:00Z'))).toBe(true);
    });
});

describe('the conclusion, in the catalogue order', () => {
    const base = { precondition: null, populationCount: 3, populationExceptions: 0, sampleSize: 2 };

    it('a failed precondition is INCONCLUSIVE on it', () => {
        expect(decideConclusion({ ...base, precondition: 'SYNC_NOT_FRESH', units: [] })).toEqual({
            conclusion: 'INCONCLUSIVE',
            basis: 'SYNC_NOT_FRESH',
        });
    });

    it('an empty population is never a pass', () => {
        for (const units of [[], [pass('u1')]]) {
            expect(
                decideConclusion({ precondition: 'EMPTY_POPULATION', populationCount: 0, populationExceptions: 0, sampleSize: units.length, units })
                    .conclusion,
            ).toBe('INCONCLUSIVE');
            expect(
                decideConclusion({ precondition: null, populationCount: 0, populationExceptions: 0, sampleSize: units.length, units })
                    .conclusion,
            ).not.toBe('PASS');
        }
    });

    it('but a population-level exception over an empty sample is a FAIL', () => {
        expect(
            decideConclusion({ precondition: 'EMPTY_POPULATION', populationCount: 0, populationExceptions: 1, sampleSize: 0, units: [] }),
        ).toEqual({ conclusion: 'FAIL', basis: 'EXCEPTIONS_FOUND' });
    });

    it('an exception beats an untestable unit, which beats a pass', () => {
        const ex = judgeUnit('u2', [{ attribute: 'X1', result: 'EXCEPTION', code: 'BAD' }]);
        const unt = judgeUnit('u3', [{ attribute: 'X1', result: 'UNTESTABLE', code: 'UNKNOWN' }]);
        expect(decideConclusion({ ...base, units: [unt, ex] }).conclusion).toBe('FAIL');
        expect(decideConclusion({ ...base, units: [pass('u1'), unt] })).toEqual({
            conclusion: 'INCONCLUSIVE',
            basis: 'ITEM_UNTESTABLE',
        });
    });

    it('a PASS needs every sampled unit tested, not only no exception', () => {
        expect(decideConclusion({ ...base, units: [pass('u1'), pass('u2')] }).conclusion).toBe('PASS');
        expect(decideConclusion({ ...base, units: [pass('u1')] }).conclusion).toBe('INCONCLUSIVE');
    });

    it('a unit keeps every exception code, in attribute order', () => {
        const u = judgeUnit('u1', [
            { attribute: 'PD1', result: 'EXCEPTION', code: 'PRIVILEGED_UNATTRIBUTED' },
            { attribute: 'PD2', result: 'UNTESTABLE', code: 'MFA_SIGNAL_AMBIGUOUS' },
            { attribute: 'PD3', result: 'EXCEPTION', code: 'PRIVILEGE_NOT_RECERTIFIED' },
        ]);
        expect(u).toEqual({
            unitId: 'u1',
            outcome: 'EXCEPTION',
            code: 'PRIVILEGED_UNATTRIBUTED',
            exceptionCodes: ['PRIVILEGED_UNATTRIBUTED', 'PRIVILEGE_NOT_RECERTIFIED'],
        });
    });
});

describe('the sample is reproducible from its epoch', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `emp_${i}`);
    const seed = 'a'.repeat(64);

    it('the same seed, epoch and frozen ids give the same sample, in any input order', () => {
        const a = drawAuditSample({ seed, epoch: 'iam.leaver_timeliness@2027-03', unitIds: ids, size: 4 });
        const b = drawAuditSample({ seed, epoch: 'iam.leaver_timeliness@2027-03', unitIds: [...ids].reverse(), size: 4 });
        expect(a).toHaveLength(4);
        expect(b).toEqual(a);
    });

    it('another epoch or another seed draws another sample', () => {
        const a = drawAuditSample({ seed, epoch: 'iam.leaver_timeliness@2027-03', unitIds: ids, size: 4 });
        expect(drawAuditSample({ seed, epoch: 'iam.leaver_timeliness@2027-04', unitIds: ids, size: 4 })).not.toEqual(a);
        expect(drawAuditSample({ seed: 'b'.repeat(64), epoch: 'iam.leaver_timeliness@2027-03', unitIds: ids, size: 4 })).not.toEqual(a);
    });

    it('sizes the sample at 10%, at least one and at most 25, or the second line\'s larger size up to the whole', () => {
        expect(auditSampleSize(0, null)).toBe(0);
        expect(auditSampleSize(3, null)).toBe(1);
        expect(auditSampleSize(40, null)).toBe(4);
        expect(auditSampleSize(1000, null)).toBe(25);
        expect(auditSampleSize(40, 10)).toBe(10);
        expect(auditSampleSize(40, 2)).toBe(4);
        expect(auditSampleSize(40, 400)).toBe(40);
    });

    it('fingerprints the seed without revealing it, over a label that can never be a score input', () => {
        expect(SEED_FINGERPRINT_LABEL).not.toContain('\u0000');
        expect(seedFingerprint(seed)).toMatch(/^[0-9a-f]{64}$/);
        expect(seedFingerprint(seed)).not.toBe(seedFingerprint('b'.repeat(64)));
        expect(seedFingerprint(seed)).not.toContain(seed);
        expect(auditSampleSeedPurpose('t1')).toBe('inflect-audit-procedure-sample-v1:t1');
    });
});

describe('the auditor reads and proposes, and holds nothing else', () => {
    it('its remit is every built-in read tool and propose_finding', () => {
        expect([...AUDITOR_TOOL_REMIT].sort()).toEqual([...MCP_READ_TOOL_NAMES, 'propose_finding'].sort());
        expect(MCP_PROPOSE_TOOL_NAMES.filter((t) => AUDITOR_TOOL_REMIT.has(t))).toEqual(['propose_finding']);
    });

    it('refuses a grant outside it to an auditor, by name, and constrains no other agent', () => {
        let refused: unknown = null;
        try {
            assertGrantWithinAuditorRemit({ isAuditor: true }, 'propose_risks');
        } catch (err) {
            refused = err;
        }
        expect(refused).toBeInstanceOf(ConflictError);
        expect((refused as ConflictError).details).toEqual({
            reason: AUDITOR_REMIT_EXCEEDED,
            toolsOutsideRemit: ['propose_risks'],
        });
        expect(() => assertGrantWithinAuditorRemit({ isAuditor: true }, 'list_findings')).not.toThrow();
        expect(() => assertGrantWithinAuditorRemit({ isAuditor: false }, 'propose_risks')).not.toThrow();
    });

    it('names every grant outside it, an external tool included', () => {
        expect(toolsOutsideAuditorRemit(['list_findings', 'propose_finding'])).toEqual([]);
        expect(toolsOutsideAuditorRemit(['propose_risks', 'list_risks', 'mcp__conn__set_owner'])).toEqual([
            'mcp__conn__set_owner',
            'propose_risks',
        ]);
    });
});

describe('an exception as a finding proposal', () => {
    const { item, rationale } = exceptionFindingProposal({
        procedureId: 'iam.privileged_access',
        periodLabel: '2027-Q1',
        unitId: 'directory:acc_1',
        code: 'PRIVILEGED_WITHOUT_MFA',
        controlId: 'ctl_1',
        auditorAgentId: 'agt_1',
        epoch: 'iam.privileged_access@2027-Q1',
    });

    it('is a finding create item, raised against the plan\'s control and tagged for the next run', () => {
        expect(item).toMatchObject({
            severity: 'HIGH',
            type: 'NONCONFORMITY',
            controlId: 'ctl_1',
            sourceKind: 'AUDIT_PROCEDURE',
            sourceRef: 'iam.privileged_access@2027-Q1:directory:acc_1:PRIVILEGED_WITHOUT_MFA',
        });
        expect(rationale).toMatch(/^Exception PRIVILEGED_WITHOUT_MFA from the re-performance/);
    });

    it('never presents the library as approved, and never closes anything', () => {
        const text = String(item.description);
        expect(text).toMatch(/proposed to internal audit and PwC/);
        expect(text).toMatch(/not an approved or agreed definition/);
        expect(text).toMatch(/the auditor closes and resolves nothing/);
    });
});

describe('the severity table', () => {
    it('raises a leaver disabled late as HIGH, as the owner decided (decision 9, 2026-10-19)', () => {
        expect(EXCEPTION_SEVERITY.LEAVER_DISABLED_LATE).toBe('HIGH');
        expect(
            exceptionFindingProposal({
                procedureId: 'iam.leaver_timeliness',
                periodLabel: '2026-09',
                unitId: 'emp_1',
                code: 'LEAVER_DISABLED_LATE',
                controlId: 'ctl_1',
                auditorAgentId: 'agt_1',
                epoch: 'iam.leaver_timeliness@2026-09',
            }).item.severity,
        ).toBe('HIGH');
    });
});

describe('the workpaper contract names each exception\'s proposal', () => {
    const base = {
        procedureId: 'iam.leaver_timeliness',
        catalogueVersion: 1,
        periodLabel: '2026-09',
        populationDefinition: 'Employee rows',
        populationCount: 1,
        populationDigest: 'a'.repeat(64),
        sample: { epoch: 'iam.leaver_timeliness@2026-09', seedFingerprint: 'b'.repeat(64), sampledUnitIds: ['emp_1'] },
        attributesTested: ['L1'],
        itemOutcomes: [{ unitId: 'emp_1', outcome: 'EXCEPTION', code: 'LEAVER_ACCOUNT_ACTIVE' }],
        conclusion: 'FAIL',
        conclusionBasis: 'EXCEPTIONS_FOUND',
        evidenceRefs: [],
        auditorAgentId: 'agt_1',
        controlTestRunId: 'run_1',
    };

    it('accepts a proposal that proposalIds lists', () => {
        expect(
            RecordAuditWorkpaperSchema.safeParse({
                ...base,
                exceptions: [{ unitId: 'emp_1', code: 'LEAVER_ACCOUNT_ACTIVE', proposalId: 'prop_1' }],
                proposalIds: ['prop_1'],
            }).success,
        ).toBe(true);
    });

    it('refuses one it does not', () => {
        expect(
            RecordAuditWorkpaperSchema.safeParse({
                ...base,
                exceptions: [{ unitId: 'emp_1', code: 'LEAVER_ACCOUNT_ACTIVE', proposalId: 'prop_9' }],
                proposalIds: ['prop_1'],
            }).success,
        ).toBe(false);
    });
});
