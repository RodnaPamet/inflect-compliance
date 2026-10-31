'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Heading } from '@/components/ui/typography';

export default function ForgotPasswordPage() {
    const t = useTranslations('auth.forgot');
    const [email, setEmail] = useState('');
    const [loading, setLoading] = useState(false);
    const [submitted, setSubmitted] = useState(false);
    const [rateLimited, setRateLimited] = useState(false);

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        setLoading(true);
        setRateLimited(false);
        try {
            const res = await fetch('/api/auth/forgot-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email }),
            });
            // The one outcome the page does tell apart (#4687): the limit is
            // keyed on the network address, not the account, so saying it
            // reveals nothing about any account. Claiming "sent" left the
            // person waiting for an email that was never going to arrive.
            if (res.status === 429) {
                setRateLimited(true);
                setLoading(false);
                return;
            }
        } catch {
            // Uniform response is the whole point — we never branch on
            // whether an account exists. Network errors get the same
            // "submitted" state so the UI never leaks whether the email is
            // registered.
        }
        setSubmitted(true);
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
                        {t('resetTitle')}
                    </Heading>

                    {submitted ? (
                        <>
                            <InlineNotice variant="success" className="mb-4" icon={null}>
                                {t('resetSent')}
                            </InlineNotice>
                            <div className="mt-6 text-center text-sm text-content-muted">
                                <a href="/login" className="text-content-emphasis underline underline-offset-2 hover:text-[var(--brand-default)]">
                                    {t('backToSignIn')}
                                </a>
                            </div>
                        </>
                    ) : (
                        <>
                            <p className="text-content-muted text-sm mb-4">
                                {t('resetIntro')}
                            </p>
                            {rateLimited && (
                                <InlineNotice variant="error" className="mb-4" icon={null}>
                                    {t('tooManyRequests')}
                                </InlineNotice>
                            )}
                            <form onSubmit={handleSubmit} className="space-y-default">
                                <FormField label={t('emailLabel')} required>
                                    <Input
                                        type="email"
                                        name="email"
                                        value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                        required
                                        placeholder={t('emailPlaceholder')}
                                    />
                                </FormField>
                                <Button type="submit" variant="primary" size="sm" className="w-full" disabled={loading}>
                                    {loading ? t('sending') : t('sendResetLink')}
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
