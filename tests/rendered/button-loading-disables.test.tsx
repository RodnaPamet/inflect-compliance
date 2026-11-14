/**
 * A loading `<Button>` is disabled, whatever `disabled` the caller passes
 * (#5312).
 *
 * `disabled={props.disabled || loading}` sat BEFORE `{...props}`, so a caller
 * that passed `disabled={false}` overrode it. The agent Tools tab does exactly
 * that (`<Button loading={granting} disabled={!selected}>`): mid-request the
 * button looked inert and still fired on a click.
 */
import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

import { Button } from '@/components/ui/button';

describe('a loading Button cannot be pressed', () => {
    test.each([
        ['disabled={false}', { disabled: false }],
        ['no disabled prop', {}],
    ])('loading with %s is disabled and ignores a click', (_label, props) => {
        const onClick = jest.fn();
        render(
            <Button data-testid="subject" loading onClick={onClick} {...props}>
                Grant
            </Button>,
        );
        const button = screen.getByTestId('subject') as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        fireEvent.click(button);
        expect(onClick).not.toHaveBeenCalled();
    });

    it('a resting button with disabled={false} is still pressable', () => {
        const onClick = jest.fn();
        render(
            <Button data-testid="subject" disabled={false} onClick={onClick}>
                Grant
            </Button>,
        );
        fireEvent.click(screen.getByTestId('subject'));
        expect(onClick).toHaveBeenCalledTimes(1);
    });
});
