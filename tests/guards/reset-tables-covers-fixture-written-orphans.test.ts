import fs from 'node:fs';

import { repoFiles, repoRelative } from '../helpers/repo-files';

/**
 * `resetDatabase` truncates a HAND-MAINTAINED list, and the list goes stale
 * silently.
 *
 * `Tenant` and `User` deliberately survive a reset so fixtures can, so every
 * model whose only parent is one of them is outside the `TRUNCATE ... CASCADE`
 * closure and has to be named in `RESET_TABLES` explicitly. Nothing enforced
 * that, and the failure mode is nasty: the suite that leaves rows behind still
 * passes, and the NEXT run of it fails on a unique constraint.
 *
 * CI is not immune to it, which is the part worth being clear about: the Test
 * shards run `jest --runInBand`, so they stay on the shared base DB and a
 * leaked row outlives the suite that made it. A new database per run stops it
 * accumulating ACROSS runs; within a shard, what keeps CI green is only that
 * no two suites collide on the same unique key, and `--shard=K/N` re-groups
 * files as they are added.
 *
 * It has now happened three times — `TenantMembership` and
 * `IntegrationConnection` (#3597), then `Employee` (#3801).
 *
 * ## What this guard does and does not claim
 *
 * It does not claim every model outside the closure must be reset: 64 are, and
 * most are never written by a test at all. The population it holds to account
 * is the intersection that can actually leak — outside the closure AND created
 * by a suite that calls `resetDatabase`. That is 22 models.
 *
 * Of those, 19 are still unreset. They are listed below rather than fixed,
 * because each addition is a behavioural change for the suites that create the
 * row (#3597's own note works through the argument) and bulk-adding them blind
 * across 88 suites is not a safe edit. They are tracked in #3804.
 *
 * So the rule is: that intersection is either reset or on the list below. A
 * NEW one is neither, and fails here — which is the property the three
 * incidents above all needed and none of them had.
 */

/** `relations ⊆ {Tenant, User, self}` — a self-relation is not a parent. */
const CLOSURE_ROOTS = new Set(['Tenant', 'User']);

/**
 * Outside the closure, created by a resetting suite, and NOT truncated.
 *
 * Every entry is a latent #3801. Removing one requires adding it to
 * `RESET_TABLES` with the safety measurement #3597 and #3801 both record, not
 * deleting the line. Tracked in #3804.
 */
const KNOWN_UNRESET: readonly string[] = [
    'AgentKillSwitch',
    'AgentKillSwitchDrill',
    'AiSystem',
    'AuditWorkpaper',
    'ExternalToolParameterSet',
    'ExternalToolPriorStateRead',
    'IdentityDepartmentGroupRule',
    'McpToolManifestPin',
    'PreHire',
    'ProcessMap',
    'ReportTemplate',
    'RiskSuggestionSession',
    'ScannerRun',
    'TenantCustomRole',
    'TenantInvite',
    'TenantNotificationSettings',
    'TenantSecuritySettings',
    'TrainingCourse',
    'UserCalendarConnection',
];

function read(abs: string): string {
    return fs.readFileSync(abs, 'utf8');
}

/** Every `model X { ... }` in the split schema, body included. */
function schemaModels(): Map<string, string> {
    const out = new Map<string, string>();
    for (const abs of repoFiles({ under: 'prisma/schema', extensions: ['.prisma'] })) {
        const src = read(abs);
        const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) out.set(m[1], m[2]);
    }
    return out;
}

/** Models whose every `@relation` field points at `Tenant`, `User` or itself. */
function outsideCascadeClosure(): Set<string> {
    const out = new Set<string>();
    for (const [name, body] of schemaModels()) {
        const targets = new Set(
            [...body.matchAll(/^\s+\w+\s+(\w+)(?:\?|\[\])?\s+@relation/gm)].map((m) => m[1]),
        );
        if (targets.size === 0) continue;
        if ([...targets].every((t) => CLOSURE_ROOTS.has(t) || t === name)) out.add(name);
    }
    return out;
}

/** The names in the `RESET_TABLES` array literal, comments stripped. */
function resetTables(): string[] {
    const src = read(repoFiles({ under: 'tests/helpers' }).find((f) => f.endsWith('/db.ts'))!);
    const body = /export const RESET_TABLES[^=]*=\s*\[([\s\S]*?)\];/.exec(src);
    expect(body).not.toBeNull();
    // Comments first: the block carries prose naming tables it does not list.
    return [...body![1].replace(/\/\/[^\n]*/g, '').matchAll(/'(\w+)'/g)].map((m) => m[1]);
}

/**
 * Models a `resetDatabase`-calling suite creates, mapped to the suites.
 *
 * Prisma's client property is the model name with a lowercased first
 * character and nothing else, so the mapping back is exact.
 */
function createdByResettingSuites(): Map<string, string[]> {
    const models = new Set(schemaModels().keys());
    const out = new Map<string, string[]>();
    for (const abs of repoFiles({ under: 'tests', extensions: ['.ts', '.tsx'] })) {
        const src = read(abs);
        if (!/\bresetDatabase\b/.test(src)) continue;
        for (const m of src.matchAll(/\.(\w+)\.(?:create|createMany|upsert)\(/g)) {
            const name = m[1][0].toUpperCase() + m[1].slice(1);
            if (!models.has(name)) continue;
            const at = out.get(name) ?? [];
            at.push(repoRelative(abs));
            out.set(name, at);
        }
    }
    return out;
}

/** The population: can leak, because it is written and is not in the closure. */
function canLeak(): Map<string, string[]> {
    const outside = outsideCascadeClosure();
    return new Map([...createdByResettingSuites()].filter(([name]) => outside.has(name)));
}

describe('RESET_TABLES covers the models a fixture can leak', () => {
    it('resets every fixture-written model outside the cascade closure, or lists it', () => {
        const reset = new Set(resetTables());
        const allowed = new Set(KNOWN_UNRESET);
        const unaccounted = [...canLeak()]
            .filter(([name]) => !reset.has(name) && !allowed.has(name))
            .map(([name, suites]) => `${name} (created by ${suites.length} suite(s), e.g. ${suites[0]})`);

        expect(unaccounted).toEqual([]);
    });

    it('keeps Employee reset, which is what #3801 was', () => {
        // The positive control for the detector AND the regression lock. If the
        // scan below ever stops seeing Employee the guard has gone blind, and
        // the assertion after it is what #3801 actually fixed.
        expect([...canLeak().keys()]).toContain('Employee');
        expect(resetTables()).toContain('Employee');
    });

    it('holds no stale allowances', () => {
        const leaking = canLeak();
        const reset = new Set(resetTables());
        const stale = KNOWN_UNRESET.filter((name) => !leaking.has(name) || reset.has(name)).map(
            (name) =>
                reset.has(name)
                    ? `${name} is reset now — delete the allowance`
                    : `${name} is no longer created by a resetting suite — delete the allowance`,
        );

        expect(stale).toEqual([]);
    });

    it('scans a population big enough to be the real one', () => {
        // Every number here is a parse away from zero, and an empty population
        // passes the rule above vacuously. Measured 2026-10-20: 256 models, 64
        // outside the closure, 88 resetting suites, 22 that can leak, 25 reset.
        expect(schemaModels().size).toBeGreaterThan(200);
        expect(outsideCascadeClosure().size).toBeGreaterThan(50);
        expect(canLeak().size).toBeGreaterThan(18);
        expect(resetTables().length).toBeGreaterThan(20);
    });
});
