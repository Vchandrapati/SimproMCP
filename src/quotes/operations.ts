import { z } from "zod";

const Id = z.number().int().positive();
const Ref = z.string().min(1).max(40);
const Qty = z.number().positive().max(100_000);
const Money = z.number().positive().max(10_000_000);

const Pricing = {
    markupPercent: z.number().min(-99).max(1_000_000).optional().describe("Markup on cost. Simpro works out the sell price."),
    marginPercent: z.number().min(0).max(99).optional().describe("Target gross margin on sell, converted to markup."),
    sellPrice: Money.optional().describe("Unit sell price ex tax, before discount. Simpro works out the markup."),
};

const CostCentreTarget = {
    costCentreId: Id.optional().describe("An existing cost centre on this quote."),
    costCentreRef: Ref.optional().describe("The ref of a cost centre added earlier in this plan."),
};

const EditableLineType = z.enum(["catalogs", "oneOffs", "labor", "serviceFees"]);

export const Operation = z.discriminatedUnion("op", [
    z.object({
        op: z.literal("add_section"),
        ref: Ref.optional().describe("A name that later operations in this plan can refer to."),
        name: z.string().min(1).max(200),
    }),
    z.object({
        op: z.literal("add_cost_centre"),
        ref: Ref.optional(),
        sectionId: Id.optional(),
        sectionRef: Ref.optional(),
        typeId: Id.describe("Cost centre type ID from list_lookups, such as Corporate."),
        name: z.string().min(1).max(200),
    }),
    z.object({
        op: z.literal("add_catalogue_item"),
        ...CostCentreTarget,
        catalogId: Id,
        qty: Qty,
        cost: Money.optional().describe("Leave out to use Simpro's default cost."),
        ...Pricing,
    }),
    z.object({
        op: z.literal("add_one_off"),
        ...CostCentreTarget,
        description: z.string().min(1).max(500),
        partNo: z.string().max(100).optional(),
        qty: Qty,
        cost: Money,
        ...Pricing,
    }),
    z.object({
        op: z.literal("add_labour"),
        ...CostCentreTarget,
        labourTypeId: Id,
        hours: Qty,
        rate: Money.optional().describe("Hourly cost rate. Leave out to use Simpro's default."),
        ...Pricing,
    }),
    z.object({
        op: z.literal("add_service_fee"),
        ...CostCentreTarget,
        serviceFeeId: Id,
        qty: Qty,
        price: Money.optional().describe("Unit price. Leave out to use Simpro's default."),
    }),
    z.object({
        op: z.literal("update_line"),
        lineType: EditableLineType,
        lineId: Id,
        qty: Qty.optional().describe("Qty, or hours for labour. Use remove_line to take a line to 0."),
        cost: Money.optional().describe("Unit cost, or hourly rate for labour. Simpro keeps the markup, so the sell price moves unless sellPrice is also set. Not valid for service fees."),
        price: Money.optional().describe("Service fees only: the unit price."),
        ...Pricing,
    }),
    z.object({
        op: z.literal("remove_line"),
        lineType: EditableLineType,
        lineId: Id,
    }),
    z.object({
        op: z.literal("restore_line"),
        lineType: EditableLineType,
        lineId: Id,
    }),
    z.object({
        op: z.literal("set_cost_centre_type"),
        costCentreId: Id,
        typeId: Id,
    }),
    z.object({
        op: z.literal("move_line"),
        lineType: z.enum(["catalogs", "oneOffs", "serviceFees"]).describe("Labour lines have no position in Simpro's API."),
        lineId: Id,
        position: z.number().int().min(1).max(10_000),
    }),
]);

export type Operation = z.infer<typeof Operation>;

export const MAX_OPERATIONS = 25;

export const OperationList = z.array(Operation).min(1).max(MAX_OPERATIONS);
