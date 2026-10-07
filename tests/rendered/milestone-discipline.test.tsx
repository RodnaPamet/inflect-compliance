/**
 * Epic 62 — end-to-end milestone-discipline contract.
 *
 * Three integrations exist:
 *   - framework page  → `framework-100` scoped by frameworkKey
 *   - evidence page   → `evidence-all-current` (tenant-wide)
 *   - audit pack page → `audit-pack-complete` scoped by packId
 *
 * Each one must obey the same rules:
 *   1. Re-rendering with the same triggering input does NOT re-fire.
 *   2. The dedupe is per-key, so different scopes (different
 *      framework keys / pack ids) each get their own celebration.
 *   3. Each celebration produces exactly one toast.success per
 *      session per dedupe key.
 *
 * This file proves all three obey the same discipline by walking
 * each through the same transition pattern in the same test
 * harness. If a future contributor wires a fourth milestone with
 * different semantics, the divergence shows up here as an obvious
 * "everyone else does X but yours doesn't" failure.
 */
/** @jest-environment jsdom */

import * as React from 'react';
import { act, render } from '@testing-library/react';

const toastSuccessMock = jest.fn();
jest.mock('sonner', () => ({
    toast: {
        success: (...args: unknown[]) => toastSuccessMock(...args),
    },
}));

import {
    useCelebration,
    __setConfettiForTest,
} from '@inflect/ui/components/ui/hooks/use-celebration';
import { type CelebrateInput } from '@inflect/ui/components/ui/hooks/use-celebration';
import {
    celebrationDedupe,
    MILESTONES,
    scopedMilestone,
} from '@/lib/celebrations';
import {
    isAllEvidenceCurrent,
    type EvidenceFreshnessRow,
} from '@/lib/evidence-freshness';

interface ConfettiCall {
    options: import('canvas-confetti').Options | undefined;
}
function makeConfettiStub() {
    const calls: ConfettiCall[] = [];
    const stub: (opts?: import('canvas-confetti').Options) => Promise<null> = (
        opts,
    ) => {
        calls.push({ options: opts });
        return Promise.resolve(null);
    };
    return { stub, calls };
}
async function flush(ms = 1300) {
    // Comfortably > rain preset's 1000ms tail.
    await act(async () => {
        await new Promise((r) => setTimeout(r, ms));
    });
}

// ─── Generic harness ───────────────────────────────────────────────
//
// Each integration is reduced to "what would you celebrate, if
// anything, given this prop bundle?" — exactly mirroring the
// useEffect bodies in the real pages.

type Trigger = () => CelebrateInput | null;

function MilestoneHarness({ trigger }: { trigger: Trigger }) {
    const { celebrate } = useCelebration(celebrationDedupe);
    const input = trigger();
    // Stable key for the dependency array — celebrate wraps the
    // input by value, but `JSON.stringify` of `input` is enough to
    // re-run when the trigger output materially changes. We
    // deliberately depend on the serialised form rather than the
    // live `input` reference (identity changes every trigger()).
    const inputKey = JSON.stringify(input);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    React.useEffect(() => { if (input === null) return; celebrate(input); }, [inputKey, celebrate]);
    return null;
}

const NOW = new Date('2026-05-03T00:00:00Z');
const DAY = 86_400_000;
const days = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

// ─── Triggers — one per integration, mirroring the page ───────────

function frameworkTrigger(args: {
    frameworkKey: string;
    coveragePercent: number | null;
}): Trigger {
    return () => {
        if (args.coveragePercent !== 100) return null;
        return scopedMilestone('framework-100', args.frameworkKey);
    };
}

function evidenceTrigger(args: {
    rows: EvidenceFreshnessRow[];
}): Trigger {
    return () => {
        if (!isAllEvidenceCurrent(args.rows, { now: NOW })) return null;
        const def = MILESTONES['evidence-all-current'];
        return {
            preset: def.preset,
            key: def.key,
            message: def.message,
            description: def.description,
        };
    };
}

function auditPackTrigger(args: {
    packId: string;
    status: string | undefined;
}): Trigger {
    return () => {
        if (args.status !== 'FROZEN' && args.status !== 'EXPORTED') return null;
        return scopedMilestone('audit-pack-complete', args.packId);
    };
}

