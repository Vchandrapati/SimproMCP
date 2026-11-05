import { randomUUID } from "node:crypto";
import type { SimproClient } from "../simpro/client.ts";
import { readQuoteLog, restorableQty, type LogEntry } from "./history.ts";
import type { Operation } from "./operations.ts";
import { PLAN_LIFETIME_MS, signPlan } from "./planToken.ts";
import { findCostCentre, findLine, readQuote, round, type Line, type LineType, type QuoteView } from "./read.ts";

export class PlanRefused extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PlanRefused";
    }
}

export type Expected = Partial<{
    qty: number;
    unitCost: number;
    basePrice: number;
    markupPercent: number;
    unitSell: number;
    displayOrder: number;
    typeId: number;
}>;

/** Where a step writes. Refs are resolved at apply time, once new records have IDs. */
export type StepTarget =
    | { kind: "new_section" }
    | { kind: "new_cost_centre"; sectionId?: number; sectionRef?: string }
    | { kind: "new_line"; lineType: LineType; sectionId?: number; costCentreId?: number; costCentreRef?: string }
    | { kind: "line"; lineType: LineType; sectionId: number; costCentreId: number; lineId: number }
    | { kind: "cost_centre"; sectionId: number; costCentreId: number };

export type PlanStep = {
    label: string;
    target: StepTarget;
    body: Record<string, unknown>;
    ref?: string;
    expect: Expected;
};

export type PlanPreview = {
    step: number;
    action: string;
    before?: unknown;
    after?: unknown;
    warnings: string[];
};

export type PlanResult = {
    planToken: string;
    quoteId: number;
    quoteName: string;
    expiresAt: string;
    changes: PlanPreview[];
    totals: {
        currentSellExTax: number;
        predictedSellExTax: number;
        /** True when a new line uses Simpro's default pricing, which can't be predicted. */
        includesUnknownPricing: boolean;
    };
};

type Pricing = { markupPercent?: number; marginPercent?: number; sellPrice?: number };

export function marginToMarkup(marginPercent: number): number {
    return (marginPercent / (100 - marginPercent)) * 100;
}

function resolveMarkup(pricing: Pricing): { markupPercent?: number; sellPrice?: number } {
    const given = [pricing.markupPercent, pricing.marginPercent, pricing.sellPrice].filter((value) => value !== undefined);
    if (given.length > 1) throw new PlanRefused("Set only one of markupPercent, marginPercent or sellPrice on a line.");
    if (pricing.marginPercent !== undefined) return { markupPercent: marginToMarkup(pricing.marginPercent) };
    return { markupPercent: pricing.markupPercent, sellPrice: pricing.sellPrice };
}

const COST_FIELD = { catalogs: "BasePrice", oneOffs: "EstimatedCost", labor: "LaborRate" } as const;

function pricingBody(lineType: "catalogs" | "oneOffs" | "labor", cost: number | undefined, pricing: { markupPercent?: number; sellPrice?: number }) {
    const body: Record<string, unknown> = {};
    if (cost !== undefined) body[COST_FIELD[lineType]] = cost;
    if (pricing.markupPercent !== undefined) body[lineType === "labor" ? "LaborMarkup" : "Markup"] = pricing.markupPercent;
    if (pricing.sellPrice !== undefined) body.SellPriceExDiscount = pricing.sellPrice;
    return body;
}

function lineSummary(line: Line) {
    return {
        name: line.name,
        qty: line.qty,
        ...(line.unitCost === null ? { unitPrice: line.basePrice } : { unitCost: line.unitCost, markupPercent: round(line.markupPercent) }),
        unitSell: round(line.unitSell),
        lineSell: line.lineSell,
    };
}

type Context = {
    quote: QuoteView;
    /** Refs declared so far, to catch use before declaration. */
    sectionRefs: Set<string>;
    costCentreRefs: Map<string, string>;
    types: Map<number, string>;
    log: () => Promise<LogEntry[]>;
    sellDelta: number;
    unknownPricing: boolean;
};

