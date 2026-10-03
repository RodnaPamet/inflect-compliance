/**
 * Epic 62 — milestone trigger conditions for framework coverage and
 * evidence freshness.
 *
 * Verifies the *integration logic* — the rule each page applies
 * before invoking `celebrate()`. The hook itself is covered in
 * `tests/rendered/use-celebration.test.tsx`; this file proves the
 * pages call it at the right moment and not on the wrong one.
 *
 * Strategy: instead of mounting the heavy framework / evidence
 * client trees (each pulls in many providers), we extract the
 * conditional surface as plain effects in a tiny harness that
 * mirrors the call-site shape:
 *
 *   - framework: "fire when coveragePercent === 100, with per-frame
 *     dedupe key"
 *   - evidence:  "fire when isAllEvidenceCurrent + no filter +
 *     loaded + active tab"
 *
 * The harness uses the real `useCelebration` hook so dedupe behaves
 * end-to-end (including session-storage persistence between
 * re-renders).
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
} from '@/components/ui/hooks/use-celebration';
import { celebrationDedupe, MILESTONES } from '@/lib/celebrations';
import {
    isAllEvidenceCurrent,
    type EvidenceFreshnessRow,
} from '@/lib/evidence-freshness';

const NOW = new Date('2026-05-03T00:00:00Z');
const DAY = 86_400_000;
const days = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

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
    // Comfortably > rain preset's 1000 ms tail (0 / 500 / 1000 ms
    // staggered bursts) so all setTimeout-deferred confetti calls
    // land before the assertion phase. Tests that re-render must
    // also use this default so the previous render's tail doesn't
    // bleed into the next flush window.
    await act(async () => {
        await new Promise((r) => setTimeout(r, ms));
    });
}

// ─── Framework harness ──────────────────────────────────────────────

function FrameworkHarness({
    frameworkKey,
    frameworkName,
    coveragePercent,
}: {
    frameworkKey: string;
    frameworkName?: string;
    coveragePercent: number | null;
}) {
    const { celebrate } = useCelebration(celebrationDedupe);
    React.useEffect(() => {
        if (coveragePercent !== 100) return;
        const def = MILESTONES['framework-100'];
        celebrate({
            preset: def.preset,
            key: `framework-100:${frameworkKey}`,
            message: def.message,
            description: frameworkName
                ? `${frameworkName} — ${def.description ?? ''}`.trim()
                : def.description,
        });
    }, [coveragePercent, frameworkKey, frameworkName, celebrate]);
    return null;
}

describe('Framework page — framework-100 trigger', () => {
    beforeEach(() => {
        window.sessionStorage.clear();
        toastSuccessMock.mockClear();
    });

    it('does not fire below 100%', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        render(
            <FrameworkHarness
                frameworkKey="iso27001"
                coveragePercent={99}
            />,
        );
        await flush();
        expect(calls.length).toBe(0);
        expect(toastSuccessMock).not.toHaveBeenCalled();
    });

    it('does not fire on null/loading coverage', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        render(
            <FrameworkHarness
                frameworkKey="iso27001"
                coveragePercent={null}
            />,
        );
        await flush();
        expect(calls.length).toBe(0);
    });

    it('fires once when coverage reaches 100', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        const { rerender } = render(
            <FrameworkHarness
                frameworkKey="iso27001"
                coveragePercent={99}
            />,
        );
        await flush();
        expect(calls.length).toBe(0);

        rerender(
            <FrameworkHarness
                frameworkKey="iso27001"
                coveragePercent={100}
            />,
        );
        await flush();
        // Fireworks preset fires three staggered bursts.
        expect(calls.length).toBe(3);
        expect(toastSuccessMock).toHaveBeenCalledTimes(1);
        expect(toastSuccessMock.mock.calls[0][0]).toContain(
            '100% framework coverage',
        );
    });

    it('does not re-fire when the user re-renders at 100%', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        const { rerender } = render(
            <FrameworkHarness
                frameworkKey="iso27001"
                coveragePercent={100}
            />,
        );
        await flush();
        const firstCount = calls.length;
        const firstToast = toastSuccessMock.mock.calls.length;

        // Same framework, same coverage → no second celebration.
        rerender(
            <FrameworkHarness
                frameworkKey="iso27001"
                coveragePercent={100}
            />,
        );
        await flush();
        expect(calls.length).toBe(firstCount);
        expect(toastSuccessMock.mock.calls.length).toBe(firstToast);
    });

    it('fires separately for two different frameworks (per-key dedupe)', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        const { rerender } = render(
            <FrameworkHarness
                frameworkKey="iso27001"
                coveragePercent={100}
            />,
        );
        await flush();
        const firstCount = calls.length;
        expect(firstCount).toBeGreaterThan(0);

        rerender(
            <FrameworkHarness
                frameworkKey="soc2"
                coveragePercent={100}
            />,
        );
        await flush();
        // Second framework gets its own celebration.
        expect(calls.length).toBeGreaterThan(firstCount);
        expect(toastSuccessMock).toHaveBeenCalledTimes(2);
    });

    it('embeds the framework name in the toast description when provided', async () => {
        const { stub } = makeConfettiStub();
        __setConfettiForTest(stub);
        render(
            <FrameworkHarness
                frameworkKey="iso27001"
                frameworkName="ISO 27001:2022"
                coveragePercent={100}
            />,
        );
        await flush();
        const [, opts] = toastSuccessMock.mock.calls[0] as [
            string,
            { description?: string },
        ];
        expect(opts.description).toContain('ISO 27001:2022');
    });
});

// ─── Evidence harness ───────────────────────────────────────────────

function EvidenceHarness({
    rows,
    isLoading = false,
    anyFilterActive = false,
    retentionFilter = 'active',
    hydratedNow = NOW,
}: {
    rows: EvidenceFreshnessRow[];
    isLoading?: boolean;
    anyFilterActive?: boolean;
    retentionFilter?: 'active' | 'expiring' | 'archived';
    hydratedNow?: Date | null;
}) {
    const { celebrate } = useCelebration(celebrationDedupe);
    React.useEffect(() => {
        if (!hydratedNow) return;
        if (retentionFilter !== 'active') return;
        if (anyFilterActive) return;
        if (isLoading) return;
        if (!isAllEvidenceCurrent(rows, { now: hydratedNow })) return;
        const def = MILESTONES['evidence-all-current'];
        celebrate({
            preset: def.preset,
            key: def.key,
            message: def.message,
            description: def.description,
        });
    }, [
        rows,
        hydratedNow,
        retentionFilter,
        anyFilterActive,
        isLoading,
        celebrate,
    ]);
    return null;
}

describe('Evidence page — evidence-all-current trigger', () => {
    beforeEach(() => {
        window.sessionStorage.clear();
        toastSuccessMock.mockClear();
    });

    it('fires when every active row is fresh', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        render(
            <EvidenceHarness
                rows={[{ updatedAt: days(2) }, { updatedAt: days(10) }]}
            />,
        );
        await flush();
        // Rain preset = three staggered top-edge bursts.
        expect(calls.length).toBe(3);
        expect(toastSuccessMock).toHaveBeenCalledTimes(1);
        expect(toastSuccessMock.mock.calls[0][0]).toContain('All evidence');
    });

    it('does not fire while the query is loading', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        render(
            <EvidenceHarness
                rows={[{ updatedAt: days(2) }]}
                isLoading={true}
            />,
        );
        await flush();
        expect(calls.length).toBe(0);
    });

    it('does not fire on the expiring tab', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        render(
            <EvidenceHarness
                rows={[{ updatedAt: days(2) }]}
                retentionFilter="expiring"
            />,
        );
        await flush();
        expect(calls.length).toBe(0);
    });

    it('does not fire when a search/status filter is active', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        render(
            <EvidenceHarness
                rows={[{ updatedAt: days(2) }]}
                anyFilterActive={true}
            />,
        );
        await flush();
        expect(calls.length).toBe(0);
    });

    it('does not fire on first render when hydratedNow is null', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        render(
            <EvidenceHarness
                rows={[{ updatedAt: days(2) }]}
                hydratedNow={null}
            />,
        );
        await flush();
        expect(calls.length).toBe(0);
    });

    it('does not fire when one row is stale', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        render(
            <EvidenceHarness
                rows={[{ updatedAt: days(2) }, { updatedAt: days(60) }]}
            />,
        );
        await flush();
        expect(calls.length).toBe(0);
    });

    it('does not re-fire on subsequent renders within the session', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        const { rerender } = render(
            <EvidenceHarness
                rows={[{ updatedAt: days(2) }]}
            />,
        );
        await flush();
        const firstCount = calls.length;

        rerender(
            <EvidenceHarness
                rows={[{ updatedAt: days(3) }]}
            />,
        );
        await flush();
        expect(calls.length).toBe(firstCount);
    });

    it('does not fire on an empty workspace', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        render(<EvidenceHarness rows={[]} />);
        await flush();
        expect(calls.length).toBe(0);
    });
});
