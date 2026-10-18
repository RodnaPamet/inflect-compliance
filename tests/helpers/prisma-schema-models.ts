/**
 * Structured Prisma-schema model parser.
 *
 * `tests/helpers/prisma-schema.ts` returns the schema as one big
 * string (the concatenation of every `prisma/schema/*.prisma` file).
 * That is enough for substring / regex assertions, but the
 * index/query guardrails need a STRUCTURED view: per model, the
 * scalar fields, the `@@index` / `@@unique` / `@@id` blocks, the
 * field-level `@id` / `@unique`, and the relation foreign-key
 * groups.
 *
 * This module is that structured layer. It is deliberately a small,
 * dependency-free, hand-rolled parser rather than a call into Prisma's
 * own internals — Prisma does not expose a stable schema-AST API for
 * test tooling, and the surface we need (models, fields, the four
 * index/uniqueness constructs, relation FK lists) is small and
 * regular enough to parse with line scanning.
 *
 * Parsing notes / robustness:
 *   - Model bodies may span many lines with varied indentation. We
 *     locate `model X {` and balance braces to find the closing `}`.
 *   - Block attributes (`@@index`, `@@unique`, `@@id`) only ever
 *     carry ONE bracket list of field names that we care about. We
 *     parse the FIRST `[...]` after the attribute name and STRIP any
 *     per-field `(sort: Desc)` / `(ops: ...)` modifiers and any
 *     trailing `, map: "..."` / `, type: ...` arguments — none exist
 *     in the schema today, but Prisma allows them and a future
 *     migration could add them.
 *   - Field lines look like `name  Type  @attr ...`. The first two
 *     whitespace-separated tokens are the field name and type. A
 *     trailing `[]` on the type means a list; a trailing `?` means
 *     optional.
 *   - Relation FK groups come from `@relation(... fields: [a, b] ...)`.
 *     The list/back side of a relation has NO `fields:` arg and is
 *     ignored — only the side that actually carries the scalar FK
 *     columns is reported.
 *
 * Consumers include `tests/guardrails/schema-index-coverage.test.ts`,
 * `tests/guardrails/query-shape-guardrails.test.ts` and, for `relations`
 * and `tableName`, the tenant-purge retention guard.
 */
import { readPrismaSchema } from './prisma-schema';

/** A single field line inside a `model { ... }` block. */
export interface SchemaField {
    /** Field name — the first token on the line. */
    name: string;
    /** Field type with `[]` / `?` stripped (e.g. `String`, `Tenant`). */
    type: string;
    /** True if the declared type carried a trailing `[]`. */
    isList: boolean;
    /** True if the declared type carried a trailing `?`. */
    isOptional: boolean;
}

/**
 * The foreign-key-carrying side of one `@relation(... fields: [...] ...)`.
 *
 * `onDelete` is the action AS WRITTEN, or null when the attribute names none.
 * Prisma's implicit default is then `Restrict` for a required relation and
 * `SetNull` for an optional one — neither of which is `Cascade`, which is the
 * only action a caller asking "what does deleting the parent take with it"
 * needs to see.
 */
export interface SchemaRelation {
    /** The relation field's name, e.g. `accessReview`. */
    field: string;
    /** The model the FK points at, e.g. `AccessReview`. */
    target: string;
    /** The scalar FK columns, e.g. `['accessReviewId', 'tenantId']`. */
    fields: string[];
    /** `Cascade`, `Restrict`, `SetNull`, `NoAction`, `SetDefault`, or null when unwritten. */
    onDelete: string | null;
}

/** A parsed `model X { ... }` block. */
export interface SchemaModel {
    /** PascalCase model name. */
    name: string;
    /**
     * The physical table name: the model-level `@@map("…")` when present,
     * otherwise the model name. Code that compares against the database's own
     * catalogue (`information_schema`, `pg_constraint`) must use this.
     */
    tableName: string;
    /** Every scalar + relation field line (no `@@` lines, no `}`). */
    fields: SchemaField[];
    /** Names of every field (scalar + relation). */
    scalarFieldNames: string[];
    /** Every `@@index([...])` as an ordered array of field names. */
    blockIndexes: string[][];
    /** Every `@@unique([...])` as an ordered array of field names. */
    blockUniques: string[][];
    /** The `@@id([...])` field list, or null if none. */
    blockId: string[] | null;
    /** The field name carrying a field-level `@id`, or null. */
    fieldIdName: string | null;
    /** Field names carrying a field-level `@unique`. */
    fieldUniqueNames: string[];
    /**
     * For every `@relation(... fields: [a, b] ...)` on a field, the
     * `[a, b]` scalar list. The list/back side of a relation (no
     * `fields:` arg) is NOT represented here.
     */
    relationFkFieldGroups: string[][];
    /** Every FK-carrying relation, with its target model and delete action. */
    relations: SchemaRelation[];
    /** True if a field with the given name exists on the model. */
    hasField(name: string): boolean;
}

