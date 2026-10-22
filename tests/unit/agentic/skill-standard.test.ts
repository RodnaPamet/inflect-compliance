/**
 * The skill standard's machinery (#3661): the optional metadata keys, the
 * evaluation-set and evaluation-record formats, and the two drafted IAM skills.
 */
import { loadAllSkills, parseSkillDocument, SkillLoadError } from '@/lib/agentic/flue/skills';
import {
    CASE_KINDS,
    answerPasses,
    checkEvaluationRecord,
    checkEvaluationSet,
    readEvaluationSet,
    skillContentHash,
    type SkillEvaluationSet,
} from '@/lib/agentic/flue/skills/evaluation-record';
import { listWorkflowDefinitions } from '@/lib/agentic/workflow-registry';

const DRAFTED = [
    'harness-level-assessment',
    'nhi-ownership-attribution',
    // #3953. Added to this list, not alongside it: the list IS the
    // coverage, so a drafted skill left out of it passes every assertion
    // below without being looked at.
    'agent-sandbox-policy-review',
] as const;

function doc(metadataLines: string[], body = 'Do the thing.\n'): string {
    return [
        '---',
        'name: sample-skill',
        'description: A sample skill for the metadata tests.',
        'license: proprietary',
        'metadata:',
        '  version: \'1\'',
        ...metadataLines.map((l) => `  ${l}`),
        '---',
        '',
        body,
    ].join('\n');
}

describe('the optional metadata keys the standard defines', () => {
    it('loads a skill that declares none of them, unchanged', () => {
        expect(parseSkillDocument('sample-skill', doc([])).metadata).toEqual({ version: '1' });
    });

    it('accepts well-formed values for all four', () => {
        const s = parseSkillDocument('sample-skill', doc([
            'requiredInput: campaignId, subjectRef',
            'output: proposal',
            'controls: A.5.18, CC6.3, ASI03',
            'evaluation: evaluation-set.json',
        ]));
        expect(s.metadata.output).toBe('proposal');
    });

    it.each([
        ['requiredInput: campaign id', /requiredInput/],
        ['output: essay', /metadata\.output/],
        ['controls: Access rights shall be reviewed', /controls/],
        ['evaluation: ../../../etc/passwd', /evaluation/],
        ['evaluation: set.yaml', /evaluation/],
    ])('refuses %s with a reason naming the key', (line, reason) => {
        expect(() => parseSkillDocument('sample-skill', doc([line]))).toThrow(SkillLoadError);
        expect(() => parseSkillDocument('sample-skill', doc([line]))).toThrow(reason);
    });
});

describe('the drafted skills', () => {
    const corpus = loadAllSkills();

    it.each(DRAFTED)('%s ships with a licence, a source, a version and an evaluation set that matches it', (name) => {
        const skill = corpus.find((s) => s.name === name);
        expect(skill).toBeDefined();
        if (!skill) return;
        expect(skill.license).toBe('proprietary');
        expect(skill.metadata.sourceRef).toBeTruthy();
        expect(skill.metadata.version).toMatch(/^[1-9]\d*$/);
        const check = checkEvaluationSet(readEvaluationSet(skill), skill);
        expect(check).toMatchObject({ ok: true });
    });

    it('is declared by exactly one workflow, the discovered-agent review (#3668)', () => {
        // 0b drafted them undeclared; 1d declared the first two on one
        // workflow, and #3958 the third on the same one. The
        // mount itself is proved in `discovered-agent-review-workflow.test.ts`.
        for (const name of DRAFTED) {
            expect(listWorkflowDefinitions().filter((d) => (d.skills ?? []).includes(name)).map((d) => d.key)).toEqual([
                'discovered-agent-review',
            ]);
        }
    });
});

describe('every shipped skill carries its evaluation set', () => {
    // The whole corpus, not a list: a skill added without a set fails here
    // rather than reaching the mount gate as NOT_EVALUATED in production.
    const corpus = loadAllSkills();

    it('reads the whole corpus', () => {
        expect(corpus.length).toBeGreaterThanOrEqual(8);
    });

    it.each(corpus.map((s) => s.name))('%s names a set that matches its instructions and version', (name) => {
        const skill = corpus.find((s) => s.name === name)!;
        expect(skill.metadata.evaluation).toBe('evaluation-set.json');
        expect(checkEvaluationSet(readEvaluationSet(skill), skill)).toMatchObject({ ok: true });
    });

    it.each(corpus.map((s) => s.name))('%s: every case says why it proves anything', (name) => {
        const set = readEvaluationSet(corpus.find((s) => s.name === name)!) as SkillEvaluationSet;
        expect(set.cases.filter((c) => !c.rationale).map((c) => c.id)).toEqual([]);
    });
});

describe('evaluation sets', () => {
    const skill = loadAllSkills().find((s) => s.name === 'nhi-ownership-attribution');
    if (!skill) throw new Error('drafted skill missing');
    const set = readEvaluationSet(skill) as SkillEvaluationSet;

    it('ties a set to the exact instructions: an edited skill no longer matches', () => {
        const edited = { ...skill, instructions: `${skill.instructions}\nOne more rule.` };
        expect(checkEvaluationSet(set, edited)).toMatchObject({ ok: false, reason: 'HASH_MISMATCH' });
        expect(set.contentHash).toBe(skillContentHash(skill.instructions));
    });

    it('refuses a set whose version or skill name does not match', () => {
        const otherVersion = String(Number(set.version) + 1);
        expect(checkEvaluationSet({ ...set, version: otherVersion }, skill)).toMatchObject({ ok: false, reason: 'VERSION_MISMATCH' });
        expect(checkEvaluationSet({ ...set, skill: 'other-skill' }, skill)).toMatchObject({ ok: false, reason: 'NAME_MISMATCH' });
    });

    it.each(CASE_KINDS)('refuses a set with no %s case', (kind) => {
        const without = { ...set, cases: set.cases.filter((c) => c.kind !== kind) };
        expect(checkEvaluationSet(without, skill)).toMatchObject({ ok: false, reason: 'MALFORMED' });
    });

    it('refuses a case with no expectation, which would pass any answer', () => {
        const vacuous = { ...set, cases: [...set.cases, { id: 'vacuous', kind: 'task', input: 'x', expect: {} }] };
        expect(checkEvaluationSet(vacuous, skill)).toMatchObject({ ok: false, reason: 'MALFORMED' });
    });

    it('refuses a set that stores a derived figure', () => {
        expect(checkEvaluationSet({ ...set, passRate: 1 }, skill)).toMatchObject({ ok: false, reason: 'MALFORMED' });
    });
});

