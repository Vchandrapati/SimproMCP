import assert from "node:assert/strict";
import { test } from "node:test";
import { applyQuotePlan } from "./apply.ts";
import { latestQtyChange, restorableQty, type LogEntry } from "./history.ts";
import { OperationList } from "./operations.ts";
import { marginToMarkup, PlanRefused, planQuoteChanges } from "./plan.ts";
import { signPlan, verifyPlan } from "./planToken.ts";
import { normaliseLine, type Line } from "./read.ts";
import { CC, NEW_CC, NEW_S, Q, S, SECRET, catalogueLine, fakeSimpro, feeLine, labourLine, memoryAudit, oneOffLine } from "./testing.ts";

const standard = () => ({
    catalogs: [catalogueLine(1, 2)],
    oneOffs: [oneOffLine(2, 3)],
    serviceFees: [feeLine(3, 2)],
    labor: [labourLine(4, 4)],
});

function entry(id: number, message: string): LogEntry {
    return { id, message, staff: null, loggedAt: "" };
}

const CENTRE = `Cost Centre test (#${Q}-${CC})`;

async function plan(fake: ReturnType<typeof fakeSimpro>, operations: unknown[]) {
    return planQuoteChanges(fake.client, Q, OperationList.parse(operations), "Vikil", SECRET);
}

async function apply(fake: ReturnType<typeof fakeSimpro>, token: string, audit = memoryAudit().audit, person = "Vikil") {
    return applyQuotePlan(fake.client, audit as never, token, person, SECRET);
}

test("marginToMarkup converts 30% margin to about 42.86% markup", () => {
    assert.equal(Math.round(marginToMarkup(30) * 100) / 100, 42.86);
});

test("service fees report a price and no cost", () => {
    const line = normaliseLine("serviceFees", feeLine(3, 2));
    assert.equal(line.unitCost, null);
    assert.equal(line.basePrice, 120);
    assert.equal(line.lineSell, 240);
});

test("catalogue lines use the part number and name that the log uses", () => {
    assert.equal(normaliseLine("catalogs", catalogueLine(1, 2)).logName, "C-HM/HM-6 Kramer HDMI cable");
});

test("reads qty changes in live log wording", () => {
    const entries = [
        entry(1, `Added "C-HM/HM-6 Kramer HDMI cable" to ${CENTRE}`),
        entry(2, `Updated "C-HM/HM-6 Kramer HDMI cable" Qty from "2.00" to "0.00" for ${CENTRE}`),
    ];
    assert.deepEqual(latestQtyChange(entries, { logName: "C-HM/HM-6 Kramer HDMI cable", lineType: "catalogs" }, Q, CC), { entryId: 2, from: 2, to: 0 });
});

test("reads labour's different wording", () => {
    const entries = [entry(1, `Updated "AV Installer" Labour Estimated Time from "4 hrs" to "0 hrs" for ${CENTRE}`)];
    assert.deepEqual(latestQtyChange(entries, { logName: "AV Installer", lineType: "labor" }, Q, CC), { entryId: 1, from: 4, to: 0 });
});

test("ignores log entries from another cost centre", () => {
    const entries = [entry(1, `Updated "AV Installer" Labour Estimated Time from "4 hrs" to "0 hrs" for Cost Centre x (#${Q}-999)`)];
    assert.equal(latestQtyChange(entries, { logName: "AV Installer", lineType: "labor" }, Q, CC), null);
});

test("doesn't confuse a similar name with the same prefix", () => {
    const entries = [entry(1, `Updated "AV Installer 2" Labour Estimated Time from "9 hrs" to "0 hrs" for ${CENTRE}`)];
    assert.equal(latestQtyChange(entries, { logName: "AV Installer", lineType: "labor" }, Q, CC), null);
});

test("restore refuses when the same item is twice in a cost centre", () => {
    const line = normaliseLine("catalogs", catalogueLine(1, 0));
    const twin = normaliseLine("catalogs", catalogueLine(5, 1));
    const result = restorableQty([entry(1, `Updated "${line.logName}" Qty from "2.00" to "0.00" for ${CENTRE}`)], line, [line, twin], Q, CC);
    assert.equal(result.ok, false);
});

test("restore refuses when the newest change didn't go to 0", () => {
    const line: Line = normaliseLine("catalogs", catalogueLine(1, 0));
    const entries = [
        entry(1, `Updated "${line.logName}" Qty from "2.00" to "0.00" for ${CENTRE}`),
        entry(2, `Updated "${line.logName}" Qty from "0.00" to "3.00" for ${CENTRE}`),
    ];
    assert.equal(restorableQty(entries, line, [line], Q, CC).ok, false);
});