function requireLine(context: Context, lineType: LineType, lineId: number) {
    const found = findLine(context.quote, lineType, lineId);
    if (!found) throw new PlanRefused(`Line ${lineType} ${lineId} isn't on quote ${context.quote.quoteId}.`);
    if (found.centre.itemsLocked) throw new PlanRefused(`Cost centre "${found.centre.name}" has its items locked in Simpro.`);
    return found;
}

function requireType(context: Context, typeId: number) {
    const name = context.types.get(typeId);
    if (!name) throw new PlanRefused(`Cost centre type ${typeId} doesn't exist or is archived. See list_lookups.`);
    return name;
}

function declareRef(seen: { has(key: string): boolean }, ref: string | undefined) {
    if (ref && seen.has(ref)) throw new PlanRefused(`The ref "${ref}" is used twice in this plan.`);
}

function resolveNewLineTarget(context: Context, lineType: LineType, op: { costCentreId?: number; costCentreRef?: string }): StepTarget {
    if ((op.costCentreId === undefined) === (op.costCentreRef === undefined)) {
        throw new PlanRefused("Set exactly one of costCentreId or costCentreRef on each new line.");
    }
    if (op.costCentreRef !== undefined) {
        if (!context.costCentreRefs.has(op.costCentreRef)) {
            throw new PlanRefused(`The ref "${op.costCentreRef}" must be added earlier in the plan.`);
        }
        return { kind: "new_line", lineType, costCentreRef: op.costCentreRef };
    }
    const found = findCostCentre(context.quote, op.costCentreId as number);
    if (!found) throw new PlanRefused(`Cost centre ${op.costCentreId} isn't on quote ${context.quote.quoteId}.`);
    if (found.centre.itemsLocked) throw new PlanRefused(`Cost centre "${found.centre.name}" has its items locked in Simpro.`);
    return { kind: "new_line", lineType, sectionId: found.section.sectionId, costCentreId: found.centre.costCentreId };
}

