// Meeting priority: a lower number outranks a higher one. A meeting's rank is
// its type's rank (1 Client ... 5 Others) pushed up by role tiers: each point of
// a role's `priority_boost` lifts it RANK_SPAN ranks, which is more than the
// whole range of type ranks. So any meeting with a boosted person (e.g. a
// Manager, boost 1) outranks every meeting without one, whatever the type; the
// type only orders meetings within the same tier.

export const RANK_SPAN = 10;

export function effectiveRank(typeRank: number, boost: number) {
  return typeRank - boost * RANK_SPAN;
}
