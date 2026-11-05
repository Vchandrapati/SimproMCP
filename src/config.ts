import { createHash, timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { AuditLog } from "./quotes/apply.ts";
import { SimproClient } from "./simpro/client.ts";

function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not configured on the server.`);
    return value;
}

export function simproClient(): SimproClient {
    return new SimproClient({
        baseUrl: `https://${required("SIMPRO_BUILD_NAME")}.simprosuite.com`,
        companyId: Number(process.env.SIMPRO_COMPANY_ID ?? 0),
        token: required("SIMPRO_MCP_API_TOKEN"),
    });
}

export function planSecret(): string {
    const secret = required("SIMPRO_MCP_PLAN_SECRET");
    if (secret.length < 32) throw new Error("SIMPRO_MCP_PLAN_SECRET must be at least 32 characters.");
    return secret;
}

/** Off unless explicitly enabled, so a deployment starts read-only. */
export function writesEnabled(): boolean {
    return process.env.SIMPRO_MCP_WRITES_ENABLED === "true";
}

/**
 * Matches a bearer token against SIMPRO_MCP_TOKENS, a JSON object of person name to
 * SHA-256 hash. Fails closed if the setting is missing or malformed.
 */
export function personForToken(token: string, configured = process.env.SIMPRO_MCP_TOKENS): string | null {
    if (!configured) return null;
    let entries: [string, unknown][];
    try {
        entries = Object.entries(JSON.parse(configured) as Record<string, unknown>);
    } catch {
        return null;
    }
    const given = createHash("sha256").update(token).digest();
    let match: string | null = null;
    for (const [person, hash] of entries) {
        if (typeof hash !== "string" || !/^[0-9a-f]{64}$/i.test(hash)) continue;
        if (timingSafeEqual(given, Buffer.from(hash, "hex"))) match = person;
    }
    return match;
}

export function supabaseAudit(): AuditLog {
    const db = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    return {
        async start({ planId, quoteId, requestedBy, steps }) {
            const { data, error } = await db
                .from("simpro_mcp_audit")
                .insert({ plan_id: planId, quote_id: quoteId, requested_by: requestedBy, steps, status: "started" })
                .select("id")
                .single();
            if (error) throw new Error(`The audit log couldn't be written, so nothing was changed: ${error.message}`);
            return String(data.id);
        },
        async finish(auditId, outcome) {
            const { error } = await db
                .from("simpro_mcp_audit")
                .update({ status: outcome.status, results: outcome.results, totals: outcome.totals, finished_at: new Date().toISOString() })
                .eq("id", auditId);
            if (error) console.error("simpro_mcp_audit finish failed", auditId, error.message);
        },
    };
}
