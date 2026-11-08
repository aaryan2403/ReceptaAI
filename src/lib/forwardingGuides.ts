export type ForwardingGuide = { title: string; steps: string[]; cancel: string; url: string; note?: string }
// Reviewed against these carrier-owned pages on 2026-11-02. Never apply mobile
// dial codes to landlines or hosted VoIP; variants and subscriptions differ.
export const forwardingGuide = (carrier: string, line: string, destination: string): ForwardingGuide => {
  const digits = destination.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '') || 'YOUR_RECEPTA_NUMBER'
  if (line === 'mobile' && carrier === 'rogers') return {
    title: 'Rogers mobile · forward every call',
    steps: [`From the business phone, dial *21*${digits}# and press Call.`, 'Wait for the carrier’s activation confirmation, then test from a different phone.'],
    cancel: 'From the business phone, dial ##21# and press Call to cancel unconditional forwarding.',
    url: 'https://www.rogers.com/support/mobility/use-call-forwarding',
    note: 'Rogers says conditional forwarding will not work when voicemail is active. Check your plan before choosing a missed-call option.',
  }
  if (line === 'mobile' && carrier === 'telus') return {
    title: 'TELUS mobile · forward every call',
    steps: [`From the business phone, dial *21*${digits}# and press Call.`, 'Wait for the carrier’s activation message. Phone call settings may also provide a forwarding switch.'],
    cancel: 'Dial #21# from the business phone to deactivate unconditional forwarding.',
    url: 'https://www.telus.com/en/support/article/call-forward-mobile',
    note: 'TELUS excludes prepaid accounts from this feature. Check forwarding allowance and charges on your plan.',
  }
  if (line === 'mobile' && carrier === 'bell') return {
    title: 'Bell Mobility · phone settings',
    steps: ['Open your phone’s Call Forwarding settings and activate forwarding.', `Enter ${destination || 'your assigned Recepta number'} as the destination. Follow the phone’s prompts and test from another phone.`],
    cancel: 'Open the same Call Forwarding settings, choose the deactivation option, and confirm voicemail is restored. Bell describes “Deactivate All” for restoring voicemail.',
    url: 'https://support.bell.ca/mobility/rate_plans_features/how_to_use_call_forwarding_on_my_mobile_phone',
  }
  if (line === 'landline' && carrier === 'rogers') return {
    title: 'Rogers Home Phone · forward every call',
    steps: [`From the business handset, dial *72, then ${digits}.`, 'Let the destination answer and keep the connection open at least five seconds. If unanswered or busy, follow the carrier’s repeat-activation procedure linked below.'],
    cancel: 'Dial *73 from the business handset, listen for two beeps, and hang up.',
    url: 'https://www.rogers.com/support/home-phone/call-forwarding',
    note: 'This guide is for Rogers Home Phone. Business PBX and hosted VoIP products may use different settings.',
  }
  if (line === 'landline' && carrier === 'telus') return {
    title: 'TELUS Office Phone · variable forwarding',
    steps: [`Dial *72 or #72, wait for the tones, then dial ${digits}.`, 'Answer at the destination and keep the call connected for five to ten seconds. If unanswered, follow TELUS’s retry instructions.'],
    cancel: 'Dial *73 or #73, listen for two beeps, then hang up.',
    url: 'https://www.telus.com/en/business/support/article/use-call-forwarding-variable',
    note: 'These steps apply to variable forwarding on TELUS Office Phone. Fixed-number and other products differ.',
  }
  return { title: line === 'voip' ? 'Hosted VoIP / PBX' : 'Carrier-specific setup',
    steps: [`In your carrier or VoIP portal, set the incoming-call forwarding destination to ${destination || 'your assigned Recepta number'}.`, 'Confirm whether all-call or missed-call forwarding is supported for your exact service. If the setting is unavailable, ask your carrier to activate it.'],
    cancel: 'Remove the forwarding rule in the same carrier portal or ask the carrier to deactivate it. Call your original number to confirm it rings normally.',
    url: carrier === 'bell' ? 'https://business.bell.ca/support/small-business/phone/calling-features/how-to-use-call-forwarding' : carrier === 'telus' ? 'https://www.telus.com/en/support' : 'https://www.rogers.com/support',
    note: 'There is no universal forwarding code for every landline or VoIP system. Use your provider’s instructions for the exact product.',
  }
}
