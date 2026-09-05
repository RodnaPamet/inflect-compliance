/**
 * Does this database's control catalogue match what the repo declares?
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * Nothing answered that question, and the cost was paid twice on 2026-09-05.
 *
 * Production's catalogue had diverged from the fixtures by 133 templates in one
 * direction and 237 in the other, for months, with no artifact anywhere that
 * would have shown it. And when the framework-catalog seeder began failing on
 * every deploy — a null-returning upsert against a framework whose stored
 * version differed — the app came up healthy, the deploy reported success, and
 * the only evidence was a line in a container log nobody reads. The catalogue
 * simply never arrived.
 *
 * This is the check that says so in one command.
 *
 * ═══ WHY IT DERIVES THE EXPECTATION RATHER THAN STORING ONE ═══
 *
 * The obvious design is a committed manifest of expected codes. This repo has
 * been bitten twice by exactly that shape — derived data stored beside its own
 * source — because two branches can each update a count without conflicting,
 * so git keeps one copy, both are green, and main is quietly wrong. The
 * `counts` header in doc-classification.json was deleted for this reason.
 *
 * So the expectation is computed from the fixtures at run time. It cannot go
 * stale, and there is no second number to keep in step.
 *
 *   tsx scripts/catalog-check.ts                    check $DATABASE_URL
 *   tsx scripts/catalog-check.ts --expected-only    print the expectation, no DB
 *
 * Exits 1 when the database is missing something the repo declares. Extra rows
 * in the database are REPORTED but do not fail: a catalogue may legitimately
 * carry populations this repo never declared — production carries `A-`, `AIMS-`,
 * `AISVS-` and `EUAIA-`, seeded from src/data/libraries by a different path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const FIXTURE_DIR = path.resolve(process.cwd(), 'prisma/fixtures');
const EXPECTED_ONLY = process.argv.includes('--expected-only');

interface Expectation {
    templateCodes: Set<string>;
    frameworkKeys: Set<string>;
    packKeys: Set<string>;
    byPrefix: Map<string, number>;
    authoredTasks: number;
}

/** Every template a fixture declares, across all three shipped shapes. */
function readExpectation(): Expectation {
    const templateCodes = new Set<string>();
    const frameworkKeys = new Set<string>();
    const packKeys = new Set<string>();
    const byPrefix = new Map<string, number>();
    let authoredTasks = 0;

    for (const file of fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'))) {
        let raw: unknown;
        try {
            raw = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));
        } catch {
            continue;
        }
        const obj = (raw ?? {}) as {
            controls?: unknown[];
            templates?: unknown[];
            framework?: { key?: unknown };
            pack?: { key?: unknown };
        };
        // Bare array, `{ templates }` (CatalogFile), or `{ controls }`
        // (internal-controls). Reading only one shape is how 151 templates
        // once stayed invisible to a scan that believed it covered everything.
        const list = (Array.isArray(raw) ? raw : (obj.templates ?? obj.controls ?? [])) as Array<{
            code?: unknown;
            tasks?: unknown[];
        }>;

        if (typeof obj.framework?.key === 'string') frameworkKeys.add(obj.framework.key);
        if (typeof obj.pack?.key === 'string') packKeys.add(obj.pack.key);

        for (const t of list) {
            if (typeof t?.code !== 'string') continue;
            templateCodes.add(t.code);
            const prefix = `${t.code.split('-')[0]}-`;
            byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + 1);
            if (Array.isArray(t.tasks)) authoredTasks += t.tasks.length;
        }
    }
    return { templateCodes, frameworkKeys, packKeys, byPrefix, authoredTasks };
}

function printExpectation(e: Expectation): void {
    console.log(`Repo declares ${e.templateCodes.size} templates, ${e.authoredTasks} authored tasks`);
    for (const [prefix, n] of [...e.byPrefix].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${prefix.padEnd(8)} ${String(n).padStart(4)}`);
    }
    console.log(`  frameworks declared in catalog files: ${[...e.frameworkKeys].sort().join(', ') || 'none'}`);
    console.log(`  packs declared: ${[...e.packKeys].sort().join(', ') || 'none'}`);
}

async function main(): Promise<void> {
    const expected = readExpectation();

    if (EXPECTED_ONLY) {
        printExpectation(expected);
        return;
    }

    const prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
    });

    try {
        const [templates, frameworks, packs] = await Promise.all([
            prisma.controlTemplate.findMany({ select: { code: true } }),
            prisma.framework.findMany({ select: { key: true } }),
            prisma.frameworkPack.findMany({ select: { key: true } }),
        ]);
        const live = new Set(templates.map((t) => t.code));
        const liveFw = new Set(frameworks.map((f) => f.key));
        const livePacks = new Set(packs.map((p) => p.key));

        const missing = [...expected.templateCodes].filter((c) => !live.has(c)).sort();
        const extra = [...live].filter((c) => !expected.templateCodes.has(c)).sort();
        const missingFw = [...expected.frameworkKeys].filter((k) => !liveFw.has(k)).sort();
        const missingPacks = [...expected.packKeys].filter((k) => !livePacks.has(k)).sort();

        printExpectation(expected);
        console.log(`\nDatabase has ${live.size} templates, ${liveFw.size} frameworks, ${livePacks.size} packs`);

        const group = (codes: string[]) => {
            const m = new Map<string, number>();
            for (const c of codes) {
                const p = `${c.split('-')[0]}-`;
                m.set(p, (m.get(p) ?? 0) + 1);
            }
            return [...m].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p}${n}`).join(' ');
        };

        if (extra.length) {
            // Not a failure. Production legitimately carries populations this
            // repo never declared, seeded from src/data/libraries by a
            // different path. Worth SEEING, because that is the divergence
            // nothing else reports.
            console.log(`\n  ℹ ${extra.length} template(s) present but not declared by any fixture: ${group(extra)}`);
        }
        if (missingFw.length) console.log(`\n  ✗ frameworks declared but absent: ${missingFw.join(', ')}`);
        if (missingPacks.length) console.log(`  ✗ packs declared but absent: ${missingPacks.join(', ')}`);
        if (missing.length) {
            console.log(`\n  ✗ ${missing.length} template(s) declared but ABSENT: ${group(missing)}`);
            console.log(`     first few: ${missing.slice(0, 8).join(', ')}`);
        }

        if (missing.length || missingFw.length || missingPacks.length) {
            console.log('\n❌ The database is missing catalogue content this repo declares.');
            console.log('   Most likely a seeder failed. Check the container log for');
            console.log("   '❌ Framework-catalog seed failed' or '❌ Seed failed'.");
            process.exitCode = 1;
            return;
        }
        console.log('\n✅ Every template, framework and pack this repo declares is present.');
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((err) => {
    console.error('❌ Catalog check failed:', err);
    process.exitCode = 1;
});
