// A small in-memory stand-in for Simpro, built from behaviour seen in live tests.
import { SimproClient } from "../simpro/client.ts";

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const SECRET = "test-secret-test-secret-test-secret-1234";
export const Q = 500;
export const S = 10;
export const CC = 20;
export const NEW_S = 11;
export const NEW_CC = 21;

const TYPE_KEYS: Record<string, string> = {
    catalogs: "Catalogs",
    oneOffs: "OneOffs",
    labor: "Labors",
    serviceFees: "ServiceFees",
    prebuilds: "Prebuilds",
};

function amounts(line: Raw, unit: number, qty: number) {
    line.SellPrice = { ExTax: unit, ExDiscountExTax: unit };
    line.Total = { Qty: qty, Amount: { ExTax: unit * qty } };
}

export function catalogueLine(id: number, qty: number, cost = 12.6, markup = 100, order = 1): Raw {
    const line: Raw = {
        ID: id,
        Catalog: { ID: 40020, PartNo: "C-HM/HM-6", Name: "Kramer HDMI cable" },
        BasePrice: cost,
        Markup: markup,
        DisplayOrder: order,
        DateModified: "2026-11-06T09:00:00+11:00",
    };
    amounts(line, cost * (1 + markup / 100), qty);
    return line;
}

export function oneOffLine(id: number, qty: number, cost = 100, markup = 25, order = 2): Raw {
    const line: Raw = { ID: id, Description: "TEST one-off", EstimatedCost: cost, Markup: markup, DisplayOrder: order };
    amounts(line, cost * (1 + markup / 100), qty);
    return line;
}

export function feeLine(id: number, qty: number, price = 120, order = 3): Raw {
    const line: Raw = { ID: id, ServiceFee: { ID: 2, Name: "PROJECT CALL OUT" }, BasePrice: price, Markup: 0, DisplayOrder: order };
    amounts(line, price, qty);
    return line;
}

export function labourLine(id: number, hours: number, rate = 90, markup = 61.111111111111): Raw {
    const line: Raw = { ID: id, LaborType: { ID: 1, Name: "AV Installer" }, LaborRate: rate, LaborMarkup: markup };
    amounts(line, rate * (1 + markup / 100), hours);
    return line;
}

export type Fake = {
    client: SimproClient;
    calls: string[];
    state: {
        lines: Record<string, Raw[]>;
        logs: Raw[];
        stage: string;
        status: string;
        name: string;
        lockedBy: string | null;
        lockedAfterWrites: number | null;
        /** Makes writes land differently from what was sent. */
        corruptWrites: boolean;
        sections: Raw[];
        costCentres: Raw[];
    };
};

