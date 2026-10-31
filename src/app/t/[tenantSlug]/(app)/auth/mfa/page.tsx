'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { ShieldCheck, KeyRound, AlertTriangle } from 'lucide-react';
import { Heading } from '@/components/ui/typography';
import { Card } from '@/components/ui/card';
import { refreshSessionCookie } from '@/lib/auth/refresh-session-cookie';

/**
 * MFA Challenge Page — shown when mfaPending is true.
 * User must enter a TOTP code to continue.
 *
 * After successful verification, redirects to the original target page
 * (or tenant home if no target is specified).
 */
export default function MfaChallengePage() {
    const t = useTranslations('mfa');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const searchParams = useSearchParams();
    // Default to /dashboard, not /, because `/t/<slug>/` has no
    // page.tsx (404) and post-MFA navigation would land on a broken
    // route if the URL didn't carry an explicit `next`.
    const next = searchParams.get('next') || tenantHref('/dashboard');

    const [code, setCode] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [attempts, setAttempts] = useState(0);

    // Check if user has MFA enrolled
    const [enrolled, setEnrolled] = useState<boolean | null>(null);
    const checkEnrollment = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/security/mfa/enroll'));
            if (res.ok) {
                const data = await res.json();
                setEnrolled(data.isVerified);
            }
        } catch {
            // Fail silently
        }
    }, [apiUrl]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { void checkEnrollment(); }, [checkEnrollment]);

    const handleVerify = async () => {
        if (code.length !== 6 || !/^\d{6}$/.test(code)) {
            setError(t('invalidCodeFormat'));
            return;
        }
        setSubmitting(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/security/mfa/challenge/verify'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code }),
            });
            const data = await res.json();

            if (data.success) {
                // MFA challenge complete. Rewrite the session cookie first:
                // the edge gate reads `mfaPending` from it, and nothing else
                // re-signs it, so navigating straight on returns here.
                await refreshSessionCookie();
                window.location.href = next;
            } else {
                setAttempts(a => a + 1);
                setCode('');
                setError(attempts >= 4 ? t('tooManyAttempts') : t('invalidCode'));
            }
        } catch {
            setError(t('verifyFailed'));
        } finally {
            setSubmitting(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && code.length === 6) {
            void handleVerify();
        }
    };

    // If not enrolled, show enrollment redirect
    if (enrolled === false) {
        return (
            <div className="min-h-[60vh] flex items-center justify-center">
                <Card className="max-w-md w-full space-y-default text-center">
                    <div className="flex justify-center">
                        <div className="w-16 h-16 rounded-full bg-bg-warning flex items-center justify-center">
                            <AlertTriangle className="w-8 h-8 text-content-warning" />
                        </div>
                    </div>
                    <Heading level={1}>{t('enrollRequiredTitle')}</Heading>
                    <p className="text-sm text-content-muted">
                        {t('enrollRequiredBody')}
                    </p>
                    <a
                        href={tenantHref('/security/mfa')}
                        className={buttonVariants({ variant: 'primary', className: 'w-full justify-center' })}
                        id="mfa-go-enroll-btn"
                    >
                        <KeyRound className="w-4 h-4" />
                        {t('setUpMfa')}
                    </a>
                </Card>
            </div>
        );
    }

    return (
        <div className="min-h-[60vh] flex items-center justify-center">
            <Card className="max-w-md w-full space-y-default">
                <div className="flex justify-center">
                    <div className="w-16 h-16 rounded-full bg-[var(--brand-subtle)] flex items-center justify-center">
                        <ShieldCheck className="w-8 h-8 text-[var(--brand-default)]" />
                    </div>
                </div>

                <div className="text-center">
                    <Heading level={1}>{t('verifyTitle')}</Heading>
                    <p className="text-sm text-content-muted mt-2">
                        {t('verifyBody')}
                    </p>
                </div>

                {error && (
                    <div className="p-3 rounded-lg border border-border-error bg-bg-error text-sm text-content-error text-center">
                        {error}
                    </div>
                )}

                <div className="flex flex-col items-center gap-default">
                    <input
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        placeholder="000000"
                        value={code}
                        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        onKeyDown={handleKeyDown}
                        className="input text-center text-2xl font-mono tracking-[0.4em] w-full sm:w-48 py-3"
                        id="mfa-challenge-input"
                        autoFocus
                        autoComplete="one-time-code"
                    />

                    <Button
                        variant="primary"
                        onClick={handleVerify}
                        disabled={submitting || code.length !== 6}
                        className="w-full justify-center"
                        id="mfa-challenge-submit"
                    >
                        {submitting ? t('verifying') : t('continueBtn')}
                    </Button>
                </div>

                <p className="text-xs text-content-subtle text-center">
                    {t('cantAccess')}
                </p>
            </Card>
        </div>
    );
}
