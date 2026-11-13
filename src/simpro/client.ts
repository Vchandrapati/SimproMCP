import { isAllowed } from "./allowlist.ts";

export class SimproError extends Error {
    readonly status: number;
    readonly detail: string;

    constructor(status: number, detail: string, path: string) {
        super(`Simpro returned ${status} for ${path}: ${detail}`);
        this.name = "SimproError";
        this.status = status;
        this.detail = detail;
    }
}

export type SimproConnection = {
    baseUrl: string;
    companyId: number;
    token: string;
    maxRequestsPerSecond?: number;
};

type Fetch = typeof fetch;
type Params = Record<string, string | number | boolean>;

const PAGE_SIZE = 250;
const MAX_PAGES = 40;
const MAX_RATE_RETRIES = 2;

/** Pulls the first readable message out of Simpro's {"errors":[{"message":...}]} body. */
export function errorDetail(body: string): string {
    try {
        const parsed = JSON.parse(body) as { errors?: { message?: string; path?: string | null }[] };
        const first = parsed.errors?.[0];
        if (first?.message) return first.path ? `${first.path}: ${first.message}` : first.message;
    } catch {
        // Not JSON, fall through to the raw text.
    }
    return body.slice(0, 300);
}

/** All Simpro traffic goes through here, and anything off the allowlist is refused before sending. */
export class SimproClient {
    private readonly base: string;
    private readonly token: string;
    private readonly fetchImpl: Fetch;
    private readonly maxPerSecond: number;
    private readonly sleep: (ms: number) => Promise<void>;
    private recent: number[] = [];
    private gate: Promise<void> = Promise.resolve();

    constructor(
        connection: SimproConnection,
        fetchImpl: Fetch = fetch,
        sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
    ) {
        this.base = `${connection.baseUrl.replace(/\/$/, "")}/api/v1.0/companies/${connection.companyId}/`;
        this.token = connection.token;
        this.fetchImpl = fetchImpl;
        this.maxPerSecond = connection.maxRequestsPerSecond ?? 8;
        this.sleep = sleep;
    }

    /** Callers queue here one at a time, so concurrent requests still respect the cap. */
    private throttle(): Promise<void> {
        const turn = this.gate.then(() => this.waitForSlot());
        this.gate = turn.catch(() => undefined);
        return turn;
    }

    private async waitForSlot() {
        const now = Date.now();
        this.recent = this.recent.filter((at) => now - at < 1000);
        if (this.recent.length >= this.maxPerSecond) {
            await this.sleep(1000 - (now - this.recent[0]));
        }
        this.recent.push(Date.now());
    }

    private async send(method: string, path: string, params?: Params, body?: unknown): Promise<Response> {
        if (!isAllowed(method, path)) {
            throw new Error(`Blocked by the endpoint allowlist: ${method} ${path}`);
        }
        const url = new URL(path, this.base);
        for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, String(value));

        for (let attempt = 0; ; attempt++) {
            await this.throttle();
            const response = await this.fetchImpl(url, {
                method,
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    Accept: "application/json",
                    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(30_000),
            });
            if (response.status !== 429 || attempt >= MAX_RATE_RETRIES) return response;
            const wait = Number(response.headers.get("retry-after"));
            await this.sleep(Number.isFinite(wait) && wait > 0 ? wait * 1000 : 1000);
        }
    }

    private async json<T>(response: Response, path: string): Promise<T> {
        const text = await response.text();
        if (!response.ok) throw new SimproError(response.status, errorDetail(text), path);
        return (text ? JSON.parse(text) : undefined) as T;
    }

    async get<T>(path: string, params?: Params): Promise<T> {
        return this.json<T>(await this.send("GET", path, params), path);
    }

    /** Reads every page, and fails rather than returning a partial list. */
    async getAll<T>(path: string, params?: Params): Promise<T[]> {
        const rows: T[] = [];
        for (let page = 1; page <= MAX_PAGES; page++) {
            const response = await this.send("GET", path, { ...params, pageSize: PAGE_SIZE, page });
            const batch = await this.json<T[]>(response, path);
            rows.push(...batch);
            const pages = Number(response.headers.get("result-pages") ?? 1);
            if (page >= pages || batch.length === 0) return rows;
        }
        throw new Error(`${path} has more than ${MAX_PAGES} pages; narrow the search`);
    }

    async post<T>(path: string, body?: unknown): Promise<T> {
        return this.json<T>(await this.send("POST", path, undefined, body), path);
    }

    async patch(path: string, body: unknown): Promise<void> {
        await this.json<void>(await this.send("PATCH", path, undefined, body), path);
    }

    async delete(path: string): Promise<void> {
        await this.json<void>(await this.send("DELETE", path), path);
    }
}
