import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { buttonVariants } from '@/components/ui/button-variants';
import { Heading } from '@/components/ui/typography';

/**
 * Global Not Found Boundary (404).
 * Polish PR-4 / PR-9 — uses semantic tokens + Button-variant Link
 * instead of hand-rolled gray utility classes / `transition-all`.
 */
export default async function NotFound() {
    const t = await getTranslations('errorPage');
    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-bg-page p-6">
            <div className="max-w-md w-full text-center space-y-section">
                <div className="text-content-emphasis font-semibold text-6xl tracking-tighter tabular-nums">
                    404
                </div>

                <div>
                    <Heading level={1} className="mb-3">
                        {t('notFoundTitle')}
                    </Heading>
                    <p className="text-sm text-content-muted">
                        {t('notFoundBody')}
                    </p>
                </div>

                <div className="pt-6">
                    <Link
                        href="/tenants"
                        className={buttonVariants({ variant: 'primary' })}
                    >
                        {t('returnToDashboard')}
                    </Link>
                </div>
            </div>
        </div>
    );
}
