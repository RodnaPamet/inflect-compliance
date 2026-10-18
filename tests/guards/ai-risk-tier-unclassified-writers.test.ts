/**
 * ONE thing writes the UNCLASSIFIED AI-system risk tier: the registration
 * intake (#3669, deploy 2 of 2).
 *
 * UNCLASSIFIED reached `AiRiskTier` in two deploys so that no running container
 * reads a value its client does not know. Deploy 1 (#3691) added the value,
 * taught every reader, and held `WRITERS` empty. This deploy adds the one
 * writer: `registerShadowAgent` in `usecases/agent-registration-intake.ts`,
 * which registers a shadow agent through a provisional entry nobody has
 * classified. Exactly one, and every check below points at it.
 *
 * Five things hold it, and each is checked here:
 *
 *   1. AiSystem has ONE write seam, `AiSystemRepository`. No other file calls a
 *      write delegate on it, writes it through a relation (`aiSystem: { create }`
 *      on an agent, `aiSystems: { create }` on a tenant), or carries SQL text
 *      that inserts into or updates the table, however the query is composed.
 *   2. Inside the seam the value is named in exactly two places: the `data` of
 *      `createProvisional`, which STORES it and takes no tier parameter, and the
 *      `where` of `classifyProvisional`, which moves an entry OUT of it. Every
 *      other method takes the CLASSIFIER's tier type, which has no UNCLASSIFIED
 *      member — type-level proofs below fail `npm run typecheck` if a parameter
 *      is ever widened to the column's type — and the seam's methods are a
 *      closed census, so a further write method fails here until somebody says
 *      what tier type it takes.
 *   3. `createProvisional` is referenced by exactly ONE file outside the seam:
 *      the intake, the sole entry on `WRITERS`. Any reference counts — a call,
 *      a destructure, a property read — so the store cannot be reached by an
 *      alias either.
 *   4. Every file whose CODE (comments stripped) names the value is a reader on
 *      `READERS`, with the reason it names it, or the seam. A new file that
 *      names it fails until somebody says whether it reads or writes.
 *   5. No Zod schema is built from the generated `AiRiskTier`, which carries
 *      UNCLASSIFIED: a request body validated by one would hand a writer the
 *      value without any file naming it.
 */
import { readFileSync } from 'fs';

import { repoFiles, repoRelative } from '../helpers/repo-files';
import { braceBlockAfter, callExpressionOf, codeOf } from '../helpers/source-blocks';
import type { AiSystemRepository } from '@/app-layer/repositories/AiSystemRepository';

/** Files that name UNCLASSIFIED to READ it, and why. */
const READERS: Readonly<Record<string, string>> = {
    'src/lib/eu-ai-act/classification.ts': 'defines StoredAiRiskTier and isClassifiedTier; the classifier type excludes it',
    'src/lib/eu-ai-act/tier-display.ts': 'tones it as a warning, never as MINIMAL’s neutral',
    'src/app-layer/usecases/ai-system-conformity.ts': 'refuses conformity drafting for an unclassified system with its own reason',
    'src/app/t/[tenantSlug]/(app)/risks/ai-systems/filter-defs.ts': 'offers it as its own filter value',
    'src/app/t/[tenantSlug]/(app)/risks/ai-systems/AiSystemsClient.tsx': 'counts it separately in the register summary',
    'src/app/t/[tenantSlug]/(app)/risks/ai-systems/[systemId]/AiSystemDetailClient.tsx': 'renders the not-classified line and notice',
    'src/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/OverviewTab.tsx': 'shows it as no classification, never as a tier',
    'src/app/t/[tenantSlug]/(app)/agents/[agentId]/AgentDetailClient.tsx': 'shows it as no classification, never as a tier',
};

/**
 * Files that may WRITE UNCLASSIFIED — by referencing the seam's
 * `createProvisional`, the only method that stores it. Exactly one: the
 * registration intake (#3669), which registers a shadow agent through a
 * provisional entry. Deploy 1 held this empty.
 */
const WRITERS: readonly string[] = ['src/app-layer/usecases/agent-registration-intake.ts'];

const AI_SYSTEM_SEAM = 'src/app-layer/repositories/AiSystemRepository.ts';

/**
 * The quoted value, an enum member access, or an object key — not an
 * identifier that merely contains the word.
 */
