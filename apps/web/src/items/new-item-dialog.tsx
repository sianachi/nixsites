import {
  Button,
  Dialog,
  Field,
  Icon,
  Input,
  Segmented,
  Textarea,
  Text,
  cn,
  fieldLabel,
  focusRing,
} from '@nix/ui';
import {
  LayoutTemplate,
  MessageSquare,
  PencilRuler,
  Sheet,
  Sparkles,
  Upload,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';

import { findViewKind } from '@nix/web-views/core/view-kinds';
import type { TemplateLibraryStatus } from '@nix/web-templates/templates/use-templates';
import type { TemplateSummary } from '@nix/web-templates/templates/template-api';
import {
  RECIPE_GROUPS,
  STRUCTURED_RECIPES,
  type StructuredRecipeId,
} from '@nix/web-views/wizard/structured-recipes';

type NewItemKind = 'canvas' | 'spreadsheet';

type NewItemDialogMode =
  { readonly kind: 'item'; readonly type: NewItemKind } | { readonly kind: 'structured' };

/** What each plain kind is called, in the dialog's title and button and as its default title. */
const NEW_ITEM_KINDS: Readonly<
  Record<NewItemKind, { readonly noun: string; readonly untitled: string }>
> = {
  canvas: { noun: 'canvas', untitled: 'Untitled canvas' },
  spreadsheet: { noun: 'sheet', untitled: 'Untitled spreadsheet' },
};

export interface NewItemDialogProps {
  /** The item selected in the tree, offered as a place to create inside; null when none is. */
  readonly childDestination: { readonly id: string; readonly name: string } | null;
  readonly initialTitle: string;
  readonly insideByDefault: boolean;
  readonly templates: readonly TemplateSummary[];
  readonly templateStatus: TemplateLibraryStatus;
  readonly onClose: () => void;
  readonly onCreate: (parentId: string | null, title: string, type: NewItemKind) => void;
  readonly onChat: (parentId: string | null) => void;
  readonly onRequest: (parentId: string | null, prompt: string) => void;
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
    case 'structured':
      return 'New structured item';
  }
}

/** A row in the structured and template lists: a name and the sentence that explains it. */
function Choice(props: {
  readonly label: string;
  readonly detail: string | null;
  readonly icon?: LucideIcon;
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
        <Icon icon={props.icon ?? LayoutTemplate} size="sm" className="mt-0.5 shrink-0" />
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
  const { childDestination, onClose } = props;
  // A canvas or sheet chosen from the structured list moves on to naming it, in the same dialog.
  const [mode, setMode] = useState<NewItemDialogMode>({ kind: 'structured' });
  const [place, setPlace] = useState<Place>(props.insideByDefault ? 'inside' : 'root');
  const [title, setTitle] = useState(props.initialTitle);
  const [prompt, setPrompt] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLFormElement>(null);
  // Naming starts at once, including after a canvas or sheet is picked from the structured list.
  useEffect(() => {
    if (mode.kind === 'item') titleRef.current?.focus();
  }, [mode]);
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
                maxLength={240}
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

  // Structured recipes and the workspace's templates in one dialog: both start a structured item.
  const { templates, templateStatus } = props;
  return (
    <Dialog
      open
      title={titleOf(mode)}
      onClose={onClose}
      initialFocus={pickerRef}
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
        <form
          ref={pickerRef}
          tabIndex={-1}
          className="flex flex-col gap-2 rounded-md border border-divider bg-surface p-3"
          onSubmit={(event) => {
            event.preventDefault();
            const request = prompt.trim();
            if (request)
              done(() => {
                props.onRequest(parentId, request);
              });
          }}
        >
          <Field label="Create with your companion">
            {(control) => (
              <Textarea
                {...control}
                rows={2}
                maxLength={2000}
                placeholder="A BMI calculator"
                value={prompt}
                onChange={(event) => {
                  setPrompt(event.currentTarget.value);
                }}
              />
            )}
          </Field>
          <Button type="submit" disabled={!prompt.trim()} className="self-end">
            <Icon icon={Sparkles} size="sm" />
            Ask companion
          </Button>
        </form>
        {placeControl}
        <div className="flex min-w-0 flex-col gap-1">
          <Text as="h3" variant="kicker" tone="muted" id="new-structured-canvas">
            Create or add
          </Text>
          <ul aria-labelledby="new-structured-canvas" className="-mx-3 flex flex-col">
            <Choice
              label="Canvas"
              icon={PencilRuler}
              detail="A freeform board for shapes, notes and drawings"
              onChoose={() => {
                setMode({ kind: 'item', type: 'canvas' });
              }}
            />
            <Choice
              label="Sheet"
              icon={Sheet}
              detail="A spreadsheet with formulas"
              onChoose={() => {
                setMode({ kind: 'item', type: 'spreadsheet' });
              }}
            />
            <Choice
              label="Chat"
              icon={MessageSquare}
              detail="Start a saved companion conversation."
              onChoose={() => {
                done(() => {
                  props.onChat(parentId);
                });
              }}
            />
            <Choice
              label="Upload"
              icon={Upload}
              detail="Add files from your device."
              onChoose={() => {
                done(() => {
                  props.onUpload(parentId);
                });
              }}
            />
          </ul>
        </div>
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
                    icon={findViewKind(recipe.viewKind)?.icon ?? LayoutTemplate}
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
        <div className="flex min-w-0 flex-col gap-1">
          <Text as="h3" variant="kicker" tone="muted" id="new-structured-templates">
            From a template
          </Text>
          {templates.length === 0 ? (
            <Text variant="note" tone="muted" role="status">
              {templateStatus === 'loading'
                ? 'Loading templates…'
                : templateStatus === 'error'
                  ? 'Templates are unavailable.'
                  : 'This workspace has no templates yet. Manage templates to make one.'}
            </Text>
          ) : (
            <ul aria-labelledby="new-structured-templates" className="-mx-3 flex flex-col">
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
      </div>
    </Dialog>
  );
}
