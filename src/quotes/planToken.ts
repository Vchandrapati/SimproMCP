import { createHmac, timingSafeEqual } from "node:crypto";
import type { PlanStep } from "./plan.ts";

/**
 * A plan travels as a signed token, so the server stores nothing between planning
 * and applying, and a caller can't alter what was shown before it runs.
 */
export type SignedPlan = {
    version: 1;
    planId: string;
    quoteId: number;
    fingerprint: string;
    createdBy: string;
    expiresAt: number;
    steps: PlanStep[];
};

export const PLAN_LIFETIME_MS = 15 * 60 * 1000;

function signature(body: string, secret: string) {
    return createHmac("sha256", secret).update(body).digest();
}

export function signPlan(plan: SignedPlan, secret: string): string {
    const body = Buffer.from(JSON.stringify(plan)).toString("base64url");
    return `${body}.${signature(body, secret).toString("base64url")}`;
}

export function verifyPlan(token: string, secret: string, now = Date.now()): SignedPlan {
    const [body, supplied, extra] = token.split(".");
    if (!body || !supplied || extra !== undefined) throw new Error("This plan token is malformed.");
    const expected = signature(body, secret);
    const given = Buffer.from(supplied, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        throw new Error("This plan token's signature is invalid, so it was not created by this server or has been altered.");
    }
    const plan = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SignedPlan;
    if (plan.version !== 1) throw new Error("This plan token uses an unsupported version.");
    if (now > plan.expiresAt) throw new Error("This plan has expired. Create a new one with plan_quote_changes.");
    return plan;
}
