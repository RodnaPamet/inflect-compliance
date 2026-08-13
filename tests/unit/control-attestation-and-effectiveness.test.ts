/* eslint-disable @typescript-eslint/no-explicit-any -- test tx fakes mirroring
 * Prisma delegate shapes; the file-level disable is this repo's standard for
 * these surfaces (see control-test.test.ts). */
/**
 * B2.3 — the two control-state writes that carry the most audit weight, executed.
 *
 * Both were covered only by structural grep. `p2-control-detail-synthesis.test.ts`
 * asserts that `attestControlTested` EXISTS and that its name appears at the
 * completion sites — which stays green through an implementation that attests on
 * every outcome, attests a NOT_APPLICABLE control, or writes the wrong cadence.
 *
 * These matter because they are what an auditor reads:
 *
 *   • `attestControlTested` stamps `Control.lastTested` and rolls the control's
 *     own `nextDueAt`. Attesting on a non-verdict would let an INCONCLUSIVE run
 *     mark a control "tested and on schedule" — a false assurance somebody acts
 *     on. The docblock says so; nothing checked it.
 *
 *   • `computeControlEffectivenessMap` is the measured pass rate that control
 *     health and residual-risk suggestion consume. Its denominator rule —
 *     INCONCLUSIVE counts toward `total` for display but is excluded from
 *     `scored` — is the difference between "we could not tell" and "it failed".
 */
import {
    attestControlTested,
    isAttestingVerdict,
    computeControlEffectivenessMap,
} from '@/app-layer/usecases/control/test-plans';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN', { tenantId: 'tenant-1' });

function txWithControl(control: Record<string, unknown> | null) {
    return {
        control: {
            findFirst: jest.fn().mockResolvedValue(control),
            update: jest.fn().mockResolvedValue({}),
        },
    } as any;
}

describe('isAttestingVerdict — only a real verdict attests', () => {
    it.each(['PASS', 'FAIL'])('%s attests', (r) => {
        expect(isAttestingVerdict(r)).toBe(true);
    });

    it.each(['INCONCLUSIVE', null, undefined, '', 'PLANNED', 'RUNNING'])(
        '%s does NOT attest',
        (r) => {
            expect(isAttestingVerdict(r as string)).toBe(false);
        },
    );

    /**
     * FAIL attests deliberately: the control WAS exercised and the answer was
     * "not effective". Testing established something, so the clock rolls and
     * the failure shows as measured effectiveness — rather than the control
     * also reading as overdue, which would double-count one problem.
     */
    it('FAIL attests — the control was exercised, the answer was just bad', () => {
        expect(isAttestingVerdict('FAIL')).toBe(true);
    });
});

describe('attestControlTested — what it refuses to stamp', () => {
    it('stamps lastTested and rolls nextDueAt on a verdict', async () => {
        const tx = txWithControl({
            id: 'ctl_1',
            frequency: 'MONTHLY',
            applicability: 'APPLICABLE',
        });

        await attestControlTested(tx, ctx, 'ctl_1', 'PASS');

        expect(tx.control.update).toHaveBeenCalledTimes(1);
        const data = tx.control.update.mock.calls[0][0].data;
        expect(data.lastTested).toBeInstanceOf(Date);
        // MONTHLY from the attestation instant.
        expect(data.nextDueAt).toBeInstanceOf(Date);
        expect(data.nextDueAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('does NOT attest on INCONCLUSIVE — the test established nothing', async () => {
        const tx = txWithControl({
            id: 'ctl_1',
            frequency: 'MONTHLY',
            applicability: 'APPLICABLE',
        });

        await attestControlTested(tx, ctx, 'ctl_1', 'INCONCLUSIVE');

        // Not merely "no update" — it must not even read the control, because
        // the verdict gate is the first thing checked. Attesting here would
        // mark the control tested and on-schedule on the strength of a run
        // that failed to determine anything.
        expect(tx.control.findFirst).not.toHaveBeenCalled();
        expect(tx.control.update).not.toHaveBeenCalled();
    });

    it('does NOT attest a NOT_APPLICABLE control', async () => {
        const tx = txWithControl({
            id: 'ctl_1',
            frequency: 'MONTHLY',
            applicability: 'NOT_APPLICABLE',
        });

        await attestControlTested(tx, ctx, 'ctl_1', 'PASS');

        expect(tx.control.update).not.toHaveBeenCalled();
    });

    it('does nothing when the control is not in this tenant', async () => {
        // `findFirst` is tenant-scoped, so a cross-tenant id resolves to null.
        const tx = txWithControl(null);

        await attestControlTested(tx, ctx, 'ctl_other_tenant', 'PASS');

        expect(tx.control.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ tenantId: 'tenant-1' }),
            }),
        );
        expect(tx.control.update).not.toHaveBeenCalled();
    });

    it('is a no-op for a run with no control attached', async () => {
        const tx = txWithControl({ id: 'x', frequency: 'MONTHLY', applicability: 'APPLICABLE' });
        await attestControlTested(tx, ctx, null, 'PASS');
        expect(tx.control.findFirst).not.toHaveBeenCalled();
    });

    it('leaves nextDueAt null for an AD_HOC control rather than inventing a date', async () => {
        const tx = txWithControl({
            id: 'ctl_1',
            frequency: 'AD_HOC',
            applicability: 'APPLICABLE',
        });

        await attestControlTested(tx, ctx, 'ctl_1', 'PASS');

        const data = tx.control.update.mock.calls[0][0].data;
        expect(data.lastTested).toBeInstanceOf(Date);
        // AD_HOC has no cadence — a synthetic due date would put the control
        // into the due queue on a schedule nobody chose.
        expect(data.nextDueAt).toBeNull();
    });
});

