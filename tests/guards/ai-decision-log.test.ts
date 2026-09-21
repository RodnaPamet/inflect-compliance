/**
 * AI decision log — ratchet (EU AI Act Art 12 / Art 14 + AI-ops).
 *
 *   - COVERAGE: every AI provider invocation routes through the logger — a new
 *     AI call site that calls getProvider() without logAiDecision fails CI.
 *   - PRIVACY: the log stores an inputDigest (SHA-256) + sanitised summary only;
 *     no raw prompt / PII field is ever written.
 *   - IMMUTABILITY: the log is append-only (a DB trigger blocks core edits); the
 *     only mutation is the one-way humanOutcome stamp.
 *   - FEEDBACK: humanOutcome transitions PENDING → terminal via the usecase; the
 *     model carries the two tenantId-leading indexes.
 */
import * as fs from 'node:fs';
import { functionBodyOf } from '../helpers/source-blocks';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
// #2246 Class A / #2679 LANGUAGE SPLIT — comments are masked at the READ SEAM,
// and WHICH masker depends on the language of the file being read.
//
// `codeOf` lexes TypeScript. Handing it a `.sql` file is the single worst
// outcome available: every `--` comment survives verbatim while the call site
// READS as masked. Migrations therefore go through `readSql`, which lexes
// `--` and `/* */` (and nests, as Postgres does). TypeScript keeps `read`.
// Which extension flows through which helper was re-derived in this file.
import { codeOf, sqlCodeOf } from '../helpers/source-blocks';

const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const read = (rel: string) => codeOf(readRaw(rel));
const readSql = (rel: string) => sqlCodeOf(readRaw(rel));

function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel, out);
        else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) out.push(rel);
    }
    return out;
}

const LOGGER_RE = /logAiDecision\s*\(/;
// A file that imports the AI risk-assessment provider factory. Scoped to THIS
// module so we don't match the unrelated integrations `getProvider`.
const AI_PROVIDER_IMPORT_RE = /import\s*\{[^}]*\bgetProvider\b[^}]*\}\s*from\s*'@\/app-layer\/ai\/risk-assessment'/;

