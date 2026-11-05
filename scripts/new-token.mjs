// Prints a new MCP access token and the entry to add to SIMPRO_MCP_TOKENS.
// The token is shown once. Only its hash goes in the environment.
import { createHash, randomBytes } from "node:crypto";

const name = process.argv[2];
if (!name) {
    console.error('Usage: pnpm new-token "Person Name"');
    process.exit(1);
}
const token = `smcp_${randomBytes(32).toString("base64url")}`;
const hash = createHash("sha256").update(token).digest("hex");
console.log(`Give this to ${name}, shown once:\n${token}\n`);
console.log(`Add to the SIMPRO_MCP_TOKENS JSON object:\n${JSON.stringify({ [name]: hash })}`);
