/**
 * Every field a CatalogFile may declare is actually written by the applier.
 *
 * ═══ THE FIELD THAT WAS NOT ═══
 *
 * `defaultOwnerHint` was authored on all 86 templates across all five shipped
 * CatalogFiles, accepted by `CatalogTemplateSchema` (catalog-loader.ts:195),
 * and given a column at controls.prisma:249 *specifically to receive it*. The
 * applier never mentioned it, so the column read NULL on all 522 rows.
 *
 * Every existing gate was green over that, and each for a good reason: they
 * check the fixture's SHAPE, whether a fixture is DELIVERED, or whether the
 * catalogue ARRIVES. None asks whether a field the format promises to carry is
 * carried. It is the 865-task bug in miniature — content authored, validated
 * at the boundary, dropped one layer before the database.
 *
 * ═══ WHY A STRUCTURAL SCAN AND NOT A ROW ASSERTION ═══
 *
 * `tests/integration/framework-catalog-delivery.test.ts` proves rows land, but
 * only for the fields it thought to check — it would have to be edited to
 * catch the NEXT dropped field, which is exactly the edit nobody makes. This
 * derives its subject from the SCHEMA, so a field added to the format is in
 * scope the moment it is added, with no second list to maintain.
 *
 * A field genuinely consumed without being persisted (`requirementCodes`
 * becomes link rows, not a column) is listed below with the reason. That list
 * is the honest part: it says which promises the format makes that are kept
 * somewhere other than a column.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../helpers/repo-files';
import { codeOf, declarationOf, functionBodyOf } from '../helpers/source-blocks';

const LOADER = path.join(REPO_ROOT, 'prisma/catalog-loader.ts');
const APPLIER = path.join(REPO_ROOT, 'prisma/catalog-applier.ts');

/**
 * Fields the applier consumes WITHOUT writing a column of the same name, and
 * how each is honoured instead. Shrink by fixing, never by adding.
 */
const CONSUMED_NOT_PERSISTED: Record<string, string> = {
    requirementCodes: 'Becomes ControlTemplateRequirementLink rows via ensureLinks, not a column.',
    tasks: 'Becomes ControlTemplateTask rows via reconcileTemplateTasks.',
    templateCodes: 'Pack membership; becomes PackTemplateLink rows.',
    summary: 'Written as FrameworkRequirement.description — the one deliberate rename.',
    key: 'The upsert key for Framework and FrameworkPack, not a payload field.',
    code: 'The upsert key for requirements and templates.',
};

/** Field names declared by one zod object schema in the loader. */
function schemaFields(schemaName: string): string[] {
    const src = fs.readFileSync(LOADER, 'utf8');
    const decl = declarationOf(src, schemaName);
    // `name: z.` — the left-hand side of each zod field.
    return [...decl.matchAll(/^\s{4}(\w+):\s*z\./gm)].map((m) => m[1]);
}

describe('the CatalogFile format keeps its promises', () => {
    // codeOf strips comments FIRST, and that is load-bearing rather than
    // tidy. Without it this guard is satisfied by prose: when `metadata` and
    // `sourceUrn` were added to the format, the applier gained a docblock
    // explaining why they matter — and a mutation that deleted both WRITES
    // left the guard green, because the comment still said the words. A
    // needle satisfied by a comment is the same defect this file exists to
    // catch, one level up.
    const applier = codeOf(fs.readFileSync(APPLIER, 'utf8'));
    const SCHEMAS = [
        'CatalogFrameworkSchema',
        'CatalogRequirementSchema',
        'CatalogTemplateSchema',
        'CatalogPackSchema',
    ];

    it('the scan reads real schemas with real fields (denominator)', () => {
        // An empty field list satisfies every assertion below while checking
        // nothing — the shape of the bug one level up. A schema rename that
        // blinds this scan must fail here rather than pass quietly.
        for (const name of SCHEMAS) {
            expect(schemaFields(name).length).toBeGreaterThanOrEqual(3);
        }
    });

    it('every declared field is referenced by the applier', () => {
        const dropped: string[] = [];
        for (const name of SCHEMAS) {
            for (const field of schemaFields(name)) {
                if (CONSUMED_NOT_PERSISTED[field]) continue;
                // `t.field`, `req.field`, `file.framework.field`, or a bare
                // `field:` in a Prisma payload all count as handled.
                const used = new RegExp(`[.\\s{]${field}\\b`).test(applier);
                if (!used) dropped.push(`${name}.${field}`);
            }
        }
        expect(dropped).toEqual([]);
    });

    it('every carve-out names a field that still exists', () => {
        // An entry for a field the format no longer has makes the list look
        // like more debt than there is, and hides a real one behind it.
        const all = new Set(SCHEMAS.flatMap(schemaFields));
        const stale = Object.keys(CONSUMED_NOT_PERSISTED).filter((f) => !all.has(f));
        expect(stale).toEqual([]);
    });

    it('defaultOwnerHint is written on create AND filled on an existing row', () => {
        // The regression that prompted this file. Two paths, and the second is
        // the one production takes: its templates already exist, so a
        // create-only write would leave every shipped row NULL forever.
        //
        // Bound to applyCatalogFile's body rather than read against the whole
        // file: a needle satisfied anywhere in the module — a docblock, a
        // sibling helper — would keep this green while the write it names was
        // gone. Same Class D shape this repo ratchets down.
        const body = functionBodyOf(applier, 'applyCatalogFile');
        expect(body).toContain('defaultOwnerHint: t.defaultOwnerHint ?? null');
        expect(body).toMatch(/existing\.defaultOwnerHint == null && t\.defaultOwnerHint/);
    });
});