test("the schema refuses cost 0, qty 0 on update, real deletes and moving labour", () => {
    assert.equal(OperationList.safeParse([{ op: "update_line", lineType: "oneOffs", lineId: 1, cost: 0 }]).success, false);
    assert.equal(OperationList.safeParse([{ op: "update_line", lineType: "oneOffs", lineId: 1, qty: 0 }]).success, false);
    assert.equal(OperationList.safeParse([{ op: "delete_line", lineType: "oneOffs", lineId: 1 }]).success, false);
    assert.equal(OperationList.safeParse([{ op: "move_line", lineType: "labor", lineId: 1, position: 1 }]).success, false);
});

test("planning writes nothing to Simpro", async () => {
    const fake = fakeSimpro(standard());
    await plan(fake, [{ op: "remove_line", lineType: "catalogs", lineId: 1 }]);
    assert.deepEqual(fake.calls.filter((call) => !call.startsWith("GET")), []);
});

test("a cost change predicts the sell price moving and warns about it", async () => {
    const fake = fakeSimpro(standard());
    const result = await plan(fake, [{ op: "update_line", lineType: "catalogs", lineId: 1, cost: 20 }]);
    assert.deepEqual(result.changes[0].after, { qty: 2, unitSell: 40, lineSell: 80 });
    assert.match(result.changes[0].warnings[0], /moves from 25.2 to 40/);
    assert.equal(Math.round((result.totals.predictedSellExTax - result.totals.currentSellExTax) * 100) / 100, 29.6);
});

test("a service fee can't take a cost", async () => {
    const fake = fakeSimpro(standard());
    await assert.rejects(plan(fake, [{ op: "update_line", lineType: "serviceFees", lineId: 3, cost: 50 }]), PlanRefused);
});

test("only one pricing input is allowed per line", async () => {
    const fake = fakeSimpro(standard());
    await assert.rejects(plan(fake, [{ op: "update_line", lineType: "catalogs", lineId: 1, markupPercent: 50, sellPrice: 40 }]), /only one/);
});

test("new lines with Simpro default pricing are flagged as unknown", async () => {
    const fake = fakeSimpro(standard());
    const result = await plan(fake, [{ op: "add_catalogue_item", costCentreId: CC, catalogId: 40020, qty: 1 }]);
    assert.equal(result.totals.includesUnknownPricing, true);
});

