import { createHash } from "node:crypto";
import type { SimproClient } from "../simpro/client.ts";

export const LINE_TYPES = ["catalogs", "oneOffs", "labor", "serviceFees", "prebuilds"] as const;
export type LineType = (typeof LINE_TYPES)[number];

export type Line = {
    lineType: LineType;
    lineId: number;
    name: string;
    /** The exact name Simpro's quote log uses for this line. */
    logName: string;
    partNo: string | null;
    qty: number;
    /** Unit cost before markup. Null for service fees, which Simpro does not count as cost. */
    unitCost: number | null;
    /** A service fee's base price. It acts as a sell price, not a cost. */
    basePrice: number | null;
    markupPercent: number;
    unitSell: number;
    lineSell: number;
    displayOrder: number | null;
};

export type CostCentre = {
    costCentreId: number;
    name: string;
    typeId: number | null;
    typeName: string | null;
    itemsLocked: boolean;
    sellExTax: number;
    lines: Line[];
};

export type Section = { sectionId: number; name: string; costCentres: CostCentre[] };

export type QuoteView = {
    quoteId: number;
    name: string;
    customer: string | null;
    stage: string;
    status: string | null;
    isClosed: boolean;
    jobNo: string | number | null;
    totals: {
        sellExTax: number;
        sellIncTax: number;
        materialsCost: number;
        labourCost: number;
        overhead: number;
        labourHours: number;
        grossProfit: number;
        grossMarginPercent: number;
        nettProfit: number;
        nettMarginPercent: number;
    };
    sections: Section[];
    /** Hash of the content, ignoring modified times, used to spot changes between plan and apply. */
    fingerprint: string;
};

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ITEM_KEYS: Record<string, LineType> = {
    Catalogs: "catalogs",
    OneOffs: "oneOffs",
    Labors: "labor",
    ServiceFees: "serviceFees",
    Prebuilds: "prebuilds",
};

export function round(value: number, places = 2): number {
    const factor = 10 ** places;
    return Math.round((value + Number.EPSILON) * factor) / factor;
}

function stripModified(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripModified);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Raw)
                .filter(([key]) => key !== "DateModified")
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, inner]) => [key, stripModified(inner)]),
        );
    }
    return value;
}

export function fingerprint(rawQuote: unknown): string {
    return createHash("sha256").update(JSON.stringify(stripModified(rawQuote))).digest("hex");
}

export function normaliseLine(lineType: LineType, raw: Raw): Line {
    const qty = Number(raw.Total?.Qty ?? 0);
    const unitSell = Number(raw.SellPrice?.ExDiscountExTax ?? raw.SellPrice?.ExTax ?? 0);
    const lineSell = Number(raw.Total?.Amount?.ExTax ?? 0);
    const base = {
        lineType,
        lineId: Number(raw.ID),
        qty,
        unitSell: round(unitSell, 4),
        lineSell: round(lineSell),
        displayOrder: typeof raw.DisplayOrder === "number" ? raw.DisplayOrder : null,
    };
    switch (lineType) {
        case "catalogs":
        case "prebuilds": {
            const item = raw.Catalog ?? raw.Prebuild ?? {};
            const partNo = item.PartNo || null;
            return {
                ...base,
                name: item.Name ?? "",
                logName: partNo ? `${partNo} ${item.Name}` : item.Name ?? "",
                partNo,
                unitCost: Number(raw.BasePrice ?? 0),
                basePrice: null,
                markupPercent: Number(raw.Markup ?? 0),
            };
        }
        case "oneOffs":
            return {
                ...base,
                name: raw.Description ?? "",
                logName: raw.Description ?? "",
                partNo: raw.PartNo || null,
                unitCost: Number(raw.EstimatedCost ?? 0),
                basePrice: null,
                markupPercent: Number(raw.Markup ?? 0),
            };
        case "labor":
            return {
                ...base,
                name: raw.LaborType?.Name ?? "",
                logName: raw.LaborType?.Name ?? "",
                partNo: null,
                unitCost: Number(raw.LaborRate ?? 0),
                basePrice: null,
                markupPercent: Number(raw.LaborMarkup ?? 0),
            };
        case "serviceFees":
            return {
                ...base,
                name: raw.ServiceFee?.Name ?? "",
                logName: raw.ServiceFee?.Name ?? "",
                partNo: null,
                unitCost: null,
                basePrice: Number(raw.BasePrice ?? 0),
                markupPercent: Number(raw.Markup ?? 0),
            };
    }
}

export function linePath(quoteId: number, sectionId: number, costCentreId: number, lineType: LineType, lineId?: number) {
    const base = `quotes/${quoteId}/sections/${sectionId}/costCenters/${costCentreId}/${lineType}/`;
    return lineId === undefined ? base : `${base}${lineId}`;
}

/** Fields each line list must return. Confirmed against live Simpro to match the per-line detail. */
const LINE_COLUMNS: Record<LineType, string> = {
    catalogs: "ID,Catalog,BasePrice,Markup,SellPrice,Total,DisplayOrder",
    prebuilds: "ID,Prebuild,BasePrice,Markup,SellPrice,Total,DisplayOrder",
    oneOffs: "ID,Description,PartNo,EstimatedCost,Markup,SellPrice,Total,DisplayOrder",
    labor: "ID,LaborType,LaborRate,LaborMarkup,SellPrice,Total",
    serviceFees: "ID,ServiceFee,BasePrice,Markup,SellPrice,Total,DisplayOrder",
};
const CENTRE_COLUMNS = "ID,Name,CostCenter,ItemsLocked,Total";

/** Requests in flight at once while reading. The client still caps the rate. */
const READ_CONCURRENCY = 6;

