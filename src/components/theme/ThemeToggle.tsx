'use client';

/**
 * Epic 51 — theme toggle button.
 *
 * Renders a token-driven icon button that flips between light / dark. Plug it
 * into any toolbar or user menu; it carries accessible labelling for screen
 * readers and keyboard users.
 */

import { Moon, Sun } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Tooltip } from '@/components/ui/tooltip';
import { useTheme } from './ThemeProvider';

export interface ThemeToggleProps {
    className?: string;
    /** Optional id for test/automation hooks. */
    id?: string;
}

export function ThemeToggle({ className, id = 'theme-toggle' }: ThemeToggleProps) {
    const { theme, toggle } = useTheme();
    const t = useTranslations('common.ui');
    const isDark = theme === 'dark';
    const label = isDark ? t('switchToLightTheme') : t('switchToDarkTheme');

    return (
        <Tooltip content={label}>
            <button
                type="button"
                onClick={toggle}
                aria-label={label}
                aria-pressed={!isDark}
                id={id}
                data-testid="theme-toggle"
                data-theme-current={theme}
                className={`icon-btn icon-btn-sm ${className ?? ''}`.trim()}
            >
                {isDark ? (
                    <Sun className="size-4" aria-hidden="true" />
                ) : (
                    <Moon className="size-4" aria-hidden="true" />
                )}
            </button>
        </Tooltip>
    );
}
