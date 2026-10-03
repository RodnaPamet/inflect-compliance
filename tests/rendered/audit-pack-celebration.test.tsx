/**
 * Epic 62 — audit-pack-complete trigger conditions.
 *
 * Mirrors the harness pattern from
 * `milestone-trigger-conditions.test.tsx` so the three milestone
 * integrations (framework / evidence / audit pack) all read the
 * same way.
 *
 * "Complete" for an audit pack maps onto `FROZEN` and its
 * downstream `EXPORTED` status — both render the same `isFrozen`
 * UI state in the page, and both deserve the celebration.
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
import { celebrationDedupe, scopedMilestone } from '@/lib/celebrations';

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
async function flush(ms = 800) {
    // Fireworks preset stagger: 0 / 250 / 500 ms — 800 ms gives all
    // three a chance to land before the assertion.
    await act(async () => {
        await new Promise((r) => setTimeout(r, ms));
    });
}

// Mirror of the page's effect — same condition, same call shape.
function PackHarness({
    packId,
    packStatus,
    packName,
}: {
    packId: string;
    packStatus: string | undefined;
    packName?: string;
}) {
    const { celebrate } = useCelebration(celebrationDedupe);
    const packComplete =
        packStatus === 'FROZEN' || packStatus === 'EXPORTED';
    React.useEffect(() => {
        if (!packComplete) return;
        celebrate(
            scopedMilestone('audit-pack-complete', packId, {
                descriptionOverride: packName
                    ? `${packName} — frozen and shareable with your auditor.`
                    : undefined,
            }),
        );
    }, [packComplete, packId, packName, celebrate]);
    return null;
}

describe('Audit pack — audit-pack-complete trigger', () => {
    beforeEach(() => {
        window.sessionStorage.clear();
        toastSuccessMock.mockClear();
    });

    it('does not fire while the pack is DRAFT', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        render(<PackHarness packId="pack_1" packStatus="DRAFT" />);
        await flush();
        expect(calls.length).toBe(0);
        expect(toastSuccessMock).not.toHaveBeenCalled();
    });

    it('does not fire while the pack is loading (status undefined)', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        render(<PackHarness packId="pack_1" packStatus={undefined} />);
        await flush();
        expect(calls.length).toBe(0);
    });

    it('fires once on FROZEN', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        const { rerender } = render(
            <PackHarness packId="pack_1" packStatus="DRAFT" />,
        );
        await flush();
        expect(calls.length).toBe(0);

        rerender(<PackHarness packId="pack_1" packStatus="FROZEN" />);
        await flush();
        // Fireworks preset = 3 staggered bursts.
        expect(calls.length).toBe(3);
        expect(toastSuccessMock).toHaveBeenCalledTimes(1);
        expect(toastSuccessMock.mock.calls[0][0]).toContain('Audit pack ready');
    });

    it('also treats EXPORTED as complete', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        render(<PackHarness packId="pack_1" packStatus="EXPORTED" />);
        await flush();
        expect(calls.length).toBe(3);
        expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    });

    it('does not re-fire when the same pack re-renders complete', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        const { rerender } = render(
            <PackHarness packId="pack_1" packStatus="FROZEN" />,
        );
        await flush();
        const firstCount = calls.length;

        rerender(<PackHarness packId="pack_1" packStatus="EXPORTED" />);
        await flush();
        // Same pack, same dedupe key — no second celebration even
        // though FROZEN → EXPORTED is a real status transition.
        expect(calls.length).toBe(firstCount);
        expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    });

    it('two different packs each get their own celebration', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        const { rerender } = render(
            <PackHarness packId="pack_1" packStatus="FROZEN" />,
        );
        await flush();
        const firstCount = calls.length;
        expect(firstCount).toBeGreaterThan(0);

        rerender(<PackHarness packId="pack_2" packStatus="FROZEN" />);
        await flush();
        expect(calls.length).toBeGreaterThan(firstCount);
        expect(toastSuccessMock).toHaveBeenCalledTimes(2);
    });

    it('embeds the pack name in the toast description when provided', async () => {
        const { stub } = makeConfettiStub();
        __setConfettiForTest(stub);
        render(
            <PackHarness
                packId="pack_1"
                packStatus="FROZEN"
                packName="Q2 ISO27001 Pack"
            />,
        );
        await flush();
        const [, opts] = toastSuccessMock.mock.calls[0] as [
            string,
            { description?: string },
        ];
        expect(opts.description).toContain('Q2 ISO27001 Pack');
    });
});
