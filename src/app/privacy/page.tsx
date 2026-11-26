/**
 * Public privacy policy — /privacy (#5957).
 *
 * UNAUTHENTICATED. The policy Google's OAuth verification asks for (owner
 * decision 2026-11-25: the whole product's policy, hosted in the app, in both
 * languages), including the Limited Use statement for data received from
 * Google APIs. The text is `external.privacyPolicy` in `messages/*.json`; its
 * shape is `PRIVACY_POLICY_SECTIONS`, and a unit test holds the two equal in
 * both languages. The page reads no database row and names no tenant. Exact
 * path in `PUBLIC_PATH_EXACT`.
 */
import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Heading } from '@/components/ui/typography';
import {
    CONTROLLER_UIC,
    GOOGLE_API_USER_DATA_POLICY_URL,
    PRIVACY_CONTACT_EMAIL,
    PRIVACY_POLICY_EFFECTIVE,
    PRIVACY_POLICY_SECTIONS,
} from '@/lib/public-site/legal-facts';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const tMeta = await getTranslations('external.privacyPolicy');
    return { title: tMeta('metaTitle'), robots: { index: true, follow: true } };
}

function range(n: number | undefined): number[] {
    return Array.from({ length: n ?? 0 }, (_, i) => i + 1);
}

export default async function PrivacyPolicyPage() {
    const t = await getTranslations('external.privacyPolicy');
    const tLegal = await getTranslations('external.legal');
    const locale = await getLocale();

    const effective = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(
        new Date(`${PRIVACY_POLICY_EFFECTIVE}T00:00:00Z`),
    );
    const values = {
        name: tLegal('name'),
        uic: CONTROLLER_UIC,
        address: tLegal('address'),
        mail: (): ReactNode => (
            <a href={`mailto:${PRIVACY_CONTACT_EMAIL}`} className="underline">
                {PRIVACY_CONTACT_EMAIL}
            </a>
        ),
        policy: (chunks: ReactNode): ReactNode => (
            <a href={GOOGLE_API_USER_DATA_POLICY_URL} className="underline" rel="noopener noreferrer">
                {chunks}
            </a>
        ),
    };
    const paragraph = (key: string) => (
        <p key={key} className="text-content-default">
            {t.rich(key, values)}
        </p>
    );

    return (
        <main className="mx-auto max-w-3xl px-6 py-12 space-y-section">
            <header className="space-y-default">
                <Heading level={1}>{t('title')}</Heading>
                <p className="text-content-muted">{t('effective', { date: effective })}</p>
                <Link href="/about" className="text-sm text-content-emphasis underline">
                    {t('backToAbout')}
                </Link>
            </header>

            {PRIVACY_POLICY_SECTIONS.map((section) => {
                const base = `sections.${section.id}`;
                return (
                    <section key={section.id} className="space-y-default" aria-labelledby={`privacy-${section.id}`}>
                        <Heading level={2} id={`privacy-${section.id}`}>
                            {t(`${base}.heading`)}
                        </Heading>
                        {range(section.before).map((n) => paragraph(`${base}.p${n}`))}
                        {section.list && (
                            <ul className="list-disc space-y-tight pl-6 text-content-default">
                                {section.list.map((item) => (
                                    <li key={item}>{t.rich(`${base}.items.${item}`, values)}</li>
                                ))}
                            </ul>
                        )}
                        {range(section.after).map((n) => paragraph(`${base}.a${n}`))}
                    </section>
                );
            })}
        </main>
    );
}
