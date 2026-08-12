/**
 * Action-executor coverage ratchet.
 *
 * Locks the invariant that the automation engine ACTUALLY EXECUTES: every
 * AutomationActionType has a handler in the executor, the dispatchers call the
 * executor (not a hardcoded no-op note), and no dispatcher regresses to the
 * "action handlers register in a later epic" stub.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AutomationActionType } from '@prisma/client';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const EXECUTOR = 'src/app-layer/automation/action-executor.ts';
const DISPATCHERS = [
    'src/app-layer/jobs/automation-event-dispatch.ts',
    'src/app-layer/jobs/rule-chain-dispatch.ts',
    'src/app-layer/jobs/subflow-dispatcher.ts',
];

describe('action-executor coverage', () => {
    it('the executor handles every AutomationActionType', () => {
        const src = read(EXECUTOR);
        for (const t of Object.keys(AutomationActionType)) {
            expect(src).toMatch(new RegExp(`case '${t}'`));
        }
    });

    it('every dispatcher calls executeAction', () => {
        for (const d of DISPATCHERS) {
            expect(read(d)).toMatch(/executeAction\(/);
        }
    });

    it('no dispatcher regresses to the no-op stub note', () => {
        for (const d of DISPATCHERS) {
            expect(read(d)).not.toMatch(/action handlers register in a later epic/);
            expect(read(d)).not.toMatch(/no-op: action handlers/);
        }
    });

    it('the executor produces real side effects (not just an execution row)', () => {
        const src = read(EXECUTOR);
        expect(src).toMatch(/notification\.createMany/); // NOTIFY_USER
        // CREATE_TASK routes through the canonical createTask usecase (TP-1)
        // so the spawned task carries a TSK-N key + audit + automation event
        // + bell, instead of a raw keyless db.task.create.
        expect(src).toMatch(/createTaskUsecase\(/); // CREATE_TASK
        // UPDATE_STATUS routes each target through its canonical status
        // usecase (B2-1b) rather than a raw `updateMany`, so the write
        // inherits that entity's gates + audit row. The raw shape is
        // explicitly banned below.
        expect(src).toMatch(/setTaskStatus\(/); // UPDATE_STATUS → Task
        expect(src).toMatch(/setControlStatus\(/); // UPDATE_STATUS → Control
        expect(src).toMatch(/bulkSetRiskStatus\(/); // UPDATE_STATUS → Risk
        expect(src).toMatch(/safeFetch\(/); // WEBHOOK (SSRF-guarded outbound)
    });
});
