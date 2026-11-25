/**
 * Hand the browser to a calendar provider's sign-in page.
 *
 * A module of its own so a rendered test can replace it: jsdom implements no
 * navigation, and its `window.location` cannot be spied on.
 */
export function leaveForProvider(authorizeUrl: string): void {
    window.location.assign(authorizeUrl);
}
