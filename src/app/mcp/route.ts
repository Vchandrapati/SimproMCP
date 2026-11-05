import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { personForToken } from "../../config.ts";
import { registerTools } from "../../tools/register.ts";

export const dynamic = "force-dynamic";
// Each write takes about 2.5 seconds with its lock, so a full plan needs a long limit.
export const maxDuration = 300;

const handler = createMcpHandler(registerTools, {
    serverInfo: { name: "simpro-quotes", version: "0.1.0" },
});

const authenticated = withMcpAuth(
    handler,
    (_request, bearerToken) => {
        if (!bearerToken) return undefined;
        const person = personForToken(bearerToken);
        return person ? { token: bearerToken, clientId: person, scopes: [] } : undefined;
    },
    { required: true },
);

export { authenticated as GET, authenticated as POST };
