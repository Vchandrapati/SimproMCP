import { SimproClient, SimproError } from "./client.ts";

export class QuoteBusyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "QuoteBusyError";
    }
}

const BUSY = /currently (locked|opened) by/i;
const NOT_HELD = /must acquire the lock/i;

/** True when there's nothing of ours to release: the write dropped it, or someone else now has the quote. */
function lockNotOurs(error: unknown) {
    return error instanceof SimproError && error.status === 422 && (NOT_HELD.test(error.detail) || BUSY.test(error.detail));
}

/** Maps Simpro's "currently locked by X" 422 to a typed error. */
export function asBusy(error: unknown): QuoteBusyError | null {
    if (error instanceof SimproError && error.status === 422 && BUSY.test(error.detail)) {
        return new QuoteBusyError(error.detail);
    }
    return null;
}

/**
 * Runs one write under the quote lock. Live testing on 2026-11-05 and 2026-11-06 showed:
 * - every POST, PATCH or DELETE drops the lock, so it must be retaken per write;
 * - staff are blocked while the API holds it, so it is held only for this call;
 * - releasing a lock that is already gone returns 422 "Must acquire the lock", which is normal.
 * So the lock is only released when the write fails, since a successful write has already
 * dropped it. A failed release is logged rather than thrown, so the write's own error is kept.
 */
export async function withQuoteLock<T>(client: SimproClient, quoteId: number, write: () => Promise<T>): Promise<T> {
    const path = `quotes/${quoteId}/lock/`;
    try {
        await client.post(path);
    } catch (error) {
        throw asBusy(error) ?? error;
    }
    try {
        return await write();
    } catch (error) {
        try {
            await client.delete(path);
        } catch (releaseError) {
            if (!lockNotOurs(releaseError)) console.error(`Could not release the lock on quote ${quoteId}; staff may be blocked`, releaseError);
        }
        throw asBusy(error) ?? error;
    }
}
