/**
 * Automation Epic 7 — structural ratchet for chained rules.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('Automation Epic 7 — multi-step chained rules', () => {
    it('schema carries the chain fields + lineage', () => {
        const src = read('prisma/schema/automation.prisma');
        expect(src).toMatch(/nextRuleId/);
        expect(src).toMatch(/nextRuleDelay/);
        expect(src).toMatch(/parentExecutionId/);
        expect(src).toMatch(/"RuleChain"/);
    });

    it('the chain-dispatch job exists + is registered', () => {
        expect(exists('src/app-layer/jobs/rule-chain-dispatch.ts')).toBe(true);
        const job = read('src/app-layer/jobs/rule-chain-dispatch.ts');
        expect(job).toMatch(/parentExecutionId/);
        expect(job).toMatch(/MAX_CHAIN_DEPTH/);
        expect(read('src/app-layer/jobs/executor-registry.ts')).toMatch(
            /register\('rule-chain-dispatch'/,
        );
    });

    it('the dispatcher enqueues the next rule on success', () => {
        const src = read('src/app-layer/jobs/automation-event-dispatch.ts');
        expect(src).toMatch(/rule\.nextRuleId/);
        expect(src).toMatch(/'rule-chain-dispatch'/);
    });

    it('the usecase guards against chain cycles', () => {
        const src = read('src/app-layer/usecases/automation-rules.ts');
        expect(src).toMatch(/followChainHasCycle/);
        expect(src).toMatch(/cycle/i);
    });

    it('the builder exposes a chain-to-next-rule field', () => {
        expect(read('src/components/processes/RuleBuilderModal.tsx')).toMatch(/nextRuleId/);
    });
});
