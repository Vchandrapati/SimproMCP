# Simpro quote MCP server

An MCP server that lets an AI client read and edit Simpro quotes. It doesn't change the catalogue.

## Tools

| Tool | What it does |
|---|---|
| `search_quotes` | Finds quotes by name or customer |
| `get_quote` | Reads sections, cost centres, lines, costs, sell prices and totals |
| `get_quote_history` | Reads Simpro's change log for a quote |
| `search_catalogue` | Finds catalogue items, to add to a quote |
| `list_lookups` | Lists cost centre types, labour types and service fees |
| `plan_quote_changes` | Shows the effect of changes without writing anything |
| `apply_quote_plan` | Writes an approved plan to Simpro |

`plan_quote_changes` accepts these operations:

- `add_section`, `add_cost_centre`
- `add_catalogue_item`, `add_one_off`, `add_labour`, `add_service_fee`
- `update_line` for qty, cost, markup, margin, sell price or a service fee's price
- `remove_line`, which sets qty to 0, and `restore_line`, which reads the old qty from Simpro's log
- `set_cost_centre_type`
- `move_line`, except for labour

## How changes are kept safe

- **Endpoint allowlist:** Simpro tokens can't be limited, so [`allowlist.ts`](src/simpro/allowlist.ts) is the real permission boundary. Real deletes, `PUT` and catalogue writes are blocked before anything is sent.
- **Plan, then apply:** a plan is a signed token that expires after 15 minutes and only works for the person who made it.
- **Only quotes being built can be edited:** a quote must have the status `Quote: To Be Completed`, be at stage `InProgress`, be open and have no job. Quotes that are sent, in follow up, won or closed are refused at both plan and apply.
- **Stale plans are refused:** apply stops without writing if the quote's content changed after planning.
- **Locking:** the lock is taken before each write, because each write drops it, and it's held only for that write.
- **Checked writes:** each write is read back. If someone opens the quote or the result differs from the plan, apply stops and reports what was written.
- **Audit log:** apply records who asked in `simpro_mcp_audit`, and writes nothing if that fails. Simpro's log shows no staff name for API writes.
- **Off by default:** nothing can be planned or applied unless `SIMPRO_MCP_WRITES_ENABLED` is `true`.

## Simpro behaviour this relies on

These were confirmed against live quotes in November 2026:

- Staff with a quote open block API writes with a `422`, and the API can't override them.
- While the API holds the lock, staff can't open the quote.
- Changing a cost keeps the markup, so the sell price moves.
- Setting a one-off's cost to 0 changes its markup, so a cost of 0 isn't allowed. Use `remove_line`.
- Service fees have no cost. Their base price acts as the sell price.
- Deleting a section or cost centre removes its contents without warning, so deletes aren't offered.
- Every one-off also creates an archived catalogue record, which stays after the line is removed.
- Labour lines have no display order.

These haven't been run against live Simpro yet:

- Setting a cost and sell price in the same edit
- Setting a markup or sell price on its own
- How qty 0 lines appear on printed quotes
- Whether qty 0 lines carry over when a quote becomes a job
- How long an abandoned lock lasts

## Setup

1. Apply `supabase/migrations/20261106000001_simpro_mcp_audit.sql` to the Supabase project that will hold the audit log.
2. Create a dedicated Simpro API login and token for this server.
3. Create an access token for each person. Give them the token and add the hash to `SIMPRO_MCP_TOKENS`:

   ```bash
   pnpm new-token "Person Name"
   ```

4. Set the variables listed in [`.env.example`](.env.example).
5. Deploy to Vercel.
6. Connect a client to `https://<host>/mcp` using the header `Authorization: Bearer <token>`.

## Development

```bash
pnpm install
```

```bash
pnpm dev
```

```bash
pnpm test
```

```bash
pnpm typecheck
```
