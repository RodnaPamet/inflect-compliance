/**
 * The seam four compliance surfaces share to reconcile the two representations
 * of one framework.
 *
 * `computeCoverage`, `generateReadinessReport`, `getSoA` and `getFrameworkTree`
 * all join a tenant's `ControlRequirementLink` rows to a framework's
 * requirements, and a framework can exist twice in `Framework` under two keys.
 * Teaching some of them to collapse the two and not the others is worse than
 * teaching none — the surfaces then disagree about one tenant at one moment —
 * so the collapse lives in one module, and this file tests it directly.
 *
 * The DB-backed proof that all four agree is
 * `tests/integration/framework-representation-coverage.test.ts`. What is here
 * is the part that has no natural fixture: the tie-break when a control is
 * linked to BOTH representations of one obligation, and the read the resolver
 * declines to make.
 */
import type { PrismaTx } from '@/lib/db-context';
import {
    collapseLinksToOwnRequirements,
    resolveFamilyRequirementAliases,
    type FamilyRequirementAliases,
} from '@/app-layer/services/framework-representation-aliases';

const ISMS_URN = 'urn:inflect:library:iso27001-2022';

/**
 * The two reads `resolveFamilyRequirementAliases` makes, and nothing else.
 *
 * The double cast erases the rest of `PrismaTx`, so this does NOT catch a
 * third read at compile time — it catches it at run time, as
 * `Cannot read properties of undefined`. That is not hypothetical: adding the
 * catalogue read is exactly how `tests/unit/framework-tree-usecase.test.ts`
 * went red, because its tenant-context mock had never needed a `framework`
 * delegate. A partial mock is a claim about what the function touches, and it
 * fails loudly when the claim goes stale.
 */
function stubDb(rows: {
    frameworks?: { id: string; key: string; sourceUrn: string | null }[];
    requirements?: { id: string; code: string }[];
}) {
    const framework = { findMany: jest.fn().mockResolvedValue(rows.frameworks ?? []) };
    const frameworkRequirement = { findMany: jest.fn().mockResolvedValue(rows.requirements ?? []) };
    return {
        db: { framework, frameworkRequirement } as unknown as PrismaTx,
        framework,
        frameworkRequirement,
    };
}

const aliasesOf = (pairs: [string, string][]): FamilyRequirementAliases => ({
    lookupIds: pairs.map(([from]) => from),
    toOwnRequirementId: new Map(pairs),
});

interface TestLink {
    requirementId: string;
    applicability: string | null;
    control: { id: string };
}

describe('resolveFamilyRequirementAliases', () => {
    const ownRequirements = [
        { id: 'lib-a515', code: 'A.5.15' },
        { id: 'lib-7', code: '7' },
    ];

    it('maps the sibling representation onto this framework by canonical code', async () => {
        const { db } = stubDb({
            frameworks: [
                { id: 'fw-lib', key: 'ISO27001-2022', sourceUrn: ISMS_URN },
                { id: 'fw-seed', key: 'ISO27001', sourceUrn: null },
            ],
            requirements: [
                { id: 'seed-515', code: '5.15' },
                { id: 'seed-7', code: '7' },
                { id: 'seed-9', code: '9' },
            ],
        });

        const aliases = await resolveFamilyRequirementAliases(
            db,
            { id: 'fw-lib', key: 'ISO27001-2022', sourceUrn: ISMS_URN },
            ownRequirements,
        );

        // `5.15` and `A.5.15` are one obligation; `7` is spelled the same in
        // both. Own rows always map to themselves.
        expect(aliases.toOwnRequirementId.get('seed-515')).toBe('lib-a515');
        expect(aliases.toOwnRequirementId.get('seed-7')).toBe('lib-7');
        expect(aliases.toOwnRequirementId.get('lib-a515')).toBe('lib-a515');

        // A sibling obligation this framework does NOT declare is dropped
        // rather than added: the denominator is the requested framework's own
        // requirements, and folding `9` in would inflate it.
        expect(aliases.toOwnRequirementId.has('seed-9')).toBe(false);
        expect(aliases.lookupIds).not.toContain('seed-9');
        expect(aliases.lookupIds.sort()).toEqual(['lib-7', 'lib-a515', 'seed-515', 'seed-7']);
    });

    it('reads no catalogue at all for a framework that declares no family', async () => {
        // `frameworkFamilyId` degrades to `key:<key>` and `Framework.key` is
        // `@unique`, so such a family can only ever name this row. The skipped
        // read is a proof, not an optimisation — assert it is actually skipped,
        // or the claim in the source comment is untested prose.
        const { db, framework, frameworkRequirement } = stubDb({});

        const aliases = await resolveFamilyRequirementAliases(
            db,
            { id: 'fw-custom', key: 'CUSTOM-THING', sourceUrn: null },
            ownRequirements,
        );

        expect(framework.findMany).not.toHaveBeenCalled();
        expect(frameworkRequirement.findMany).not.toHaveBeenCalled();
        expect(aliases.lookupIds.sort()).toEqual(['lib-7', 'lib-a515']);
    });

    it('reads no requirements when the family has no other row', async () => {
        const { db, framework, frameworkRequirement } = stubDb({
            frameworks: [{ id: 'fw-lib', key: 'ISO27001-2022', sourceUrn: ISMS_URN }],
        });

        await resolveFamilyRequirementAliases(
            db,
            { id: 'fw-lib', key: 'ISO27001-2022', sourceUrn: ISMS_URN },
            ownRequirements,
        );

        expect(framework.findMany).toHaveBeenCalledTimes(1);
        expect(frameworkRequirement.findMany).not.toHaveBeenCalled();
    });
});

