'use client'; // Error boundaries must be Client Components

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import * as Sentry from '@sentry/nextjs';
import { ErrorState } from '@/components/ui/error-state';
import { Card } from '@/components/ui/card';

/**
 * Global Error Boundary for the Next.js App Router.
 * Automatically catches unhandled errors in server and client components
 * within the `/app` directory, preventing the app from crashing entirely.
 *
 * R11-PR3 — routes the root error chrome through the shared
 * `<ErrorState>` primitive so failures read consistently with in-card
 * error fallbacks (e.g. failed list fetches) and with the (app)/error.tsx
 * sub-route boundary.
 */
export default function GlobalError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    const t = useTranslations('errorPage');
    useEffect(() => {
        // Report to Sentry — wrapped in try/catch so the error boundary
        // itself never crashes (which causes "missing required error components")
        try {
            Sentry.captureException(error, {
                tags: { digest: error.digest || 'none' },
            });
        } catch {
            console.error('[error.tsx] Failed to report to Sentry:', error);
        }
    }, [error]);

    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-bg-page p-6">
            <Card elevation="floating" className="max-w-md w-full">
                <ErrorState
                    title={t('title')}
                    description={
                        <>
                            {t('description')}
                            {error.digest && (
                                <span className="block mt-2 text-xs font-mono text-content-subtle">
                                    {t('errorId', { id: error.digest })}
                                </span>
                            )}
                        </>
                    }
                    onRetry={() => reset()}
                    secondaryAction={{
                        label: t('goToDashboard'),
                        onClick: () => {
                            window.location.href = '/tenants';
                        },
                    }}
                    data-testid="global-error"
                />
            </Card>
        </div>
    );
}