async function planOperation(op: Operation, context: Context): Promise<{ step: PlanStep; preview: Omit<PlanPreview, "step"> }> {
    switch (op.op) {
        case "add_section": {
            declareRef(context.sectionRefs, op.ref);
            if (op.ref) context.sectionRefs.add(op.ref);
            const label = `Add section "${op.name}"`;
            return {
                step: { label, target: { kind: "new_section" }, body: { Name: op.name }, ref: op.ref, expect: {} },
                preview: { action: label, warnings: [] },
            };
        }
        case "add_cost_centre": {
            if ((op.sectionId === undefined) === (op.sectionRef === undefined)) {
                throw new PlanRefused("Set exactly one of sectionId or sectionRef on each new cost centre.");
            }
            if (op.sectionRef !== undefined && !context.sectionRefs.has(op.sectionRef)) {
                throw new PlanRefused(`The ref "${op.sectionRef}" must be added earlier in the plan.`);
            }
            if (op.sectionId !== undefined && !context.quote.sections.some((section) => section.sectionId === op.sectionId)) {
                throw new PlanRefused(`Section ${op.sectionId} isn't on quote ${context.quote.quoteId}.`);
            }
            declareRef(context.costCentreRefs, op.ref);
            const typeName = requireType(context, op.typeId);
            if (op.ref) context.costCentreRefs.set(op.ref, op.name);
            const label = `Add cost centre "${op.name}" with type ${typeName}`;
            return {
                step: {
                    label,
                    target: { kind: "new_cost_centre", sectionId: op.sectionId, sectionRef: op.sectionRef },
                    body: { CostCenter: op.typeId, Name: op.name },
                    ref: op.ref,
                    expect: { typeId: op.typeId },
                },
                preview: { action: label, warnings: [] },
            };
        }
        case "add_catalogue_item":
        case "add_one_off":
        case "add_labour": {
            const pricing = resolveMarkup(op);
            const lineType = op.op === "add_catalogue_item" ? "catalogs" : op.op === "add_one_off" ? "oneOffs" : "labor";
            const qty = op.op === "add_labour" ? op.hours : op.qty;
            const cost = op.op === "add_labour" ? op.rate : op.cost;
            const target = resolveNewLineTarget(context, lineType, op);
            const body: Record<string, unknown> = { ...pricingBody(lineType, cost, pricing), Total: { Qty: qty } };
            const warnings: string[] = [];
            let name: string;
            if (op.op === "add_catalogue_item") {
                body.Catalog = op.catalogId;
                name = `catalogue item ${op.catalogId}`;
            } else if (op.op === "add_one_off") {
                if (pricing.markupPercent === undefined && pricing.sellPrice === undefined) {
                    throw new PlanRefused(`One-off "${op.description}" needs markupPercent, marginPercent or sellPrice.`);
                }
                Object.assign(body, { Type: "Material", Description: op.description });
                if (op.partNo) body.PartNo = op.partNo;
                name = `one-off "${op.description}"`;
                warnings.push("Simpro also creates an archived catalogue record for each one-off, and it stays after the line is removed.");
            } else {
                body.LaborType = op.labourTypeId;
                name = `labour type ${op.labourTypeId}`;
            }
            const expect: Expected = { qty };
            if (cost !== undefined) expect.unitCost = cost;
            let unitSell: number | undefined;
            if (pricing.sellPrice !== undefined) unitSell = pricing.sellPrice;
            else if (cost !== undefined && pricing.markupPercent !== undefined) unitSell = cost * (1 + pricing.markupPercent / 100);
            if (unitSell !== undefined) {
                expect.unitSell = unitSell;
                context.sellDelta += unitSell * qty;
            } else {
                context.unknownPricing = true;
                warnings.push("Pricing comes from Simpro's defaults, so the sell price will only be known after applying.");
            }
            const label = `Add ${name} × ${qty}`;
            return {
                step: { label, target, body, expect },
                preview: { action: label, after: unitSell === undefined ? { qty, unitSell: "Simpro default" } : { qty, unitSell: round(unitSell), lineSell: round(unitSell * qty) }, warnings },
            };
        }
        case "add_service_fee": {
            const target = resolveNewLineTarget(context, "serviceFees", op);
            const body: Record<string, unknown> = { ServiceFee: op.serviceFeeId, Total: { Qty: op.qty } };
            const expect: Expected = { qty: op.qty };
            const warnings: string[] = [];
            if (op.price !== undefined) {
                body.BasePrice = op.price;
                expect.basePrice = op.price;
                context.sellDelta += op.price * op.qty;
            } else {
                context.unknownPricing = true;
                warnings.push("Pricing comes from Simpro's defaults, so the sell price will only be known after applying.");
            }
            const label = `Add service fee ${op.serviceFeeId} × ${op.qty}`;
            return { step: { label, target, body, expect }, preview: { action: label, warnings } };
        }
        case "update_line":
            return planUpdate(op, context);
        case "remove_line": {
            const { section, centre, line } = requireLine(context, op.lineType, op.lineId);
            if (line.qty === 0) throw new PlanRefused(`"${line.name}" is already at qty 0.`);
            context.sellDelta -= line.lineSell;
            const label = `Remove "${line.name}" by setting its ${op.lineType === "labor" ? "hours" : "qty"} to 0`;
            return {
                step: {
                    label,
                    target: { kind: "line", lineType: op.lineType, sectionId: section.sectionId, costCentreId: centre.costCentreId, lineId: line.lineId },
                    body: { Total: { Qty: 0 } },
                    expect: { qty: 0 },
                },
                preview: {
                    action: label,
                    before: lineSummary(line),
                    after: { qty: 0, lineSell: 0 },
                    warnings: ["The line stays on the quote at qty 0, and it can be restored from the quote log with restore_line."],
                },
            };
        }
        case "restore_line": {
            const { section, centre, line } = requireLine(context, op.lineType, op.lineId);
            const result = restorableQty(await context.log(), line, centre.lines, context.quote.quoteId, centre.costCentreId);
            if (!result.ok) throw new PlanRefused(result.reason);
            context.sellDelta += line.unitSell * result.qty;
            const label = `Restore "${line.name}" to ${result.qty}, from quote log entry ${result.entryId}`;
            return {
                step: {
                    label,
                    target: { kind: "line", lineType: op.lineType, sectionId: section.sectionId, costCentreId: centre.costCentreId, lineId: line.lineId },
                    body: { Total: { Qty: result.qty } },
                    expect: { qty: result.qty },
                },
                preview: { action: label, before: lineSummary(line), after: { qty: result.qty, lineSell: round(line.unitSell * result.qty) }, warnings: [] },
            };
        }
        case "set_cost_centre_type": {
            const found = findCostCentre(context.quote, op.costCentreId);
            if (!found) throw new PlanRefused(`Cost centre ${op.costCentreId} isn't on quote ${context.quote.quoteId}.`);
            const typeName = requireType(context, op.typeId);
            if (found.centre.typeId === op.typeId) throw new PlanRefused(`"${found.centre.name}" is already ${typeName}.`);
            const label = `Change "${found.centre.name}" from ${found.centre.typeName} to ${typeName}`;
            return {
                step: {
                    label,
                    target: { kind: "cost_centre", sectionId: found.section.sectionId, costCentreId: found.centre.costCentreId },
                    body: { CostCenter: op.typeId },
                    expect: { typeId: op.typeId },
                },
                preview: {
                    action: label,
                    before: { type: found.centre.typeName },
                    after: { type: typeName },
                    warnings: ["The dashboards report by cost centre type, so this can change how the quote is reported."],
                },
            };
        }
        case "move_line": {
            const { section, centre, line } = requireLine(context, op.lineType, op.lineId);
            const movable = centre.lines.filter((other) => other.displayOrder !== null).length;
            if (op.position > movable) throw new PlanRefused(`"${centre.name}" only has ${movable} positions.`);
            const label = `Move "${line.name}" to position ${op.position} in "${centre.name}"`;
            return {
                step: {
                    label,
                    target: { kind: "line", lineType: op.lineType, sectionId: section.sectionId, costCentreId: centre.costCentreId, lineId: line.lineId },
                    body: { DisplayOrder: op.position },
                    expect: { displayOrder: op.position },
                },
                preview: {
                    action: label,
                    before: { position: line.displayOrder },
                    after: { position: op.position },
                    warnings: ["Simpro renumbers the other lines. Moves aren't recorded in the quote log, so note the old position if you may want it back."],
                },
            };
        }
    }
}

