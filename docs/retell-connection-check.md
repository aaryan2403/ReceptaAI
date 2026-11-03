# Checking an existing Retell agent

In Recepta Admin, under the Retell Agent ID field in Create Client or Edit Client,
click **Check Retell connection**. This uses the current deployment's server key.
It lists accessible voice agents by name and ID; selecting one fills the form.
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
- **Timeout or provider error:** retry later. An unsuccessful refresh clears old
  success results rather than presenting them as a fresh successful check.

Retell keys must remain server-side. Do not put them in `VITE_*` variables,
screenshots, support messages, source files, or browser requests. If rotating
the production key, retain Recepta's existing webhook authentication arrangement:
its Retell webhook verifier uses `RETELL_API_KEY`, so the workspace's designated
webhook signing key must match. Check signed webhook delivery after rotation.

The check uses Retell's documented `POST /v2/list-agents` with a voice-channel
filter, limit 100 and cursor pagination. Only IDs, names and suspended/transfer
flags are returned to an authenticated admin. Prompts and provider response
bodies are never returned. Responses are not cached. Each provider check has an
eight-second timeout. Access checks cannot establish successful publication,
number routing, billing eligibility, or real call reception.

References:
- https://docs.retellai.com/api-references/list-agents
- https://docs.retellai.com/api-references/get-agent
- https://docs.retellai.com/accounts/workspace
- https://docs.retellai.com/accounts/manage-api-keys
- https://docs.netlify.com/build/functions/environment-variables/
