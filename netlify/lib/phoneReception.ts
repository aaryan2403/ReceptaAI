export const verifyReceptionResources = async (apiKey: string, agentId: string, numbers: string[]) => {
  const get = async (path: string) => {
    const response = await fetch('https://api.retellai.com' + path, {
      headers: { Authorization: 'Bearer ' + apiKey }, signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) throw new Error('The assigned agent or number is disconnected from the Recepta Retell workspace.')
    return await response.json()
  }
  const agent = await get('/get-agent/' + encodeURIComponent(agentId))
  if (agent.agent_id !== agentId) throw new Error('Retell agent ownership could not be verified.')
  const expectedHook = new URL('/.netlify/functions/retell-inbound', process.env.RECEPTA_APP_URL || process.env.URL || 'https://recepta.ca').toString()
  let routingReady = numbers.length > 0
  for (const number of numbers) {
    const phone = await get('/get-phone-number/' + encodeURIComponent(number))
    if (phone.phone_number !== number) throw new Error('Retell phone ownership could not be verified.')
    if ((phone.inbound_agents ?? []).some((binding: { agent_id?: string }) => binding.agent_id !== agentId)) {
      throw new Error('This number is bound to a different Retell agent. Recepta must review its assignment.')
    }
    routingReady &&= phone.inbound_webhook_url === expectedHook && !(phone.inbound_agents?.length)
  }
  return { routingReady }
}
