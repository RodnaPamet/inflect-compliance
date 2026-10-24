/**
 * `<TaskChecklistPanel>` — the authored steps and template guidance of a task
 * installed from a control template.
 *
 * Install has written `checklistJson` and the phase / evidence hint / suggested
 * role in `metadataJson` since 2026-09-04, and the task page rendered none of
 * it, so every installed task looked generic whatever its template carried.
 * These tests fail if the page goes back to that: the steps must be visible,
 * tickable by an editor, frozen for a reader, and the guidance must show.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const lookup = (path: string): unknown =>
        path.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    return {
        useTranslations: (ns: string) => (key: string, params?: Record<string, unknown>) => {
            let v = lookup(`${ns}.${key}`);
            if (typeof v !== 'string') return key;
            if (params) {
                for (const [p, val] of Object.entries(params)) {
                    v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
                }
            }
            return v;
        },
        useLocale: () => 'en',
    };
});

import {
    TaskChecklistPanel,
    parseTaskChecklist,
    parseTaskTemplateGuidance,
} from '@/components/controls-shared/TaskChecklistPanel';

const STORED_CHECKLIST = [
    { id: 'a', text: 'List every deployment able to act on its own', done: true, doneAt: '2026-10-01T00:00:00.000Z', doneByUserId: 'u1' },
    { id: 'b', text: 'Record the authority limit for each one', hint: 'Spend, reach and change', done: false },
    { id: 'c', text: 'Have the accountable owner approve each record', done: false },
];

describe('parseTaskChecklist', () => {
    it('reads the stored shape and keeps the hint', () => {
        expect(parseTaskChecklist(STORED_CHECKLIST)).toEqual([
            { id: 'a', text: 'List every deployment able to act on its own', done: true },
            { id: 'b', text: 'Record the authority limit for each one', hint: 'Spend, reach and change', done: false },
            { id: 'c', text: 'Have the accountable owner approve each record', done: false },
        ]);
    });

    it('returns nothing for a task without a checklist, and skips an unreadable item', () => {
        expect(parseTaskChecklist(null)).toEqual([]);
        expect(parseTaskChecklist({ not: 'an array' })).toEqual([]);
        expect(parseTaskChecklist([{ id: 'x' }, 'step', { id: 'y', text: 'Kept', done: 'yes' }])).toEqual([
            { id: 'y', text: 'Kept', done: false },
        ]);
    });
});

describe('parseTaskTemplateGuidance', () => {
    it('reads the three keys install writes, and ignores the rest', () => {
        expect(
            parseTaskTemplateGuidance({
                phase: 'OPERATE',
                evidenceHint: 'The signed authority declarations',
                suggestedRole: 'Management',
                findingSource: 'INTERNAL_AUDIT',
            }),
        ).toEqual({
            phase: 'OPERATE',
            evidenceHint: 'The signed authority declarations',
            suggestedRole: 'Management',
        });
    });

    it('drops a phase it has no label for rather than rendering a raw key', () => {
        expect(parseTaskTemplateGuidance({ phase: 'LAUNCH' })).toEqual({});
        expect(parseTaskTemplateGuidance(null)).toEqual({});
    });
});

describe('<TaskChecklistPanel>', () => {
    const guidance = {
        phase: 'IMPLEMENT',
        evidenceHint: 'The authority declaration for every deployment',
        suggestedRole: 'Management',
    };

    it('shows every step, the progress and the template guidance', () => {
        render(
            <TaskChecklistPanel
                items={parseTaskChecklist(STORED_CHECKLIST)}
                guidance={guidance}
                canEdit
                onToggle={jest.fn()}
            />,
        );

        expect(screen.getByText('Steps')).toBeTruthy();
        expect(screen.getByText('List every deployment able to act on its own')).toBeTruthy();
        expect(screen.getByText('Spend, reach and change')).toBeTruthy();
        expect(document.getElementById('task-checklist-progress')?.textContent).toBe('1 of 3 steps done');

        expect(document.getElementById('task-template-phase')?.textContent).toBe('Implement');
        expect(document.getElementById('task-template-role')?.textContent).toBe('Management');
        expect(document.getElementById('task-template-evidence-hint')?.textContent).toBe(
            'The authority declaration for every deployment',
        );

        const boxes = screen.getAllByRole('checkbox');
        expect(boxes).toHaveLength(3);
        expect(boxes.map((b) => b.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    });

    it('asks for the opposite state of the step that was clicked', () => {
        const onToggle = jest.fn();
        render(
            <TaskChecklistPanel
                items={parseTaskChecklist(STORED_CHECKLIST)}
                guidance={{}}
                canEdit
                onToggle={onToggle}
            />,
        );

        const [first, second] = screen.getAllByRole('checkbox');
        fireEvent.click(second);
        expect(onToggle).toHaveBeenLastCalledWith('b', true);
        fireEvent.click(first);
        expect(onToggle).toHaveBeenLastCalledWith('a', false);
    });

    it('freezes every step for a caller who cannot edit the task', () => {
        const onToggle = jest.fn();
        render(
            <TaskChecklistPanel
                items={parseTaskChecklist(STORED_CHECKLIST)}
                guidance={{}}
                canEdit={false}
                onToggle={onToggle}
            />,
        );

        for (const box of screen.getAllByRole('checkbox')) {
            expect(box.hasAttribute('disabled')).toBe(true);
            fireEvent.click(box);
        }
        expect(onToggle).not.toHaveBeenCalled();
    });

    it('freezes the step whose write is in flight, and only that one', () => {
        render(
            <TaskChecklistPanel
                items={parseTaskChecklist(STORED_CHECKLIST)}
                guidance={{}}
                canEdit
                onToggle={jest.fn()}
                pendingItemId="b"
            />,
        );

        expect(screen.getAllByRole('checkbox').map((b) => b.hasAttribute('disabled'))).toEqual([
            false,
            true,
            false,
        ]);
    });

    it('renders nothing for a hand-written task with neither steps nor guidance', () => {
        const { container } = render(
            <TaskChecklistPanel items={[]} guidance={{}} canEdit onToggle={jest.fn()} />,
        );
        expect(container.innerHTML).toBe('');
    });

    it('shows the guidance alone for a template task authored without steps', () => {
        render(
            <TaskChecklistPanel items={[]} guidance={guidance} canEdit onToggle={jest.fn()} />,
        );
        expect(screen.getByText('From the control template')).toBeTruthy();
        expect(screen.queryByText('Steps')).toBeNull();
        expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    });
});
