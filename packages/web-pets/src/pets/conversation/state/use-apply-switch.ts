import { useState } from 'react';

/** Lane F: run clean changes without a click, for this conversation. Plain React state on
 * purpose - never sent to the worker - starting from the pet's saved default, so closing the
 * panel or reloading comes back to that default rather than to whatever was last pressed. The
 * stored scope makes a switch to another pet or workspace read as the new pet's default without
 * an effect: the choice belonged to the conversation it was made in. Writes already waiting when
 * the switch goes on stay the owner's to decide: the switch only covers what arrives after it.
 * The same holds when the panel (re)mounts: a write already waiting when the conversation first
 * loads is never auto-applied, so one left waiting with the switch off cannot run on reopening.
 * A note-scoped conversation offers the same switch; the note scope still bounds what it may
 * touch (packages/companion scope rules), and a read-only note offers no writes at all. */
export function useApplySwitch({
  workspaceId,
  petId,
  savedDefault,
  readOnly,
  needsDecisionIds,
  loaded,
  conversationKey,
  pendingToolIds,
}: {
  readonly workspaceId: string;
  readonly petId: string;
  readonly savedDefault: boolean;
  readonly readOnly: boolean;
  readonly needsDecisionIds: readonly string[];
  /** Whether the conversation has loaded; the tools pending then are noted once. */
  readonly loaded: boolean;
  /** Names the loaded conversation (its first message id); a new value is another conversation,
   * resumed from History or started anew, whose waiting writes are noted afresh. */
  readonly conversationKey: string;
  /** Ids of every tool call still pending in the loaded conversation. */
  readonly pendingToolIds: readonly string[];
}): {
  readonly applyWithoutAsking: boolean;
  readonly applyExemptToolIds: readonly string[];
  readonly setApplyWithoutAsking: (on: boolean) => void;
} {
  const applyScope = `${workspaceId}:${petId}`;
  const [applySwitch, setApplySwitch] = useState<{
    scope: string;
    on: boolean;
    exempt: readonly string[];
  }>({ scope: applyScope, on: savedDefault, exempt: [] });
  // Adjusted during render so no card sees a waiting write before it is exempt.
  const [waiting, setWaiting] = useState<{ scope: string; ids: readonly string[] } | null>(null);
  const waitingScope = `${applyScope}:${conversationKey}`;
  if (loaded && waiting?.scope !== waitingScope)
    setWaiting({ scope: waitingScope, ids: pendingToolIds });
  const waitingAtLoad = waiting?.scope === waitingScope ? waiting.ids : [];
  const applyWithoutAsking =
    !readOnly && (applySwitch.scope === applyScope ? applySwitch.on : savedDefault);
  const applyExemptToolIds = applyWithoutAsking ? [...waitingAtLoad, ...applySwitch.exempt] : [];
  const setApplyWithoutAsking = (on: boolean) => {
    setApplySwitch({ scope: applyScope, on, exempt: on ? needsDecisionIds : [] });
  };
  return { applyWithoutAsking, applyExemptToolIds, setApplyWithoutAsking };
}