describe('computeControlEffectivenessMap — the measured pass rate', () => {
    function txWithRuns(grouped: Array<{ controlId: string; result: string | null; n: number }>) {
        return {
            controlTestRun: {
                groupBy: jest.fn().mockResolvedValue(
                    grouped.map((g) => ({
                        controlId: g.controlId,
                        result: g.result,
                        _count: { _all: g.n },
                    })),
                ),
            },
        } as any;
    }

    it('returns an entry for every requested control, including ones with no runs', async () => {
        const tx = txWithRuns([]);
        const map = await computeControlEffectivenessMap(tx, 'tenant-1', ['a', 'b']);

        expect([...map.keys()].sort()).toEqual(['a', 'b']);
        // A control with no runs has no measured rate — null, not 0. Zero would
        // read as "measured, and it fails every time".
        expect(map.get('a')!.passRate).toBeNull();
        expect(map.get('a')!.total).toBe(0);
    });

    it('excludes INCONCLUSIVE from the denominator but keeps it in the total', async () => {
        const tx = txWithRuns([
            { controlId: 'a', result: 'PASS', n: 3 },
            { controlId: 'a', result: 'FAIL', n: 1 },
            { controlId: 'a', result: 'INCONCLUSIVE', n: 6 },
        ]);

        const e = (await computeControlEffectivenessMap(tx, 'tenant-1', ['a'])).get('a')!;

        expect(e.total).toBe(10); // display count — every completed run
        expect(e.scored).toBe(4); // verdicts only
        // 3/4 = 75. Counting the six no-verdict runs against it would give 30
        // and report a healthy control as failing — which is the whole point
        // of the split denominator.
        expect(e.passRate).toBe(75);
    });

    it('reports null rather than 0 when every run was inconclusive', async () => {
        const tx = txWithRuns([{ controlId: 'a', result: 'INCONCLUSIVE', n: 4 }]);
        const e = (await computeControlEffectivenessMap(tx, 'tenant-1', ['a'])).get('a')!;

        expect(e.total).toBe(4);
        expect(e.scored).toBe(0);
        // "We could not tell" is not "it fails".
        expect(e.passRate).toBeNull();
    });

    it('scopes the aggregate to the tenant and to COMPLETED runs in the window', async () => {
        const tx = txWithRuns([{ controlId: 'a', result: 'PASS', n: 1 }]);
        await computeControlEffectivenessMap(tx, 'tenant-1', ['a'], 30);

        const arg = tx.controlTestRun.groupBy.mock.calls[0][0];
        expect(arg.where.tenantId).toBe('tenant-1');
        expect(arg.where.status).toBe('COMPLETED');
        // A run still in flight has no verdict; counting it would move the rate
        // before the answer exists.
        expect(arg.where.executedAt.gte).toBeInstanceOf(Date);
    });

    it('short-circuits on an empty id list without querying', async () => {
        const tx = txWithRuns([]);
        const map = await computeControlEffectivenessMap(tx, 'tenant-1', []);
        expect(map.size).toBe(0);
        expect(tx.controlTestRun.groupBy).not.toHaveBeenCalled();
    });

    it('ignores a grouped row for a control that was not requested', async () => {
        // Defensive: the map is pre-seeded per requested id, so a stray row
        // must not create an entry nobody asked about.
        const tx = txWithRuns([{ controlId: 'zzz', result: 'PASS', n: 5 }]);
        const map = await computeControlEffectivenessMap(tx, 'tenant-1', ['a']);
        expect(map.has('zzz')).toBe(false);
        expect(map.get('a')!.total).toBe(0);
    });
});
