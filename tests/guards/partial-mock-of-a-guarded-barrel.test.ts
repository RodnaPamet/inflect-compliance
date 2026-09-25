/**
 * Barrels that must not be mocked as a SUBSET, and a count that can only fall
 * (#2897).
 *
 * ═══ WHY A DECLARED LIST RATHER THAN EVERY BARREL ═══
 *
 * Measured across `tests/`: 934 factories partially mock a module with five or
 * more value exports. Almost all of them are correct — stubbing one function of
 * a 62-export barrel is the ordinary reason to reach for `jest.mock`. A ratchet
 * pinned to 934 would force churn through mostly-fine fixtures and teach people
 * to route around it.
 *
 * What makes a partial mock DANGEROUS is not its arithmetic, it is what the
 * omitted export does. So the population is declared, each entry with the
 * reason it earns a place, and it grows when a barrel demonstrates the failure
 * rather than when it crosses a threshold.
 *
 * Migrate an entry with `strictMock` (`tests/helpers/strict-mock.ts`), which
 * turns the omission into an error naming the module and the export, or by
 * spreading `requireActual` where the real implementation is genuinely wanted.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    mockFactoriesIn,
    resolveAliasedModule,
    valueExportsOf,
} from '../helpers/mock-surface';

const ROOT = path.resolve(__dirname, '../..');

interface GuardedBarrel {
    readonly reason: string;
    /** Current count. MAY FALL, NEVER RISE. */
    readonly cap: number;
}

const GUARDED_BARRELS: Readonly<Record<string, GuardedBarrel>> = {
    '@/lib/audit': {
        reason:
            're-exports `appendAuditEntryOrQueue`, the no-silent-drop wrapper (#2657). A factory ' +
            'supplying only `logEvent` resolves that wrapper to undefined, so the call that was ' +
            'supposed to guarantee an audit row silently does nothing and every assertion in the ' +
            'test still passes.',
        cap: 57,
    },
};

/** Test files that name the barrel at all — the only ones worth parsing. */
function testsMentioning(moduleId: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.test\.tsx?$/.test(e.name) && fs.readFileSync(p, 'utf8').includes(moduleId)) {
                out.push(p);
            }
        }
    };
    walk(path.join(ROOT, 'tests'));
    return out;
}

function partialMocksOf(moduleId: string): string[] {
    const real = resolveAliasedModule(ROOT, moduleId);
    if (!real) throw new Error(`guarded barrel ${moduleId} does not resolve to repo source`);
    const exports = valueExportsOf(real);
    const offenders: string[] = [];
    for (const file of testsMentioning(moduleId)) {
        for (const f of mockFactoriesIn(file)) {
            if (f.moduleId !== moduleId) continue;
            if (f.defersToReal || f.keys === null) continue;
            const missing = [...exports].filter((k) => !f.keys!.has(k));
            if (missing.length > 0) offenders.push(path.relative(ROOT, file));
        }
    }
    return offenders;
}

describe('a guarded barrel is not mocked as a subset', () => {
    it('the list is real: every entry resolves and is actually a barrel', () => {
        // A guarded module that does not resolve, or that exports almost
        // nothing, would make its ratchet vacuously satisfiable.
        expect(Object.keys(GUARDED_BARRELS).length).toBeGreaterThan(0);
        for (const id of Object.keys(GUARDED_BARRELS)) {
            const real = resolveAliasedModule(ROOT, id);
            expect(real).not.toBeNull();
            expect(valueExportsOf(real as string).size).toBeGreaterThanOrEqual(5);
        }
    });

    it('every entry states why it is guarded', () => {
        for (const [id, g] of Object.entries(GUARDED_BARRELS)) {
            expect(g.reason.length).toBeGreaterThan(60);
            expect(g.cap).toBeGreaterThanOrEqual(0);
            expect(id.startsWith('@/')).toBe(true);
        }
    });

    it('the scan can see the population it is counting', () => {
        // The denominator. Without it a broken parser reports zero offenders
        // and the ratchet passes by seeing nothing at all.
        for (const id of Object.keys(GUARDED_BARRELS)) {
            expect(testsMentioning(id).length).toBeGreaterThan(0);
        }
    });

    it.each(Object.keys(GUARDED_BARRELS))('%s stays at or below its cap', (id) => {
        const offenders = partialMocksOf(id);
        const { cap } = GUARDED_BARRELS[id];

        if (offenders.length > cap) {
            throw new Error(
                `${offenders.length} test files mock '${id}' as a subset; the cap is ${cap}. ` +
                    `${GUARDED_BARRELS[id].reason}\n` +
                    `Use strictMock (tests/helpers/strict-mock.ts) or spread requireActual.\n` +
                    `Newest offenders:\n  ${offenders.slice(0, 5).join('\n  ')}`,
            );
        }
        expect(offenders.length).toBeLessThanOrEqual(cap);
    });

    it('the cap tracks reality, so a migration lowers it', () => {
        // A cap far above the real count is a ratchet that has stopped
        // ratcheting: it would absorb new offenders silently. Kept within
        // five so the next migration has to move the number.
        for (const id of Object.keys(GUARDED_BARRELS)) {
            const actual = partialMocksOf(id).length;
            expect(GUARDED_BARRELS[id].cap - actual).toBeLessThanOrEqual(5);
        }
    });
});
