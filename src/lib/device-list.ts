/**
 * The Devices inventory shows at most this many devices. The usecase reads one
 * more, so the page can tell "500 devices" from "the first 500 of more" and say
 * so, rather than presenting a cut list as the whole inventory (#4816).
 *
 * Pure and client-safe: the page's client component imports it for the banner.
 */
export const DEVICE_LIST_CAP = 500;
