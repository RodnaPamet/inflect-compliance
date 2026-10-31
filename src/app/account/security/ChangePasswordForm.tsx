'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Heading } from '@/components/ui/typography';
import { apiErrorMessage } from '@/lib/api-error';
import {
    isChangePasswordRefusal,
    type ChangePasswordRefusal,
} from '@/lib/auth/change-password-refusals';

/**
 * Each refusal's label under `account.security`. The route's own sentences
 * are English, so a known refusal is said from the catalogue instead (#4645).
 * Exhaustive: a new code does not compile without a label.
 */
const REFUSAL_LABEL: Record<ChangePasswordRefusal, string> = {
    SAME_AS_CURRENT: 'mustDiffer',
    PASSWORD_EMPTY: 'fillAllThree',
    PASSWORD_TOO_SHORT: 'tooShort',
    PASSWORD_TOO_LONG: 'tooLong',
    PASSWORD_BREACHED: 'breached',
    NO_PASSWORD: 'withoutPassword',
    CURRENT_PASSWORD_INCORRECT: 'currentIncorrect',
};

export function ChangePasswordForm() {
    const t = useTranslations('account.security');
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [error, setError] = useState('');
    const [success, setSuccess] = useState(false);
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        setError('');

        if (!currentPassword || !newPassword || !confirmPassword) {
            setError(t('fillAllThree'));
            return;
        }
        if (newPassword !== confirmPassword) {
            setError(t('newPasswordsNoMatch'));
            return;
        }
        if (newPassword.length < 8) {
            setError(t('tooShort'));
            return;
        }
        if (newPassword === currentPassword) {
            setError(t('mustDiffer'));
            return;
        }

        setLoading(true);
        try {
            const res = await fetch('/api/auth/change-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword, newPassword }),
            });
            if (res.ok) {
                setSuccess(true);
                setTimeout(() => {
                    window.location.href = '/login?passwordChanged=1';
                }, 1500);
                return;
            }
            const data: unknown = await res.json().catch(() => null);
            const code = data && typeof data === 'object' ? (data as { code?: unknown }).code : undefined;
            setError(
                isChangePasswordRefusal(code)
                    ? t(REFUSAL_LABEL[code] as Parameters<typeof t>[0])
                    : apiErrorMessage(data, t('couldNotChange')),
            );
        } catch {
            setError(t('couldNotChange'));
        }
        setLoading(false);
    };

    return (
        <Card className="animate-fadeIn">
            <Heading level={2} className="mb-6">
                {t('changePasswordTitle')}
            </Heading>

            {success ? (
                <InlineNotice variant="success" className="mb-4" icon={null}>
                    {t('passwordChangedRedirect')}
                </InlineNotice>
            ) : (
                <>
                    {error && (
                        <InlineNotice variant="error" className="mb-4" icon={null}>
                            {error}
                        </InlineNotice>
                    )}

                    <form onSubmit={handleSubmit} className="space-y-default">
                        <FormField label={t('currentPassword')} required>
                            <Input
                                type="password"
                                name="currentPassword"
                                value={currentPassword}
                                onChange={(e) => setCurrentPassword(e.target.value)}
                                required
                                placeholder={t('currentPasswordPlaceholder')}
                            />
                        </FormField>
                        <FormField label={t('newPassword')} required>
                            <Input
                                type="password"
                                name="newPassword"
                                value={newPassword}
                                onChange={(e) => setNewPassword(e.target.value)}
                                required
                                placeholder={t('newPasswordPlaceholder')}
                            />
                        </FormField>
                        <FormField label={t('confirmPassword')} required>
                            <Input
                                type="password"
                                name="confirmPassword"
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                required
                                placeholder={t('confirmPasswordPlaceholder')}
                            />
                        </FormField>
                        <Button type="submit" variant="primary" size="sm" className="w-full" disabled={loading}>
                            {loading ? t('changing') : t('changePassword')}
                        </Button>
                    </form>
                </>
            )}
        </Card>
    );
}
