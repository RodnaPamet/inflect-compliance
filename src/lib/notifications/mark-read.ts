/**
 * The request that marks one notification read through the tenant route,
 * `PUT /api/t/:slug/notifications/:id`.
 *
 * It lives here rather than inline in the notifications page so the route's
 * own test can replay exactly what the page sends. The page used to send a
 * bare PATCH, which that route does not export, so every "Mark read" was a
 * 405 that the page then rolled back. The route reads its body through
 * `withValidatedBody(EmptyBodySchema, …)`, which parses JSON, so the empty
 * object is required, not decoration: a PUT with no body is a 400.
 */
export const MARK_NOTIFICATION_READ_REQUEST = Object.freeze({
    method: 'PUT',
    headers: Object.freeze({ 'Content-Type': 'application/json' }),
    body: '{}',
});
