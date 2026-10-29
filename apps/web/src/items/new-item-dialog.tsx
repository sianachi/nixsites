import {
  Button,
  Dialog,
  Field,
  Icon,
  Input,
  Segmented,
  Text,
  cn,
  fieldLabel,
  focusRing,
} from '@nix/ui';
import { LayoutTemplate } from 'lucide-react';
import { useId, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';

import type { TemplateLibraryStatus } from '../templates/use-templates';
import type { TemplateSummary } from '../templates/template-api';
import {
  RECIPE_GROUPS,
  STRUCTURED_RECIPES,
  type StructuredRecipeId,
} from '@nix/web-views/wizard/structured-recipes';

/**
 * The dialog behind each entry of the sidebar's New menu.
 *
 * The menu used to be the whole flow: a destination checkbox, every body kind, upload,
 * every structured recipe and three templates in one long list, with an item created the moment
 * its row was chosen and named "Untitled" until somebody renamed it. The menu now names six
 * things, and each opens this dialog, which asks the two questions that decide what gets made -
 * where it goes and, for a plain item, what it is called - before anything is created.
 *
 * **Where it goes** is the same choice in every mode, so it is one control at the top. The top of
 * the workspace is the default every time the dialog opens: a previous creation inside an item
 * must not quietly turn the next one into another child.
 *
 * **Structured items and templates** are listed in full, each with the sentence that says what it
 * is - the detail the menu could not show.
 */

export type NewItemKind = 'note' | 'canvas' | 'spreadsheet';

export type NewItemDialogMode =
  | { readonly kind: 'item'; readonly type: NewItemKind }
  | { readonly kind: 'upload' }
  | { readonly kind: 'structured' }
  | { readonly kind: 'template' };

/** What each plain kind is called, in the dialog's title and button and as its default title. */
export const NEW_ITEM_KINDS: Readonly<
  Record<NewItemKind, { readonly noun: string; readonly untitled: string }>
> = {
  note: { noun: 'note', untitled: 'Untitled note' },
  canvas: { noun: 'canvas', untitled: 'Untitled canvas' },
  spreadsheet: { noun: 'sheet', untitled: 'Untitled spreadsheet' },
};

export interface NewItemDialogProps {
  readonly mode: NewItemDialogMode;
  /** The item selected in the tree, offered as a place to create inside; null when none is. */
  readonly childDestination: { readonly id: string; readonly name: string } | null;
  readonly templates: readonly TemplateSummary[];
  readonly templateStatus: TemplateLibraryStatus;
  readonly onClose: () => void;
  readonly onCreate: (parentId: string | null, title: string, type: NewItemKind) => void;
  readonly onUpload: (parentId: string | null) => void;
  readonly onStartStructured: (parentId: string | null, recipe: StructuredRecipeId) => void;
  readonly onStartTemplate: (parentId: string | null, templateId: string) => void;
  readonly onBrowseTemplates: (parentId: string | null) => void;
}

type Place = 'root' | 'inside';

function titleOf(mode: NewItemDialogMode): string {
  switch (mode.kind) {
    case 'item':
      return `New ${NEW_ITEM_KINDS[mode.type].noun}`;
    case 'upload':
      return 'Upload files';
    case 'structured':
      return 'New structured item';
    case 'template':
      return 'New from a template';
  }
}

/** A row in the structured and template lists: a name and the sentence that explains it. */
function Choice(props: {
  readonly label: string;
  readonly detail: string | null;
  readonly onChoose: () => void;
}): ReactNode {
  return (
    <li>
      <button
        type="button"
        onClick={props.onChoose}
        className={cn(
          'flex min-w-0 w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-accent/10',
          focusRing,
        )}
      >
        <Icon icon={LayoutTemplate} size="sm" className="mt-0.5 shrink-0" />
        <span className="flex min-w-0 flex-col gap-0.5">
          <Text as="span" variant="body" className="break-words">
            {props.label}
          </Text>
          {props.detail === null || props.detail === '' ? null : (
            <Text as="span" variant="caption" tone="muted" className="break-words">
              {props.detail}
            </Text>
          )}
        </span>
      </button>
    </li>
  );
}

export function NewItemDialog(props: NewItemDialogProps): ReactNode {
  const { mode, childDestination, onClose } = props;
  const [place, setPlace] = useState<Place>('root');
  const [title, setTitle] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);
  const placeHintId = useId();

  const parentId = place === 'inside' && childDestination !== null ? childDestination.id : null;
  const done = (action: () => void): void => {
    action();
    onClose();
  };

  const placeControl =
    childDestination === null ? (
      <Text variant="note" tone="muted" id={placeHintId}>
        It goes at the top of the workspace. Select an item in the tree first to put it inside one.
      </Text>
    ) : (
      <div className="flex flex-col gap-1.5">
        <span aria-hidden="true" className={fieldLabel}>
          Where
        </span>
        <Segmented<Place>
          label="Where"
          value={place}
          onChange={setPlace}
          options={[
            { value: 'root', label: 'Top of workspace' },
            { value: 'inside', label: `Inside ${childDestination.name}` },
          ]}
        />
      </div>
    );

  if (mode.kind === 'item') {
    const kind = NEW_ITEM_KINDS[mode.type];
    const submit = (event: SyntheticEvent): void => {
      event.preventDefault();
      const trimmed = title.trim();
      done(() => {
        props.onCreate(parentId, trimmed === '' ? kind.untitled : trimmed, mode.type);
      });
    };
    return (
      <Dialog
        open
        title={titleOf(mode)}
        onClose={onClose}
        initialFocus={titleRef}
        actions={
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form="new-item-form">
              Create {kind.noun}
            </Button>
          </>
        }
      >
        <form id="new-item-form" onSubmit={submit} className="flex min-w-0 flex-col gap-4">
          <Field label="Title" hint={`Left empty, it is called "${kind.untitled}".`}>
            {(control) => (
              <Input
                {...control}
                ref={titleRef}
                value={title}
                placeholder={kind.untitled}
                onChange={(event) => {
                  setTitle(event.currentTarget.value);
                }}
              />
            )}
          </Field>
          {placeControl}
        </form>
      </Dialog>
    );
  }

  if (mode.kind === 'upload') {
    return (
      <Dialog
        open
        title={titleOf(mode)}
        onClose={onClose}
        actions={
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                done(() => {
                  props.onUpload(parentId);
                });
              }}
            >
              Choose files
            </Button>
          </>
        }
      >
        <div className="flex min-w-0 flex-col gap-4">
          <Text variant="body">
            Each file becomes an item you can open, preview and link to. You can also drop files
            onto the tree or into a note.
          </Text>
          {placeControl}
        </div>
      </Dialog>
    );
  }

  if (mode.kind === 'structured') {
    // Every recipe the registry has, under the headings it declares: the menu no longer hides the
    // kinds that used to be reachable only through "Add view" on an existing item.
    return (
      <Dialog open title={titleOf(mode)} onClose={onClose}>
        <div className="flex min-w-0 flex-col gap-4">
          {placeControl}
          {RECIPE_GROUPS.map((group) => {
            const recipes = STRUCTURED_RECIPES.filter((recipe) => recipe.group === group);
            if (recipes.length === 0) return null;
            return (
              <div key={group} className="flex min-w-0 flex-col gap-1">
                <Text as="h3" variant="kicker" tone="muted" id={`new-structured-${group}`}>
                  {group}
                </Text>
                <ul aria-labelledby={`new-structured-${group}`} className="-mx-3 flex flex-col">
                  {recipes.map((recipe) => (
                    <Choice
                      key={recipe.id}
                      label={recipe.label}
                      detail={recipe.detail}
                      onChoose={() => {
                        done(() => {
                          props.onStartStructured(parentId, recipe.id);
                        });
                      }}
                    />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </Dialog>
    );
  }

  const { templates, templateStatus } = props;
  return (
    <Dialog
      open
      title={titleOf(mode)}
      onClose={onClose}
      actions={
        <Button
          variant="ghost"
          onClick={() => {
            done(() => {
              props.onBrowseTemplates(parentId);
            });
          }}
        >
          Manage templates
        </Button>
      }
    >
      <div className="flex min-w-0 flex-col gap-4">
        {placeControl}
        {templates.length === 0 ? (
          <Text variant="note" tone="muted" role="status">
            {templateStatus === 'loading'
              ? 'Loading templates…'
              : templateStatus === 'error'
                ? 'Templates are unavailable.'
                : 'This workspace has no templates yet. Manage templates to make one.'}
          </Text>
        ) : (
          <ul aria-label="Templates" className="-mx-3 flex flex-col">
            {templates.map((template) => (
              <Choice
                key={template.id}
                label={template.title}
                detail={template.description}
                onChoose={() => {
                  done(() => {
                    props.onStartTemplate(parentId, template.id);
                  });
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
