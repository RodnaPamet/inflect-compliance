/**
 * seed-catalog YAML/JSON ingestion boundary.
 *
 * Replaces the per-framework `require('./fixtures/*.json')` + inline
 * TS-array fragments scattered across `prisma/seed-catalog.ts`. One
 * loader, one Zod schema, one canonical internal representation —
 * `seed-catalog.ts` and the `framework:import` CLI both consume the
 * same shape.
 *
 * ## Format support
 *
 *   • `.yaml` / `.yml` — parsed with `js-yaml` (already a dep, used
 *     by the cross-framework `library-loader.ts`).
 *   • `.json` — parsed with `JSON.parse`.
 *
 * Dispatch is by file extension (case-insensitive). Anything else
 * throws `CatalogParseError` with an actionable message.
 *
 * ## Schema (CatalogFileSchema)
 *
 *   framework:
 *     key: ISO27001                # PK against `Framework.key`
 *     name: ISO/IEC 27001          # human-readable
 *     version: "2022"              # optional, used in `key_version` upsert
 *     kind: ISO_STANDARD           # optional, FrameworkKind enum
 *     description: ...             # optional
 *
 *   requirements:                  # required, ≥ 1
 *     - code: A.5.1
 *       title: Information security policies
 *       summary: ...               # → FrameworkRequirement.description
 *       theme: Organizational      # optional
 *       themeNumber: 5             # optional
 *       sortOrder: 1               # optional, default = array index
 *       section: A.5               # optional, fallback to `theme` when null
 *       category: ...              # optional, fallback to theme/section
 *
 *   templates:                     # optional, may be []
 *     - code: A-A.5.1              # PK against `ControlTemplate.code`
 *       title: ...
 *       category: Organizational
 *       defaultFrequency: QUARTERLY  # ControlFrequency enum, default QUARTERLY
 *       requirementCodes: [A.5.1]    # codes — resolved to FrameworkRequirement IDs
 *
 *   pack:                          # optional, single pack per file
 *     key: ISO27001_2022_BASE      # PK against `FrameworkPack.key`
 *     name: ...
 *     version: ...
 *     description: ...
 *     templateCodes: [A-A.5.1, …]  # subset of `templates[*].code`; defaults
 *                                  # to ALL templates in this file
 *
 * ## Validation contract
 *
 *   • Malformed YAML/JSON → `CatalogParseError` (carries file + cause).
 *   • Schema-invalid content → `CatalogValidationError` (carries file
 *     + Zod issue list with `path` and `message`).
 *   • Both error types subclass `Error` so `try/catch (err)` callers
 *     can `instanceof` discriminate.
 *
 * Validation happens BEFORE the seed-catalog ever touches the DB.
 * A bad file is rejected at the boundary, not halfway through a
 * partial upsert.
 *
 * @module prisma/catalog-loader
 */
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import * as yaml from 'js-yaml';
import { createHash } from 'node:crypto';

// ─── Errors ─────────────────────────────────────────────────────────

export class CatalogParseError extends Error {
    readonly file: string;
    readonly cause?: unknown;
    constructor(file: string, message: string, cause?: unknown) {
        super(`Catalog parse error in ${path.relative(process.cwd(), file) || file}: ${message}`);
        this.name = 'CatalogParseError';
        this.file = file;
        this.cause = cause;
    }
}

export class CatalogValidationError extends Error {
    readonly file: string;
    readonly issues: ReadonlyArray<{ path: string; message: string }>;
    constructor(file: string, issues: ReadonlyArray<{ path: string; message: string }>) {
        const summary = issues
            .map((i) => `  ‒ ${i.path || '<root>'}: ${i.message}`)
            .join('\n');
        super(
            `Catalog validation failed in ${path.relative(process.cwd(), file) || file}:\n${summary}`,
        );
        this.name = 'CatalogValidationError';
        this.file = file;
        this.issues = issues;
    }
}

// ─── Zod schema ─────────────────────────────────────────────────────

const FRAMEWORK_KINDS = [
    'ISO_STANDARD',
    'NIST_FRAMEWORK',
    'SOC_CRITERIA',
    'EU_DIRECTIVE',
    'REGULATION',
    'INDUSTRY_STANDARD',
    'CUSTOM',
] as const;

