import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ShieldSlash } from '@inflect/ui/components/ui/icons/nucleo';
import { buttonVariants } from '@/components/ui/button-variants';
import { Heading } from '@/components/ui/typography';

/**
 * What an organization member sees on an org page their role cannot use
 * (#4845). It names the role that can and leads back to the portfolio.
 *
 * It replaces two answers that were each wrong in its own way: reading the
 * data anyway (the drill-down lists, which a Reader could open by URL), and
 * throwing `forbidden(...)`, which the root error boundary renders as
 * "an unexpected error has occurred. Our team has been notified" and reports
 * as a crash. A member is not an outsider, so this is a refusal they can read,
 * not the 404 a non-member gets from the layout.
 */
export async function OrgForbiddenPage({ orgSlug, message }: { orgSlug: string; message: string }) {
    const t = await getTranslations('org.forbidden');
    return (
        <div
            className="flex flex-col items-center justify-center min-h-[60vh] text-center px-4"
            data-testid="org-forbidden"
        >
            <div className="w-16 h-16 rounded-lg bg-bg-error flex items-center justify-center mb-6">
                <ShieldSlash className="w-8 h-8 text-content-error" aria-hidden="true" />
            </div>
            <Heading level={1} className="text-content-emphasis mb-2" id="org-forbidden-heading">
                {t('title')}
            </Heading>
            <p className="text-content-muted text-sm max-w-md mb-8">{message}</p>
            <Link href={`/org/${orgSlug}`} className={buttonVariants({ variant: 'primary' })} id="org-forbidden-back">
                {t('back')}
            </Link>
        </div>
    );
}
