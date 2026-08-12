/**
 * Guardrail — every task-creation call site passes a VALID TaskSource.
 *
 * The KRI-breach + risk-appetite spawners shipped with invalid free
 * strings (`'kri_breach'` / `'risk_appetite_breach'`) that are not
 * `TaskSource` enum members: one was swallowed in a try/catch (task
 * silently never created), the other threw a 500. The repo now validates
 * `source` at the write boundary (`normalizeWorkItemSource`), and this
 * structural ratchet stops a new caller from re-introducing a bogus
 * literal — a `source: '<literal>'` on any `createTask(...)` /
 * `db.task.create(...)` / `prisma.task.create(...)` call must be a real
 * enum member.
 *
 * String-literal sources only: a `source:` bound to a variable/expression
 * can't be checked statically and is validated at runtime by
 * `normalizeWorkItemSource` instead.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

/** Parse the TaskSource enum members from the live Prisma schema. */
function validSources(): Set<string> {
    const enums = fs.readFileSync(path.join(ROOT, 'prisma/schema/enums.prisma'), 'utf8');
    const m = enums.match(/enum TaskSource\s*\{([^}]+)\}/);
    if (!m) throw new Error('TaskSource enum not found in enums.prisma');
    const members = m[1]
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, '').trim())
        .filter((l) => /^[A-Z_]+$/.test(l));
    return new Set(members);
}

/** Recursively collect .ts files under a dir (skip tests / generated). */
function walk(dir: string, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (['__tests__', '__mocks__', 'node_modules'].includes(entry.name)) continue;
            walk(full, acc);
        } else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
            acc.push(full);
        }
    }
    return acc;
}

// A task-creation call: the canonical usecase or a raw Prisma create.
const CREATE_CALL = /(?:createTask\s*\(|\.task\.create(?:Many)?\s*\()/g;

describe('Guardrail: valid TaskSource at every task-creation call site', () => {
    const valid = validSources();
    const files = walk(path.join(ROOT, 'src/app-layer'));

    it('parses a non-trivial TaskSource enum', () => {
        expect(valid.size).toBeGreaterThanOrEqual(6);
        expect(valid.has('MANUAL')).toBe(true);
        expect(valid.has('RISK_MONITOR')).toBe(true);
    });

    it('every literal `source:` on a task-create call is a real enum member', () => {
        const violations: string[] = [];
        for (const file of files) {
            const src = fs.readFileSync(file, 'utf8');
            let call: RegExpExecArray | null;
            CREATE_CALL.lastIndex = 0;
            while ((call = CREATE_CALL.exec(src)) !== null) {
                // Scan the object literal that follows the call opener.
                const window = src.slice(call.index, call.index + 900);
                const sourceMatch = window.match(/\bsource:\s*['"]([^'"]+)['"]/);
                if (!sourceMatch) continue; // no literal source (variable or omitted)
                const literal = sourceMatch[1];
                if (!valid.has(literal)) {
                    const line = src.slice(0, call.index).split('\n').length;
                    violations.push(
                        `${path.relative(ROOT, file)}:${line} — source: '${literal}' is not a TaskSource member`,
                    );
                }
            }
        }
        if (violations.length) {
            throw new Error(
                `Invalid TaskSource literal(s) at task-creation call site(s):\n${violations.join('\n')}\n\n` +
                    `Valid members: ${[...valid].join(', ')}. Map the spawn to a real member ` +
                    `(add one to enums.prisma if a distinct provenance is warranted).`,
            );
        }
    });
});
