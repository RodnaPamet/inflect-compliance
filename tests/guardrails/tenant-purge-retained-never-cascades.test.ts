/**
 * A model the tenant purge RETAINS is never reached by a cascade from a model
 * it DELETES (#3724).
 *
 * WHY THIS EXISTS
 * ───────────────
 * `TENANT_PURGE_RETAINED` is a list of TABLES the purge skips. Skipping a table
 * is not the same as keeping its rows: the purge issues `DELETE FROM "Parent"
 * WHERE "tenantId" = $1` for every table it does not skip, and Postgres then
 * runs each child's `ON DELETE CASCADE` without asking the list. So a retained
 * child whose parent is purged is deleted anyway — by the database, silently,
 * inside a purge that reports success.
 *
 * That is #3716/#3724 exactly. `AccessReviewConnectedDecision` and 3a's pack,
 * narrowing and sample tables were in the retained set; each cascades from
 * `AccessReview`; `AccessReview` was not retained. Every campaign decision a
 * purge was promised to keep went with its campaign, and the two neighbouring
 * guards were green throughout, because both compare the retained set with
 * `docs/data-retention.md` — a list against a document — and neither reads a
 * foreign key.
 *
 * WHAT IT CHECKS, AND FROM WHERE
 * ──────────────────────────────
 *   deleted directly  — every tenant-scoped model, through the REAL
 *                       `deletionOrder()` and the REAL retained-set filter,
 *                       composed as `purgeSoftDeletedTenants` composes them;
 *   deleted by cascade — the transitive closure of that set over every
 *                       `onDelete: Cascade` relation in the live Prisma schema,
 *                       INCLUDING through models with no `tenantId`, which the
 *                       purge never names but Postgres still cascades through.
 *
 * A retained table anywhere in the closure fails, with the chain that reaches
 * it. There is NO allowlist: a retained model that may be cascaded away is not
 * retained, and the fix is to retain its parent or detach the FK (SET NULL on a
 * nullable column, as `IdentityWriteJournal` and `ExternalWriteJournal` do) —
 * or to stop calling it retained in the document.
 *
 * The schema, not the database, is read because this runs without one; the two
 * agree because `schema-drift-gate-runs-in-ci` makes CI prove the migrations
 * produce this schema. The schema's 205 cascade relations equal the live
 * catalogue's 205 `confdeltype = 'c'` constraints on the day this was written.
 */
import { TENANT_PURGE_RETAINED, deletionOrder } from '@/app-layer/usecases/tenant-purge';
import { parseSchemaModels, type SchemaModel } from '../helpers/prisma-schema-models';

interface CascadeEdge {
    /** The model whose rows go when `parent` rows go. */
    readonly child: string;
    readonly parent: string;
    readonly field: string;
}

/**
 * The models the purge DELETEs by name. Built the way `purgeSoftDeletedTenants`
 * builds its statement list — tenant-scoped tables, `deletionOrder()`, then the
 * retained-set filter on the TABLE name — and mapped back to model names.
 */
function deletedDirectly(models: readonly SchemaModel[], retained: ReadonlySet<string>): Set<string> {
    const tenantScoped = models.filter((m) => m.hasField('tenantId'));
    const modelOfTable = new Map(tenantScoped.map((m) => [m.tableName, m.name]));
    const order = deletionOrder(
        tenantScoped.map((m) => ({ table: m.tableName, dependsOn: new Set<string>() })),
    ).filter((t) => !retained.has(t));
    return new Set(order.map((t) => modelOfTable.get(t)!));
}

function cascadeEdges(models: readonly SchemaModel[]): CascadeEdge[] {
    return models.flatMap((m) =>
        m.relations
            .filter((r) => r.onDelete === 'Cascade' && r.target !== m.name)
            .map((r) => ({ child: m.name, parent: r.target, field: r.field })),
    );
}

/**
 * Every model a purge removes rows from, directly or by cascade, with the
 * shortest chain that reaches it: `[model, parent, …, a model deleted directly]`.
 */
