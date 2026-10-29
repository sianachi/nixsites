import { type PetProfile, type PetSettings } from '@nix/api-client';
import { Button, ContextMenu, Icon, Menu, Text, type MenuEntry } from '@nix/ui';
import { ChevronDown, MoreHorizontal, X } from 'lucide-react';
import { type ReactElement, type RefObject } from 'react';
import { Link } from 'react-router';
import { PetAvatar, type PetAnimationState } from '../../pet-avatar';
import { TitleEditor } from '../../pet-history';
import { statusIsQuiet } from '../state/status-text';

function renderMenuLink({
  href,
  children,
  ...rest
}: Parameters<NonNullable<Parameters<typeof Menu>[0]['renderLink']>>[0]): ReactElement {
  return (
    <Link to={href} {...rest}>
      {children}
    </Link>
  );
}

interface NoteScope {
  readonly rootItemId: string;
  readonly title: string;
  readonly readOnly: boolean;
  readonly onReadOnlyChange: (readOnly: boolean) => void;
}

/** What a note chat may do: read the note, or propose edits that each ask first. A menu rather
 * than a select, so the header stays one row. */
function NoteAccessChip({
  noteScope,
  locked,
}: {
  readonly noteScope: NoteScope;
  readonly locked: boolean;
}): ReactElement {
  const current = noteScope.readOnly ? 'Read only' : 'Can edit';
  return (
    <>
      <Menu
        label="Note chat access"
        items={[
          {
            label: 'Read only',
            role: 'menuitemradio',
            checked: noteScope.readOnly,
            onSelect: () => {
              noteScope.onReadOnlyChange(true);
            },
          },
          {
            label: 'Approved edits',
            role: 'menuitemradio',
            checked: !noteScope.readOnly,
            onSelect: () => {
              noteScope.onReadOnlyChange(false);
            },
          },
        ]}
      >
        {(trigger) => (
          <Button
            {...trigger}
            data-context-menu-ignore
            variant="ghost"
            className="shrink-0"
            disabled={locked}
            aria-label={`Note access: ${current}`}
            aria-describedby="pet-note-access-hint"
          >
            {current}
            <Icon icon={ChevronDown} size="sm" />
          </Button>
        )}
      </Menu>
      <Text as="span" variant="note" className="sr-only" id="pet-note-access-hint">
        Reads this note and its readable children on demand. Search and results can be partial.
        Every change asks first.
      </Text>
    </>
  );
}

export function ConversationHeader({
  layout,
  zen,
  petName,
  appearance,
  motion,
  animation,
  status,
  title,
  renaming,
  renameBusy,
  renameError,
  onRename,
  onCancelRename,
  menuItems,
  menuTrigger,
  onClose,
  noteScope,
  locked,
}: {
  readonly layout: string;
  readonly zen: boolean;
  readonly petName: string;
  readonly appearance: PetProfile['appearance'];
  readonly motion: PetSettings['motion'];
  readonly animation: PetAnimationState;
  readonly status: string;
  /** The conversation's own title, when it has one. */
  readonly title: string | undefined;
  readonly renaming: boolean;
  readonly renameBusy: boolean;
  readonly renameError: string;
  readonly onRename: (title: string) => void;
  readonly onCancelRename: () => void;
  readonly menuItems: MenuEntry[];
  readonly menuTrigger: RefObject<{ current: HTMLButtonElement | null } | null>;
  readonly onClose: (() => void) | undefined;
  readonly noteScope: NoteScope | undefined;
  /** A turn is running: the note access cannot change. */
  readonly locked: boolean;
}): ReactElement {
  // A new conversation's title is an empty string, not absent.
  const heading = [noteScope?.title, title].find((value) => value) ?? petName;
  return (
    <ContextMenu label="Conversation actions" items={menuItems} renderLink={renderMenuLink}>
      {(target) => (
        <div
          {...target}
          className={`flex shrink-0 select-none flex-col gap-2 border-b border-divider bg-surface p-3 @sm:px-4 ${layout === 'page' && zen ? 'pr-16 @sm:pr-16' : ''}`}
        >
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-3">
              <div aria-hidden="true" className="hidden shrink-0 @md:block">
                <PetAvatar
                  appearance={appearance}
                  motion={motion}
                  state={animation}
                  label={`${petName}: ${animation}`}
                  size="compact"
                />
              </div>
              <div className="flex min-w-0 flex-col">
                <Text variant="h5" as="h2" title={heading} truncate>
                  {heading}
                </Text>
                {/* Only what needs attention is drawn; Ready and the states the log already shows
                    stay in the accessibility tree without taking a line. */}
                <Text
                  role="status"
                  // The conversation's one announcer speaks replies and approvals; this line is visual.
                  aria-live="off"
                  variant="note"
                  tone="muted"
                  truncate
                  {...(statusIsQuiet(status) ? { className: 'sr-only' } : {})}
                >
                  {status}
                </Text>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {noteScope ? <NoteAccessChip noteScope={noteScope} locked={locked} /> : null}
              <Menu label="Conversation actions" items={menuItems} renderLink={renderMenuLink}>
                {(trigger) => {
                  menuTrigger.current = trigger.ref;
                  return (
                    <Button {...trigger} variant="icon" aria-label="More conversation actions">
                      <Icon icon={MoreHorizontal} size="sm" />
                    </Button>
                  );
                }}
              </Menu>
              {onClose ? (
                <Button
                  data-context-menu-ignore
                  variant="icon"
                  aria-label="Close"
                  onClick={onClose}
                >
                  <Icon icon={X} size="sm" />
                </Button>
              ) : null}
            </div>
          </div>
          {renaming ? (
            <div data-context-menu-ignore className="flex min-w-0 flex-col gap-1">
              <TitleEditor
                initial={title ?? ''}
                busy={renameBusy}
                onSave={onRename}
                onCancel={onCancelRename}
              />
              {renameError ? <Text role="alert">{renameError}</Text> : null}
            </div>
          ) : null}
        </div>
      )}
    </ContextMenu>
  );
}
