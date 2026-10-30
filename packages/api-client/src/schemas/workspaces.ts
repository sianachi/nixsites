/**
 * A workspace: a container of items, one of the several a tenant may hold.
 *
 * The schema is the source of truth and the type is `z.infer` of it; the `satisfies` line ties it
 * to the generated contract so a backend rename fails this package's build rather than a user's
 * request. The two quota fields arrive as strings because they are 64-bit and 32-bit integers the
 * JSON contract widens to `["integer","string"]` to survive a language whose numbers are not - so
 * they are carried as strings and parsed where a number is actually needed, rather than lost to a
 * double here.
 */

import { z } from 'zod';
import type { components } from '../generated/api.js';

export const workspaceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  versionRetentionDays: z.union([z.number(), z.string()]),
  storageQuotaBytes: z.union([z.number(), z.string()]),
  createdAt: z.iso.datetime({ offset: true }),
  kind: z.enum(['personal', 'shared']),
  canRename: z.boolean(),
  canManageMembers: z.boolean(),
  canLeave: z.boolean(),
  canUseDailyNotes: z.boolean(),
  pendingInvitationId: z.uuid().nullable(),
  lifecycleState: z.enum(['active', 'archived', 'purging']),
  archivedAt: z.iso.datetime({ offset: true }).nullable(),
  /** Whether owners closed the workspace to new members. */
  membershipLocked: z.boolean().default(false),
  /** Whether several people may edit a file at once; off means one editor at a time. */
  collaboration: z.boolean().default(true),
});

export type Workspace = z.infer<typeof workspaceSchema>;

const _workspaceContract = workspaceSchema satisfies z.ZodType<
  components['schemas']['WorkspaceResponse']
>;
void _workspaceContract;

export const workspaceMemberSchema = z.object({
  subjectType: z.enum(['principal', 'group']),
  subjectId: z.uuid(),
  subjectDisplayName: z.string(),
  email: z.string().nullable(),
  role: z.enum(['owner', 'editor', 'commenter', 'viewer']),
  grantedAt: z.iso.datetime({ offset: true }),
  canChangeRole: z.boolean(),
  canRemove: z.boolean(),
  assignableRoles: z.array(z.enum(['owner', 'editor', 'commenter', 'viewer'])),
});
export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;

const _workspaceMemberContract = workspaceMemberSchema satisfies z.ZodType<
  components['schemas']['WorkspaceMemberResponse']
>;
void _workspaceMemberContract;

export const workspacePrincipalSchema = z.object({
  principalId: z.uuid(),
  displayName: z.string(),
  kind: z.string().min(1),
});
export type WorkspacePrincipal = z.infer<typeof workspacePrincipalSchema>;

const _workspacePrincipalContract = workspacePrincipalSchema satisfies z.ZodType<
  components['schemas']['WorkspacePrincipalResponse']
>;
void _workspacePrincipalContract;

export const workspaceInvitationSchema = z.object({
  id: z.uuid(),
  emailNormalized: z.string().min(1).max(320),
  targetPrincipalId: z.uuid().nullable(),
  role: z.enum(['owner', 'editor', 'commenter', 'viewer']),
  status: z.enum(['pending', 'accepted', 'revoked']),
  invitedByPrincipalId: z.uuid(),
  invitedAt: z.iso.datetime({ offset: true }),
  acceptedAt: z.iso.datetime({ offset: true }).nullable(),
  acceptedByPrincipalId: z.uuid().nullable(),
  revokedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type WorkspaceInvitation = z.infer<typeof workspaceInvitationSchema>;

const _workspaceInvitationContract = workspaceInvitationSchema satisfies z.ZodType<
  components['schemas']['WorkspaceInvitationResponse']
>;
void _workspaceInvitationContract;

export const workspaceInviteeSchema = z.object({
  principalId: z.uuid(),
  displayName: z.string(),
  email: z.string().max(320).nullable(),
  canInvite: z.boolean(),
  cannotInviteReason: z.string().nullable(),
});
export type WorkspaceInvitee = z.infer<typeof workspaceInviteeSchema>;

const _workspaceInviteeContract = workspaceInviteeSchema satisfies z.ZodType<
  components['schemas']['WorkspaceInviteeResponse']
>;
void _workspaceInviteeContract;

/**
 * `created` is true only for the request that inserted the note, so a client inserts its template
 * once. It defaults to false so a response from a server that predates the field still parses.
 */
export const dailyNoteSchema = z.object({ itemId: z.uuid(), created: z.boolean().default(false) });
export type DailyNote = z.infer<typeof dailyNoteSchema>;

const _dailyNoteContract = dailyNoteSchema satisfies z.ZodType<
  components['schemas']['DailyNoteResponse']
>;
void _dailyNoteContract;

/**
 * A workspace's daily-note settings. `rolloverHour` and `showOnCalendar` and `template` are stored
 * for the client and never interpreted by the server; `folders` and `titleFormat` shape notes the
 * server creates afterwards.
 */
export const dailyNoteSettingsSchema = z.object({
  enabled: z.boolean(),
  folders: z.enum(['flat', 'by-year', 'by-month']),
  titleFormat: z.enum(['iso', 'long', 'weekday-long']),
  template: z.string().max(4000),
  rolloverHour: z.number().int().min(0).max(6),
  showOnCalendar: z.boolean(),
});
export type DailyNoteSettings = z.infer<typeof dailyNoteSettingsSchema>;

const _dailyNoteSettingsContract = dailyNoteSettingsSchema satisfies z.ZodType<
  components['schemas']['DailyNoteSettingsResponse']
>;
void _dailyNoteSettingsContract;
