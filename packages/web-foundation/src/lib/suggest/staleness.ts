/**
 * Which members of a group have gone untouched far longer than the group usually does.
 *
 * Built for the board's "stale card" hint, and shaped so it knows nothing about boards: a group is
 * a key and the ages of its members, an age is how long since a member last changed, and a member
 * is an outlier when its age is both at least {@link STALE_THRESHOLDS.factor} times its group's
 * median and at least {@link STALE_THRESHOLDS.minimumAgeMs} in absolute terms.
 *
 * **Both bars, because each alone is wrong somewhere.** A ratio alone flags a two-day-old card in
 * a column whose cards change hourly, which is not stale by anybody's measure. An absolute age alone
 * flags every card in "Done", where nothing is ever supposed to change again - but there the median
 * is old too, so the ratio keeps the column quiet. A group needs at least
 * {@link STALE_THRESHOLDS.minimumGroup} members before its median says anything about what is usual.
 *
 * Pure: the caller decides what "last changed" is and supplies the ages.
 */

export interface StaleThresholds {
  /** How many times the group's median age an outlier must reach. */
  readonly factor: number;

  /** The least age, in milliseconds, worth calling stale at all. */
  readonly minimumAgeMs: number;

  /** The fewest members a group needs before its median is meaningful. */
  readonly minimumGroup: number;
}

export const STALE_THRESHOLDS: StaleThresholds = {
  factor: 3,
  minimumAgeMs: 7 * 24 * 60 * 60 * 1000,
  minimumGroup: 4,
};

export interface AgedMember {
  readonly id: string;
  readonly ageMs: number;
}

export interface StaleMember {
  readonly ageMs: number;

  /** The median age of the member's group, for the sentence comparing the two. */
  readonly medianMs: number;
}

/** The median of `values`, or null when there are none. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Every outlier across `groups`, keyed by member id. */
export function staleMembers(
  groups: readonly (readonly AgedMember[])[],
  thresholds: StaleThresholds = STALE_THRESHOLDS,
): ReadonlyMap<string, StaleMember> {
  const stale = new Map<string, StaleMember>();
  for (const members of groups) {
    if (members.length < thresholds.minimumGroup) {
      continue;
    }
    const middle = median(members.map((member) => member.ageMs));
    if (middle === null) {
      continue;
    }
    for (const member of members) {
      if (member.ageMs >= thresholds.minimumAgeMs && member.ageMs >= middle * thresholds.factor) {
        stale.set(member.id, { ageMs: member.ageMs, medianMs: middle });
      }
    }
  }
  return stale;
}
