-- Who asked the Simpro MCP server to change which quote. Simpro's own quote log
-- records the values but shows no staff name for API writes, so this table holds
-- the person. Only the server reads or writes it, using the service role.
create table public.simpro_mcp_audit (
    id bigint generated always as identity primary key,
    plan_id uuid not null,
    quote_id bigint not null,
    requested_by text not null,
    steps jsonb not null,
    status text not null,
    results jsonb,
    totals jsonb,
    started_at timestamptz not null default now(),
    finished_at timestamptz
);

create index simpro_mcp_audit_quote_idx on public.simpro_mcp_audit (quote_id, started_at desc);

alter table public.simpro_mcp_audit enable row level security;
revoke all on public.simpro_mcp_audit from anon, authenticated;
