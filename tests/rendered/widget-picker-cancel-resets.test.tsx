/** @jest-environment jsdom */

/**
 * The widget picker's Cancel button forgets an abandoned edit (#5309).
 *
 * Cancel closed the picker without resetting it, while the modal's own close
 * did. So a cancelled edit's title (and type, variant and config) pre-filled
 * the next "Add widget", and reopening Edit on the same widget skipped
 * hydration and showed the discarded changes instead of the stored config.
 */
import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/org/acme',
    useSearchParams: () => new URLSearchParams(),
}));

import { WidgetPicker } from '@/components/ui/dashboard-widgets/WidgetPicker';
import type { OrgDashboardWidgetDto } from '@/app-layer/schemas/org-dashboard-widget.schemas';

const WIDGET = {
    id: 'w-critical',
    organizationId: 'org-1',
    type: 'KPI',
    chartType: 'critical-risks',
    title: 'Critical risks',
    config: { format: 'number' },
    position: { x: 0, y: 0 },
    size: { w: 3, h: 2 },
    enabled: true,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
} as unknown as OrgDashboardWidgetDto;

/** The portfolio dashboard's wiring: closing clears the widget being edited. */
function Harness() {
    const [open, setOpen] = React.useState(false);
    const [editWidget, setEditWidget] = React.useState<OrgDashboardWidgetDto | null>(null);
    return (
        <>
            <button type="button" data-testid="open-edit" onClick={() => { setEditWidget(WIDGET); setOpen(true); }} />
            <button type="button" data-testid="open-add" onClick={() => { setEditWidget(null); setOpen(true); }} />
            <WidgetPicker
                open={open}
                onOpenChange={(next) => {
                    setOpen(next);
                    if (!next) setEditWidget(null);
                }}
                onSubmit={jest.fn()}
                onUpdate={jest.fn()}
                editWidget={editWidget}
            />
        </>
    );
}

const titleInput = () => screen.getByTestId('widget-picker-title') as HTMLInputElement;

describe('WidgetPicker — Cancel', () => {
    it('a cancelled edit does not pre-fill the next Add widget', () => {
        render(<Harness />);
        fireEvent.click(screen.getByTestId('open-edit'));
        expect(titleInput().value).toBe('Critical risks');
        fireEvent.change(titleInput(), { target: { value: 'Abandoned title' } });

        fireEvent.click(screen.getByTestId('widget-picker-cancel'));
        fireEvent.click(screen.getByTestId('open-add'));

        expect(titleInput().value).toBe('');
    });

    it('reopening Edit after Cancel shows the stored config, not the discarded one', () => {
        render(<Harness />);
        fireEvent.click(screen.getByTestId('open-edit'));
        fireEvent.change(titleInput(), { target: { value: 'Abandoned title' } });

        fireEvent.click(screen.getByTestId('widget-picker-cancel'));
        fireEvent.click(screen.getByTestId('open-edit'));

        expect(titleInput().value).toBe('Critical risks');
    });
});
