import type { SimproClient } from "../simpro/client.ts";
import type { Line } from "./read.ts";

export type LogEntry = { id: number; message: string; staff: string | null; loggedAt: string };

type RawLog = { ID: number; Message?: string; Staff?: { Name?: string } | null; DateLogged?: string };

export async function readQuoteLog(client: SimproClient, quoteId: number): Promise<LogEntry[]> {
    const rows = await client.getAll<RawLog>("logs/quotes/", {
        QuoteID: quoteId,
        columns: "ID,Message,Staff,DateLogged",
    });
    return rows
        .map((row) => ({
            id: row.ID,
            message: row.Message ?? "",
            staff: row.Staff?.Name ?? null,
            loggedAt: row.DateLogged ?? "",
        }))
        .sort((a, b) => a.id - b.id);
}

const QTY = /Qty from "([\d.,]+)" to "([\d.,]+)"/;
const HOURS = /Labour Estimated Time from "([\d.,]+) hrs?" to "([\d.,]+) hrs?"/;

function toNumber(text: string): number {
    return Number(text.replace(/,/g, ""));
}

export type QtyChange = { entryId: number; from: number; to: number };

/**
 * Newest qty change for a line in a cost centre, from wording seen live:
 *   Updated "C-HM/HM-6 Kramer ..." Qty from "2.00" to "0.00" for Cost Centre X (#12486-43114)
 *   Updated "AV Installer" Labour Estimated Time from "4 hrs" to "0 hrs" for Cost Centre X (#12486-43114)
 * Entries carry no line ID, so the match is the exact quoted name plus the cost centre.
 */
export function latestQtyChange(entries: LogEntry[], line: Pick<Line, "logName" | "lineType">, quoteId: number, costCentreId: number): QtyChange | null {
    const prefix = `Updated "${line.logName}" `;
    const centre = `(#${quoteId}-${costCentreId})`;
    const pattern = line.lineType === "labor" ? HOURS : QTY;
    for (let index = entries.length - 1; index >= 0; index--) {
        const { id, message } = entries[index];
        if (!message.startsWith(prefix) || !message.includes(centre)) continue;
        const match = pattern.exec(message);
        if (match) return { entryId: id, from: toNumber(match[1]), to: toNumber(match[2]) };
    }
    return null;
}

/** The qty to put back for a removed line, or the reason it can't be worked out safely. */
export function restorableQty(
    entries: LogEntry[],
    line: Line,
    siblings: Line[],
    quoteId: number,
    costCentreId: number,
): { ok: true; qty: number; entryId: number } | { ok: false; reason: string } {
    if (line.qty !== 0) return { ok: false, reason: `Line ${line.lineId} has qty ${line.qty}, so it isn't removed.` };
    const sameName = siblings.filter((other) => other.logName === line.logName && other.lineType === line.lineType);
    if (sameName.length > 1) {
        return {
            ok: false,
            reason: `"${line.name}" appears ${sameName.length} times in this cost centre and log entries have no line IDs, so the log can't show which one changed. Set the qty explicitly with update_line.`,
        };
    }
    const change = latestQtyChange(entries, line, quoteId, costCentreId);
    if (!change) {
        return { ok: false, reason: `No qty change for "${line.name}" was found in the quote log. Set the qty explicitly with update_line.` };
    }
    if (change.to !== 0 || change.from <= 0) {
        return { ok: false, reason: `The newest log entry for "${line.name}" went from ${change.from} to ${change.to}, not to 0. Set the qty explicitly with update_line.` };
    }
    return { ok: true, qty: change.from, entryId: change.entryId };
}
