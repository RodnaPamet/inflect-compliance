/**
 * The risk score chip answers a 44px tap on a touch screen.
 *
 * The chip is a button the size of its text: on `risks/[riskId]` the
 * "16 · Критичен, обяснение" trigger was 16px tall, one of the last tap
 * targets under 24px on a fixed mobile route (#5884). It now wears the shared
 * touch hit area, a transparent `::after` that grows to 44x44 on a coarse
 * pointer, so the chip's own size and every table row it sits in are unchanged.
 */
import { render, screen } from '@testing-library/react';
import * as React from 'react';

import { RiskScoreExplainer } from '@/components/risks/RiskScoreExplainer';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { TOUCH_HIT_AREA_CLASS } from '@inflect/ui/components/ui/hit-area';

describe('RiskScoreExplainer — touch target', () => {
    it('the trigger carries the shared touch hit area and is its positioning context', () => {
        render(
            <KeyboardShortcutProvider>
                <RiskScoreExplainer tenantSlug="acme" riskId="r-1" label="16 · Critical">
                    <span>16</span>
                </RiskScoreExplainer>
            </KeyboardShortcutProvider>,
        );
        const trigger = screen.getByRole('button', { name: '16 · Critical, explain' });
        expect(trigger).toHaveClass('relative', ...TOUCH_HIT_AREA_CLASS.split(' '));
        // `overflow: hidden` would clip the hit area back to the chip.
        expect(trigger.className).not.toMatch(/\b(truncate|overflow-hidden)\b/);
    });
});
