-- Atomic phone-pair linking uses ON CONFLICT(client_id). The live baseline
-- previously lacked this constraint. Fail on ambiguous assignments rather
-- than moving or deleting any customer's agent.
create unique index recepta_single_agent_per_client on public.agents(client_id);