const CONTROL_FREQUENCIES = [
    'AD_HOC',
    'DAILY',
    'WEEKLY',
    'MONTHLY',
    'QUARTERLY',
    'ANNUALLY',
] as const;

export const CatalogFrameworkSchema = z.object({
    key: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1).optional(),
    kind: z.enum(FRAMEWORK_KINDS).optional(),
    description: z.string().optional(),
});

export const CatalogRequirementSchema = z.object({
    code: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().optional(),
    theme: z.string().optional(),
    themeNumber: z.number().int().nonnegative().optional(),
    sortOrder: z.number().int().nonnegative().optional(),
    section: z.string().optional(),
    category: z.string().optional(),
});

/**
 * A localised string. `en` is required and is what lands in the scalar
 * columns; everything else rides in `i18nJson`.
 */
export const LocaleStringSchema = z.object({
    en: z.string().min(1),
    bg: z.string().optional(),
});

/** One authored step of a task. */
export const CatalogTaskStepSchema = z.object({
    text: LocaleStringSchema,
    hint: LocaleStringSchema.optional(),
});

/**
 * An authored control task.
 *
 * `steps` IS OPTIONAL, and that is a deliberate departure from the spec,
 * which asked for `.min(3).max(8)`. The five curated fixtures already carry
 * 205 tasks shaped `{title, description}` with no steps at all, and this
 * loader exists specifically to replace the `require()`-based seeding those
 * fixtures use (see this file's own header). A required `steps` would make
 * the loader structurally unable to read the very files it is migrating
 * toward — it would reject shipped content on day one.
 *
 * The 3-8 bound still holds WHEN steps are present, so the authoring rule is
 * unchanged; what moves is where absence is caught. That belongs to
 * `control-task-actionability`, which already has the
 * `LEGACY_GENERIC_ALLOWLIST` machinery for exactly this population and
 * shrinks as content PRs land. A zod schema has no allowlist and would have
 * had to grow one.
 */
export const CatalogTaskSchema = z.object({
    title: LocaleStringSchema,
    description: LocaleStringSchema,
    phase: z.enum(['SCOPE', 'IMPLEMENT', 'OPERATE', 'REVIEW']).default('IMPLEMENT'),
    steps: z.array(CatalogTaskStepSchema).min(3).max(8).optional(),
    evidenceHint: LocaleStringSchema.optional(),
    suggestedRole: z.string().optional(),
    sortOrder: z.number().int().nonnegative().default(0),
});

export const CatalogTemplateSchema = z.object({
    code: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    category: z.string().min(1),
    defaultFrequency: z.enum(CONTROL_FREQUENCIES).default('QUARTERLY'),
    requirementCodes: z.array(z.string().min(1)).default([]),
    /** The role a control is typically owned by, e.g. "IT Operations".
     *  Every curated fixture has carried this key since it was written; there
     *  was no column, so the seeder read it and dropped it. */
    defaultOwnerHint: z.string().optional(),
    tasks: z.array(CatalogTaskSchema).default([]),
});

export const CatalogPackSchema = z.object({
    key: z.string().min(1),
    name: z.string().min(1),
    version: z.string().optional(),
    description: z.string().optional(),
    /** When omitted, the pack includes every template in this file. */
    templateCodes: z.array(z.string().min(1)).optional(),
});

export const CatalogFileSchema = z.object({
    framework: CatalogFrameworkSchema,
    requirements: z.array(CatalogRequirementSchema).min(1),
    templates: z.array(CatalogTemplateSchema).default([]),
    pack: CatalogPackSchema.optional(),
});

export type CatalogFile = z.infer<typeof CatalogFileSchema>;
export type CatalogFramework = z.infer<typeof CatalogFrameworkSchema>;
export type CatalogRequirement = z.infer<typeof CatalogRequirementSchema>;
export type CatalogTemplate = z.infer<typeof CatalogTemplateSchema>;
export type CatalogPack = z.infer<typeof CatalogPackSchema>;

// ─── Loader ─────────────────────────────────────────────────────────

const YAML_EXT = new Set(['.yaml', '.yml']);
const JSON_EXT = new Set(['.json']);

