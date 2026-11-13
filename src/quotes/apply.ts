import type { SimproClient } from "../simpro/client.ts";
import { QuoteBusyError, withQuoteLock } from "../simpro/locks.ts";
import { PlanRefused, refuseUneditable, type Expected, type PlanStep } from "./plan.ts";
import { verifyPlan } from "./planToken.ts";
import { linePath, normaliseLine, readQuote, readTotals, round, type LineType, type QuoteView } from "./read.ts";

export type AuditLog = {
    /** Must succeed before anything is written. */
    start(entry: { planId: string; quoteId: number; requestedBy: string; steps: PlanStep[] }): Promise<string>;
    finish(auditId: string, outcome: { status: string; results: StepResult[]; totals: unknown }): Promise<void>;
};

export type StepResult = {
    step: number;
    action: string;
    status: "done" | "mismatch" | "not_written";
    createdId?: number;
    actual?: unknown;
    problem?: string;
};

export type ApplyResult = {
    status: "complete" | "stopped_quote_busy" | "stopped_error" | "stopped_mismatch";
    quoteId: number;
    results: StepResult[];
    notAttempted: string[];
    message: string;
    totals?: QuoteView["totals"];
};

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Created = { sections: Map<string, number>; costCentres: Map<string, { sectionId: number; costCentreId: number }> };

const TOLERANCE = 0.011;

function mismatches(expect: Expected, actual: Record<string, unknown>): string[] {
    const problems: string[] = [];
    for (const [key, wanted] of Object.entries(expect)) {
        const got = actual[key];
        if (typeof got !== "number" || Math.abs(got - (wanted as number)) > TOLERANCE) {
            problems.push(`${key} is ${String(got)}, expected ${round(wanted as number, 4)}`);
        }
    }
    return problems;
}

function requirePath(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

/** Runs one write and reads the record back, returning what's now in Simpro. */
async function runStep(client: SimproClient, quoteId: number, step: PlanStep, created: Created) {
    const { target } = step;
    const write = <T>(work: () => Promise<T>) => withQuoteLock(client, quoteId, work);

    switch (target.kind) {
        case "new_section": {
            const made = await write(() => client.post<Raw>(`quotes/${quoteId}/sections/`, step.body));
            if (step.ref) created.sections.set(step.ref, made.ID);
            return { createdId: made.ID as number, actual: { name: made.Name } };
        }
        case "new_cost_centre": {
            const sectionId = target.sectionId ?? created.sections.get(target.sectionRef ?? "");
            requirePath(sectionId, `Section ref "${target.sectionRef}" wasn't created.`);
            const base = `quotes/${quoteId}/sections/${sectionId}/costCenters/`;
            const made = await write(() => client.post<Raw>(base, step.body));
            if (step.ref) created.costCentres.set(step.ref, { sectionId, costCentreId: made.ID });
            const after = await client.get<Raw>(`${base}${made.ID}`);
            return { createdId: made.ID as number, actual: { typeId: after.CostCenter?.ID, name: after.Name } };
        }
        case "new_line": {
            const owner = target.costCentreRef
                ? created.costCentres.get(target.costCentreRef)
                : { sectionId: target.sectionId, costCentreId: target.costCentreId };
            requirePath(owner?.sectionId && owner.costCentreId, `Cost centre ref "${target.costCentreRef}" wasn't created.`);
            const made = await write(() => client.post<Raw>(linePath(quoteId, owner.sectionId as number, owner.costCentreId as number, target.lineType), step.body));
            const after = await client.get<Raw>(linePath(quoteId, owner.sectionId as number, owner.costCentreId as number, target.lineType, made.ID));
            return { createdId: made.ID as number, actual: normaliseLine(target.lineType, after) };
        }
        case "line": {
            const path = linePath(quoteId, target.sectionId, target.costCentreId, target.lineType, target.lineId);
            await write(() => client.patch(path, step.body));
            return { actual: normaliseLine(target.lineType as LineType, await client.get<Raw>(path)) };
        }
        case "cost_centre": {
            const path = `quotes/${quoteId}/sections/${target.sectionId}/costCenters/${target.costCentreId}`;
            await write(() => client.patch(path, step.body));
            const after = await client.get<Raw>(path);
            return { actual: { typeId: after.CostCenter?.ID, name: after.Name } };
        }
    }
}

export async function applyQuotePlan(
    client: SimproClient,
    audit: AuditLog,
    planToken: string,
    requestedBy: string,
    secret: string,
    now = Date.now(),
): Promise<ApplyResult> {
    const plan = verifyPlan(planToken, secret, now);
    if (plan.createdBy !== requestedBy) throw new PlanRefused("This plan was created by a different user.");

    const current = await readQuote(client, plan.quoteId);
    refuseUneditable(current);
    if (current.fingerprint !== plan.fingerprint) {
        throw new PlanRefused(`Quote ${plan.quoteId} has changed since this plan was made, so nothing was written. Read it again and create a new plan.`);
    }

    const auditId = await audit.start({ planId: plan.planId, quoteId: plan.quoteId, requestedBy, steps: plan.steps });
    const created: Created = { sections: new Map(), costCentres: new Map() };
    const results: StepResult[] = [];
    let status: ApplyResult["status"] = "complete";
    let message = `All ${plan.steps.length} changes were applied and checked.`;

    for (const [index, step] of plan.steps.entries()) {
        const number = index + 1;
        try {
            const outcome = await runStep(client, plan.quoteId, step, created);
            const problems = mismatches(step.expect, outcome.actual as Record<string, unknown>);
            if (problems.length > 0) {
                results.push({ step: number, action: step.label, status: "mismatch", ...outcome, problem: problems.join("; ") });
                status = "stopped_mismatch";
                message = `Step ${number} was written, but Simpro's result differs from the plan: ${problems.join("; ")}. Later steps were not run.`;
                break;
            }
            results.push({ step: number, action: step.label, status: "done", ...outcome });
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            results.push({ step: number, action: step.label, status: "not_written", problem: text });
            if (error instanceof QuoteBusyError) {
                status = "stopped_quote_busy";
                message = `${text} Step ${number} wasn't written.`;
            } else {
                status = "stopped_error";
                message = `Step ${number} failed: ${text}`;
            }
            if (number > 1) message += " Earlier steps remain on the quote, so read it again before planning the rest.";
            break;
        }
    }

    const totals = await readTotals(client, plan.quoteId).catch(() => undefined);
    await audit.finish(auditId, { status, results, totals });
    return {
        status,
        quoteId: plan.quoteId,
        results,
        notAttempted: plan.steps.slice(results.length).map((step) => step.label),
        message,
        totals,
    };
}
