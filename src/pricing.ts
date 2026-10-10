export type TokenUsage = { input?: number; output?: number; total?: number }
export type TokenPricing = { inputPerMillion?: number; outputPerMillion?: number }

export function tokenCost(tokens: number | undefined, pricePerMillion: number | undefined): number | null {
  if (tokens === undefined || pricePerMillion === undefined || !Number.isFinite(tokens) || !Number.isFinite(pricePerMillion)) return null
  return tokens * pricePerMillion / 1_000_000
}

export function replyCosts(usage: TokenUsage | undefined, pricing: TokenPricing | undefined) {
  const input = tokenCost(usage?.input, pricing?.inputPerMillion)
  const output = tokenCost(usage?.output, pricing?.outputPerMillion)
  return { input, output, total: input === null || output === null ? null : input + output }
}

export function conversationCost(replies: Array<{ usage?: TokenUsage; pricing?: TokenPricing; attempted?: boolean }>) {
  let total = 0
  let incomplete = false
  for (const reply of replies) {
    if (!reply.attempted) continue
    const costs = replyCosts(reply.usage, reply.pricing)
    if (costs.total === null) incomplete = true
    else total += costs.total
  }
  return { total, incomplete }
}

export function formatUsd(amount: number) {
  if (amount === 0) return '$0.00'
  if (amount < 0.0001) return `$${amount.toFixed(8)}`
  if (amount < 0.01) return `$${amount.toFixed(6)}`
  return `$${amount.toFixed(4)}`
}
