type Reference = string | { id?: string } | null
type InvoiceReference = {
  subscription?: Reference
  parent?: { subscription_details?: { subscription?: Reference } | null } | null
}

export const getInvoiceSubscriptionId = (invoice: InvoiceReference) => {
  const reference = invoice.subscription ?? invoice.parent?.subscription_details?.subscription
  return typeof reference === 'string' ? reference : reference?.id ?? null
}

export const getInvoicePeriod = (lines: Array<{
  type?: string
  proration?: boolean
  subscription?: Reference
  parent?: {
    type?: string
    subscription_item_details?: { proration?: boolean; subscription?: Reference } | null
  } | null
  period: { start: number; end: number }
}>, subscriptionId: string) => {
  const line = lines.find((item) => {
    const details = item.parent?.subscription_item_details
    const reference = item.subscription ?? details?.subscription
    const id = typeof reference === 'string' ? reference : reference?.id
    return id === subscriptionId && !(item.proration ?? details?.proration) &&
      (item.type === 'subscription' || item.parent?.type === 'subscription_item_details') &&
      item.period.end > item.period.start
  })
  if (!line) throw new Error('The paid subscription invoice has no recurring billing period.')
  return {
    start: new Date(line.period.start * 1000).toISOString(),
    end: new Date(line.period.end * 1000).toISOString(),
  }
}
