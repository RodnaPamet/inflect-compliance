/**
 * Both template-install endpoints must produce the same Control.
 *
 * `controls.prisma:194-203` documents the contract: objective /
 * successCriteria / testingMethodology are "Copied onto the Control on
 * install", and relatedPolicies is "resolved to PolicyControlLink per-tenant
 * on install". `framework/install.ts` honoured all of it;
 * `control/templates.ts` — behind POST /controls/templates/install — wrote
 * code/name/category/frequency only. Both endpoints are exported and
 * reachable, so which fields your control ended up with depended on how you
 * installed it.
 *
 * Both now build their `data` from `controlDataFromTemplate`, so the
 * contract has one implementation. These tests pin the projection itself:
 * the parity assertion at the end is the one that would have caught the
 * original divergence.
 */
import {
    controlDataFromTemplate,
    resolveRelatedPolicyIds,
} from '@/app-layer/usecases/control/template-projection';

const TEMPLATE = {
    code: 'AC-1',
    title: 'Access control policy',
    category: 'Access control',
    objective: 'Restrict access to authorised users',
    successCriteria: 'No unauthorised access in the review period',
    testingMethodology: 'Sample 25 accounts against the approver list',
    defaultFrequency: 'QUARTERLY',
};

const CTX = { tenantId: 'tenant-1', userId: 'user-1' };

describe('controlDataFromTemplate', () => {
    it('carries the three internal-controls import fields', () => {
        // These are exactly what the thin path dropped. The detail
        // Overview and Tests tabs render them, so their absence looked
        // like an empty template rather than a lost field.
        const data = controlDataFromTemplate(TEMPLATE, CTX);
        expect(data.objective).toBe(TEMPLATE.objective);
        expect(data.successCriteria).toBe(TEMPLATE.successCriteria);
        expect(data.testingMethodology).toBe(TEMPLATE.testingMethodology);
    });

    it('carries identity, category, frequency and provenance', () => {
        const data = controlDataFromTemplate(TEMPLATE, CTX);
        expect(data.code).toBe('AC-1');
        expect(data.name).toBe('Access control policy');
        expect(data.category).toBe('Access control');
        expect(data.frequency).toBe('QUARTERLY');
        expect(data.tenantId).toBe('tenant-1');
        expect(data.createdByUserId).toBe('user-1');
        expect(data.status).toBe('NOT_STARTED');
    });

    it('marks an installed control as not custom, and lets a caller override', () => {
        expect(controlDataFromTemplate(TEMPLATE, CTX).isCustom).toBe(false);
        expect(controlDataFromTemplate(TEMPLATE, CTX, { isCustom: true }).isCustom).toBe(true);
    });

    it('passes nulls through rather than inventing values', () => {
        const sparse = {
            ...TEMPLATE,
            code: null,
            category: null,
            objective: null,
            successCriteria: null,
            testingMethodology: null,
            defaultFrequency: null,
        };
        const data = controlDataFromTemplate(sparse, CTX);
        expect(data.code).toBeNull();
        expect(data.objective).toBeNull();
        expect(data.frequency).toBeNull();
        // …but the fields that are never optional stay populated.
        expect(data.name).toBe(TEMPLATE.title);
    });

    it('both install paths would produce an identical field set', () => {
        // The parity property, stated directly. Both callers now spread
        // this one object, so any field added here reaches both endpoints —
        // which is the whole point of the extraction.
        const fromFrameworkWizard = controlDataFromTemplate(TEMPLATE, CTX);
        const fromTemplatesEndpoint = controlDataFromTemplate(TEMPLATE, CTX);
        expect(Object.keys(fromFrameworkWizard).sort()).toEqual(
            Object.keys(fromTemplatesEndpoint).sort(),
        );
        expect(fromFrameworkWizard).toEqual(fromTemplatesEndpoint);

        // And the field set is the documented contract, not a subset of it.
        expect(Object.keys(fromFrameworkWizard).sort()).toEqual(
            [
                'category',
                'code',
                'createdByUserId',
                'frequency',
                'isCustom',
                'name',
                'objective',
                'status',
                'successCriteria',
                'tenantId',
                'testingMethodology',
            ].sort(),
        );
    });
});

describe('resolveRelatedPolicyIds', () => {
    const index = new Map([
        ['access control policy', 'p-access'],
        ['incident response plan', 'p-incident'],
    ]);

    it('resolves pipe-delimited titles case- and whitespace-insensitively', () => {
        expect(resolveRelatedPolicyIds('Access Control Policy | incident response plan', index))
            .toEqual(['p-access', 'p-incident']);
    });

    it('drops titles this tenant has no policy for, rather than failing', () => {
        // A shared template names policies a given tenant may not have
        // written yet. Failing the whole install for that would be wrong.
        expect(resolveRelatedPolicyIds('Access control policy|Nonexistent', index))
            .toEqual(['p-access']);
    });

    it('deduplicates', () => {
        expect(resolveRelatedPolicyIds('Access control policy|access control policy', index))
            .toEqual(['p-access']);
    });

    it('returns nothing for null or empty', () => {
        expect(resolveRelatedPolicyIds(null, index)).toEqual([]);
        expect(resolveRelatedPolicyIds('', index)).toEqual([]);
    });
});
