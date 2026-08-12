/**
 * Soft-deleted parents must not leak onto the calendar through child loaders.
 *
 * `src/lib/soft-delete.ts` injects `deletedAt: null` into the TOP-LEVEL
 * `args.where` only. It never descends into `select`/`include`, and Prisma has
 * no global relation filters — so a nested join on a required to-one relation
 * is unconditional. Two independent gaps made that reachable:
 *
 *   - a child model may not be in SOFT_DELETE_MODELS at all (VendorDocument,
 *     VendorAssessment, TreatmentMilestone have no `deletedAt` column), and
 *   - a soft delete is an UPDATE, so the schema's `onDelete: Cascade` never
 *     fires and children are never deleted in sympathy.
 *
 * Six loader/relation pairs leaked. This guard resolves each loader's nested
 * relations through the Prisma DMMF — not a hardcoded list — so a NEW loader,
 * or a new relation on an existing one, is covered the day it lands.
 *
 * It asserts the predicate exists, which is a structural claim. The behavioural
 * companion (soft-delete a vendor, assert its document expiry disappears) lives
 * in the calendar's usecase tests.
 */
import {
    readCalendarUsecase,
    calendarLoaderBlocks,
} from '../helpers/calendar-usecase-source';
import { Prisma } from '@prisma/client';



/** Models carrying a `deletedAt` column, straight from the datamodel. */
const SOFT_DELETABLE = new Set(
    Prisma.dmmf.datamodel.models
        .filter((m) => m.fields.some((f) => f.name === 'deletedAt'))
        .map((m) => m.name),
);

/** relationName → target model, per owning model. */
function relationTargets(modelName: string): Map<string, string> {
    const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName);
    const out = new Map<string, string>();
    if (!model) return out;
    for (const f of model.fields) {
        if (f.kind === 'object' && typeof f.type === 'string') {
            out.set(f.name, f.type);
        }
    }
    return out;
}

/** Prisma model name for a `db.<accessor>` property (lowerCamel → PascalCase). */
function modelOfAccessor(accessor: string): string | undefined {
    return Prisma.dmmf.datamodel.models.find(
        (m) => m.name.charAt(0).toLowerCase() + m.name.slice(1) === accessor,
    )?.name;
}


describe('calendar loaders — nested soft-delete predicates', () => {
    const blocks = calendarLoaderBlocks(readCalendarUsecase());

    it('finds the loader blocks at all', () => {
        // If this regresses to 0 the whole suite would pass vacuously.
        expect(blocks.length).toBeGreaterThanOrEqual(15);
    });

    it('every nested relation on a soft-deletable model is filtered', () => {
        const violations: string[] = [];

        for (const block of blocks) {
            const accessor = block.body.match(/\bdb\.(\w+)\.findMany\(/)?.[1];
            if (!accessor) continue;
            const model = modelOfAccessor(accessor);
            if (!model) continue;
            const targets = relationTargets(model);

            // Relations the loader JOINS: `name: { select: {` inside its body.
            const joined = new Set<string>();
            for (const rm of block.body.matchAll(/(\w+):\s*\{\s*select:/g)) {
                if (targets.has(rm[1])) joined.add(rm[1]);
            }

            for (const relation of joined) {
                const target = targets.get(relation)!;
                if (!SOFT_DELETABLE.has(target)) continue;
                // The predicate may carry more (`{ deletedAt: null, status: … }`)
                // and may be nested one level deeper, so match the pair, not a
                // whole-object literal.
                const filtered = new RegExp(
                    `${relation}:\\s*\\{[^}]*deletedAt:\\s*null`,
                ).test(block.body);
                if (!filtered) {
                    violations.push(
                        `${block.name}: joins ${relation} (${target}, soft-deletable) ` +
                            `without a nested \`${relation}: { deletedAt: null }\` predicate`,
                    );
                }
            }
        }

        expect(violations).toEqual([]);
    });

    it('the six known leaks are actually covered', () => {
        // Named explicitly so a refactor that drops a predicate fails with the
        // loader's name rather than only through the generic sweep above.
        const required: Array<[string, string]> = [
            ['loadVendorDocumentEvents', 'vendor'],
            ['loadVendorAssessmentEvents', 'vendor'],
            ['loadTestPlanEvents', 'control'],
            ['loadControlExceptionEvents', 'control'],
            ['loadTreatmentPlanEvents', 'risk'],
            ['loadTreatmentMilestoneEvents', 'treatmentPlan'],
        ];
        for (const [loader, relation] of required) {
            const block = blocks.find((b) => b.name === loader);
            expect(block).toBeDefined();
            expect(block!.body).toMatch(
                new RegExp(`${relation}:\\s*\\{[^}]*deletedAt:\\s*null`),
            );
        }
    });

    it('the milestone loader filters the grandparent risk, not just the plan', () => {
        // The second-order case: the plan predicate alone was a half-filter,
        // because a milestone's click-through lands on /risks/{riskId}.
        const block = blocks.find((b) => b.name === 'loadTreatmentMilestoneEvents');
        expect(block!.body).toMatch(/treatmentPlan:\s*\{[^}]*risk:\s*\{\s*deletedAt:\s*null/);
    });
});
