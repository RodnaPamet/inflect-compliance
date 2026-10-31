'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Heading } from '@/components/ui/typography';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@/lib/auth/password-limits';
import { isResetPasswordRefusal, type ResetPasswordRefusal } from '@/lib/auth/reset-password-refusals';

/**
 * A refusal the route names, said from the catalogue instead of the route's
 * English sentence (#4688). A link refusal also offers a new link.
 */
const LINK_REFUSALS: ReadonlySet<ResetPasswordRefusal> = new Set(['RESET_LINK_EXPIRED', 'RESET_LINK_INVALID']);

function ResetPasswordForm() {
    const t = useTranslations('auth.reset');
    const searchParams = useSearchParams();
    const token = searchParams?.get('token') ?? '';

    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [error, setError] = useState('');
    const [linkRefused, setLinkRefused] = useState(false);
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        setError('');
        setLinkRefused(false);

        if (!newPassword || !confirmPassword) {
            setError(t('fillBoth'));
            return;
        }
        if (newPassword !== confirmPassword) {
            setError(t('passwordsNoMatch'));
            return;
        }
        if (newPassword.length < MIN_PASSWORD_LENGTH) {
            setError(t('tooShort'));
            return;
        }
        if (newPassword.length > MAX_PASSWORD_LENGTH) {
            setError(t('tooLong'));
            return;
        }

        setLoading(true);
        try {
            const res = await fetch('/api/auth/reset-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, newPassword }),
            });
            if (res.ok) {
                window.location.href = '/login?reset=success';
                return;
            }
            if (res.status === 429) {
                setError(t('tooManyAttempts'));
            } else {
                const data: unknown = await res.json().catch(() => null);
                const code = data && typeof data === 'object' ? (data as { code?: unknown }).code : undefined;
                if (isResetPasswordRefusal(code)) {
                    setError(t(`refused.${code}`));
                    setLinkRefused(LINK_REFUSALS.has(code));
                } else {
                    const sentence = data && typeof data === 'object' ? (data as { error?: unknown }).error : undefined;
                    setError(typeof sentence === 'string' && sentence ? sentence : t('couldNotReset'));
                }
            }
        } catch {
            setError(t('couldNotReset'));
        }
        setLoading(false);
    };

    return (
        <div className="min-h-screen flex items-center justify-center bg-bg-page p-4">
            {/* Background effects */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <div className="absolute -top-40 -right-40 w-80 h-80 rounded-full bg-[var(--brand-default)]/10 blur-3xl" />
                <div className="absolute -bottom-40 -left-40 w-80 h-80 rounded-full bg-[var(--brand-emphasis)]/10 blur-3xl" />
            </div>

            <div className="relative w-full max-w-md">
                {/* Logo */}
                <div className="text-center mb-8 animate-fadeIn">
                    <div className="inline-flex items-center gap-tight mb-2">
                        <div className="w-10 h-10 rounded-lg bg-[var(--brand-default)] flex items-center justify-center">
                            <svg className="w-6 h-6 text-content-inverted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                            </svg>
                        </div>
                    </div>
                </div>

                {/* Form */}
                <Card className="animate-fadeIn">
                    <Heading level={2} className="mb-6">
                        {t('chooseNewTitle')}
                    </Heading>

                    {!token ? (
                        <>
                            <InlineNotice variant="warning" className="mb-4" icon={null}>
                                {t('invalidLink')}
                            </InlineNotice>
                            <div className="mt-6 text-center text-sm text-content-muted">
                                <a href="/forgot-password" className="text-content-emphasis underline underline-offset-2 hover:text-[var(--brand-default)]">
                                    {t('requestNewLink')}
                                </a>
                            </div>
                        </>
                    ) : (
                        <>
                            {error && (
                                <InlineNotice variant="error" className="mb-4" icon={null}>
                                    {error}
                                    {linkRefused && (
                                        <>
                                            {' '}
                                            <a
                                                href="/forgot-password"
                                                id="reset-request-new-link"
                                                className="underline underline-offset-2"
                                            >
                                                {t('requestNewLink')}
                                            </a>
                                        </>
                                    )}
                                </InlineNotice>
                            )}

                            <form onSubmit={handleSubmit} className="space-y-default">
                                <FormField label={t('newPasswordLabel')} required>
                                    <Input
                                        type="password"
                                        name="newPassword"
                                        value={newPassword}
                                        onChange={(e) => setNewPassword(e.target.value)}
                                        required
                                        placeholder={t('newPasswordPlaceholder')}
                                    />
                                </FormField>
                                <FormField label={t('confirmLabel')} required>
                                    <Input
                                        type="password"
                                        name="confirmPassword"
                                        value={confirmPassword}
                                        onChange={(e) => setConfirmPassword(e.target.value)}
                                        required
                                        placeholder={t('confirmPlaceholder')}
                                    />
                                </FormField>
                                <Button type="submit" variant="primary" size="sm" className="w-full" disabled={loading}>
                                    {loading ? t('resetting') : t('resetPassword')}
                                </Button>
                            </form>

                            <div className="mt-6 text-center text-sm text-content-muted">
                                <a href="/login" className="text-content-emphasis underline underline-offset-2 hover:text-[var(--brand-default)]">
                                    {t('backToSignIn')}
                                </a>
                            </div>
                        </>
                    )}
                </Card>
            </div>
        </div>
    );
}

function ResetPasswordFallback() {
    const t = useTranslations('common');
    return (
        <div className="min-h-screen flex items-center justify-center bg-bg-page">
            <div className="text-content-muted">{t('loading')}</div>
        </div>
    );
}

export default function ResetPasswordPage() {
    return (
        <Suspense fallback={<ResetPasswordFallback />}>
            <ResetPasswordForm />
        </Suspense>
    );
}