describe('collapseLinksToOwnRequirements', () => {
    const aliases = aliasesOf([
        ['own-8', 'own-8'],
        ['sibling-8', 'own-8'],
        ['other-8', 'own-8'],
    ]);

    const link = (requirementId: string, applicability: string | null, controlId = 'ctl-1'): TestLink => ({
        requirementId,
        applicability,
        control: { id: controlId },
    });

    it('re-points a sibling link at this framework own requirement row', () => {
        const out = collapseLinksToOwnRequirements([link('sibling-8', null)], aliases);

        expect(out).toHaveLength(1);
        expect(out[0].requirementId).toBe('own-8');
        // The rest of the row is carried through untouched.
        expect(out[0].control.id).toBe('ctl-1');
    });

    it('drops a link on an obligation this framework does not declare', () => {
        expect(collapseLinksToOwnRequirements([link('unknown-9', null)], aliases)).toEqual([]);
    });

    it.each([
        ['own link first', ['own', 'sibling']],
        ['sibling link first', ['sibling', 'own']],
    ])('keeps one link per (requirement, control) — %s', (_name, order) => {
        // `@@unique([controlId, requirementId])` made a duplicate impossible
        // until the collapse re-pointed two rows onto one requirement.
        const links = order.map((which) =>
            which === 'own'
                ? link('own-8', 'NOT_APPLICABLE')
                : link('sibling-8', null),
        );

        const out = collapseLinksToOwnRequirements(links, aliases);

        expect(out).toHaveLength(1);
        // The survivor is the link written against the framework the caller
        // ASKED about, whichever order the database returned them in —
        // `applicability` is a per-framework override, so the other row's
        // value answers a question nobody asked. Reading the tie-break off the
        // already-re-pointed row makes every held link look like the own one
        // and silently keeps whichever arrived first.
        expect(out[0].applicability).toBe('NOT_APPLICABLE');
    });

    it.each([
        ['ascending', ['other-8', 'sibling-8']],
        ['descending', ['sibling-8', 'other-8']],
    ])('breaks a tie between two sibling links stably — %s', (_name, order) => {
        // Three representations, none of them the requested one. There is no
        // meaningful winner, so the rule is only that it must not depend on
        // the query plan: the same tenant cannot get two different answers.
        const out = collapseLinksToOwnRequirements(
            order.map((requirementId) => link(requirementId, `from-${requirementId}`)),
            aliases,
        );

        expect(out).toHaveLength(1);
        expect(out[0].applicability).toBe('from-other-8');
    });

    it('keeps distinct controls and distinct requirements apart', () => {
        const wider = aliasesOf([
            ['own-8', 'own-8'],
            ['sibling-8', 'own-8'],
            ['own-7', 'own-7'],
        ]);

        const out = collapseLinksToOwnRequirements(
            [
                link('own-8', null, 'ctl-1'),
                link('sibling-8', null, 'ctl-2'),
                link('own-7', null, 'ctl-1'),
            ],
            wider,
        );

        expect(
            out.map((l) => `${l.requirementId}/${l.control.id}`).sort(),
        ).toEqual(['own-7/ctl-1', 'own-8/ctl-1', 'own-8/ctl-2']);
    });
});
