'use client';

/**
 * The assistant's entry point on a phone (#5813, owner decision 2026-11-22).
 *
 * Below `md` the floating launcher is not rendered; this icon sits in the top
 * bar beside the notifications bell instead and opens the SAME sheet. It owns
 * no sheet and no open state of its own: it writes the shared state in
 * `assistant-open-context.tsx`, and the sheet stays mounted by
 * `AssistantLauncher`, so the conversation is one conversation whichever entry
 * point opened it.
 *
 * ═══ ONE GATE, READ RATHER THAN RE-DERIVED ═══
 *
 * It renders only while `available` is true — which the launcher sets, and
 * only when it has decided the viewer may use the assistant: the kill
 * switches on, a role that may write, and not on the sign-in gate. Re-deriving
 * any of that here would be a second copy of the gate, free to disagree with
 * the first; the palette entry reads the same flag for the same reason.
 *
 * `md:hidden`: from `md` up the floating launcher is the entry point, and two
 * buttons for one sheet on one screen would be a choice with no difference.
 */
import { useTranslations } from 'next-intl';
import { Sparkle3 } from '@inflect/ui/components/ui/icons/glyphs/sparkle3';

import { NAV_BAR_ICON_BUTTON_CLASS } from '@/components/layout/nav-bar';
import { Tooltip } from '@/components/ui/tooltip';

import { warmAssistantSheet } from './AssistantLauncher';
import { useAssistantOpen } from './assistant-open-context';

export function AssistantTopBarButton() {
    const t = useTranslations('assistant');
    const { open, setOpen, available, returnFocusRef } = useAssistantOpen();

    if (!available) return null;

    const label = open ? t('closeLauncher') : t('openLauncher');

    return (
        <Tooltip content={label}>
            <button
                type="button"
                onClick={(event) => {
                    if (open) {
                        setOpen(false);
                        return;
                    }
                    // The launcher's close returns focus here rather than to
                    // its own button, which is hidden on a phone.
                    returnFocusRef.current = event.currentTarget;
                    setOpen(true);
                }}
                onPointerEnter={warmAssistantSheet}
                onFocus={warmAssistantSheet}
                aria-label={label}
                aria-expanded={open}
                aria-haspopup="dialog"
                data-testid="assistant-top-bar-button"
                className={`md:hidden ${NAV_BAR_ICON_BUTTON_CLASS}`}
            >
                <Sparkle3 className="h-4 w-4" aria-hidden="true" />
            </button>
        </Tooltip>
    );
}