test("plans refuse quotes that aren't in progress, unknown lines and archived types", async () => {
    const complete = fakeSimpro(standard());
    complete.state.stage = "Complete";
    await assert.rejects(plan(complete, [{ op: "remove_line", lineType: "catalogs", lineId: 1 }]), /stage Complete/);
    const fake = fakeSimpro(standard());
    await assert.rejects(plan(fake, [{ op: "remove_line", lineType: "catalogs", lineId: 999 }]), /isn't on quote/);
    await assert.rejects(plan(fake, [{ op: "set_cost_centre_type", costCentreId: CC, typeId: 99 }]), /archived/);
});

test("refs must be declared before use", async () => {
    const fake = fakeSimpro(standard());
    await assert.rejects(plan(fake, [{ op: "add_cost_centre", sectionRef: "s", typeId: 44, name: "x" }]), /earlier in the plan/);
});

test("applying takes the lock before each write and treats the dropped lock as normal", async () => {
    const fake = fakeSimpro(standard());
    const { planToken } = await plan(fake, [
        { op: "update_line", lineType: "catalogs", lineId: 1, qty: 5 },
        { op: "remove_line", lineType: "oneOffs", lineId: 2 },
    ]);
    fake.calls.length = 0;
    const result = await apply(fake, planToken);
    assert.equal(result.status, "complete");
    const writes = fake.calls.filter((call) => !call.startsWith("GET"));
    assert.deepEqual(writes.map((call) => call.split(" ")[0]), ["POST", "PATCH", "DELETE", "POST", "PATCH", "DELETE"]);
    assert.equal(fake.state.lines.catalogs[0].Total.Qty, 5);
    assert.equal(fake.state.lines.oneOffs[0].Total.Qty, 0);
    assert.equal(fake.state.lines.oneOffs[0].EstimatedCost, 100, "remove keeps the cost");
});

test("remove and restore round trip through the log", async () => {
    const fake = fakeSimpro(standard());
    await apply(fake, (await plan(fake, [{ op: "remove_line", lineType: "labor", lineId: 4 }])).planToken);
    assert.equal(fake.state.lines.labor[0].Total.Qty, 0);
    fake.state.logs.push({ ID: 1, Message: `Updated "AV Installer" Labour Estimated Time from "4 hrs" to "0 hrs" for ${CENTRE}` });
    const restore = await plan(fake, [{ op: "restore_line", lineType: "labor", lineId: 4 }]);
    assert.equal((await apply(fake, restore.planToken)).status, "complete");
    assert.equal(fake.state.lines.labor[0].Total.Qty, 4);
});

test("a plan can build a section, cost centre and lines using refs", async () => {
    const fake = fakeSimpro({});
    const { planToken } = await plan(fake, [
        { op: "add_section", ref: "s", name: "test" },
        { op: "add_cost_centre", ref: "c", sectionRef: "s", typeId: 44, name: "new centre" },
        { op: "add_one_off", costCentreRef: "c", description: "Thing", qty: 2, cost: 100, markupPercent: 25 },
        { op: "add_service_fee", costCentreRef: "c", serviceFeeId: 2, qty: 1, price: 120 },
    ]);
    const result = await apply(fake, planToken);
    assert.equal(result.status, "complete");
    assert.ok(fake.calls.includes(`POST quotes/${Q}/sections/${NEW_S}/costCenters/`));
    assert.ok(fake.calls.includes(`POST quotes/${Q}/sections/${NEW_S}/costCenters/${NEW_CC}/oneOffs/`));
    assert.equal(fake.state.lines[`${NEW_CC}:oneOffs`][0].Total.Amount.ExTax, 250);
});

test("apply refuses if the quote changed after planning, and writes nothing", async () => {
    const fake = fakeSimpro(standard());
    const { planToken } = await plan(fake, [{ op: "remove_line", lineType: "catalogs", lineId: 1 }]);
    fake.state.lines.oneOffs[0].Total.Qty = 9;
    fake.calls.length = 0;
    await assert.rejects(apply(fake, planToken), /has changed since/);
    assert.deepEqual(fake.calls.filter((call) => !call.startsWith("GET")), []);
});

test("a modified time alone doesn't invalidate a plan", async () => {
    const fake = fakeSimpro(standard());
    const { planToken } = await plan(fake, [{ op: "remove_line", lineType: "catalogs", lineId: 1 }]);
    fake.state.lines.catalogs[0].DateModified = "2030-01-01T00:00:00+11:00";
    assert.equal((await apply(fake, planToken)).status, "complete");
});

test("if someone opens the quote partway, it stops and reports what was written", async () => {
    const fake = fakeSimpro(standard());
    const { planToken } = await plan(fake, [
        { op: "update_line", lineType: "catalogs", lineId: 1, qty: 5 },
        { op: "update_line", lineType: "oneOffs", lineId: 2, qty: 7 },
        { op: "update_line", lineType: "labor", lineId: 4, qty: 8 },
    ]);
    fake.state.lockedAfterWrites = 1;
    const { audit, entries } = memoryAudit();
    const result = await apply(fake, planToken, audit);
    assert.equal(result.status, "stopped_quote_busy");
    assert.match(result.message, /locked by Shaun Peffer/);
    assert.deepEqual(result.results.map((step) => step.status), ["done", "not_written"]);
    assert.equal(result.notAttempted.length, 1);
    assert.equal(fake.state.lines.oneOffs[0].Total.Qty, 3);
    assert.equal(entries[0].finished?.status, "stopped_quote_busy");
});

test("if Simpro's result differs from the plan, it stops", async () => {
    const fake = fakeSimpro(standard());
    const { planToken } = await plan(fake, [
        { op: "update_line", lineType: "catalogs", lineId: 1, qty: 5 },
        { op: "update_line", lineType: "oneOffs", lineId: 2, qty: 7 },
    ]);
    fake.state.corruptWrites = true;
    const result = await apply(fake, planToken);
    assert.equal(result.status, "stopped_mismatch");
    assert.equal(result.results.length, 1);
    assert.equal(result.notAttempted.length, 1);
});

test("nothing is written if the audit log can't start", async () => {
    const fake = fakeSimpro(standard());
    const { planToken } = await plan(fake, [{ op: "remove_line", lineType: "catalogs", lineId: 1 }]);
    fake.calls.length = 0;
    const audit = { start: async () => { throw new Error("audit down"); }, finish: async () => {} };
    await assert.rejects(apply(fake, planToken, audit as never), /audit down/);
    assert.deepEqual(fake.calls.filter((call) => !call.startsWith("GET")), []);
});

test("a plan can't be applied by another person", async () => {
    const fake = fakeSimpro(standard());
    const { planToken } = await plan(fake, [{ op: "remove_line", lineType: "catalogs", lineId: 1 }]);
    await assert.rejects(apply(fake, planToken, memoryAudit().audit, "Someone Else"), /different user/);
});

test("plan tokens reject tampering, the wrong secret and expiry", () => {
    const plan1 = { version: 1 as const, planId: "p", quoteId: Q, fingerprint: "f", createdBy: "V", expiresAt: 1000, steps: [] };
    const token = signPlan(plan1, SECRET);
    assert.equal(verifyPlan(token, SECRET, 500).quoteId, Q);
    assert.throws(() => verifyPlan(token, "other-secret-other-secret-other-secret", 500), /signature/);
    assert.throws(() => verifyPlan(token, SECRET, 2000), /expired/);
    const altered = `${Buffer.from(JSON.stringify({ ...plan1, quoteId: 1 })).toString("base64url")}.${token.split(".")[1]}`;
    assert.throws(() => verifyPlan(altered, SECRET, 500), /signature/);
});

test("the section constant matches the fake's existing cost centre", () => {
    assert.equal(fakeSimpro({}).state.costCentres[0].SectionID, S);
});