export function fakeSimpro(lines: Record<string, Raw[]>): Fake {
    const state: Fake["state"] = {
        lines,
        logs: [],
        stage: "InProgress",
        status: "Quote: To Be Completed",
        name: "Test quote",
        lockedBy: null,
        lockedAfterWrites: null,
        corruptWrites: false,
        sections: [{ ID: S, Name: "Main" }],
        costCentres: [{ ID: CC, SectionID: S, Name: "Equipment", CostCenter: { ID: 44, Name: "Corporate" }, ItemsLocked: false }],
    };
    const calls: string[] = [];
    let held = false;
    let writes = 0;

    const reply = (status: number, body?: unknown, headers?: Record<string, string>) =>
        new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
    const locked = () => reply(422, { errors: [{ path: null, message: `This quote is currently locked by ${state.lockedBy}. Please try again later.`, value: null }] });

    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = new URL(String(input));
        const path = url.pathname.replace(/^\/api\/v1\.0\/companies\/0\//, "");
        const method = init?.method ?? "GET";
        calls.push(`${method} ${path}`);
        const body = init?.body ? JSON.parse(String(init.body)) as Raw : undefined;

        if (method !== "GET" && state.lockedAfterWrites !== null && writes >= state.lockedAfterWrites) {
            state.lockedBy = "Shaun Peffer";
        }

        if (path === `quotes/${Q}/lock/`) {
            if (state.lockedBy) return locked();
            if (method === "POST") {
                held = true;
                return reply(201, []);
            }
            if (!held) return reply(422, { errors: [{ path: null, message: "Must acquire the lock to release it.", value: null }] });
            held = false;
            return reply(204);
        }

        if (method === "GET" && path === `quotes/${Q}`) {
            const sum = Object.values(state.lines).flat().reduce((total, line) => total + line.Total.Amount.ExTax, 0);
            return reply(200, {
                ID: Q,
                Name: state.name,
                Stage: state.stage,
                Status: { ID: 1, Name: state.status },
                IsClosed: false,
                DateModified: new Date().toISOString(),
                Customer: { CompanyName: "Test customer" },
                Total: { ExTax: sum, IncTax: sum * 1.1 },
                Totals: {},
                Sections: state.sections.map((section) => ({
                    ID: section.ID,
                    Name: section.Name,
                    CostCenters: state.costCentres.filter((centre) => centre.SectionID === section.ID).map((centre) => ({
                        ID: centre.ID,
                        Name: centre.Name,
                        Items: Object.fromEntries(Object.entries(TYPE_KEYS).map(([type, key]) => [
                            key,
                            centre.ID === CC ? state.lines[type] ?? [] : state.lines[`${centre.ID}:${type}`] ?? [],
                        ])),
                    })),
                })),
            });
        }
        if (method === "GET" && path === "logs/quotes/") return reply(200, state.logs, { "result-pages": "1" });
        if (method === "GET" && path === "setup/accounts/costCenters/") {
            return reply(200, [{ ID: 44, Name: "Corporate" }, { ID: 48, Name: "Education - Other" }, { ID: 99, Name: "Old", Archived: true }], { "result-pages": "1" });
        }

        const section = path.match(new RegExp(`^quotes/${Q}/sections/$`));
        if (section && method === "POST") {
            writes++;
            held = false;
            const made = { ID: NEW_S, Name: body?.Name };
            state.sections.push(made);
            return reply(201, made);
        }
        const centres = path.match(new RegExp(`^quotes/${Q}/sections/(\\d+)/costCenters/$`));
        if (centres && method === "POST") {
            writes++;
            held = false;
            const made = { ID: NEW_CC, SectionID: Number(centres[1]), Name: body?.Name, CostCenter: { ID: body?.CostCenter, Name: "New" }, ItemsLocked: false };
            state.costCentres.push(made);
            return reply(201, made);
        }
        if (centres && method === "GET") {
            const rows = state.costCentres.filter((candidate) => candidate.SectionID === Number(centres[1])).map((found) => ({ ...found, Total: { ExTax: 0 } }));
            return reply(200, rows, { "result-pages": "1" });
        }
        const centre = path.match(new RegExp(`^quotes/${Q}/sections/(\\d+)/costCenters/(\\d+)$`));
        if (centre) {
            const found = state.costCentres.find((candidate) => candidate.ID === Number(centre[2]));
            if (!found) return reply(404, { errors: [{ message: "not found" }] });
            if (method === "GET") return reply(200, { ...found, Total: { ExTax: 0 } });
            writes++;
            held = false;
            if (body?.CostCenter) found.CostCenter = { ID: body.CostCenter, Name: "Changed" };
            return reply(204);
        }
        const item = path.match(new RegExp(`^quotes/${Q}/sections/\\d+/costCenters/(\\d+)/(\\w+)/(\\d+)?$|^quotes/${Q}/sections/\\d+/costCenters/(\\d+)/(\\w+)/(\\d+)$`));
        if (item) {
            const owner = Number(item[1] ?? item[4]);
            const type = item[2] ?? item[5];
            const id = Number(item[3] ?? item[6]);
            const key = owner === CC ? type : `${owner}:${type}`;
            const list = (state.lines[key] ??= []);
            if (method === "POST") {
                writes++;
                held = false;
                const made = applyBody(type, { ID: 9000 + list.length }, body ?? {});
                list.push(made);
                return reply(201, made);
            }
            if (method === "GET" && Number.isNaN(id)) return reply(200, list, { "result-pages": "1" });
            const line = list.find((candidate) => candidate.ID === id);
            if (!line) return reply(404, { errors: [{ message: "not found" }] });
            if (method === "GET") return reply(200, line);
            writes++;
            held = false;
            applyBody(type, line, state.corruptWrites ? { Total: { Qty: 777 } } : body ?? {});
            return reply(204);
        }
        return reply(500, { errors: [{ message: `Fake has no route for ${method} ${path}` }] });
    }) as typeof fetch;

    return {
        calls,
        state,
        client: new SimproClient({ baseUrl: "https://fake.simprosuite.com", companyId: 0, token: "t" }, fetchImpl, async () => {}),
    };
}

/** Same pricing rules as live Simpro: cost changes keep the markup and move the sell price. */
function applyBody(type: string, line: Raw, body: Raw): Raw {
    const costKey = type === "labor" ? "LaborRate" : type === "oneOffs" ? "EstimatedCost" : "BasePrice";
    const markupKey = type === "labor" ? "LaborMarkup" : "Markup";
    if (body.Catalog) line.Catalog = { ID: body.Catalog, PartNo: "X", Name: "Item" };
    if (body.Description) line.Description = body.Description;
    if (body.ServiceFee) line.ServiceFee = { ID: body.ServiceFee, Name: "Fee" };
    if (body.LaborType) line.LaborType = { ID: body.LaborType, Name: "Labour" };
    if (body[costKey] !== undefined) line[costKey] = body[costKey];
    if (line[costKey] === undefined) line[costKey] = 50;
    if (body[markupKey] !== undefined) line[markupKey] = body[markupKey];
    if (line[markupKey] === undefined) line[markupKey] = 0;
    if (body.DisplayOrder !== undefined) line.DisplayOrder = body.DisplayOrder;
    let unit = line[costKey] * (1 + line[markupKey] / 100);
    if (body.SellPriceExDiscount !== undefined) {
        unit = body.SellPriceExDiscount;
        line[markupKey] = (unit / line[costKey] - 1) * 100;
    }
    amounts(line, unit, body.Total?.Qty ?? line.Total?.Qty ?? 0);
    return line;
}

export function memoryAudit() {
    const entries: { started: Raw; finished?: Raw }[] = [];
    return {
        entries,
        audit: {
            async start(entry: Raw) {
                entries.push({ started: entry });
                return String(entries.length - 1);
            },
            async finish(id: string, outcome: Raw) {
                entries[Number(id)].finished = outcome;
            },
        },
    };
}
