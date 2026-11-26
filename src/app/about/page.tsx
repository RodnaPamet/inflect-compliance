/**
 * Public home page — /about (#5957).
 *
 * UNAUTHENTICATED. Google's OAuth verification for the calendar push asks for
 * a public home page, on a verified domain, that says what the app is and links
 * to its privacy policy (owner decision 2026-11-25: host it in the app). The
 * page reads no database row and names no tenant; every fact on it is static
 * copy or `src/lib/public-site/legal-facts.ts`. Exact path in
 * `PUBLIC_PATH_EXACT`.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Heading } from '@/components/ui/typography';
import { ABOUT_FEATURES, CONTROLLER_UIC, PRIVACY_CONTACT_EMAIL } from '@/lib/public-site/legal-facts';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const tMeta = await getTranslations('external.publicAbout');
    return { title: tMeta('metaTitle'), robots: { index: true, follow: true } };
}

export default async function AboutPage() {
    const t = await getTranslations('external.publicAbout');
    const tLegal = await getTranslations('external.legal');

    return (
        <main className="mx-auto max-w-3xl px-6 py-12 space-y-section">
            <header className="space-y-default">
                <Heading level={1}>{t('title')}</Heading>
                <p className="text-lg text-content-default">{t('tagline')}</p>
                <p className="text-content-muted">{t('intro')}</p>
            </header>

            <section className="space-y-default" aria-labelledby="about-features">
                <Heading level={2} id="about-features">{t('featuresHeading')}</Heading>
                <ul className="list-disc space-y-tight pl-6 text-content-default">
                    {ABOUT_FEATURES.map((key) => (
                        <li key={key}>{t(`features.${key}`)}</li>
                    ))}
                </ul>
            </section>

            <section className="space-y-default" aria-labelledby="about-access">
                <Heading level={2} id="about-access">{t('accessHeading')}</Heading>
                <p className="text-content-default">{t('accessBody')}</p>
                <nav className="flex flex-wrap gap-default" aria-label={t('title')}>
                    <Link href="/login" className="text-content-emphasis underline">
                        {t('signIn')}
                    </Link>
                    <Link href="/privacy" className="text-content-emphasis underline">
                        {t('privacyLink')}
                    </Link>
                </nav>
            </section>

            <footer className="space-y-tight border-t border-border-subtle pt-default text-sm text-content-muted">
                <p>{t('operator', { name: tLegal('name'), uic: CONTROLLER_UIC, address: tLegal('address') })}</p>
                <p>
                    {t.rich('contact', {
                        mail: () => (
                            <a href={`mailto:${PRIVACY_CONTACT_EMAIL}`} className="underline">
                                {PRIVACY_CONTACT_EMAIL}
                            </a>
                        ),
                    })}
                </p>
            </footer>
        </main>
    );
}
