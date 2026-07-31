/**
 * List repositories never `as`-cast a raw filter value onto a Prisma
 * column.
 *
 * A list filter arrives as a string off the query string. Casting it —
 *
 *     where.status = filters.status as RiskStatus;        // ✗
 *     { status: options.status as never }                 // ✗
 *
 * — only silences the compiler. Prisma still validates the value at
 * query time and throws `PrismaClientValidationError` on the two shapes
 * the UI actually produces:
 *
 *   - a comma-joined multi-select (`?status=OPEN,MITIGATING` — every
 *     list facet is `multiple: true` and `toApiSearchParams` comma-joins);
 *   - a value from another entity's enum (`?status=ACTIVE` carried over
 *     from Assets or Vendors onto Risks).
 *
 * `PrismaClientValidationError` has no mapping in
 * `src/lib/errors/types.ts`, so it becomes a **500**; and because the
 * list pages read the same filters in their Server Component, it takes
 * the whole section down with "Something went wrong" instead of failing
 * one fetch. This has now been fixed three times — Controls (#1742),
 * Tasks, and this sweep across Risks / Assets / Vendors / Policies /
 * Evidence / AI systems — which is what makes it worth a ratchet.
 *
 * The fix is always `parseEnumListFilter` from
 * `src/app-layer/domain/list-filter.ts`: split, dedupe, validate every
 * member against the real enum, collapse to a scalar or `{ in: [...] }`,
 * and `badRequest` (400) on anything unknown.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const REPO_DIR = path.join(ROOT, 'src/app-layer/repositories');

/**
 * A filter/option bag member cast with `as`. Covers the two spellings
 * that shipped: `filters.status as RiskStatus` (named enum) and
 * `options.status as never` (compiler silencer).
 */
const FILTER_CAST_RE =
    /\b(?:filters|options|opts|params|query)\??\.[A-Za-z_]\w*\s+as\s+(?:never|unknown|[A-Z][\w.]*)/;

/** Strip line + block comments so prose ABOUT the bug isn't flagged. */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1: string) => p1);
}

function repositoryFiles(): string[] {
    return fs
        .readdirSync(REPO_DIR)
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
        .map((f) => path.join(REPO_DIR, f));
}

interface Violation {
    file: string;
    line: number;
    text: string;
}

function scan(source: string): Array<{ line: number; text: string }> {
    const out: Array<{ line: number; text: string }> = [];
    const lines = stripComments(source).split('\n');
    lines.forEach((line, i) => {
        if (FILTER_CAST_RE.test(line)) {
            out.push({ line: i + 1, text: line.trim() });
        }
    });
    return out;
}

describe('list repositories validate enum filters instead of casting them', () => {
    const files = repositoryFiles();

    it('finds the repository sources (scan is not vacuous)', () => {
        expect(files.length).toBeGreaterThan(15);
        expect(files.map((f) => path.basename(f))).toEqual(
            expect.arrayContaining([
                'RiskRepository.ts',
                'ControlRepository.ts',
                'WorkItemRepository.ts',
            ]),
        );
    });

    it('routes every list filter through the shared parser', () => {
        const shared = fs.readFileSync(
            path.join(ROOT, 'src/app-layer/domain/list-filter.ts'),
            'utf8',
        );
        // The ratchet is only meaningful while the canonical parser
        // exists and still validates. If it is ever gutted, fail here
        // rather than let the scan below pass over defanged call sites.
        expect(shared).toContain('export function parseEnumListFilter');
        expect(shared).toContain('badRequest');
    });

    it('has no `as`-cast filter values in any repository', () => {
        const violations: Violation[] = [];
        for (const file of files) {
            const source = fs.readFileSync(file, 'utf8');
            for (const hit of scan(source)) {
                violations.push({
                    file: path.relative(ROOT, file),
                    line: hit.line,
                    text: hit.text,
                });
            }
        }
        const message = violations
            .map(
                (v) =>
                    `  ${v.file}:${v.line}\n      ${v.text}\n` +
                    `      → use parseEnumListFilter(raw, Object.values(TheEnum), 'label') ` +
                    `from @/app-layer/domain/list-filter.`,
            )
            .join('\n');
        expect(violations.length === 0 ? '' : `\n${message}\n`).toBe('');
    });

    it('flags a cast and clears a validated call (detector proof)', () => {
        expect(
            scan('        if (filters.status) where.status = filters.status as RiskStatus;'),
        ).toHaveLength(1);
        expect(
            scan('                ...(options.status ? { status: options.status as never } : {}),'),
        ).toHaveLength(1);
        expect(
            scan(
                "        where.status = parseEnumListFilter<RiskStatus>(filters.status, Object.values(RiskStatus), 'risk status');",
            ),
        ).toHaveLength(0);
        // Prose describing the old shape must not trip the scan — every
        // fixed call site carries a comment quoting it.
        expect(
            scan('        // This used to be `filters.status as Prisma.EnumControlStatusFilter` — an'),
        ).toHaveLength(0);
        expect(
            scan('/**\n * (`where.status = filters.status as WorkItemStatus`), so two selected\n */'),
        ).toHaveLength(0);
    });
});
