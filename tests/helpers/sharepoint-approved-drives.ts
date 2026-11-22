/**
 * Wrap a test's fetch mock so the SharePoint client's approved-drive lookup is
 * answered here, and every other request reaches the mock unchanged.
 *
 * The client resolves the drives of each approved site (`GET
 * /sites/{id}/drives`) before it reads or writes a drive. Tests that script
 * the Graph responses with `mockResolvedValueOnce` would otherwise have that
 * lookup consume their first scripted answer. Answering it here keeps the
 * mock's call list exactly the calls the test is about.
 */
const DRIVES_PATH = /^https:\/\/graph\.microsoft\.com\/v1\.0\/sites\/[^/?]+\/drives(\?|$)/;

export function withApprovedDrives<F extends (...args: never[]) => unknown>(
    fetchImpl: F,
    driveIds: string[] = ['drv1', 'd1'],
): F {
    const wrapped = (...args: Parameters<F>) => {
        const url = String((args as unknown[])[0]);
        if (DRIVES_PATH.test(url)) {
            const body = { value: driveIds.map((id) => ({ id })) };
            return Promise.resolve({
                ok: true,
                status: 200,
                json: async () => body,
            } as unknown as Response);
        }
        return fetchImpl(...args);
    };
    return wrapped as unknown as F;
}
