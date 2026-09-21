/**
 * Prisma schema test helper.
 *
 * GAP-09 split the monolithic `prisma/schema.prisma` into a folder
 * (`prisma/schema/`) holding base/auth/compliance/vendor/audit/
 * automation/enums/schema files. Tests that previously read the
 * monolith with `fs.readFileSync('prisma/schema.prisma')` now need
 * the concatenated content of the whole folder — that is what
 * Prisma itself sees at codegen time.
 *
 * `readPrismaSchema()` is the single entry point. It is sync (most
 * guardrail tests are synchronous) and caches the result for the
 * test process so 30+ guard tests don't re-read the same files.
 *
 * Concatenation order is deterministic (alphabetical filename) so
 * substring-search assertions get the same text every run.
 */
import * as fs from 'fs';
import * as path from 'path';
import { codeOf } from './source-blocks';

const SCHEMA_DIR = path.resolve(__dirname, '../../prisma/schema');

let cached: string | null = null;

function concatSchema(): string {
    if (cached !== null) return cached;
    const files = fs
        .readdirSync(SCHEMA_DIR)
        .filter((f) => f.endsWith('.prisma'))
        .sort();
    cached = files
        .map((f) => fs.readFileSync(path.join(SCHEMA_DIR, f), 'utf-8'))
        .join('\n');
    return cached;
}

/**
 * Read every `.prisma` file under `prisma/schema/`, concatenated in
 * alphabetical filename order, with COMMENTS BLANKED.
 *
 * Use this anywhere a test previously read `prisma/schema.prisma`
 * to a string. It is a drop-in replacement for that path.
 *
 * #2246 Class A — the mask belongs at the read seam. This schema is
 * 11337 lines of which 4738 are comment (3438 of them `///` doc
 * comments), so an unmasked assertion here is mostly searching prose:
 * `expect(schema).toMatch(/model Foo/)` passes on a `/// see model Foo`
 * note after the model itself is deleted, and the negated form
 * (`not.toMatch(/model Scope/)`, six files do this) reddens a healthy
 * guard because a comment names the thing it forbids.
 *
 * `codeOf` is the right masker for Prisma, not `sqlCodeOf`: Prisma's
 * comment syntax is `//` and `///`, it has no `--` and no `/* … *\/`,
 * and its only string form is double-quoted. Verified on this schema:
 * masking is idempotent and preserves both length and line count, so
 * every `indexOf`/`slice`/`^…$`-multiline anchor in the 61 calling
 * files still lines up. Verified too that it changes no verdict — all
 * nine negated schema assertions read false on raw AND masked text.
 *
 * `tests/guards/rq7-bowtie.test.ts` already wrapped this call site in
 * `codeOf` by hand; that wrapper is now redundant but still correct.
 */
export function readPrismaSchema(): string {
    return codeOf(concatSchema());
}

/**
 * The DELIBERATE raw twin. Only for an assertion whose SUBJECT is the
 * schema's prose — a `///` doc comment carrying a rationale, a licence
 * header, a deprecation note. Masked, such an assertion could never
 * pass again. Anything asserting on MODELS, FIELDS or ATTRIBUTES wants
 * `readPrismaSchema` instead.
 */
export function readPrismaSchemaRaw(): string {
    return concatSchema();
}

/**
 * Path of the schema FOLDER for tooling that wants to invoke
 * Prisma CLI commands like `prisma migrate diff --schema=...`.
 *
 * Returns the absolute path of `prisma/schema/`.
 */
export function getPrismaSchemaDir(): string {
    return SCHEMA_DIR;
}