describe('coverage — every provider invocation logs a decision', () => {
    const sources = walk('src/app-layer').filter((f) => !f.includes('__tests__'));

    it('every AI-provider call site also calls logAiDecision()', () => {
        const offenders = sources.filter((f) => {
            const src = read(f);
            return AI_PROVIDER_IMPORT_RE.test(src) && !LOGGER_RE.test(src);
        });
        expect(offenders).toEqual([]);
    });

    it('the risk-suggestions usecase imports AND calls logAiDecision', () => {
        const src = read('src/app-layer/usecases/risk-suggestions.ts');
        expect(src).toContain("from '@/app-layer/ai/decision-log'");
        expect(LOGGER_RE.test(src)).toBe(true);
    });

    it('mutation proof — the detector flags a usecase that drops the logger', () => {
        const mutated = read('src/app-layer/usecases/risk-suggestions.ts').replace(/logAiDecision\s*\(/g, 'noop(');
        expect(AI_PROVIDER_IMPORT_RE.test(mutated) && !LOGGER_RE.test(mutated)).toBe(true);
    });
});

describe('privacy — digest + sanitised summary only', () => {
    const mod = read('src/app-layer/ai/decision-log/index.ts');

    it('the module hashes the input (SHA-256 digest), never stores it raw', () => {
        expect(mod).toContain("createHash('sha256')");
        // BOUND to the writer. `inputDigest:` at file scope now also matches
        // the digest-keyed stamp's WHERE clause, so it stopped being evidence
        // that the write persists a digest — which is the claim here.
        expect(functionBodyOf(mod, 'logAiDecision')).toContain('inputDigest:');
    });

    it('the output summary is sanitised + bounded', () => {
        expect(mod).toContain('sanitizePlainText(');
        expect(mod).toContain('SUMMARY_MAX');
    });

    it('no raw prompt / raw input column is written', () => {
        // The create-data must not carry a raw prompt field.
        expect(mod).not.toMatch(/\b(rawPrompt|rawInput|prompt)\s*:/);
    });

    it('the schema has inputDigest and no raw prompt column', () => {
        const schema = read('prisma/schema/automation.prisma');
        const model = schema.slice(schema.indexOf('model AiDecisionLog'));
        expect(model).toContain('inputDigest');
        expect(model).not.toMatch(/\brawPrompt\b|\brawInput\b/);
    });
});

describe('immutability — append-only core record', () => {
    it('a migration installs the append-only trigger', () => {
        const mig = readSql('prisma/migrations/20260703130000_ai_decision_log/migration.sql');
        expect(mig).toContain('ai_decision_log_immutable');
        expect(mig).toContain('BEFORE UPDATE ON "AiDecisionLog"');
        expect(mig).toMatch(/append-only/i);
    });

    it('the decision-log module never updates the core record — only humanOutcome', () => {
        const mod = read('src/app-layer/ai/decision-log/index.ts');

        // EVERY write-back is checked, rather than counting them.
        //
        // This asserted `updates.length === 1` until a second legitimate stamp
        // arrived — `recordDecisionOutcomeForDigest`, the same one-way
        // humanOutcome transition keyed by digest instead of session — and the
        // count went red for a change that honoured the invariant exactly. The
        // pairing was also weaker than it looked: `toMatch(/data:\s*\{\s*humanOutcome:/)`
        // is satisfied by ANY one update setting humanOutcome, so a second
        // update writing `provider` would have passed it. The count was doing
        // all the work, and a hand-maintained count of call sites stops
        // covering its subject the moment that population grows.
        //
        // What matters is that no update touches a column other than
        // humanOutcome. That is now read off each call's own `data` block, so
        // a third stamp is free and a stamp that mutates the record is not.
        const calls = [...mod.matchAll(/aiDecisionLog\.update(?:Many)?\s*\(/g)];

        // Population control: zero call sites would satisfy the loop below
        // without examining anything.
        expect(calls.length).toBeGreaterThan(0);

        const offenders: string[] = [];
        for (const call of calls) {
            const after = mod.slice(call.index ?? 0);
            const dataBlock = /data:\s*\{([^}]*)\}/.exec(after)?.[1];
            if (dataBlock === undefined) {
                offenders.push('an update with no readable `data` block');
                continue;
            }
            const keys = [...dataBlock.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((k) => k[1]);
            if (keys.join(',') !== 'humanOutcome') {
                offenders.push(`writes [${keys.join(', ')}]`);
            }
        }
        expect({ examined: calls.length, offenders }).toEqual({
            examined: calls.length,
            offenders: [],
        });
    });
});

describe('feedback + indexes', () => {
    const schema = read('prisma/schema/automation.prisma');
    const model = schema.slice(schema.indexOf('model AiDecisionLog'), schema.indexOf('model AiDecisionLog') + 2000);

    it('humanOutcome transitions PENDING → terminal via recordDecisionOutcome', () => {
        const mod = read('src/app-layer/ai/decision-log/index.ts');

        // BOUND to the declaration, not asserted against the whole file.
        //
        // `toContain('export async function recordDecisionOutcome')` was
        // satisfied by any function whose name merely STARTS with that — which
        // `recordDecisionOutcomeForDigest` does. The assertion would have
        // survived deleting the function it is named for, which is precisely
        // the Class D failure `assertion-needle-uniqueness-ratchet` counts.
        // Narrowing the read also makes the PENDING needle unique again: both
        // stamps legitimately filter on it, so at file scope it says nothing
        // about which one.
        const fn = functionBodyOf(mod, 'recordDecisionOutcome');
        expect(fn).toMatch(/humanOutcome:\s*'PENDING'/);
        expect(fn).toMatch(/data:\s*\{\s*humanOutcome: outcome\s*\}/);
    });

    it('the digest-keyed sibling makes the same one-way transition', () => {
        // The second stamp is the reason the assertion above had to be bound.
        // It gets its own, equally bound, rather than sharing a file-scope
        // needle that would then prove nothing about either.
        const mod = read('src/app-layer/ai/decision-log/index.ts');
        const fn = functionBodyOf(mod, 'recordDecisionOutcomeForDigest');
        expect(fn).toMatch(/humanOutcome:\s*'PENDING'/);
        expect(fn).toMatch(/inputDigest/);
    });

    it('AiDecisionLog carries the two tenantId-leading indexes', () => {
        expect(model).toContain('@@index([tenantId, createdAt])');
        expect(model).toContain('@@index([tenantId, aiSystemId])');
    });

    it('feedback is wired into applySession + dismissSession', () => {
        const uc = read('src/app-layer/usecases/risk-suggestions.ts');
        expect(uc).toMatch(/recordDecisionOutcome\([\s\S]*?'ACCEPTED'|recordDecisionOutcome\([\s\S]*?ACCEPTED/);
        expect(uc).toMatch(/recordDecisionOutcome\([\s\S]*?'REJECTED'/);
    });
});

describe('AGPL tripwire', () => {
    it('the decision-log feature references no AegisAI material', () => {
        expect(/aegis/i.test(read('src/app-layer/ai/decision-log/index.ts'))).toBe(false);
    });
});