// ─── Discipline tests ──────────────────────────────────────────────

describe('Milestone discipline — three integrations behave the same', () => {
    beforeEach(() => {
        window.sessionStorage.clear();
        toastSuccessMock.mockClear();
    });

    const cases: Array<{
        name: string;
        triggerOff: Trigger;
        triggerOn: Trigger;
        triggerOnAlt: Trigger;
    }> = [
        {
            name: 'framework-100',
            triggerOff: frameworkTrigger({
                frameworkKey: 'iso27001',
                coveragePercent: 50,
            }),
            triggerOn: frameworkTrigger({
                frameworkKey: 'iso27001',
                coveragePercent: 100,
            }),
            triggerOnAlt: frameworkTrigger({
                frameworkKey: 'soc2',
                coveragePercent: 100,
            }),
        },
        {
            name: 'audit-pack-complete',
            triggerOff: auditPackTrigger({
                packId: 'pack_1',
                status: 'DRAFT',
            }),
            triggerOn: auditPackTrigger({
                packId: 'pack_1',
                status: 'FROZEN',
            }),
            triggerOnAlt: auditPackTrigger({
                packId: 'pack_2',
                status: 'FROZEN',
            }),
        },
    ];

    for (const { name, triggerOff, triggerOn, triggerOnAlt } of cases) {
        describe(`${name} discipline`, () => {
            it('off → on fires exactly one toast', async () => {
                const { stub } = makeConfettiStub();
                __setConfettiForTest(stub);
                const { rerender } = render(
                    <MilestoneHarness trigger={triggerOff} />,
                );
                await flush();
                expect(toastSuccessMock).not.toHaveBeenCalled();

                rerender(<MilestoneHarness trigger={triggerOn} />);
                await flush();
                expect(toastSuccessMock).toHaveBeenCalledTimes(1);
            });

            it('on → on (same scope) does NOT fire a second toast', async () => {
                const { stub } = makeConfettiStub();
                __setConfettiForTest(stub);
                const { rerender } = render(
                    <MilestoneHarness trigger={triggerOn} />,
                );
                await flush();
                rerender(<MilestoneHarness trigger={triggerOn} />);
                await flush();
                expect(toastSuccessMock).toHaveBeenCalledTimes(1);
            });

            it('on (scope A) → on (scope B) DOES fire a second toast', async () => {
                const { stub } = makeConfettiStub();
                __setConfettiForTest(stub);
                const { rerender } = render(
                    <MilestoneHarness trigger={triggerOn} />,
                );
                await flush();
                rerender(<MilestoneHarness trigger={triggerOnAlt} />);
                await flush();
                expect(toastSuccessMock).toHaveBeenCalledTimes(2);
            });
        });
    }

    // Tenant-wide milestone (no scope) — only fires once per session
    // total, regardless of subsequent state changes.
    describe('evidence-all-current discipline (tenant-wide)', () => {
        it('off → on fires exactly one toast', async () => {
            const { stub } = makeConfettiStub();
            __setConfettiForTest(stub);
            const { rerender } = render(
                <MilestoneHarness
                    trigger={evidenceTrigger({
                        rows: [{ updatedAt: days(1) }, { updatedAt: days(60) }],
                    })}
                />,
            );
            await flush();
            expect(toastSuccessMock).not.toHaveBeenCalled();

            rerender(
                <MilestoneHarness
                    trigger={evidenceTrigger({
                        rows: [{ updatedAt: days(1) }],
                    })}
                />,
            );
            await flush();
            expect(toastSuccessMock).toHaveBeenCalledTimes(1);
        });

        it('on → on (still all current) does NOT fire a second toast', async () => {
            const { stub } = makeConfettiStub();
            __setConfettiForTest(stub);
            const { rerender } = render(
                <MilestoneHarness
                    trigger={evidenceTrigger({
                        rows: [{ updatedAt: days(1) }],
                    })}
                />,
            );
            await flush();
            rerender(
                <MilestoneHarness
                    trigger={evidenceTrigger({
                        rows: [{ updatedAt: days(2) }, { updatedAt: days(3) }],
                    })}
                />,
            );
            await flush();
            expect(toastSuccessMock).toHaveBeenCalledTimes(1);
        });
    });
});
