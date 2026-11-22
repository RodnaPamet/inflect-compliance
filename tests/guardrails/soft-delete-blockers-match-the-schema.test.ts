/**
 * THE BLOCKER LIST IS THE SCHEMA'S, NOT A HAND-KEPT COPY — #5083.
 *
 * `SOFT_DELETE_BLOCKERS` is what the delete usecases refuse on. If it falls
 * behind the schema, a new RESTRICT child silently re-opens the original bug:
 * the delete is accepted, the row is soft-deleted, and ninety days later the
 * `data-lifecycle` sweep hits SQLSTATE 23503 on it.
 *
 * ═══ WHY THIS CANNOT BE A GREP FOR `onDelete: Restrict` ═══
 *
 * Prisma's DEFAULT for a relation with no `onDelete` is Restrict when the
 * relation is REQUIRED (and SetNull when optional). Two of the six live edges
 * are blocking by that default and carry no `onDelete` at all —
 * `ControlException.control` and `RiskTreatmentPlan.risk` — and they are two
 * of the three the original report named. A list built by searching for the
 * attribute would have missed precisely the cases that matter, so the rule is
 * applied here rather than the attribute matched.
 */
import { SOFT_DELETE_BLOCKERS } from '@/lib/soft-delete-blockers';
import { parseSchemaModels, type SchemaModel, type SchemaRelation } from '../helpers/prisma-schema-models';

const MODELS = parseSchemaModels();
const PARENTS = Object.keys(SOFT_DELETE_BLOCKERS);

/** Prisma's rule: the attribute when written, else required ⇒ Restrict. */
function effectiveOnDelete(model: SchemaModel, rel: SchemaRelation): string {
    if (rel.onDelete) return rel.onDelete;
    const field = model.fields.find((f) => f.name === rel.field);
    return field?.isOptional ? 'SetNull' : 'Restrict';
}

/** Every edge that would REFUSE a hard delete of one of these parents. */
function derivedBlockers(): Map<string, Array<{ model: string; fk: string }>> {
    const out = new Map<string, Array<{ model: string; fk: string }>>();
    for (const model of MODELS) {
        for (const rel of model.relations) {
            if (!PARENTS.includes(rel.target)) continue;
            if (effectiveOnDelete(model, rel) !== 'Restrict') continue;
            // The FK onto the parent is the non-tenant scalar of the relation.
            const fk = rel.fields.find((f) => f !== 'tenantId') ?? rel.fields[0];
            const list = out.get(rel.target) ?? [];
            list.push({ model: model.name, fk });
            out.set(rel.target, list);
        }
    }
    return out;
}

const DERIVED = derivedBlockers();
const key = (e: { model: string; fk: string }) => `${e.model}.${e.fk}`;

describe('the population this guard ranges over', () => {
    it('parses the whole schema and a non-empty parent set', () => {
        expect(MODELS.length).toBeGreaterThan(100);
        expect(PARENTS.length).toBeGreaterThan(0);
        // Every parent named in the map must be a real model, or the map is
        // refusing on behalf of something that does not exist.
        for (const p of PARENTS) {
            expect({ parent: p, exists: MODELS.some((m) => m.name === p) })
                .toEqual({ parent: p, exists: true });
        }
    });

    it('finds blocking edges at all — a derivation that found none would pass vacuously', () => {
        expect([...DERIVED.values()].flat().length).toBeGreaterThan(0);
    });
});

describe('SOFT_DELETE_BLOCKERS equals what the schema would refuse', () => {
    it.each(PARENTS)('%s lists exactly its blocking children', (parent) => {
        const declared = (SOFT_DELETE_BLOCKERS[parent] ?? []).map(key).sort();
        const derived = (DERIVED.get(parent) ?? []).map(key).sort();
        // Exact equality in BOTH directions: a missing entry re-opens the
        // purge crash, and a stale extra entry refuses a delete for a child
        // that no longer blocks it.
        expect({ parent, declared }).toEqual({ parent, declared: derived });
    });

    it('declares no parent the schema has no blocking edge for', () => {
        for (const parent of PARENTS) {
            expect({ parent, hasEdges: (DERIVED.get(parent) ?? []).length > 0 })
                .toEqual({ parent, hasEdges: true });
        }
    });

    it('includes the two DEFAULT-Restrict edges a grep would miss', () => {
        // Named explicitly: these are the regression this guard exists for.
        const controls = (SOFT_DELETE_BLOCKERS.Control ?? []).map((b) => b.model);
        const risks = (SOFT_DELETE_BLOCKERS.Risk ?? []).map((b) => b.model);
        expect(controls).toContain('ControlException');
        expect(risks).toContain('RiskTreatmentPlan');
    });

    it('gives every blocker a human label for the refusal message', () => {
        for (const [parent, blockers] of Object.entries(SOFT_DELETE_BLOCKERS)) {
            for (const b of blockers) {
                expect({ parent, model: b.model, labelled: b.label.length > 0 })
                    .toEqual({ parent, model: b.model, labelled: true });
            }
        }
    });
});
