/**
 * No layer that builds a Prisma `where` clause ever `as`-casts a raw filter
 * value onto a column.
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
 * one fetch. This has now been fixed four times — Controls (#1742),
 * Tasks, the sweep across Risks / Assets / Vendors / Policies / Evidence /
 * AI systems, and (D3) the four usecases that build their own `where`
 * without going through a repository — which is what makes it worth a
 * ratchet.
 *
 * The fix is always `parseEnumListFilter` from
 * `src/app-layer/domain/list-filter.ts`: split, dedupe, validate every
 * member against the real enum, collapse to a scalar or `{ in: [...] }`,
 * and `badRequest` (400) on anything unknown.
 *
 * ## Scope
 *
 * The original ratchet only scanned `src/app-layer/repositories`, which is
 * why the same bug survived in `src/app-layer/usecases` — several list
 * usecases (`listAllTestPlans`, `listAgentProposals`,
 * `listTenantFrameworkDeltas`, `listWorkflowRuns`) assemble their `where`
 * inline instead of delegating to a repository. All three layers that can
 * reach Prisma with a user-supplied filter are now in scope.
 * `src/app-layer/jobs` was swept at the same time and had no hits; it is
 * left out because job inputs are scheduler-supplied, not request-supplied.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

/** Every layer that may hand a user-supplied filter value to Prisma. */
const SCANNED_DIRS = [
    'src/app-layer/repositories',
    'src/app-layer/usecases',
    'src/app-layer/services',
] as const;

/**
 * A filter/option bag member cast with `as`. Covers the two spellings
 * that shipped: `filters.status as RiskStatus` (named enum) and
 * `options.status as never` (compiler silencer).
 */
const FILTER_CAST_RE =
    /\b(?:filters|options|opts|params|query)\??\.[A-Za-z_]\w*\s+as\s+(?:never|unknown|[A-Z][\w.]*)/;

/**
 * Casts that are allowed to stay, keyed by `<repo-relative path>:<line text>`.
 *
 * Add an entry ONLY when the cast provably cannot reach a Prisma enum
 * column with an unvalidated wire value — and write the reason. The
 * "no stale entries" test below deletes the incentive to leave one
 * behind: an exemption that no longer matches a real line fails CI, so
 * fixing a site means removing its entry in the same diff.
 *
 * Empty today. The D3 sweep found no cast in these three directories
 * that had to survive.
 */
const EXEMPT_CASTS: Record<string, string> = {};

/** Strip line + block comments so prose ABOUT the bug isn't flagged. */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1: string) => p1);
}

/** Recursive walk — `usecases/` and `services/` both have subdirectories. */
function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...sourceFiles(full));
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
            out.push(full);
        }
    }
    return out;
}

function scannedFiles(): string[] {
    return SCANNED_DIRS.flatMap((rel) => sourceFiles(path.join(ROOT, rel)));
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

/** Every cast hit across the scanned tree, exempt or not. */
function allHits(): Violation[] {
    const hits: Violation[] = [];
    for (const file of scannedFiles()) {
        const source = fs.readFileSync(file, 'utf8');
        for (const hit of scan(source)) {
            hits.push({ file: path.relative(ROOT, file), line: hit.line, text: hit.text });
        }
    }
    return hits;
}

const exemptionKey = (v: Pick<Violation, 'file' | 'text'>) => `${v.file}:${v.text}`;

describe('list filters are validated, never `as`-cast onto a Prisma column', () => {
    const files = scannedFiles();

    it('finds the sources in every scanned layer (scan is not vacuous)', () => {
        for (const rel of SCANNED_DIRS) {
            const inDir = files.filter((f) => path.relative(ROOT, f).startsWith(rel));
            expect(inDir.length).toBeGreaterThan(10);
        }
        const names = files.map((f) => path.basename(f));
        expect(names).toEqual(
            expect.arrayContaining([
                // repositories
                'RiskRepository.ts',
                'ControlRepository.ts',
                'WorkItemRepository.ts',
                // usecases — the D3 sites, each of which built its own `where`
                'due-planning.ts',
                'agent-proposals.ts',
                'framework-delta.ts',
                'workflow-runs.ts',
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

    it('has no `as`-cast filter values in any scanned layer', () => {
        const violations = allHits().filter((v) => !(exemptionKey(v) in EXEMPT_CASTS));
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

    it('carries no stale exemptions', () => {
        const live = new Set(allHits().map(exemptionKey));
        const stale = Object.keys(EXEMPT_CASTS).filter((k) => !live.has(k));
        expect(stale).toEqual([]);
    });

    it('gives every exemption a written reason', () => {
        for (const [key, reason] of Object.entries(EXEMPT_CASTS)) {
            expect(`${key} → ${reason}`.length).toBeGreaterThan(key.length + 25);
        }
    });

    it('flags a cast and clears a validated call (detector proof)', () => {
        expect(
            scan('        if (filters.status) where.status = filters.status as RiskStatus;'),
        ).toHaveLength(1);
        expect(
            scan('                ...(options.status ? { status: options.status as never } : {}),'),
        ).toHaveLength(1);
        // The exact shape that shipped in the four D3 usecases.
        expect(
            scan(
                '            where: { tenantId: ctx.tenantId, ...(opts.status ? { status: opts.status as never } : {}) },',
            ),
        ).toHaveLength(1);
        expect(
            scan(
                "        where.status = parseEnumListFilter<RiskStatus>(filters.status, Object.values(RiskStatus), 'risk status');",
            ),
        ).toHaveLength(0);
        // A value read back OUT of the database is not a wire filter —
        // `agent-proposals.ts` narrows `proposal.kind` that way and must
        // not be dragged in by the scan.
        expect(scan('    return { id: proposal.id, kind: proposal.kind as AgentProposalKind };')).toHaveLength(0);
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