function removedByPurge(
    direct: ReadonlySet<string>,
    edges: readonly CascadeEdge[],
): Map<string, string[]> {
    const chain = new Map<string, string[]>([...direct].map((m) => [m, [m]]));
    const queue = [...direct];
    while (queue.length > 0) {
        const parent = queue.shift()!;
        for (const e of edges) {
            if (e.parent !== parent || chain.has(e.child)) continue;
            chain.set(e.child, [`${e.child}.${e.field}`, ...chain.get(parent)!]);
            queue.push(e.child);
        }
    }
    return chain;
}

/** Retained models a purge would remove anyway, each with the chain that removes it. */
function retainedButCascaded(
    models: readonly SchemaModel[],
    retained: ReadonlySet<string>,
): string[] {
    const removed = removedByPurge(deletedDirectly(models, retained), cascadeEdges(models));
    return models
        .filter((m) => retained.has(m.tableName) && removed.has(m.name))
        .map((m) => removed.get(m.name)!.join(' <- cascade from '))
        .sort();
}

const MODELS = parseSchemaModels();

describe('tenant purge — a retained model is never cascaded away by a purged one', () => {
    it('the population is real — a parse returning nothing must fail', () => {
        // POSITIVE CONTROLS. Every assertion below is a search over these, and
        // a search over nothing finds no violation.
        const edges = cascadeEdges(MODELS);
        const direct = deletedDirectly(MODELS, TENANT_PURGE_RETAINED);
        console.log(
            `[tenant-purge-retained-never-cascades] ${MODELS.length} models, ` +
                `${edges.length} cascade relations, ${direct.size} purged directly, ` +
                `${TENANT_PURGE_RETAINED.size} retained`,
        );
        expect(edges.length).toBeGreaterThan(150);
        expect(direct.has('Control')).toBe(true);
        expect(direct.has('TenantMembership')).toBe(true);
        expect(direct.has('AuditLog')).toBe(false);
        // The edge that was the bug must be visible to the parser, or the
        // invariant below is vacuous for exactly the case it exists for.
        expect(edges).toContainEqual({
            child: 'AccessReviewConnectedDecision',
            parent: 'AccessReview',
            field: 'accessReview',
        });
    });

    it('every retained name is a real table — an unmatched name would be skipped silently', () => {
        // `retainedButCascaded` filters models BY the retained set. A retained
        // name that is no model's table (a typo, a rename, a model-level
        // `@@map`) would simply never be examined, and this guard would pass
        // over it while the purge kept nothing under that name.
        const tables = new Set(MODELS.map((m) => m.tableName));
        expect([...TENANT_PURGE_RETAINED].filter((t) => !tables.has(t)).sort()).toEqual([]);
    });

    it('no retained model can be reached by a cascade from a model the purge deletes', () => {
        // THE INVARIANT. Each entry reads `Child.field <- cascade from Parent`,
        // down to a model the purge DELETEs by name.
        expect(retainedButCascaded(MODELS, TENANT_PURGE_RETAINED)).toEqual([]);
    });

    it('MUTATION PROOF — un-retaining AccessReview recreates #3724, transitively', () => {
        // The defect as it shipped: the campaign root purged, its evidence
        // "retained". The detector must name every child, including the
        // narrowing, which hangs off the pack and the decision as well as the
        // campaign — so the closure, not a single hop, is what is being proved.
        const withoutRoot = new Set([...TENANT_PURGE_RETAINED].filter((t) => t !== 'AccessReview'));
        const found = retainedButCascaded(MODELS, withoutRoot).map((c) => c.split('.')[0]);
        expect(found).toEqual(
            expect.arrayContaining([
                'AccessReviewAgentNarrowing',
                'AccessReviewAgentPack',
                'AccessReviewConnectedDecision',
                'AccessReviewDecision',
                'AccessReviewDecisionSampleAudit',
            ]),
        );
    });

    it('the closure runs through models the purge never names', () => {
        // A model with no `tenantId` is never in the purge's DELETE list, but a
        // cascade still passes through it. Synthetic, so the property is proved
        // independent of whether today's schema happens to contain the shape.
        const removed = removedByPurge(new Set(['Purged']), [
            { child: 'GlobalJoin', parent: 'Purged', field: 'purged' },
            { child: 'Kept', parent: 'GlobalJoin', field: 'join' },
        ]);
        expect(removed.get('Kept')).toEqual(['Kept.join', 'GlobalJoin.purged', 'Purged']);
    });
});
