import { Button, Icon, Listbox, Menu, Text, Textarea, type MenuEntry } from '@nix/ui';
import { ArrowUp, FilePlus, Layers, Plus, Square, TextQuote } from 'lucide-react';
import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type RefObject,
} from 'react';
import { MAX_CONTEXTS, type SharedContext } from '../state/use-message-context';
import { ContextChips } from './context-chips';
import { type useSlashMenu } from './use-slash-menu';

export function Composer({
  petName,
  input,
  draft,
  onDraftChange,
  touchLikeComposer,
  slash,
  onSubmit,
  onInterrupt,
  running,
  canSend,
  chips,
  onRemoveChip,
  needsWorkspaceAccess,
  onTurnOnWorkspaceAccess,
  workspaceAccess,
  hasNoteScope,
  noteReadOnly,
  onToggleWorkspaceAccess,
  applyWithoutAsking,
  onApplyChange,
  hasPage,
  contextCount,
  hasSelection,
  onAttachPage,
  onShareSelection,
}: {
  readonly petName: string;
  readonly input: RefObject<HTMLTextAreaElement | null>;
  readonly draft: string;
  readonly onDraftChange: (text: string) => void;
  readonly touchLikeComposer: boolean;
  readonly slash: ReturnType<typeof useSlashMenu>;
  readonly onSubmit: () => void;
  readonly onInterrupt: () => void;
  readonly running: boolean;
  readonly canSend: boolean;
  readonly chips: readonly SharedContext[];
  readonly onRemoveChip: (context: SharedContext) => void;
  readonly needsWorkspaceAccess: boolean;
  readonly onTurnOnWorkspaceAccess: () => void;
  readonly workspaceAccess: boolean;
  readonly hasNoteScope: boolean;
  readonly noteReadOnly: boolean;
  readonly onToggleWorkspaceAccess: () => void;
  readonly applyWithoutAsking: boolean;
  readonly onApplyChange: (on: boolean) => void;
  readonly hasPage: boolean;
  readonly contextCount: number;
  readonly hasSelection: boolean;
  readonly onAttachPage: () => void;
  readonly onShareSelection: () => void;
}): ReactElement {
  const { options: slashOptions, listbox: slashListbox } = slash;
  // The "+" trigger, so the banner's "Turn off" can hand focus back to the control it mirrors.
  const plusTrigger = useRef<RefObject<HTMLButtonElement | null> | null>(null);

  // The field grows with its content up to its max height, wrapped lines included. Measured
  // rather than counted: a long sentence on a phone wraps without a line break.
  useLayoutEffect(() => {
    const field = input.current;
    if (!field) return;
    field.style.setProperty('height', 'auto');
    if (field.scrollHeight > 0)
      field.style.setProperty('height', `${String(field.scrollHeight)}px`);
  }, [draft, input]);

  const addItems: MenuEntry[] = [
    {
      label: 'Add this page',
      icon: FilePlus,
      disabled: !hasPage || contextCount >= MAX_CONTEXTS,
      onSelect: onAttachPage,
    },
    ...(!hasNoteScope && !workspaceAccess
      ? [
          {
            label: 'Use workspace',
            icon: Layers,
            disabled: running,
            onSelect: onToggleWorkspaceAccess,
          },
        ]
      : []),
    ...(workspaceAccess && !noteReadOnly
      ? [
          {
            label: 'Apply without asking',
            role: 'menuitemcheckbox' as const,
            checked: applyWithoutAsking,
            onSelect: () => {
              onApplyChange(!applyWithoutAsking);
            },
          },
        ]
      : []),
  ];

  function onComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    // An IME's confirming Enter or arrow is the IME's, not the menu's.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const composing = event.nativeEvent.isComposing || event.keyCode === 229;
    if (slashOptions.length > 0 && !composing) {
      if (event.key === 'Tab') {
        // Hide the menu before focus moves, so Tab leaves the field instead of entering the list.
        slash.dismiss();
        return;
      }
      if (event.key === 'Escape') {
        // The menu is the innermost layer, so the conversation behind it stays open.
        event.preventDefault();
        event.stopPropagation();
        slash.dismiss();
        return;
      }
      slashListbox.onKeyDown(event);
      if (event.defaultPrevented) return;
    }
    // Must-fix 18: an IME composition's confirming Enter arrives as `keyCode === 229` on some
    // browsers without `isComposing` also being set - both are checked so it is never mistaken
    // for a real submit.
    // `keyCode` is deprecated but is the only signal some browsers give for an IME's confirming
    // Enter once `isComposing` has already gone false.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.shiftKey || touchLikeComposer) return;
    event.preventDefault();
    onSubmit();
  }

  return (
    <div className="mx-auto flex min-w-0 w-full max-h-[50%] max-w-2xl shrink-0 flex-col gap-2 overflow-y-auto overscroll-contain border-t border-divider p-3">
      <ContextChips
        chips={chips}
        onRemove={onRemoveChip}
        workspace={
          workspaceAccess && !hasNoteScope
            ? { disabled: running, onRemove: onToggleWorkspaceAccess }
            : undefined
        }
      />
      {needsWorkspaceAccess ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-divider bg-surface px-3 py-2">
          <Text variant="note">{petName} needs workspace access for this.</Text>
          <Button variant="secondary" onClick={onTurnOnWorkspaceAccess}>
            Turn on
          </Button>
        </div>
      ) : null}
      {applyWithoutAsking ? (
        // Not a live region: the menu item's own check already shows the state, and a region that
        // appears with its text already in it is read unreliably.
        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-divider bg-accent/15 px-3 py-2">
          <div className="flex min-w-0 flex-col">
            <Text variant="note">Applying changes without asking</Text>
            <Text variant="note" tone="muted">
              Moves, trash, template saves and external links still ask.
            </Text>
          </div>
          <Button
            variant="secondary"
            onClick={() => {
              onApplyChange(false);
              // The banner goes with this button, so focus returns to the "+" that turns it on.
              plusTrigger.current?.current?.focus();
            }}
          >
            Turn off
          </Button>
        </div>
      ) : null}
      {slashOptions.length > 0 ? (
        <div className="flex max-h-48 shrink-0 flex-col overflow-y-auto rounded border border-divider bg-background">
          <Listbox
            label="Actions"
            options={slashOptions}
            controller={slashListbox}
            emptyMessage="No matching actions"
          />
        </div>
      ) : null}
      <label htmlFor="pet-message" className="sr-only">
        Message {petName}
      </label>
      <div className="flex min-w-0 items-end gap-2">
        <Menu label="Add to message" items={addItems}>
          {(trigger) => {
            plusTrigger.current = trigger.ref;
            return (
              <Button {...trigger} variant="icon" className="shrink-0" aria-label="Add to message">
                <Icon icon={Plus} size="sm" />
              </Button>
            );
          }}
        </Menu>
        {hasPage ? (
          // Its own button, not a menu entry: choosing from a menu moves focus and can drop the
          // page selection this action shares, and the mousedown guard keeps it.
          <Button
            variant="icon"
            className="shrink-0"
            aria-label={hasSelection ? 'Share selected text' : 'Select text on the page first'}
            disabled={!hasSelection || contextCount >= MAX_CONTEXTS}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={onShareSelection}
          >
            <Icon icon={TextQuote} size="sm" />
          </Button>
        ) : null}
        <Textarea
          id="pet-message"
          ref={input}
          rows={1}
          maxLength={8000}
          value={draft}
          placeholder={`Message ${petName}`}
          enterKeyHint={touchLikeComposer ? undefined : 'send'}
          resize="none"
          className="min-w-0 max-h-32 flex-1 @sm:max-h-48"
          onChange={(event) => {
            onDraftChange(event.currentTarget.value);
          }}
          aria-controls={slashOptions.length > 0 ? slashListbox.id : undefined}
          aria-activedescendant={slashOptions.length > 0 ? slashListbox.activeOptionId : undefined}
          onBlur={() => {
            if (slashOptions.length > 0) slash.dismiss();
          }}
          onKeyDown={onComposerKeyDown}
        />
        {/* One element for Send and Stop, so focus stays on it when a turn starts and ends. */}
        <Button
          variant="primary"
          className="w-(--control-md) shrink-0 px-0 any-pointer-coarse:w-(--control-lg)"
          aria-label={running ? 'Stop response' : 'Send'}
          disabled={!running && !canSend}
          onClick={running ? onInterrupt : onSubmit}
        >
          <Icon icon={running ? Square : ArrowUp} size="sm" />
        </Button>
      </div>
    </div>
  );
}
