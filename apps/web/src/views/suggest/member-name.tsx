import type { ReactNode } from 'react';

import { useWorkspaceMembers } from '@nix/web-settings/settings/members/use-workspace-members';

/**
 * A principal's display name, for a suggestion that offers a person.
 *
 * An assignee is stored as an identifier, and "Suggested Assignee: 3f2c9a1e-..." is not a sentence
 * anybody can check. While the member list loads, when it fails, or where there is no member list
 * to read (a story, a public form), a person reads as "a workspace member" rather than an
 * identifier or a guess.
 */
export type MemberNameOf = (subjectId: string) => string;

const UNNAMED = 'a workspace member';

/** The lookup to use where no member list can be read. */
export const unnamedMember: MemberNameOf = () => UNNAMED;

/**
 * Reads the workspace's member list once and hands its children a lookup by subject.
 *
 * One read for a whole surface - every suggestion line in a create field, every usual-value hint in
 * a form - rather than one per name drawn. Mounted only where an API client and a workspace exist;
 * the caller checks, because the member list is a workspace read.
 */
export function WithMemberNames({
  children,
}: {
  readonly children: (nameOf: MemberNameOf) => ReactNode;
}): ReactNode {
  const { members } = useWorkspaceMembers();
  const names = new Map(members.map((member) => [member.subjectId, member.subjectDisplayName]));
  return children((subjectId) => names.get(subjectId) ?? UNNAMED);
}

/**
 * {@link WithMemberNames} where a member list can be read, and {@link unnamedMember} where it
 * cannot - so a caller hands over one render function rather than branching on whether to load.
 */
export function MemberNames({
  enabled,
  children,
}: {
  readonly enabled: boolean;
  readonly children: (nameOf: MemberNameOf) => ReactNode;
}): ReactNode {
  return enabled ? <WithMemberNames>{children}</WithMemberNames> : children(unnamedMember);
}