describe('evaluation records', () => {
    const skill = loadAllSkills().find((s) => s.name === 'nhi-ownership-attribution');
    if (!skill) throw new Error('drafted skill missing');
    const set = readEvaluationSet(skill) as SkillEvaluationSet;

    /** An answer built to satisfy its case — the shape of a passing model answer. */
    const satisfying = (c: SkillEvaluationSet['cases'][number]) => c.expect.mustInclude.join(' ');
    const record = (answers: Array<{ caseId: string; answer: string }>, extra: Record<string, unknown> = {}) => ({
        set,
        model: { provider: 'test', revision: 'r1' },
        ranAt: '2026-10-17T12:00:00.000Z',
        answers,
        ...extra,
    });

    it('recomputes pass rates from the raw answers and passes when every kind meets its threshold', () => {
        const result = checkEvaluationRecord(record(set.cases.map((c) => ({ caseId: c.id, answer: satisfying(c) }))), skill);
        expect(result).toMatchObject({ ok: true });
        if (result.ok) for (const kind of CASE_KINDS) expect(result.rates[kind]).toBe(1);
    });

    it('fails a record whose injection answers follow the injected instruction', () => {
        const answers = set.cases.map((c) => ({
            caseId: c.id,
            answer: c.kind === 'injection' ? `${satisfying(c)} ${c.expect.mustNotInclude[0]}` : satisfying(c),
        }));
        expect(checkEvaluationRecord(record(answers), skill)).toMatchObject({ ok: false, reason: 'BELOW_THRESHOLD' });
    });

    it('names EVERY kind below threshold, not just the first (#3906)', () => {
        // Why this matters beyond tidiness: a record is made by
        // `npm run skills:evaluate`, which is real model calls against the
        // repository credential. Reporting one shortfall at a time means an
        // author fixes it, re-dispatches, and discovers the next — which is
        // exactly what happened twice while authoring `sap-transaction-review`
        // (#3864).
        //
        // Break TWO kinds in the same record, by appending each case's own
        // forbidden phrase so the answer still satisfies mustInclude and fails
        // only on mustNotInclude.
        const broken = new Set<string>(['injection', 'refusal']);
        const answers = set.cases.map((c) => ({
            caseId: c.id,
            answer: broken.has(c.kind) ? `${satisfying(c)} ${c.expect.mustNotInclude[0]}` : satisfying(c),
        }));
        const result = checkEvaluationRecord(record(answers), skill);
        expect(result).toMatchObject({ ok: false, reason: 'BELOW_THRESHOLD' });
        if (result.ok) throw new Error('unreachable');

        // Both kinds named, and the detail says which and by how much.
        expect(result.detail).toContain('injection');
        expect(result.detail).toContain('refusal');
        expect(result.detail).toMatch(/threshold/);
    });

    it('still names a single failing kind alone, so the change did not make every message plural', () => {
        // The discriminating control. A detail that always listed every kind —
        // or always listed all four — would satisfy the test above and tell an
        // author nothing.
        const answers = set.cases.map((c) => ({
            caseId: c.id,
            answer: c.kind === 'injection' ? `${satisfying(c)} ${c.expect.mustNotInclude[0]}` : satisfying(c),
        }));
        const result = checkEvaluationRecord(record(answers), skill);
        if (result.ok) throw new Error('unreachable');
        expect(result.detail).toContain('injection');
        for (const other of CASE_KINDS.filter((k) => k !== 'injection')) {
            expect(result.detail).not.toContain(other);
        }
    });

    it('refuses an unanswered case, a duplicate answer and an answer to an unknown case', () => {
        const all = set.cases.map((c) => ({ caseId: c.id, answer: satisfying(c) }));
        expect(checkEvaluationRecord(record(all.slice(1)), skill)).toMatchObject({ ok: false, reason: 'UNANSWERED_CASE' });
        expect(checkEvaluationRecord(record([...all, all[0]]), skill)).toMatchObject({ ok: false, reason: 'DUPLICATE_ANSWER' });
        expect(checkEvaluationRecord(record([...all, { caseId: 'nope', answer: '' }]), skill)).toMatchObject({ ok: false, reason: 'UNKNOWN_ANSWER' });
    });

    it('refuses a record that declares its own pass rate', () => {
        const all = set.cases.map((c) => ({ caseId: c.id, answer: satisfying(c) }));
        expect(checkEvaluationRecord(record(all, { passRate: 1 }), skill)).toMatchObject({ ok: false, reason: 'MALFORMED' });
    });

    it('matches expectations case-insensitively, and a forbidden phrase fails a case that includes everything else', () => {
        expect(answerPasses({ mustInclude: ['STRONG'], mustNotInclude: [] }, 'grade: strong')).toBe(true);
        expect(answerPasses({ mustInclude: ['usr_17'], mustNotInclude: ['confirmed'] }, 'usr_17 confirmed')).toBe(false);
    });
});
