/**
 * `<FilePicker>` — a chosen file, in the product's words, that a phone can fit.
 *
 * The browser's file input drew "Choose File" / "No file chosen" in the
 * browser's language at a width no stylesheet could shrink, so a phone's
 * section holding one was forced wider than the screen and clipped. The
 * picker keeps the native input only to open the dialog (hidden, out of the
 * tab order) and shows a real button and the file's name, both of which wrap.
 */
import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

jest.mock('next-intl', () => {
    const bg = jest.requireActual('../../messages/bg.json');
    return {
        useTranslations: (ns: string) => (key: string) =>
            `${ns}.${key}`.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), bg) as string,
        useLocale: () => 'bg',
    };
});

import { FilePicker } from '@/components/ui/file-picker';
import { FormField } from '@/components/ui/form-field';
import bg from '../../messages/bg.json';

const words = bg.common.filePicker;

describe('<FilePicker>', () => {
    it('shows a button and the "no file" line in the page language, and hides the native input', () => {
        render(<FilePicker inputId="f" onFileChange={jest.fn()} />);
        expect(screen.getByRole('button', { name: words.choose })).toBeInTheDocument();
        expect(screen.getByTestId('file-picker-name')).toHaveTextContent(words.none);
        const input = document.getElementById('f') as HTMLInputElement;
        expect(input.type).toBe('file');
        expect(input).toHaveClass('sr-only');
        expect(input).toHaveAttribute('tabindex', '-1');
    });

    it('the button opens the file dialog', () => {
        render(<FilePicker inputId="f" onFileChange={jest.fn()} />);
        const click = jest.spyOn(document.getElementById('f') as HTMLInputElement, 'click');
        fireEvent.click(screen.getByRole('button', { name: words.choose }));
        expect(click).toHaveBeenCalledTimes(1);
    });

    it('names the chosen file and hands it to the caller', () => {
        const onFileChange = jest.fn();
        render(<FilePicker inputId="f" onFileChange={onFileChange} />);
        const file = new File(['x'], 'a-very-long-file-name-with-no-spaces-at-all-quarterly-report.pdf');
        fireEvent.change(document.getElementById('f') as HTMLInputElement, { target: { files: [file] } });
        expect(onFileChange).toHaveBeenCalledWith(file);
        const name = screen.getByTestId('file-picker-name');
        expect(name).toHaveTextContent(file.name);
        expect(screen.getByRole('button')).toHaveAttribute('aria-describedby', expect.stringContaining(name.id));
    });

    it('wraps instead of widening: the row wraps and the name breaks anywhere', () => {
        render(<FilePicker inputId="f" onFileChange={jest.fn()} />);
        const row = screen.getByTestId('file-picker-name').parentElement!;
        expect(row).toHaveClass('flex-wrap', 'min-w-0');
        expect(screen.getByTestId('file-picker-name')).toHaveClass('wrap-anywhere', 'min-w-0');
    });

    it('inside a FormField, the field label names the button', () => {
        render(
            <FormField label="Файл">
                <FilePicker inputId="f" onFileChange={jest.fn()} />
            </FormField>,
        );
        expect(screen.getByRole('button', { name: 'Файл' })).toBeInTheDocument();
    });
});