function planUpdate(op: Extract<Operation, { op: "update_line" }>, context: Context): { step: PlanStep; preview: Omit<PlanPreview, "step"> } {
    const { section, centre, line } = requireLine(context, op.lineType, op.lineId);
    const pricing = resolveMarkup(op);
    const warnings: string[] = [];
    const body: Record<string, unknown> = {};
    const expect: Expected = {};
    const qty = op.qty ?? line.qty;
    let unitSell = line.unitSell;

    if (op.lineType === "serviceFees") {
        if (op.cost !== undefined) throw new PlanRefused("Service fees have no cost in Simpro. Use price, which sets what the customer pays.");
        if (pricing.markupPercent !== undefined || pricing.sellPrice !== undefined) throw new PlanRefused("Use price to change a service fee.");
        if (op.price !== undefined) {
            body.BasePrice = op.price;
            expect.basePrice = op.price;
            unitSell = op.price * (1 + line.markupPercent / 100);
        }
    } else {
        if (op.price !== undefined) throw new PlanRefused("price only applies to service fees. Use cost or sellPrice.");
        Object.assign(body, pricingBody(op.lineType, op.cost, pricing));
        const cost = op.cost ?? (line.unitCost as number);
        if (op.cost !== undefined) expect.unitCost = op.cost;
        if (pricing.sellPrice !== undefined) {
            unitSell = pricing.sellPrice;
            expect.unitSell = pricing.sellPrice;
            if (op.cost !== undefined) warnings.push("Setting cost and sell price in one edit hasn't been run against live Simpro yet. The result is checked after writing.");
        } else if (pricing.markupPercent !== undefined) {
            unitSell = cost * (1 + pricing.markupPercent / 100);
            expect.unitSell = unitSell;
        } else if (op.cost !== undefined) {
            // Confirmed live: Simpro keeps the markup and recalculates the sell price.
            unitSell = cost * (1 + line.markupPercent / 100);
            expect.unitSell = unitSell;
            warnings.push(`The customer's unit price moves from ${round(line.unitSell)} to ${round(unitSell)}, because Simpro keeps the markup. Set sellPrice as well to hold the price.`);
            if (line.markupPercent >= 1000) warnings.push(`This line has a ${round(line.markupPercent)}% markup, so a small cost change makes a large price change. Set sellPrice instead.`);
        }
    }
    if (op.qty !== undefined) {
        body.Total = { Qty: op.qty };
        expect.qty = op.qty;
    }
    if (Object.keys(body).length === 0) throw new PlanRefused(`update_line on "${line.name}" doesn't change anything.`);

    const after = { qty, unitSell: round(unitSell), lineSell: round(unitSell * qty) };
    context.sellDelta += unitSell * qty - line.lineSell;
    const label = `Update "${line.name}"`;
    return {
        step: {
            label,
            target: { kind: "line", lineType: op.lineType, sectionId: section.sectionId, costCentreId: centre.costCentreId, lineId: line.lineId },
            body,
            expect,
        },
        preview: { action: label, before: lineSummary(line), after, warnings },
    };
}

