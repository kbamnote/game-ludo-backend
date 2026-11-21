export const ENTRY_TIERS = [100, 300, 500, 1000, 2000] as const
export type MatchEntry = typeof ENTRY_TIERS[number] | 0

export function readMatchEntry(value: unknown): MatchEntry | undefined {
  if (value === undefined || value === 0) return 0
  return ENTRY_TIERS.find(tier => tier === value)
}

export type MatchPot = { id: string; entry: number; accounts: string[]; expiresAt: number }
