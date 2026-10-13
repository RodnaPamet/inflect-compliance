/**
 * Request headers for Microsoft Graph — the one place that knows about
 * `Accept-Language` (#3458).
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * Node's built-in `fetch` (undici) sends `Accept-Language: *` among its
 * default headers. Several Graph backends parse that header into a .NET
 * `CultureInfo`, and `*` is not a culture identifier, so the request fails:
 *
 *     400 {"error":{"code":"UnknownError","message":
 *       "{\"ErrorCode\":\"CultureNotFoundException\",
 *         \"Message\":\"Culture is not supported.\\r\\nParameter name: name\\r\\n
 *          * is an invalid culture identifier.\"}"}}
 *
 * Measured live against tenant 5c459bc6 on 2026-10-13: every Privileged
 * Identity Management endpoint returned 400 this way, on both `v1.0` and
 * `beta`, bare and filtered, with a correctly-scoped token. Setting a real
 * culture turned ten of ten into 200. `$filter`, `ConsistencyLevel` and the
 * beta endpoint changed nothing; the header alone did.
 *
 * Not every Graph backend parses it — `roleDefinitions`, `roleAssignments`,
 * users, groups and access packages all answer 200 either way, which is why
 * this went unnoticed for as long as our surface avoided the ones that do.
 * That makes it a tripwire rather than an outage: it waits for whoever adds
 * the first call to an affected endpoint, and greets them with
 * `UnknownError` on a request that is correct in every visible respect.
 *
 * ═══ WHY IT TAKES NO `Accept` ═══
 *
 * Deliberately additive. Callers keep whatever `Accept` they already sent,
 * because not all of them want JSON: the profile-photo fetch in `src/auth.ts`
 * reads `/me/photos/48x48/$value`, which is binary, and sends no `Accept` at
 * all. A helper that defaulted `Accept: application/json` would have broken
 * avatars to fix PIM. Pass it in `extra` where you want it.
 */

/**
 * The culture sent to Graph. Must be a REAL culture identifier — the defect
 * being fixed is that `*` is not one, so a wildcard or an empty string here
 * reintroduces it.
 */
export const GRAPH_ACCEPT_LANGUAGE = 'en-US';

/**
 * Headers for a Microsoft Graph request.
 *
 * @param accessToken bearer token for the call
 * @param extra       merged last, so a caller can set `Accept` or override
 *                    anything here for one request
 */
export function graphHeaders(
    accessToken: string,
    extra?: Record<string, string>,
): Record<string, string> {
    return {
        Authorization: `Bearer ${accessToken}`,
        'Accept-Language': GRAPH_ACCEPT_LANGUAGE,
        ...extra,
    };
}