/**
 * Parse a comma-separated list of bracketed identifiers, stripping
 * any `(sort: ...)` / `(ops: ...)` per-field modifiers.
 *
 * Input is the raw text BETWEEN the outermost `[` and `]`, e.g.
 *   `tenantId, score(sort: Desc)`
 * Output: `['tenantId', 'score']`.
 */
function parseFieldList(inner: string): string[] {
    return inner
        .split(',')
        .map((tok) => tok.trim())
        // Drop a trailing `(sort: Desc)` / `(ops: raw(...))` modifier.
        .map((tok) => tok.replace(/\(.*$/, '').trim())
        .filter((tok) => tok.length > 0);
}

/**
 * Given the text of a block attribute line starting at `@@index` /
 * `@@unique` / `@@id`, extract the FIRST `[...]` field list.
 *
 * Returns null if the attribute carries no bracket list (e.g. a
 * `@@id` declared field-level is handled elsewhere; a malformed
 * line is simply ignored).
 */
function extractFirstBracketList(line: string): string[] | null {
    const open = line.indexOf('[');
    if (open === -1) return null;
    // Balance brackets so a `[id, tenantId]` inside a nested
    // `references: [...]` (not present on @@-attrs, but cheap to be
    // safe) doesn't truncate the list.
    let depth = 0;
    let close = -1;
    for (let i = open; i < line.length; i++) {
        if (line[i] === '[') depth++;
        else if (line[i] === ']') {
            depth--;
            if (depth === 0) {
                close = i;
                break;
            }
        }
    }
    if (close === -1) return null;
    return parseFieldList(line.slice(open + 1, close));
}

/**
 * Extract the `fields: [...]` list from a `@relation(...)` attribute,
 * or null if the relation carries no `fields:` arg (the back side).
 */
function extractRelationFkList(line: string): string[] | null {
    // `@relation(name: "x", fields: [a, b], references: [id, tid])`
    const m = line.match(/@relation\s*\(/);
    if (!m) return null;
    const fieldsIdx = line.indexOf('fields:', m.index);
    if (fieldsIdx === -1) return null;
    const open = line.indexOf('[', fieldsIdx);
    if (open === -1) return null;
    let depth = 0;
    let close = -1;
    for (let i = open; i < line.length; i++) {
        if (line[i] === '[') depth++;
        else if (line[i] === ']') {
            depth--;
            if (depth === 0) {
                close = i;
                break;
            }
        }
    }
    if (close === -1) return null;
    return parseFieldList(line.slice(open + 1, close));
}

/**
 * Strip `//` line comments and `///` doc comments from a model-body
 * line so attribute parsing never trips over a `[`-bearing comment.
 * Only strips comments that begin the comment outside a string — the
 * schema never embeds `//` inside a string literal on an attribute
 * line, so a simple first-`//` cut is safe here.
 */
function stripLineComment(line: string): string {
    const idx = line.indexOf('//');
    return idx === -1 ? line : line.slice(0, idx);
}

/**
 * Locate every `model X { ... }` block in the concatenated schema by
 * balancing braces, returning `[name, bodyText]` pairs.
 */
function findModelBlocks(schema: string): { name: string; body: string }[] {
    const out: { name: string; body: string }[] = [];
    const modelRe = /^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm;
    let m: RegExpExecArray | null;
    while ((m = modelRe.exec(schema)) !== null) {
        const name = m[1];
        // The body starts right after the `{` that closed the match.
        const bodyStart = m.index + m[0].length;
        let depth = 1;
        let i = bodyStart;
        for (; i < schema.length && depth > 0; i++) {
            const ch = schema[i];
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
        }
        // `i` now points just past the closing `}`.
        const body = schema.slice(bodyStart, i - 1);
        out.push({ name, body });
        // Continue the scan past this block.
        modelRe.lastIndex = i;
    }
    return out;
}

/**
 * Parse one model body into a `SchemaModel`.
 */
function parseModelBody(name: string, body: string): SchemaModel {
    const fields: SchemaField[] = [];
    const blockIndexes: string[][] = [];
    const blockUniques: string[][] = [];
    let blockId: string[] | null = null;
    let fieldIdName: string | null = null;
    const fieldUniqueNames: string[] = [];
    const relationFkFieldGroups: string[][] = [];
    const relations: SchemaRelation[] = [];
    let tableName = name;

    const rawLines = body.split('\n');
    for (const raw of rawLines) {
        const line = stripLineComment(raw).trim();
        if (line.length === 0) continue;
        if (line === '}') continue;

        // ── Block attributes ──────────────────────────────────────
        if (line.startsWith('@@index')) {
            const list = extractFirstBracketList(line);
            if (list && list.length > 0) blockIndexes.push(list);
            continue;
        }
        if (line.startsWith('@@unique')) {
            const list = extractFirstBracketList(line);
            if (list && list.length > 0) blockUniques.push(list);
            continue;
        }
        if (line.startsWith('@@id')) {
            const list = extractFirstBracketList(line);
            if (list && list.length > 0) blockId = list;
            continue;
        }
        if (line.startsWith('@@map')) {
            const mapped = /^@@map\(\s*"([^"]+)"\s*\)/.exec(line);
            if (mapped) tableName = mapped[1];
            continue;
        }
        // Any other `@@`-attribute (`@@schema`, …) — ignore.
        if (line.startsWith('@@')) continue;

        // ── Field line ────────────────────────────────────────────
        // First two whitespace-separated tokens are name + type.
        const tokens = line.split(/\s+/);
        if (tokens.length < 2) continue;
        const fieldName = tokens[0];
        // A field name is a plain identifier — guards against stray
        // lines (block comments, braces) slipping through.
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(fieldName)) continue;
        let typeToken = tokens[1];
        const isList = typeToken.endsWith('[]');
        if (isList) typeToken = typeToken.slice(0, -2);
        const isOptional = typeToken.endsWith('?');
        if (isOptional) typeToken = typeToken.slice(0, -1);
        // The type token must itself be an identifier — otherwise the
        // "line" is not a field declaration.
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(typeToken)) continue;

        fields.push({
            name: fieldName,
            type: typeToken,
            isList,
            isOptional,
        });

        // Field-level `@id` / `@unique`. Match on word boundary so
        // `@@id` / a hypothetical `@idsomething` never false-trigger.
        if (/(^|\s)@id\b/.test(line)) fieldIdName = fieldName;
        if (/(^|\s)@unique\b/.test(line)) fieldUniqueNames.push(fieldName);

        // Relation FK list — only the side that carries `fields:`.
        const fkList = extractRelationFkList(line);
        if (fkList && fkList.length > 0) {
            relationFkFieldGroups.push(fkList);
            const action = /\bonDelete:\s*([A-Za-z]+)/.exec(line);
            relations.push({
                field: fieldName,
                target: typeToken,
                fields: fkList,
                onDelete: action ? action[1] : null,
            });
        }
    }

    const scalarFieldNames = fields.map((f) => f.name);
    const fieldNameSet = new Set(scalarFieldNames);

    return {
        name,
        tableName,
        fields,
        scalarFieldNames,
        blockIndexes,
        blockUniques,
        blockId,
        fieldIdName,
        fieldUniqueNames,
        relationFkFieldGroups,
        relations,
        hasField(fieldName: string): boolean {
            return fieldNameSet.has(fieldName);
        },
    };
}

