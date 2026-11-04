# Checking an existing Retell agent

In Recepta Admin, under the Retell Agent ID field in Create Client or Edit Client,
click **Check Retell connection**. This uses the current deployment's server key.
With an ID entered it checks that exact agent directly, independently of the
agent-list endpoint. **Browse available agents** lists accessible voice agents
by name and ID; selecting one fills the form. With no ID entered, the connection
check also lists agents.
It does not purchase numbers, activate subscriptions, publish agents, or change
client assignments. Creation/save still performs its normal provider validation.

Results:

- **Key rejected:** update the existing `RETELL_API_KEY` variable in Netlify for
  the correct site and deployment context, with Functions scope, then redeploy.
- **Access denied:** check Build → Agent permissions. Read permits this check;
  existing agent synchronization requires Edit access.
- **Entered ID absent / empty list:** the key was accepted but cannot see that
  voice agent. Check that the agent still exists and that the key belongs to its
  workspace. Retell isolates resources between workspaces. An empty list does
  not prove that a particular agent was deleted.
- **More results:** load more pages before concluding an ID is unavailable.
- **HTTP 400 / 422 request rejected, endpoint unavailable, or unexpected response:**
  investigate the server integration. A list failure does not mean that the
  entered agent is missing; check the exact ID directly.
- **Timeout, network error or provider error:** the check identifies the category
  and provider HTTP status when available. An unsuccessful refresh clears old
  success results rather than presenting them as a fresh successful check.

Retell keys must remain server-side. Do not put them in `VITE_*` variables,
screenshots, support messages, source files, or browser requests. If rotating
the production key, retain Recepta's existing webhook authentication arrangement:
its Retell webhook verifier uses `RETELL_API_KEY`, so the workspace's designated
webhook signing key must match. Check signed webhook delivery after rotation.

The direct check uses `GET /get-agent/{agent_id}` and requires an exact ID match.
Browsing uses Retell's documented `POST /v2/list-agents` with a voice-channel
filter (`{ type: 'string', op: 'eq', value: 'voice' }`), limit 100 and cursor pagination.
The `type` discriminator is required by Retell's current official SDK schema;
omitting it causes the production agent-list request to return HTTP 400.
Only IDs, names and suspended/transfer
flags are returned to an authenticated admin. Prompts and provider response
bodies are never returned. Error codes and HTTP status are safe fixed metadata;
raw provider errors are never sent to the browser. Responses are not cached. Each provider check has an
eight-second timeout. Access checks cannot establish successful publication,
number routing, billing eligibility, or real call reception.

References:
- https://docs.retellai.com/api-references/list-agents
- https://docs.retellai.com/api-references/get-agent
- https://github.com/RetellAI/retell-typescript-sdk/blob/main/src/resources/agent.ts
- https://docs.retellai.com/accounts/workspace
- https://docs.retellai.com/accounts/manage-api-keys
- https://docs.netlify.com/build/functions/environment-variables/