export function refuseUneditable(quote: QuoteView) {
    if (quote.isClosed) throw new PlanRefused(`Quote ${quote.quoteId} is closed.`);
    if (quote.stage !== "InProgress") throw new PlanRefused(`Quote ${quote.quoteId} is at stage ${quote.stage}, and only in-progress quotes can be edited.`);
    if (quote.jobNo) throw new PlanRefused(`Quote ${quote.quoteId} has been converted to job ${quote.jobNo}.`);
}

export async function planQuoteChanges(
    client: SimproClient,
    quoteId: number,
    operations: Operation[],
    createdBy: string,
    secret: string,
    now = Date.now(),
): Promise<PlanResult> {
    const quote = await readQuote(client, quoteId);
    refuseUneditable(quote);

    const needsTypes = operations.some((op) => op.op === "add_cost_centre" || op.op === "set_cost_centre_type");
    const types = new Map<number, string>();
    if (needsTypes) {
        const rows = await client.getAll<{ ID: number; Name: string; Archived?: boolean }>("setup/accounts/costCenters/", { columns: "ID,Name,Archived" });
        for (const row of rows) if (!row.Archived) types.set(row.ID, row.Name);
    }

    let cachedLog: LogEntry[] | undefined;
    const context: Context = {
        quote,
        sectionRefs: new Set(),
        costCentreRefs: new Map(),
        types,
        log: async () => (cachedLog ??= await readQuoteLog(client, quoteId)),
        sellDelta: 0,
        unknownPricing: false,
    };

    const steps: PlanStep[] = [];
    const changes: PlanPreview[] = [];
    for (const [index, op] of operations.entries()) {
        const { step, preview } = await planOperation(op, context);
        steps.push(step);
        changes.push({ step: index + 1, ...preview });
    }

    const expiresAt = now + PLAN_LIFETIME_MS;
    return {
        planToken: signPlan({ version: 1, planId: randomUUID(), quoteId, fingerprint: quote.fingerprint, createdBy, expiresAt, steps }, secret),
        quoteId,
        quoteName: quote.name,
        expiresAt: new Date(expiresAt).toISOString(),
        changes,
        totals: {
            currentSellExTax: quote.totals.sellExTax,
            predictedSellExTax: round(quote.totals.sellExTax + context.sellDelta),
            includesUnknownPricing: context.unknownPricing,
        },
    };
}
