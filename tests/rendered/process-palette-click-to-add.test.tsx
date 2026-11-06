/**
 * A palette item is a BUTTON: a click or a key press adds the step.
 *
 * Drag was the only way in, and it is the wrong only way: HTML5 drag never
 * fires on a touch screen, a keyboard cannot drag, and when the drop handler
 * broke the items did nothing at all. Drag still works — the payload test below
 * holds the contract the canvas's drop handler parses.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

import { PALETTE_DRAG_MIME, ProcessPalette } from '@/components/processes/ProcessPalette';
import { CanvasModeProvider } from '@/lib/processes/canvas-mode-context';

function renderPalette(onAdd?: (kind: string, label: string) => void) {
    return render(
        <CanvasModeProvider mode="DOCUMENT">
            <ProcessPalette {...(onAdd ? { onAdd } : {})} />
        </CanvasModeProvider>,
    );
}

describe('ProcessPalette items', () => {
    it('are buttons, so they are reachable and pressable without a pointer', () => {
        const { container } = renderPalette(jest.fn());
        const items = container.querySelectorAll('[data-process-palette-item="true"]');
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) {
            expect(item.tagName).toBe('BUTTON');
            expect(item.getAttribute('type')).toBe('button');
        }
    });

    it('a click adds that kind of step', async () => {
        const onAdd = jest.fn();
        const { container } = renderPalette(onAdd);
        await userEvent.click(container.querySelector('[data-palette-item="risk"]')!);
        expect(onAdd).toHaveBeenCalledTimes(1);
        expect(onAdd.mock.calls[0]![0]).toBe('risk');
        expect(typeof onAdd.mock.calls[0]![1]).toBe('string');
    });

    it('Enter on a focused item adds it too', async () => {
        const onAdd = jest.fn();
        const { container } = renderPalette(onAdd);
        const decision = container.querySelector<HTMLButtonElement>('[data-palette-item="decision"]')!;
        decision.focus();
        await userEvent.keyboard('{Enter}');
        expect(onAdd).toHaveBeenCalledWith('decision', expect.any(String));
    });

    it('names the click in its accessible label when it can add', () => {
        renderPalette(jest.fn());
        expect(screen.getAllByRole('button', { name: /click, or drag onto the canvas/i }).length).toBeGreaterThan(0);
    });

    it('still carries the drag payload the canvas parses', () => {
        const { container } = renderPalette(jest.fn());
        const data = new Map<string, string>();
        fireEvent.dragStart(container.querySelector('[data-palette-item="asset"]')!, {
            dataTransfer: {
                setData: (k: string, v: string) => data.set(k, v),
                effectAllowed: '',
            },
        });
        expect(JSON.parse(data.get(PALETTE_DRAG_MIME)!)).toMatchObject({ kind: 'asset' });
    });
});
