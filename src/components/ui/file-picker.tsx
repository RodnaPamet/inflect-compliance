'use client';

/**
 * `<FilePicker>` — choose one file, with the product's own button and words.
 *
 * The browser's `<input type="file">` draws its own "Choose File" button and
 * "No file chosen" text, in the BROWSER's language rather than the page's,
 * at an intrinsic width no stylesheet can shrink. On a phone that width forced
 * the section holding it wider than the screen, and the shell's horizontal
 * clip cut it off at 360 and 390 px (the trust center's gated documents).
 *
 * Here the native input is kept (it is what opens the file dialog, and what a
 * test or an E2E run sets files on) but visually hidden, and a real `<Button>`
 * opens it. The chosen file's name sits beside the button and breaks anywhere,
 * so a long name wraps instead of widening the row; the row itself wraps, so
 * on a narrow screen the name goes under the button.
 *
 * Inside a `<FormField>` the field's `id` and `aria-*` land on the BUTTON, the
 * one focusable control, so the field's label names it and clicking the label
 * opens the dialog. The name of the chosen file describes the button.
 *
 * To clear the choice after a successful upload, remount it with a new `key`.
 */
import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Paperclip } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@inflect/ui/lib/cn';

export interface FilePickerProps {
    /** The id of the hidden native input, for a test or an E2E run to set files on. */
    inputId?: string;
    /** Passed to the native input (`.pdf,.docx`, `image/*`, …). */
    accept?: string;
    disabled?: boolean;
    /** Called with the chosen file, or `null` when the choice is cleared. */
    onFileChange: (file: File | null) => void;
    /** Overrides the button's words ("Choose file"). */
    chooseLabel?: string;
    className?: string;
    /** Set by `<FormField>`: placed on the button. */
    id?: string;
    'aria-describedby'?: string;
    'aria-invalid'?: boolean | 'true' | 'false';
    'aria-required'?: boolean;
    /** Set by `<FormField>`; the button has no invalid styling of its own. */
    invalid?: boolean;
}

export function FilePicker({
    inputId,
    accept,
    disabled,
    onFileChange,
    chooseLabel,
    className,
    id,
    'aria-describedby': describedBy,
    'aria-invalid': ariaInvalid,
    'aria-required': ariaRequired,
}: FilePickerProps) {
    const t = useTranslations('common.filePicker');
    const inputRef = React.useRef<HTMLInputElement>(null);
    const [chosen, setChosen] = React.useState<string | null>(null);
    const nameId = React.useId();

    return (
        <div className={cn('flex min-w-0 flex-wrap items-center gap-tight', className)} data-slot="file-picker">
            <input
                ref={inputRef}
                id={inputId}
                type="file"
                accept={accept}
                disabled={disabled}
                className="sr-only"
                // The button is the control; the input only opens the dialog.
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                    const file = e.target.files?.[0] ?? null;
                    setChosen(file ? file.name : null);
                    onFileChange(file);
                }}
                data-testid="file-picker-input"
            />
            <Button
                id={id}
                type="button"
                variant="secondary"
                size="sm"
                icon={<Paperclip aria-hidden="true" />}
                disabled={disabled}
                onClick={() => inputRef.current?.click()}
                aria-describedby={[nameId, describedBy].filter(Boolean).join(' ')}
                aria-invalid={ariaInvalid}
                aria-required={ariaRequired}
                data-testid="file-picker-button"
            >
                {chooseLabel ?? t('choose')}
            </Button>
            <span
                id={nameId}
                className={cn('min-w-0 text-sm wrap-anywhere', chosen ? 'text-content-default' : 'text-content-muted')}
                data-testid="file-picker-name"
            >
                {chosen ?? t('none')}
            </span>
        </div>
    );
}
