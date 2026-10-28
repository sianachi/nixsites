import { useState } from 'react';

import { frecencyScores, recordPick } from '@nix/web-foundation/lib/frecency';
import { rankByScore } from '@nix/web-foundation/lib/suggest/rank';
import { useChoiceOrderPreference } from '@nix/web-foundation/lib/suggestion-preferences';
import { useOptionalWorkspace } from '../workspaces/workspace-context';

/**
 * The options this person picked most often in a choice control, offered again ahead of the
 * declared list, and the call that remembers a pick.
 *
 * **The declared order is never changed.** A schema's option order is somebody's decision - a
 * status runs Backlog, Doing, Done for a reason - and a list that reorders itself breaks the
 * muscle memory of everyone who learned it. So the full list stays as declared and the top
 * {@link RECENT_CHOICES} picks are repeated in a leading "Recent" group, which is the familiar
 * shape of a font or language picker.
 *
 * **Scoped to the workspace and the property key** (`select:<workspace>:<key>`): a select's values
 * are workspace data, so one workspace's habits never surface in another's, and "Status" in one
 * container shares its history with "Status" in the next because a key reused across containers
 * is, nearly always, the same vocabulary. The values stored are option labels - workspace content
 * a person typed into a schema - which is why the store is cleared whenever the subject changes
 * (see `lib/frecency.ts`).
 *
 * **Read once, when the control mounts.** The scores are a snapshot rather than a subscription:
 * a Recent group that changed the moment somebody chose from it would move the value they just
 * picked out from under the pointer. The next control to mount sees the pick. A workspace switch
 * re-reads, because the snapshot is keyed by its namespace.
 *
 * **Off, or outside a workspace, there is no memory.** The "Order choices by what I pick most"
 * preference turns off both the group and the recording. A public form renders these controls
 * with no workspace at all, and a history keyed to nobody's workspace would leak one visitor's
 * picks into the next visitor's form on a shared machine.
 */
export interface SelectFrecency {
  /** At most {@link RECENT_CHOICES} of `options`, most picked first; empty when there is no history. */
  readonly recent: <T>(options: readonly T[], keyOf: (option: T) => string) => readonly T[];
  readonly remember: (value: string) => void;
}

/** How many picks the Recent group repeats. */
export const RECENT_CHOICES = 3;

const NO_SCORES: ReadonlyMap<string, number> = new Map();

export function useSelectFrecency(propertyKey: string, allowStorage = true): SelectFrecency {
  const workspace = useOptionalWorkspace();
  const enabled = useChoiceOrderPreference((state) => state.setting === 'on');
  const namespace =
    workspace === null || !enabled || !allowStorage
      ? null
      : `select:${workspace.workspaceId}:${propertyKey}`;

  const [snapshot, setSnapshot] = useState(() => ({
    namespace,
    scores: namespace === null ? NO_SCORES : frecencyScores(namespace),
  }));

  // Render-time adjustment rather than an effect: a control moved to another workspace must not
  // draw one frame with the previous workspace's history.
  let scores = snapshot.scores;
  if (snapshot.namespace !== namespace) {
    scores = namespace === null ? NO_SCORES : frecencyScores(namespace);
    setSnapshot({ namespace, scores });
  }

  return {
    recent: (options, keyOf) =>
      rankByScore(options, scores, keyOf)
        .filter((option) => (scores.get(keyOf(option)) ?? 0) > 0)
        .slice(0, RECENT_CHOICES),
    remember: (value) => {
      if (namespace !== null && value.length > 0) {
        recordPick(namespace, value);
      }
    },
  };
}