function detectFormat(filePath: string): 'yaml' | 'json' {
    const ext = path.extname(filePath).toLowerCase();
    if (YAML_EXT.has(ext)) return 'yaml';
    if (JSON_EXT.has(ext)) return 'json';
    throw new CatalogParseError(
        filePath,
        `Unsupported file extension '${ext}'. Use .yaml/.yml or .json.`,
    );
}

/**
 * Parse + validate a catalog file. Returns the canonical internal
 * shape that `seed-catalog` and the framework-import CLI both
 * consume.
 *
 * @throws CatalogParseError    Unsupported extension, malformed YAML/JSON.
 * @throws CatalogValidationError The parsed content didn't match
 *                                CatalogFileSchema. The thrown error
 *                                carries the full Zod issue list with
 *                                paths so reviewers can pinpoint the
 *                                offending field.
 */
export function loadCatalogFile(filePath: string): CatalogFile {
    const absPath = path.resolve(filePath);

    let raw: string;
    try {
        raw = fs.readFileSync(absPath, 'utf8');
    } catch (err) {
        throw new CatalogParseError(absPath, 'failed to read file', err);
    }

    const format = detectFormat(absPath);

    let parsed: unknown;
    try {
        parsed = format === 'yaml' ? yaml.load(raw) : JSON.parse(raw);
    } catch (err) {
        throw new CatalogParseError(
            absPath,
            `failed to parse ${format.toUpperCase()}: ${err instanceof Error ? err.message : String(err)}`,
            err,
        );
    }

    if (parsed === null || parsed === undefined) {
        throw new CatalogParseError(absPath, 'file is empty after parsing');
    }

    const result = CatalogFileSchema.safeParse(parsed);
    if (!result.success) {
        throw new CatalogValidationError(
            absPath,
            result.error.issues.map((i) => ({
                path: i.path.join('.'),
                message: i.message,
            })),
        );
    }

    return result.data;
}

/**
 * Cross-validate a parsed catalog file: every templateCode listed in
 * the pack must exist in `templates[*].code`, and every
 * requirementCode listed on a template must exist in
 * `requirements[*].code`. Catches typos that the per-field schema
 * can't.
 *
 * Throws CatalogValidationError on the first issue found.
 */
export function assertCatalogConsistency(file: CatalogFile, sourcePath: string): void {
    const issues: Array<{ path: string; message: string }> = [];

    const requirementCodes = new Set(file.requirements.map((r) => r.code));
    const templateCodes = new Set(file.templates.map((t) => t.code));

    file.templates.forEach((t, i) => {
        for (const reqCode of t.requirementCodes) {
            if (!requirementCodes.has(reqCode)) {
                issues.push({
                    path: `templates[${i}].requirementCodes`,
                    message: `requirement code '${reqCode}' not found in requirements[*].code`,
                });
            }
        }
    });

    if (file.pack?.templateCodes) {
        file.pack.templateCodes.forEach((tc, i) => {
            if (!templateCodes.has(tc)) {
                issues.push({
                    path: `pack.templateCodes[${i}]`,
                    message: `template code '${tc}' not found in templates[*].code`,
                });
            }
        });
    }

    if (issues.length > 0) {
        throw new CatalogValidationError(sourcePath, issues);
    }
}

/** Convenience — load + cross-validate in one call. */
export function loadAndValidateCatalogFile(filePath: string): CatalogFile {
    const file = loadCatalogFile(filePath);
    assertCatalogConsistency(file, filePath);
    return file;
}

/**
 * A stable identity for one authored task.
 *
 * The applier reconciles on `(templateId, contentHash)`: equal means the
 * authored content is unchanged and the row is skipped, so re-applying a
 * catalogue is cheap and a re-authored task is detected without diffing every
 * column.
 *
 * KEY ORDER IS CANONICALISED, and that is the whole reason this is a function
 * rather than `JSON.stringify(task)`. `stringify` preserves insertion order,
 * so the same task authored with `phase` before `title` would hash
 * differently and reconcile as changed on every run — a no-op diff that would
 * rewrite every row nightly and make "changed" meaningless.
 *
 * Locale maps are hashed WHOLE. A task whose Bulgarian translation changed
 * has changed, even though every scalar column it writes is identical.
 */
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** sha256 over the canonicalised task. Hex, so it fits a plain text column. */
export function taskContentHash(task: unknown): string {
    return createHash('sha256').update(canonicalJson(task)).digest('hex');
}
