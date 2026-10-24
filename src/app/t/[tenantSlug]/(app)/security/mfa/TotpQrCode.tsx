'use client';

import { useEffect, useState } from 'react';
import { toDataURL, type QRCodeToDataURLOptions } from 'qrcode';

/**
 * Rendering options for the enrolment QR code.
 *
 * Exported so the rendered test can rebuild the image from the same otpauth
 * URI and compare it byte for byte — that is what proves the picture encodes
 * THIS enrolment rather than being any image at all.
 *
 *   - `errorCorrectionLevel: 'M'` — the qrcode default, stated so a library
 *     default changing cannot silently change the image.
 *   - `margin: 2` — two modules of quiet zone. Scanners need one; the white
 *     card around the image supplies the rest.
 *   - `width: 384` — drawn at twice the 192px it is displayed at, so it stays
 *     sharp on high-density screens.
 */
export const TOTP_QR_OPTIONS: QRCodeToDataURLOptions = {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 384,
};

type QrState =
    | { value: string; src: string }
    | { value: string; failed: true };

/**
 * The otpauth:// URI as a scannable QR code.
 *
 * Generated in the browser, from the URI the enrol-start response returned:
 * the URI carries the TOTP shared secret, so it is never sent anywhere to be
 * drawn. A `data:` image is allowed by the CSP (`img-src 'self' data: https:`,
 * src/lib/security/csp.ts).
 *
 * State is keyed by the value it was drawn from, so a new URI never shows the
 * previous image while its own is being drawn. If drawing fails the component
 * renders nothing, and the setup key beside it is the way in.
 */
export function TotpQrCode({ value, alt }: { value: string; alt: string }) {
    const [qr, setQr] = useState<QrState | null>(null);

    useEffect(() => {
        let cancelled = false;
        toDataURL(value, TOTP_QR_OPTIONS)
            .then((src) => {
                if (!cancelled) setQr({ value, src });
            })
            .catch(() => {
                if (!cancelled) setQr({ value, failed: true });
            });
        return () => {
            cancelled = true;
        };
    }, [value]);

    const current = qr?.value === value ? qr : null;

    if (current && 'failed' in current) return null;

    if (!current) {
        return (
            // Holds the image's place while it is drawn (a few milliseconds),
            // so the card does not jump when it arrives.
            <div className="h-48 w-48" aria-hidden="true" data-testid="mfa-qr-code-pending" />
        );
    }

    return (
        // A data: URI drawn in the browser — next/image would only add an
        // optimiser round-trip for a picture that never leaves the page.
        // eslint-disable-next-line @next/next/no-img-element
        <img
            src={current.src}
            alt={alt}
            width={192}
            height={192}
            className="h-48 w-48"
            id="mfa-qr-code"
            data-testid="mfa-qr-code"
        />
    );
}
