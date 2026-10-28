import { createContext, use, useMemo, type ReactNode } from 'react';

import {
  useWorkspaceMembers,
  type WorkspaceMembersStatus,
} from '../settings/members/use-workspace-members';

/**
 * Who each workspace member is, loaded once for a whole view.
 *
 * A board of two hundred cards that each showed an assignee by calling `useWorkspaceMembers` would
 * page through the member list two hundred times. So a view that shows people mounts one directory
 * above its cards, and every value display reads names out of it.
 *
 * **Absent is not an error, and neither is it an answer.** Outside a directory - a story, a
 * component test, a view whose schema declares no assignee - nothing has been asked, so nothing
 * may be said to be unknown. Only a directory whose read succeeded can say an identifier is not a
 * member; while it is loading, or after it failed, the display says less rather than something
 * false.
 */

/** Where a member lookup has got to. */
export type MemberLookup =
  | { readonly status: 'absent' | 'loading' | 'error' }
  | { readonly status: 'ready'; readonly name: string | null };

interface MemberDirectoryValue {
  readonly status: WorkspaceMembersStatus;
  readonly names: ReadonlyMap<string, string>;
}

const MemberNamesContext = createContext<MemberDirectoryValue | null>(null);

export function MemberDirectory(props: { readonly children: ReactNode }): ReactNode {
  const { status, members } = useWorkspaceMembers();
  const value = useMemo(
    () => ({
      status,
      names: new Map(members.map((member) => [member.subjectId, member.subjectDisplayName])),
    }),
    [members, status],
  );

  return <MemberNamesContext value={value}>{props.children}</MemberNamesContext>;
}

/** A member's display name, as far as the directory above can answer for it. */
export function useMember(subjectId: string): MemberLookup {
  const directory = use(MemberNamesContext);
  if (directory === null) return { status: 'absent' };
  if (directory.status !== 'ready') return { status: directory.status };
  return { status: 'ready', name: directory.names.get(subjectId) ?? null };
}
