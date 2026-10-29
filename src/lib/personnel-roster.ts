/**
 * The most people one personnel roster read returns (#4470).
 *
 * `listEmployees` reads one row past this, so it can tell a roster that fits
 * from one that was cut, and reports `truncated` on the response. The admin
 * Personnel page names the number in its truncation notice.
 *
 * Both sides import it from here so the notice cannot name a different number
 * from the one the read applies. The module is dependency-free because a
 * client component imports it, and it must not pull Prisma into the bundle.
 */
export const PERSONNEL_ROSTER_CAP = 500;
