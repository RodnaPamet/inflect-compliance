/**
 * Nothing writes the UNCLASSIFIED AI-system risk tier yet (#3691, deploy 1 of 2).
 *
 * UNCLASSIFIED reaches `AiRiskTier` in two deploys so that no running container
 * reads a value its client does not know. In THIS deploy the value exists and
 * every reader handles it, and nothing may write it. The registration intake
 * (#3669) is deploy 2: it becomes the one writer, and it is added to `WRITERS`
 * below in the same pull request. Until then `WRITERS` is empty, and that
 * emptiness is the property.
 *
 * Three things hold it, and each is checked here:
 *
 *   1. AiSystem has ONE write seam, `AiSystemRepository`. No other file calls a
 *      write delegate on it, writes it through a relation (`aiSystem: { create }`
 *      on an agent, `aiSystems: { create }` on a tenant), or carries SQL text
 *      that inserts into or updates the table, however the query is composed.
 *   2. That seam's `create` takes the CLASSIFIER's tier type, which has no
 *      UNCLASSIFIED member. A type-level proof below fails `npm run typecheck`
 *      if the parameter is ever widened to the column's type, and the seam's
 *      methods are a closed census, so a second write method fails here until
 *      somebody says what tier type it takes.
 *   3. Every file whose CODE (comments stripped) names the value is a reader on
 *      `READERS`, with the reason it names it. A new file that names it fails
 *      until somebody says whether it reads or writes.
 *   4. No Zod schema is built from the generated `AiRiskTier`, which carries
 *      UNCLASSIFIED: a request body validated by one would hand a writer the
 *      value without any file naming it.
 */
import { readFileSync } from 'fs';

import { repoFiles, repoRelative } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';
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

/** Files that may WRITE UNCLASSIFIED. Empty in deploy 1; #3669 adds the intake. */
const WRITERS: readonly string[] = [];

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

/** A Zod schema built from an enum object that carries every stored tier. */
export function widensTierSchema(code: string): boolean {
    return /\bz\s*\.\s*(?:nativeEnum|enum)\s*\(\s*(?:Object\s*\.\s*values\s*\(\s*)?(?:\$Enums\s*\.\s*|Prisma\s*\.\s*)?AiRiskTier\b/.test(code);
}

/** The static methods the seam declares, each with what it does to the tier. */
const SEAM_METHODS: Readonly<Record<string, string>> = {
    list: 'reads; its riskTier filter is a query-string value parsed against the stored tiers',
    getById: 'reads',
    create: 'writes; takes the classifier’s tier type, proved below',
    linkRequirements: 'writes requirement links only; takes no tier',
};

export function staticMethodsOf(code: string): string[] {
    return [...code.matchAll(/^\s*static\s+(?:async\s+)?(\w+)\s*[(<]/gm)].map((m) => m[1]);
}

describe('nothing writes UNCLASSIFIED to an AI system in deploy 1', () => {
    const files = repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] });
    const scanned = files.map((abs) => {
        const code = codeOf(readFileSync(abs, 'utf8'));
        return { rel: repoRelative(abs), names: namesUnclassified(code), writes: writesAiSystem(code) };
    });

    it('scans the tree', () => {
        expect(files.length).toBeGreaterThan(500);
    });

    it('AiSystem has one write seam, and it does not name UNCLASSIFIED', () => {
        expect(scanned.filter((s) => s.writes.length > 0).map((s) => s.rel)).toEqual([AI_SYSTEM_SEAM]);
        expect(scanned.find((s) => s.rel === AI_SYSTEM_SEAM)?.names).toBe(false);
    });

    it('every file that names the value is a listed reader or a listed writer, and every listing is live', () => {
        const naming = scanned.filter((s) => s.names).map((s) => s.rel).sort();
        expect(naming).toEqual([...Object.keys(READERS), ...WRITERS].sort());
    });

    it('no listed reader writes an AI system', () => {
        const readerWrites = scanned.filter((s) => s.rel in READERS && s.writes.length > 0).map((s) => s.rel);
        expect(readerWrites).toEqual([]);
    });

    it('has no writer in this deploy', () => {
        expect(WRITERS).toEqual([]);
    });

    it('no Zod schema is built from the generated tier enum', () => {
        const widening = files
            .filter((abs) => widensTierSchema(codeOf(readFileSync(abs, 'utf8'))))
            .map((abs) => repoRelative(abs));
        expect(widening).toEqual([]);
    });

    it('the seam declares exactly the methods classified above', () => {
        const seam = files.find((abs) => repoRelative(abs) === AI_SYSTEM_SEAM);
        expect(seam).toBeDefined();
        const declared = staticMethodsOf(codeOf(readFileSync(seam!, 'utf8')));
        expect(declared.sort()).toEqual(Object.keys(SEAM_METHODS).sort());
    });
});

describe('the one writer cannot store it, by type', () => {
    // Enforced by `npm run typecheck`, which covers tests/: if `create`'s tier
    // parameter ever admits 'UNCLASSIFIED', `Proof` is `never` and the
    // assignment below fails to compile. The runtime assertion only keeps the
    // binding used.
    type CreateTier = Parameters<typeof AiSystemRepository.create>[2]['riskTier'];
    type Proof = 'UNCLASSIFIED' extends CreateTier ? never : true;
    const proof: Proof = true;

    // `linkRequirements` writes, but not the tier: none of its parameters has a
    // `riskTier` member. Should one gain it, this is `never` and fails too.
    type LinkParams = Parameters<typeof AiSystemRepository.linkRequirements>[number];
    type NoTier = Extract<LinkParams, { riskTier?: unknown }> extends never ? true : never;
    const noTier: NoTier = true;

    it('AiSystemRepository.create takes a classified tier only', () => {
        expect(proof).toBe(true);
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

    it('methods: the static methods a class body declares', () => {
        expect(staticMethodsOf('class R {\n    static async list(\n    static getById(db) {}\n    static async create<T>(\n}')).toEqual(['list', 'getById', 'create']);
    });
});