/** Runs work over items with limited concurrency, keeping results in input order. */
export async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await work(items[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

/**
 * Reads a quote with full line detail. display=all leaves out one-off costs, display
 * order and cost centre types, so cost centres are read per section and lines per cost
 * centre and type, using list endpoints with explicit columns.
 */
export async function readQuote(client: SimproClient, quoteId: number): Promise<QuoteView> {
    const raw = await client.get<Raw>(`quotes/${quoteId}`, { display: "all" });
    const rawSections = (raw.Sections ?? []) as Raw[];

    const centreLists = await mapLimit(rawSections, READ_CONCURRENCY, (rawSection) =>
        client.getAll<Raw>(`quotes/${quoteId}/sections/${rawSection.ID}/costCenters/`, { columns: CENTRE_COLUMNS }));

    type Job = { sectionId: number; centreId: number; lineType: LineType; ids: number[] };
    const jobs: Job[] = [];
    for (const rawSection of rawSections) {
        for (const rawCentre of (rawSection.CostCenters ?? []) as Raw[]) {
            for (const [key, lineType] of Object.entries(ITEM_KEYS)) {
                const ids = ((rawCentre.Items?.[key] ?? []) as Raw[]).map((item) => Number(item.ID));
                if (ids.length > 0) jobs.push({ sectionId: rawSection.ID, centreId: rawCentre.ID, lineType, ids });
            }
        }
    }
    const rows = await mapLimit(jobs, READ_CONCURRENCY, async (job) => {
        const listed = await client.getAll<Raw>(linePath(quoteId, job.sectionId, job.centreId, job.lineType), { columns: LINE_COLUMNS[job.lineType] });
        const byId = new Map(listed.map((row) => [Number(row.ID), row]));
        // Keep the overview's order, and read any line the list missed on its own.
        return Promise.all(job.ids.map((id) => byId.get(id) ?? client.get<Raw>(linePath(quoteId, job.sectionId, job.centreId, job.lineType, id))));
    });
    const linesFor = new Map(jobs.map((job, index) => [`${job.centreId}:${job.lineType}`, rows[index]]));

    const sections: Section[] = [];
    const detailed: unknown[] = [];
    rawSections.forEach((rawSection, sectionIndex) => {
        const centreDetail = new Map(centreLists[sectionIndex].map((row) => [Number(row.ID), row]));
        const costCentres: CostCentre[] = [];
        for (const rawCentre of (rawSection.CostCenters ?? []) as Raw[]) {
            const centre = centreDetail.get(Number(rawCentre.ID));
            if (!centre) throw new Error(`Cost centre ${rawCentre.ID} is missing from section ${rawSection.ID}'s list.`);
            detailed.push({ ItemsLocked: centre.ItemsLocked, Type: centre.CostCenter, Id: centre.ID });
            const lines: Line[] = [];
            for (const lineType of Object.values(ITEM_KEYS)) {
                for (const full of linesFor.get(`${rawCentre.ID}:${lineType}`) ?? []) {
                    detailed.push(full);
                    lines.push(normaliseLine(lineType, full));
                }
            }
            lines.sort((a, b) => (a.displayOrder ?? Number.MAX_SAFE_INTEGER) - (b.displayOrder ?? Number.MAX_SAFE_INTEGER));
            costCentres.push({
                costCentreId: Number(rawCentre.ID),
                name: rawCentre.Name ?? "",
                typeId: centre.CostCenter?.ID ?? null,
                typeName: centre.CostCenter?.Name ?? null,
                itemsLocked: Boolean(centre.ItemsLocked),
                sellExTax: Number(centre.Total?.ExTax ?? 0),
                lines,
            });
        }
        sections.push({ sectionId: Number(rawSection.ID), name: rawSection.Name ?? "", costCentres });
    });

    const t = raw.Totals ?? {};
    return {
        quoteId,
        name: raw.Name ?? "",
        customer: raw.Customer?.CompanyName || [raw.Customer?.GivenName, raw.Customer?.FamilyName].filter(Boolean).join(" ") || null,
        stage: raw.Stage ?? "",
        status: raw.Status?.Name ?? null,
        isClosed: Boolean(raw.IsClosed),
        jobNo: raw.JobNo ?? null,
        totals: {
            sellExTax: Number(raw.Total?.ExTax ?? 0),
            sellIncTax: Number(raw.Total?.IncTax ?? 0),
            materialsCost: Number(t.MaterialsCost?.Estimate ?? 0),
            labourCost: Number(t.ResourcesCost?.Labor?.Estimate ?? 0),
            overhead: Number(t.ResourcesCost?.Overhead?.Estimate ?? 0),
            labourHours: Number(t.ResourcesCost?.LaborHours?.Estimate ?? 0),
            grossProfit: Number(t.GrossProfitLoss?.Estimate ?? 0),
            grossMarginPercent: Number(t.GrossMargin?.Estimate ?? 0),
            nettProfit: Number(t.NettProfitLoss?.Estimate ?? 0),
            nettMarginPercent: Number(t.NettMargin?.Estimate ?? 0),
        },
        sections,
        fingerprint: fingerprint({ raw, detailed }),
    };
}

export function findLine(quote: QuoteView, lineType: LineType, lineId: number) {
    for (const section of quote.sections) {
        for (const centre of section.costCentres) {
            const line = centre.lines.find((candidate) => candidate.lineType === lineType && candidate.lineId === lineId);
            if (line) return { section, centre, line };
        }
    }
    return null;
}

export function findCostCentre(quote: QuoteView, costCentreId: number) {
    for (const section of quote.sections) {
        const centre = section.costCentres.find((candidate) => candidate.costCentreId === costCentreId);
        if (centre) return { section, centre };
    }
    return null;
}