let cached: SchemaModel[] | null = null;

/**
 * Parse every `model X { ... }` block in the concatenated Prisma
 * schema. Result is cached for the test process.
 */
export function parseSchemaModels(): SchemaModel[] {
    if (cached !== null) return cached;
    const schema = readPrismaSchema();
    cached = findModelBlocks(schema).map((b) => parseModelBody(b.name, b.body));
    return cached;
}

/**
 * The set of fields on a model that lead (are the FIRST element of)
 * some index / uniqueness construct — i.e. fields Postgres can do an
 * efficient leftmost-prefix lookup on.
 *
 * Includes:
 *   - the first field of every `@@index`, `@@unique`, `@@id`,
 *   - the field carrying a field-level `@id`,
 *   - every field carrying a field-level `@unique`.
 *
 * (A field-level `@id` / `@unique` creates a single-column index, so
 * that field is trivially the leftmost prefix of its own index.)
 */
export function leadingIndexedFields(model: SchemaModel): Set<string> {
    const out = new Set<string>();
    for (const idx of model.blockIndexes) {
        if (idx.length > 0) out.add(idx[0]);
    }
    for (const uniq of model.blockUniques) {
        if (uniq.length > 0) out.add(uniq[0]);
    }
    if (model.blockId && model.blockId.length > 0) {
        out.add(model.blockId[0]);
    }
    if (model.fieldIdName) out.add(model.fieldIdName);
    for (const f of model.fieldUniqueNames) out.add(f);
    return out;
}
