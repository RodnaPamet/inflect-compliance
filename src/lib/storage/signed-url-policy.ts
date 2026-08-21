/**
 * How long a presigned download URL lives.
 *
 * A signed URL is a BEARER credential: once minted it works for anyone holding
 * it, is replayable, is visible to intermediaries, and is outside our
 * revocation — quarantining the row it points at does not stop it. Its lifetime
 * is therefore the exposure window for those bytes, and the only lever we have
 * over it is this number.
 *
 * It lives in its own leaf module (no imports, so any layer can read it) because
 * two places must agree on it: `downloadEvidenceFile`, which mints the URL, and
 * the download route, which records the window that URL opens in the file
 * distribution ledger. If they drift, the ledger states an expiry the URL does
 * not honour and the exposure report built from it is wrong.
 *
 * #2040 is the cautionary tale: the trust-center path passed no `expiresIn` at
 * all and inherited the s3-provider's `?? 3600` fallback — twelve times more
 * generous than its authenticated sibling, by omission rather than decision.
 * Shortening this is always safe; lengthening it needs a reason written here.
 */
export const SIGNED_DOWNLOAD_URL_TTL_SECONDS = 300;
