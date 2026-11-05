import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { personForToken } from "../config.ts";
import { isAllowed } from "./allowlist.ts";
import { SimproClient, SimproError, errorDetail } from "./client.ts";

const CC = "quotes/1/sections/2/costCenters/3";

test("allows the writes the tools need", () => {
    for (const [method, path] of [
        ["POST", "quotes/1/lock/"],
        ["DELETE", "quotes/1/lock/"],
        ["POST", "quotes/1/sections/"],
        ["POST", "quotes/1/sections/2/costCenters/"],
        ["POST", `${CC}/catalogs/`],
        ["POST", `${CC}/oneOffs/`],
        ["POST", `${CC}/serviceFees/`],
        ["POST", `${CC}/labor/`],
        ["PATCH", CC],
        ["PATCH", `${CC}/catalogs/4`],
    ]) {
        assert.equal(isAllowed(method, path), true, `${method} ${path}`);
    }
});

test("blocks real deletes, PUT, and everything outside quote editing", () => {
    for (const [method, path] of [
        ["DELETE", "quotes/1"],
        ["DELETE", "quotes/1/sections/2"],
        ["DELETE", CC],
        ["DELETE", `${CC}/catalogs/4`],
        ["PUT", `${CC}/catalogs/`],
        ["PATCH", "quotes/1"],
        ["POST", "quotes/"],
        ["POST", "catalogs/"],
        ["PATCH", "catalogs/1"],
        ["DELETE", "catalogs/1"],
        ["POST", `${CC}/prebuilds/`],
        ["PATCH", `${CC}/prebuilds/4`],
        ["GET", "customers/"],
        ["GET", "jobs/1"],
        ["GET", "quotes/1/../../customers/"],
        ["POST", "quotes/1/lock/extra"],
    ]) {
        assert.equal(isAllowed(method, path), false, `${method} ${path}`);
    }
});

test("the client refuses a blocked request before sending anything", async () => {
    let sent = 0;
    const client = new SimproClient({ baseUrl: "https://x.simprosuite.com", companyId: 0, token: "t" }, (async () => {
        sent++;
        return new Response("[]");
    }) as typeof fetch);
    await assert.rejects(client.delete("quotes/1"), /allowlist/);
    assert.equal(sent, 0);
});

test("turns Simpro's error body into a readable message", () => {
    assert.equal(errorDetail('{"errors":[{"path":null,"message":"Must acquire the lock to release it.","value":null}]}'), "Must acquire the lock to release it.");
    assert.equal(errorDetail('{"errors":[{"path":"/DisplayOrder","message":"Invalid column.","value":1}]}'), "/DisplayOrder: Invalid column.");
    assert.equal(errorDetail("plain"), "plain");
});

test("reads every page and retries after a rate limit", async () => {
    let calls = 0;
    const client = new SimproClient({ baseUrl: "https://x.simprosuite.com", companyId: 0, token: "t" }, (async (url: URL) => {
        calls++;
        if (calls === 1) return new Response("", { status: 429 });
        const page = Number(url.searchParams.get("page"));
        return new Response(JSON.stringify([{ ID: page }]), { headers: { "result-pages": "2" } });
    }) as unknown as typeof fetch, async () => {});
    assert.deepEqual(await client.getAll("catalogs/"), [{ ID: 1 }, { ID: 2 }]);
    assert.equal(calls, 3);
});

test("errors don't include the token", async () => {
    const client = new SimproClient({ baseUrl: "https://x.simprosuite.com", companyId: 0, token: "secret-token" }, (async () => new Response('{"errors":[{"message":"bad"}]}', { status: 422 })) as typeof fetch);
    await assert.rejects(client.get("quotes/1"), (error: unknown) => {
        assert.ok(error instanceof SimproError);
        assert.equal(error.message.includes("secret-token"), false);
        return true;
    });
});

test("access tokens match by hash and fail closed", () => {
    const hash = createHash("sha256").update("good").digest("hex");
    const configured = JSON.stringify({ Vikil: hash });
    assert.equal(personForToken("good", configured), "Vikil");
    assert.equal(personForToken("bad", configured), null);
    assert.equal(personForToken("good", undefined), null);
    assert.equal(personForToken("good", "not json"), null);
    assert.equal(personForToken("good", JSON.stringify({ Vikil: "short" })), null);
});
