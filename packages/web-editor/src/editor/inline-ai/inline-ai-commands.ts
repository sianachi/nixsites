import {
  AlignLeft,
  Languages,
  ListChecks,
  PenLine,
  SpellCheck,
  Sparkles,
  Wand2,
  type LucideIcon,
} from 'lucide-react';

import type { InlineKind } from './inline-ai-stream';

/**
 * Everything the writing assistance offers, in the order both entry points list it.
 *
 * One catalogue for the slash menu and the selection menu, so the two can never disagree about
 * what is on offer. The keywords are the words somebody types after `/` looking for it.
 */
export interface InlineAiCommand {
  readonly id: string;
  readonly kind: InlineKind;
  readonly label: string;
  readonly hint: string;
  readonly icon: LucideIcon;
  readonly keywords: readonly string[];
}

/** The heading the commands sit under in a list that has headings. */
export const INLINE_AI_GROUP = 'AI';

export const INLINE_AI_COMMANDS: readonly InlineAiCommand[] = [
  {
    id: 'ai-continue',
    kind: 'continue',
    label: 'Continue writing',
    hint: 'Carry on from the cursor',
    icon: PenLine,
    keywords: ['ai', 'continue', 'write', 'draft', 'carry on'],
  },
  {
    id: 'ai-summarise',
    kind: 'summarise',
    label: 'Summarise',
    hint: 'Shorten the selection or the note',
    icon: AlignLeft,
    keywords: ['ai', 'summarise', 'summarize', 'summary', 'shorten', 'tldr'],
  },
  {
    id: 'ai-improve',
    kind: 'improve',
    label: 'Improve writing',
    hint: 'Clearer and tighter',
    icon: Wand2,
    keywords: ['ai', 'improve', 'rewrite', 'polish', 'edit'],
  },
  {
    id: 'ai-fix',
    kind: 'fix',
    label: 'Fix spelling and grammar',
    hint: 'Correct mistakes, keep the voice',
    icon: SpellCheck,
    keywords: ['ai', 'fix', 'spelling', 'grammar', 'proofread', 'typo'],
  },
  {
    id: 'ai-translate',
    kind: 'translate',
    label: 'Translate…',
    hint: 'Into another language',
    icon: Languages,
    keywords: ['ai', 'translate', 'language'],
  },
  {
    id: 'ai-action-items',
    kind: 'action_items',
    label: 'List action items',
    hint: 'Pull out what needs doing',
    icon: ListChecks,
    keywords: ['ai', 'action', 'items', 'tasks', 'todo', 'next steps'],
  },
  {
    id: 'ai-custom',
    kind: 'custom',
    label: 'Ask AI…',
    hint: 'Say what you want',
    icon: Sparkles,
    keywords: ['ai', 'ask', 'prompt', 'custom', 'instruction'],
  },
];
