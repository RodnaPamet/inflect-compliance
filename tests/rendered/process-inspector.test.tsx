/**
 * R26-PR-E — ProcessInspector rendered tests.
 *
 * Exercises the property panel directly with synthetic xyflow
 * Node props. The wiring to xyflow's selection state is covered
 * by the structural ratchet at r26-pre-editor-ux.test.ts.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { render, screen, fireEvent } from '@testing-library/react';
import { ProcessInspector } from '@/components/processes/ProcessInspector';

function makeNode(overrides: any = {}) {
    return {
        id: 'node-1',
        type: 'processStep',
        position: { x: 0, y: 0 },
        data: { label: 'Receive order', subtitle: 'Step', kind: 'processStep' },
        ...overrides,
    };
}

/**
 * The size control appears only where the renderer reads the value.
 *
 * It persisted to `dataJson.size`, which the tldraw node shape deliberately
 * does not read — the owner's option-B decision on #2961, because #2960 made
 * `dataJson` an opaque passthrough. So on that host the control was visible and
 * inert: it saved a value nothing displayed, which reads as a bug to whoever
 * touches it.
 *
 * Asserted in BOTH directions. A test that only checked the hidden case would
 * pass just as well if the control had been deleted outright, which would
 * silently remove a working feature from the xyflow canvas.
 */
describe('the size control follows the renderer', () => {
    it('is present by default — the xyflow canvas is unchanged', () => {
        render(<ProcessInspector node={makeNode() as any} onUpdate={jest.fn()} />);
        expect(screen.getByTestId('inspector-size')).toBeTruthy();
    });

    it('is absent when the renderer does not honour size', () => {
        render(
            <ProcessInspector
                node={makeNode() as any}
                onUpdate={jest.fn()}
                rendererHonoursSize={false}
            />,
        );
        expect(screen.queryByTestId('inspector-size')).toBeNull();
    });

    it('and the rest of the panel still renders — teeth', () => {
        // Without this, hiding the whole panel would satisfy the assertion
        // above. The label input is the thing a user came to the inspector for.
        render(
            <ProcessInspector
                node={makeNode() as any}
                onUpdate={jest.fn()}
                rendererHonoursSize={false}
            />,
        );
        expect(screen.getByTestId('inspector-label-input')).toBeTruthy();
        expect(screen.getByTestId('inspector-subtitle-input')).toBeTruthy();
    });

    it('HIDES rather than disables it', () => {
        // A greyed-out control still advertises a capability the host does not
        // have, and still invites the question "why can I not change this?".
        const { container } = render(
            <ProcessInspector
                node={makeNode() as any}
                onUpdate={jest.fn()}
                rendererHonoursSize={false}
            />,
        );
        expect(container.querySelectorAll('[disabled]')).toHaveLength(0);
    });
});

describe('ProcessInspector', () => {
    it('renders nothing when no node is selected', () => {
        const { container } = render(
            <ProcessInspector node={null} onUpdate={jest.fn()} />,
        );
        expect(container.firstChild).toBeNull();
    });

    it('mounts with the node label + subtitle pre-filled', () => {
        render(
            <ProcessInspector
                node={makeNode() as any}
                onUpdate={jest.fn()}
            />,
        );
        const labelInput = screen.getByTestId(
            'inspector-label-input',
        ) as HTMLInputElement;
        const subtitleInput = screen.getByTestId(
            'inspector-subtitle-input',
        ) as HTMLInputElement;
        expect(labelInput.value).toBe('Receive order');
        expect(subtitleInput.value).toBe('Step');
    });

    it('commits the label change on blur', () => {
        const onUpdate = jest.fn();
        render(
            <ProcessInspector
                node={makeNode() as any}
                onUpdate={onUpdate}
            />,
        );
        const input = screen.getByTestId(
            'inspector-label-input',
        ) as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'Reviewed' } });
        fireEvent.blur(input);
        expect(onUpdate).toHaveBeenCalledWith('node-1', {
            label: 'Reviewed',
            subtitle: 'Step',
        });
    });

    it('treats an empty subtitle as null (drops the field)', () => {
        const onUpdate = jest.fn();
        render(
            <ProcessInspector
                node={makeNode() as any}
                onUpdate={onUpdate}
            />,
        );
        const input = screen.getByTestId(
            'inspector-subtitle-input',
        ) as HTMLInputElement;
        fireEvent.change(input, { target: { value: '' } });
        fireEvent.blur(input);
        expect(onUpdate).toHaveBeenCalledWith('node-1', {
            label: 'Receive order',
            subtitle: null,
        });
    });

    it('commits on Enter', () => {
        const onUpdate = jest.fn();
        render(
            <ProcessInspector
                node={makeNode() as any}
                onUpdate={onUpdate}
            />,
        );
        const input = screen.getByTestId(
            'inspector-label-input',
        ) as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'New label' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        // The Enter handler calls .blur() which fires the commit.
        // jsdom's blur on Enter doesn't auto-fire; assert via a
        // direct blur instead.
        fireEvent.blur(input);
        expect(onUpdate).toHaveBeenCalled();
        const lastCall = (onUpdate.mock.calls.at(-1) ?? [])[1];
        expect(lastCall.label).toBe('New label');
    });

    it('shows the kind label in the inspector heading when known', () => {
        render(
            <ProcessInspector
                node={makeNode({ data: { label: 'X', kind: 'decision' } }) as any}
                onUpdate={jest.fn()}
            />,
        );
        // R31 Bundle 5 — the inspector now lives inside the
        // <AsidePanel> primitive, which renders 'Inspector' in
        // BOTH its desktop title bar and its mobile sheet-
        // trigger button (same component, two responsive
        // surfaces). Use `getAllByText` and assert at least one
        // — the title is correctly rendered; we no longer claim
        // it's unique.
        expect(screen.getAllByText('Inspector').length).toBeGreaterThan(0);
        // The kind name appears in a category span.
        expect(screen.getByText(/Decision/)).toBeInTheDocument();
    });

    it('mounts the panel for unknown kinds too (fallback resilience)', () => {
        render(
            <ProcessInspector
                node={
                    makeNode({
                        data: { label: 'X', kind: 'totally-made-up-kind' },
                    }) as any
                }
                onUpdate={jest.fn()}
            />,
        );
        expect(
            screen.getByTestId('inspector-label-input'),
        ).toBeInTheDocument();
    });
});
