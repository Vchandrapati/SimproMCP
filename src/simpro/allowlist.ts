// The only Simpro requests this server may send. Simpro tokens cannot be scoped
// (its API team confirms a token has full access to the company), so this list is
// the real permission boundary. Real deletes are deliberately absent: removing a
// line sets its qty to 0, and the one DELETE allowed releases a lock.

const ID = "\\d+";
const QUOTE = `quotes/${ID}`;
const SECTION = `${QUOTE}/sections/${ID}`;
const COST_CENTRE = `${SECTION}/costCenters/${ID}`;
const WRITABLE_LINES = "(catalogs|oneOffs|labor|serviceFees)";
const READABLE_LINES = "(catalogs|oneOffs|labor|serviceFees|prebuilds)";

type Method = "GET" | "POST" | "PATCH" | "DELETE";

const RULES: Record<Method, string[]> = {
    GET: [
        "quotes/",
        QUOTE,
        `${QUOTE}/sections/`,
        SECTION,
        `${SECTION}/costCenters/`,
        COST_CENTRE,
        `${COST_CENTRE}/${READABLE_LINES}/`,
        `${COST_CENTRE}/${READABLE_LINES}/${ID}`,
        "logs/quotes/",
        "catalogs/",
        `catalogs/${ID}`,
        "setup/accounts/costCenters/",
        "setup/labor/serviceFees/",
        "setup/labor/laborRates/",
        "setup/accounts/taxCodes/",
    ],
    POST: [
        `${QUOTE}/lock/`,
        `${QUOTE}/sections/`,
        `${SECTION}/costCenters/`,
        `${COST_CENTRE}/${WRITABLE_LINES}/`,
    ],
    PATCH: [
        COST_CENTRE,
        `${COST_CENTRE}/${WRITABLE_LINES}/${ID}`,
    ],
    DELETE: [
        `${QUOTE}/lock/`,
    ],
};

const COMPILED = Object.fromEntries(
    Object.entries(RULES).map(([method, patterns]) => [
        method,
        patterns.map((pattern) => new RegExp(`^${pattern}$`)),
    ]),
) as Record<Method, RegExp[]>;

export function isAllowed(method: string, path: string): boolean {
    const rules = COMPILED[method as Method];
    return Boolean(rules) && rules.some((rule) => rule.test(path));
}
