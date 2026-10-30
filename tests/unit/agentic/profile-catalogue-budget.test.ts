/**
 * AN AGENT PROFILE VERSION'S SKILLS AGAINST THE PER-RUN CATALOGUE BUDGET (#4523).
 *
 * A version's save and approval measure the skills it names with
 * `runCatalogue`; a run of it is refused at admission by `resolveRunSkills`.
 * This file holds the two to ONE answer on the same input, at the byte: the
 * shipped corpus as it is, and tenant versions the mount gate passes. If the
 * save ever measured different lines, or compared them differently, a version
 * could again be saved and approved that no run of it can mount — or be
 * refused when its run would have fitted.
 *
 * The integration test (`tests/integration/agent-profiles.test.ts`, section 9)
 * holds the same agreement through the usecases and admission's database read.
 */
import { catalogBytes, loadSkillCorpus, MAX_CATALOG_BYTES, measureCatalog, withinCatalogBudget } from '@/lib/agentic/flue/skills';
import { skillContentHash } from '@/lib/agentic/flue/skills/evaluation-record';
import { resetSkillCache, resolveRunSkills, runCatalogue } from '@/lib/agentic/flue/skills/resolve';
import type { TenantSkillVersionForMount } from '@/lib/agentic/flue/skills/tenant-skill';
import { passingRecordFor, TENANT_SKILL_INSTRUCTIONS, tenantSkillFields } from '../../helpers/tenant-skill-fixture';

beforeEach(() => resetSkillCache());

const corpus = loadSkillCorpus().skills;

/** Shipped skills up to 1,400 catalogue bytes, so one tenant skill of a few hundred bytes decides the total. */
const repo: string[] = [];
let repoBytes = 0;
for (const s of corpus) {
    const b = catalogBytes([s]);
    if (repoBytes + b > 1_400) continue;
    repo.push(s.name);
    repoBytes += b;
}

const NAME = 'acme-budget-check';

/** The description that puts `repo` and the tenant skill at exactly `total` catalogue bytes. */
function descriptionFor(total: number): string {
    const n = total - repoBytes - Buffer.byteLength(`${NAME}: \n`, 'utf8');
    if (n < 2 || n > 1_024) throw new Error(`the fixture cannot reach ${total} bytes with a description of ${n} characters`);
    return `${'Review the access request against the policy and say what to grant. '.repeat(20).slice(0, n - 1)}x`;
}

/** An approved, evaluated tenant version the mount gate passes. */
function tenantVersion(description: string): TenantSkillVersionForMount {
    const f = tenantSkillFields();
    return {
        versionId: 'ver-1',
        name: NAME,
        version: 1,
        description,
        instructions: TENANT_SKILL_INSTRUCTIONS,
        license: f.license,
        sourceRef: f.sourceRef,
        requiredInput: null,
        output: null,
        controls: null,
        tools: null,
        workflowKeys: [],
        status: 'APPROVED',
        contentHash: skillContentHash(TENANT_SKILL_INSTRUCTIONS),
        authorUserId: 'author',
        approvedByUserId: 'reviewer',
        approvedContentHash: skillContentHash(TENANT_SKILL_INSTRUCTIONS),
        evaluationRecordJson: JSON.stringify(passingRecordFor(NAME, 1)),
    };
}

/** Admission's answer: the bytes the run mounts, or `null` when it is refused on the budget. */
function admitted(declared: readonly string[], tenant: readonly TenantSkillVersionForMount[]): number | null {
    try {
        return catalogBytes(resolveRunSkills(declared, tenant).documents);
    } catch (err) {
        if (err instanceof Error && /the always-present catalog is \d+ bytes, over the \d+ budget/.test(err.message)) return null;
        throw err;
    }
}

/** The save's answer for the same input: the bytes it measured, or `null` when it refuses. */
function saved(declared: readonly string[], tenant: readonly TenantSkillVersionForMount[]): number | null {
    const c = runCatalogue(declared, tenant.map((v) => ({ name: v.name, description: v.description })));
    return c.withinBudget ? c.bytes : null;
}

describe('the save-time measure and admission agree (#4523)', () => {
    it.each([
        ['one byte under', MAX_CATALOG_BYTES - 1, MAX_CATALOG_BYTES - 1],
        ['exactly at', MAX_CATALOG_BYTES, MAX_CATALOG_BYTES],
        ['one byte over', MAX_CATALOG_BYTES + 1, null],
    ] as const)('%s the budget, with shipped and tenant skills together', (_label, total, expected) => {
        const tenant = [tenantVersion(descriptionFor(total))];
        expect(runCatalogue(repo, tenant).bytes).toBe(total);
        expect(admitted(repo, tenant)).toBe(expected);
        expect(saved(repo, tenant)).toBe(expected);
    });

    it('on every prefix of the shipped corpus, which as a whole is over the budget', () => {
        const names = corpus.map((s) => s.name);
        const answers = names.map((_, k) => [saved(names.slice(0, k + 1), []), admitted(names.slice(0, k + 1), [])]);
        for (const [save, admit] of answers) expect(save).toBe(admit);
        // Both sides of the line are exercised, or the agreement says nothing.
        expect(answers.some(([save]) => save !== null)).toBe(true);
        expect(answers[answers.length - 1][0]).toBeNull();
    });

    it('names the figure the run is refused with', () => {
        const tenant = [tenantVersion(descriptionFor(MAX_CATALOG_BYTES + 1))];
        const measured = runCatalogue(repo, tenant);
        expect(measured).toMatchObject({ bytes: MAX_CATALOG_BYTES + 1, budgetBytes: MAX_CATALOG_BYTES, withinBudget: false });
        expect(() => resolveRunSkills(repo, tenant)).toThrow(`catalog is ${measured.bytes} bytes, over the ${measured.budgetBytes} budget`);
    });
});

describe('the one comparison', () => {
    it('is inclusive of the budget', () => {
        expect(withinCatalogBudget(MAX_CATALOG_BYTES)).toBe(true);
        expect(withinCatalogBudget(MAX_CATALOG_BYTES + 1)).toBe(false);
        expect(measureCatalog([{ name: 'a', description: 'b' }])).toEqual({
            bytes: Buffer.byteLength('a: b\n', 'utf8'),
            budgetBytes: MAX_CATALOG_BYTES,
            withinBudget: true,
        });
    });
});
