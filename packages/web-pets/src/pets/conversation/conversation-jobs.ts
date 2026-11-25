import type { ReactNode } from 'react';
import type { PetPlanSourceScope } from '@nix/api-client';

export interface ConversationPlanBatch {
  readonly conversationId: string;
  readonly turnId: string;
  readonly toolIds: readonly string[];
  readonly sourceScope: PetPlanSourceScope;
  readonly brief: string;
  readonly afterMessageId?: string;
  readonly rootItemId: string | null;
  readonly readOnly: boolean;
}

export interface ConversationJobEntry {
  readonly id: string;
  readonly afterMessageId?: string;
  readonly content: ReactNode;
}

export interface ConversationJobDraft {
  readonly text: string;
  readonly onStarted: () => void;
  readonly restore?: ((text: string) => void) | undefined;
}

export interface ConversationJobMessage extends ConversationJobDraft {
  readonly afterMessageId: string | undefined;
  readonly focusComposer: () => void;
}

export interface ConversationJobs {
  readonly consentMode?: 'plan';
  readonly adoptTools?: ((batch: ConversationPlanBatch) => void) | undefined;
  readonly ready: boolean;
  readonly busy: boolean;
  readonly canSubmit: (text: string) => boolean;
  /** `force` starts a job whatever the wording; the person chose it. */
  readonly submit: (message: ConversationJobMessage, force?: boolean) => boolean;
  readonly panel: (draft: ConversationJobDraft) => ReactNode;
  readonly timeline: readonly ConversationJobEntry[];
  readonly options?: ReactNode;
  readonly attachMessage?: (text: string, draft: string) => string;
}