export function namesUnclassified(code: string): boolean {
    return /(['"`])UNCLASSIFIED\1|\.UNCLASSIFIED\b|(?<![\w.$])UNCLASSIFIED\s*:/.test(code);
}

export function writesAiSystem(code: string): string[] {
    const out: string[] = [];
    const delegate = /\baiSystem\s*\.\s*(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = delegate.exec(code)) !== null) out.push(`aiSystem.${m[1]}(`);
    // A nested write through either relation that reaches the model. The
    // operation must sit directly inside the relation's object, so a read
    // shaped `aiSystem: { select: { … } }` is not mistaken for one.
    const nested = /\b(aiSystems?)\s*:\s*\{[^{}]*?\b(create|createMany|connectOrCreate|upsert|update|updateMany)\s*:/g;
    while ((m = nested.exec(code)) !== null) out.push(`${m[1]}: { ${m[2]} }`);
    // The SQL text itself, wherever it is built — inline in `$executeRaw`, in
    // a `Prisma.sql` fragment passed in later, or in a plain string.
    const raw = /\b(INSERT\s+INTO|UPDATE)\s+(?:"public"\s*\.\s*)?"AiSystem"(?=[\s(]|$)/gi;
    while ((m = raw.exec(code)) !== null) out.push(`raw ${m[1].replace(/\s+/g, ' ').toUpperCase()} "AiSystem"`);
    return out;
}

/** Any reference to the provisional store, in any form: call, destructure or property read. */
export function referencesProvisionalStore(code: string): boolean {
    return /\bcreateProvisional\b/.test(code);
}

/** A Zod schema built from an enum object that carries every stored tier. */
export function widensTierSchema(code: string): boolean {
    return /\bz\s*\.\s*(?:nativeEnum|enum)\s*\(\s*(?:Object\s*\.\s*values\s*\(\s*)?(?:\$Enums\s*\.\s*|Prisma\s*\.\s*)?AiRiskTier\b/.test(code);
}

/** The static methods the seam declares, each with what it does to the tier. */
const SEAM_METHODS: Readonly<Record<string, string>> = {
    list: 'reads; its riskTier filter is a query-string value parsed against the stored tiers',
    getById: 'reads',
    create: 'writes; takes the classifier’s tier type, proved below',
    createProvisional: 'writes UNCLASSIFIED — the only method that stores it; takes no tier, proved below; one caller',
    classifyProvisional: 'writes; takes the classifier’s tier type, proved below; matches only an UNCLASSIFIED entry',
    linkRequirements: 'writes requirement links only; takes no tier',
};

export function staticMethodsOf(code: string): string[] {
    return [...code.matchAll(/^\s*static\s+(?:async\s+)?(\w+)\s*[(<]/gm)].map((m) => m[1]);
}

describe('exactly one file writes UNCLASSIFIED to an AI system', () => {
    const files = repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] });
    const scanned = files.map((abs) => {
        const code = codeOf(readFileSync(abs, 'utf8'));
        return {
            rel: repoRelative(abs),
            names: namesUnclassified(code),
            writes: writesAiSystem(code),
            store: referencesProvisionalStore(code),
        };
    });
    const seamAbs = files.find((abs) => repoRelative(abs) === AI_SYSTEM_SEAM);
    const seamSrc = seamAbs ? readFileSync(seamAbs, 'utf8') : '';
    const storeMethod = () => braceBlockAfter(seamSrc, '\\bstatic\\s+async\\s+createProvisional\\b');
    const classifyMethod = () => braceBlockAfter(seamSrc, '\\bstatic\\s+async\\s+classifyProvisional\\b');

    it('scans the tree', () => {
        expect(files.length).toBeGreaterThan(500);
        expect(seamAbs).toBeDefined();
    });

    it('AiSystem has one write seam', () => {
        expect(scanned.filter((s) => s.writes.length > 0).map((s) => s.rel)).toEqual([AI_SYSTEM_SEAM]);
    });

    it('the seam stores the value in the data of createProvisional’s insert', () => {
        // The insert's own `data`, not the method's `data` parameter, whose
        // type literal comes first in the method text.
        const insert = callExpressionOf(storeMethod(), 'aiSystem\\s*\\.\\s*create');
        const data = braceBlockAfter(insert, '\\bdata\\s*:');
        expect(data).toMatch(/riskTier\s*:\s*'UNCLASSIFIED'/);
    });

    it('classifyProvisional names the value only in its WHERE — it moves an entry out, never in', () => {
        const body = classifyMethod();
        const where = braceBlockAfter(body, '\\bwhere\\s*:');
        expect(namesUnclassified(where)).toBe(true);
        expect(namesUnclassified(body.replace(where, ''))).toBe(false);
    });

    it('no other part of the seam names the value', () => {
        const rest = codeOf(seamSrc).replace(codeOf(storeMethod()), '').replace(codeOf(classifyMethod()), '');
        // Non-vacuous: the two methods really were cut out of the text.
        expect(referencesProvisionalStore(rest)).toBe(false);
        expect(namesUnclassified(rest)).toBe(false);
    });

    it('the provisional store is referenced by the seam and by exactly the one listed writer', () => {
        expect(scanned.filter((s) => s.store).map((s) => s.rel).sort()).toEqual([AI_SYSTEM_SEAM, ...WRITERS].sort());
    });

    it('has exactly one writer, the registration intake', () => {
        expect(WRITERS).toEqual(['src/app-layer/usecases/agent-registration-intake.ts']);
    });

    it('every file that names the value is a listed reader or the seam, and every listed reader is live', () => {
        const naming = scanned.filter((s) => s.names).map((s) => s.rel).sort();
        expect(naming).toEqual([...Object.keys(READERS), AI_SYSTEM_SEAM].sort());
    });

    it('no listed reader, and not the writer, writes an AI system or reaches the store', () => {
        const offenders = scanned
            .filter((s) => s.rel in READERS && (s.writes.length > 0 || s.store))
            .map((s) => s.rel);
        expect(offenders).toEqual([]);
        expect(scanned.find((s) => s.rel === WRITERS[0])?.writes).toEqual([]);
    });

    it('no Zod schema is built from the generated tier enum', () => {
        const widening = files
            .filter((abs) => widensTierSchema(codeOf(readFileSync(abs, 'utf8'))))
            .map((abs) => repoRelative(abs));
        expect(widening).toEqual([]);
    });

    it('the seam declares exactly the methods classified above', () => {
        const declared = staticMethodsOf(codeOf(seamSrc));
        expect(declared.sort()).toEqual(Object.keys(SEAM_METHODS).sort());
    });
});

describe('only the provisional store can hold it, by type', () => {
    // Enforced by `npm run typecheck`, which covers tests/: if `create`'s tier
    // parameter ever admits 'UNCLASSIFIED', `Proof` is `never` and the
    // assignment below fails to compile. The runtime assertions only keep the
    // bindings used.
    type CreateTier = Parameters<typeof AiSystemRepository.create>[2]['riskTier'];
    type Proof = 'UNCLASSIFIED' extends CreateTier ? never : true;
    const proof: Proof = true;

    // The classify writes a tier, and it is the classifier's: it moves an entry
    // OUT of UNCLASSIFIED and could not move one back.
    type ClassifyTier = Parameters<typeof AiSystemRepository.classifyProvisional>[3]['riskTier'];
    type ClassifyProof = 'UNCLASSIFIED' extends ClassifyTier ? never : true;
    const classifyProof: ClassifyProof = true;

    // The store takes NO tier: the value is fixed in its body, so no caller can
    // choose one. Should its data gain a `riskTier`, this is `never`.
    type StoreData = Parameters<typeof AiSystemRepository.createProvisional>[2];
    type StoreTakesNoTier = Extract<StoreData, { riskTier?: unknown }> extends never ? true : never;
    const storeTakesNoTier: StoreTakesNoTier = true;

    // `linkRequirements` writes, but not the tier: none of its parameters has a
    // `riskTier` member. Should one gain it, this is `never` and fails too.
    type LinkParams = Parameters<typeof AiSystemRepository.linkRequirements>[number];
    type NoTier = Extract<LinkParams, { riskTier?: unknown }> extends never ? true : never;
    const noTier: NoTier = true;

    it('AiSystemRepository.create takes a classified tier only', () => {
        expect(proof).toBe(true);
    });

    it('AiSystemRepository.classifyProvisional takes a classified tier only', () => {
        expect(classifyProof).toBe(true);
    });

    it('AiSystemRepository.createProvisional takes no tier at all', () => {
        expect(storeTakesNoTier).toBe(true);
    });

    it('AiSystemRepository.linkRequirements takes no tier at all', () => {
        expect(noTier).toBe(true);
    });
});

describe('the detectors are not vacuous', () => {
    it('names: the literal, an enum member and an object key, not an identifier containing the word', () => {
        expect(namesUnclassified(`riskTier: 'UNCLASSIFIED'`)).toBe(true);
        expect(namesUnclassified('AiRiskTier.UNCLASSIFIED')).toBe(true);
        expect(namesUnclassified(`{ UNCLASSIFIED: 'warning' }`)).toBe(true);
        expect(namesUnclassified('UNCLASSIFIED_FRAMEWORK_KEY')).toBe(false);
        expect(namesUnclassified('frameworkKey: UNCLASSIFIED_FRAMEWORK_KEY,')).toBe(false);
    });

    it('writes: a delegate on any receiver, and raw SQL', () => {
        expect(writesAiSystem('await tx.aiSystem.update({ data })')).toEqual(['aiSystem.update(']);
        expect(writesAiSystem('await prisma.$executeRawUnsafe(`UPDATE "AiSystem" SET x = 1`)')).toEqual(['raw UPDATE "AiSystem"']);
        expect(writesAiSystem('await db.aiSystem.findMany({})')).toEqual([]);
    });

    it('writes: a nested write through either relation, but not a nested read', () => {
        expect(writesAiSystem('tx.registeredAgent.create({ data: { aiSystem: { create: { riskTier: t } } } })'))
            .toEqual(['aiSystem: { create }']);
        expect(writesAiSystem('tenant.update({ data: { aiSystems: { createMany: { data: rows } } } })'))
            .toEqual(['aiSystems: { createMany }']);
        expect(writesAiSystem('agent.update({ data: { aiSystem: { connectOrCreate: { where, create } } } })'))
            .toEqual(['aiSystem: { connectOrCreate }']);
        expect(writesAiSystem('findFirst({ select: { aiSystem: { select: { id: true, riskTier: true } } } })')).toEqual([]);
        expect(writesAiSystem('findMany({ include: { aiSystem: true }, where: { aiSystem: { riskTier: t } } })')).toEqual([]);
        expect(writesAiSystem('registeredAgent.create({ data: { aiSystem: { connect: { id } } } })')).toEqual([]);
    });

    it('writes: SQL text composed before it reaches the client', () => {
        expect(writesAiSystem('const q = Prisma.sql`UPDATE "AiSystem" SET "riskTier" = ${t}`; await db.$executeRaw(q);'))
            .toEqual(['raw UPDATE "AiSystem"']);
        expect(writesAiSystem(`const q = 'insert into "public"."AiSystem" ("id") values ($1)';`)).toEqual(['raw INSERT INTO "AiSystem"']);
        expect(writesAiSystem('SELECT * FROM "AiSystem"')).toEqual([]);
        expect(writesAiSystem('UPDATE "AiSystemRequirementLink" SET x = 1')).toEqual([]);
    });

    it('widens: a Zod schema over the generated enum, however it is spelled', () => {
        expect(widensTierSchema('z.nativeEnum(AiRiskTier)')).toBe(true);
        expect(widensTierSchema('z.enum(AiRiskTier)')).toBe(true);
        expect(widensTierSchema('z.enum(Object.values(AiRiskTier) as [string])')).toBe(true);
        expect(widensTierSchema('z.nativeEnum($Enums.AiRiskTier)')).toBe(true);
        expect(widensTierSchema("z.enum(['HIGH', 'LIMITED'])")).toBe(false);
        expect(widensTierSchema('parseEnumListFilter<AiRiskTier>(v, Object.values(AiRiskTier))')).toBe(false);
    });

    it('store: any reference to the provisional create, not a longer identifier', () => {
        expect(referencesProvisionalStore('await AiSystemRepository.createProvisional(db, ctx, data)')).toBe(true);
        expect(referencesProvisionalStore('const { createProvisional: make } = AiSystemRepository;')).toBe(true);
        expect(referencesProvisionalStore("AiSystemRepository['createProvisional']")).toBe(true);
        expect(referencesProvisionalStore('createProvisionalDraft(x)')).toBe(false);
        expect(referencesProvisionalStore('AiSystemRepository.create(db, ctx, data)')).toBe(false);
    });

    it('methods: the static methods a class body declares', () => {
        expect(staticMethodsOf('class R {\n    static async list(\n    static getById(db) {}\n    static async create<T>(\n}')).toEqual(['list', 'getById', 'create']);
    });
});
