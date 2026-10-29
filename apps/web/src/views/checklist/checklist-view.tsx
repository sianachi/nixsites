import {
  Button,
  Checkbox,
  ContextMenu,
  Field,
  Icon,
  Input,
  Select,
  Text,
  cn,
  focusRing,
} from '@nix/ui';
import { ArrowUpRight, Plus } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { useItemOpenProps } from '../core/item-open-click';
import { ShownItems, useOptionalItemSelection } from '../core/item-selection-context';
import { SelectCheckbox } from '../core/select-checkbox';
import {
  readPropertyText,
  type Item,
  type PropertyDefinition,
  type View,
} from '../core/container-model';
import { TITLE_COLUMN_KEY } from '../core/columns';
import { propertyTypeWord, valueShapeOf } from '../core/property-types';
import type { ContainerData } from '../core/use-container';
import { useItemContextActions } from '../core/use-item-context-actions';
import { drawable, undrawable, useViewChrome } from '../core/view-chrome';
import type { ViewConfigurationEditorProps } from '../core/view-kinds';
import { useViewState } from '../core/view-state';

/**
 * The checklist (plan 3.4): one line per child - a box and the title, either of which ticks it, then one optional property and a trailing button that opens the item -
 * with the count done at the top and a field as the last line for adding the next.
 *
 * **The box is a property write, nothing else.** Ticking a line writes the checkbox the view
 * names, or - named nothing - a checkbox keyed `done`, or the schema's task completion. So a line
 * ticked here is ticked in the list, on the board and in every smart list that asks, exactly as a
 * board's column is its property value and not a placement of its own.
 *
 * **Made for a phone in a shop.** The add field stays open and keeps focus after each line, so a
 * list of ten things is ten names and ten Enters; the field is never disabled while a line saves,
 * because a disabled field drops focus and the eleventh name would go nowhere.
 */

export interface ChecklistViewProps {
  readonly container: ContainerData;
  readonly view: View;
  readonly onOpen: (itemId: string) => void;
}

/** Why a checklist cannot tick anything, as data, so the sentence can name the problem. */
type DoneResolution =
  | { readonly kind: 'ready'; readonly property: PropertyDefinition }
  | { readonly kind: 'missing'; readonly key: string }
  | { readonly kind: 'wrongType'; readonly property: PropertyDefinition }
  | { readonly kind: 'none' };

/** Whether a property is something a box can tick: a checkbox, or a task's completion. */
function isTickable(property: PropertyDefinition): boolean {
  return valueShapeOf(property.type) === 'checkbox';
}

/**
 * Which property the boxes tick: the one the view names, else a checkbox keyed `done`, else the
 * schema's task completion - the same order `refuseChecklist` in `@nix/structure-spec` checks, so
 * a pet told a checklist is valid is told so about the property this draws.
 */
export function resolveDoneProperty(
  properties: readonly PropertyDefinition[],
  named: string | null | undefined,
): DoneResolution {
  if (named !== null && named !== undefined && named.length > 0) {
    const property = properties.find((candidate) => candidate.key === named);
    if (property === undefined) return { kind: 'missing', key: named };
    return isTickable(property) ? { kind: 'ready', property } : { kind: 'wrongType', property };
  }

  const fallback =
    properties.find((candidate) => candidate.key === 'done' && isTickable(candidate)) ??
    properties.find((candidate) => candidate.type === 'completion');
  return fallback === undefined ? { kind: 'none' } : { kind: 'ready', property: fallback };
}

function describeDone(
  resolution: Exclude<DoneResolution, { kind: 'ready' }>,
  view: View,
): { readonly title: string; readonly detail: string } {
  switch (resolution.kind) {
    case 'none':
      return {
        title: 'This checklist has nothing to tick',
        detail: `"${view.name}" ticks a checkbox, and there is no checkbox called "Done" and no task completion here. Add one under Properties, or choose one in this view's settings.`,
      };
    case 'missing':
      return {
        title: 'This checklist ticks a property that no longer exists',
        detail: `"${view.name}" ticks a property that has been removed from this item. The items are all still here; choose another checkbox in this view's settings.`,
      };
    case 'wrongType':
      return {
        title: 'This checklist ticks a property that is not a checkbox',
        detail: `"${resolution.property.label}" is a ${propertyTypeWord(resolution.property.type)} property, and a checklist's boxes need a checkbox or a completion. The items are all still here; choose another in this view's settings.`,
      };
  }
}

export function ChecklistView(props: ChecklistViewProps): ReactNode {
  const { container, view, onOpen } = props;
  const viewState = useViewState();
  const [hideDone, setHideDone] = useState(false);
  const [refusals, setRefusals] = useState<ReadonlyMap<string, string>>(() => new Map());
  // Where focus goes once a ticked line has been hidden: the next visible line's box, so ticking
  // through a list with "Hide done" on never drops focus to the page. A ref, because it is an
  // instruction to the render that follows the write, not something to draw.
  const boxRefs = useRef(new Map<string, HTMLInputElement>());
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    const box = boxRefs.current.get(target);
    if (box !== undefined) {
      pendingFocus.current = null;
      box.focus();
    }
  });
  const properties = container.schema?.properties ?? [];
  const done = resolveDoneProperty(properties, view.doneProperty);

  const chrome = useViewChrome({
    container,
    viewState,
    subject: 'this checklist',
    drawable:
      done.kind === 'ready'
        ? drawable(done.property)
        : undrawable<PropertyDefinition>(describeDone(done, view)),
    emptyTitle: 'Nothing on this checklist yet',
    emptyDetail: 'Add the first line below; each one is an item inside this one.',
    filtered: (total) => ({
      title: 'No lines match the filters',
      detail: `This checklist holds ${String(total)} lines. The filters in the address are hiding all of them.`,
    }),
    savedRules: view.filters,
    view,
    sortBy: viewState.sortBy ?? view.sortBy,
    descending:
      viewState.sortBy === null ? view.sortDescending : viewState.direction === 'descending',
  });

  // An empty checklist is drawn by the checklist itself rather than the chrome's empty panel, so
  // the add field sits at the same place in the tree before and after the first line: focus typed
  // into it survives the first add instead of being dropped when the panel is replaced.
  const emptyAndReady =
    container.status === 'ready' &&
    !container.locked &&
    container.children.length === 0 &&
    done.kind === 'ready';
  if (chrome.kind === 'chrome' && !emptyAndReady) {
    return chrome.node;
  }
  if (done.kind !== 'ready') return null;

  const doneProperty = done.property;
  const items = chrome.kind === 'items' ? chrome.items : [];
  const notice = chrome.kind === 'items' ? chrome.notice : null;
  const isDone = (item: Item): boolean => item.properties[doneProperty.key] === true;
  const secondary = secondaryProperty(view, properties, doneProperty.key);
  const doneCount = items.filter(isDone).length;
  const shown = hideDone ? items.filter((item) => !isDone(item)) : items;

  function tick(item: Item, checked: boolean): void {
    if (hideDone && checked) {
      const at = shown.findIndex((candidate) => candidate.id === item.id);
      pendingFocus.current = (shown[at + 1] ?? shown[at - 1])?.id ?? null;
    }
    setRefusals((current) => withoutKey(current, item.id));
    void container.setProperties(item.id, { [doneProperty.key]: checked }).then((refusal) => {
      if (refusal !== null) {
        setRefusals((current) => new Map(current).set(item.id, refusal));
      }
    });
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-3">
      <ShownItems ids={shown.map((line) => line.id)} />
      {notice}

      {items.length === 0 ? (
        <Text variant="bodySmall" tone="muted">
          Nothing on this checklist yet.
        </Text>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <Text variant="bodySmall" tone="muted" as="p" role="status" aria-live="polite">
            {`${String(doneCount)} of ${String(items.length)} done`}
          </Text>
          <Button
            variant="ghost"
            aria-pressed={hideDone}
            onClick={() => {
              setHideDone((current) => !current);
            }}
          >
            Hide done
          </Button>
        </div>
      )}

      {items.length > 0 && shown.length === 0 ? (
        <Text variant="bodySmall" tone="muted">
          All done.
        </Text>
      ) : null}

      {/* Drawn even when empty, so the add field keeps its place in the tree across the first add. */}
      <ul aria-label={`${view.name} lines`} className="flex flex-col divide-y divide-divider">
        {shown.map((item) => (
          <ChecklistLine
            key={item.id}
            item={item}
            done={isDone(item)}
            boxRef={(element) => {
              if (element === null) boxRefs.current.delete(item.id);
              else boxRefs.current.set(item.id, element);
            }}
            secondary={secondary}
            refusal={refusals.get(item.id) ?? null}
            onTick={(checked) => {
              tick(item, checked);
            }}
            onOpen={onOpen}
          />
        ))}
        <AddLine onCreate={container.create} />
      </ul>
    </div>
  );
}

/**
 * The one property each line shows beside its title: the first of the view's columns that is a
 * property and not the box itself. A checklist has room for one; the rest belong on a list.
 */
function secondaryProperty(
  view: View,
  properties: readonly PropertyDefinition[],
  doneKey: string,
): PropertyDefinition | null {
  for (const key of view.columns) {
    if (key === TITLE_COLUMN_KEY || key === doneKey) continue;
    const property = properties.find((candidate) => candidate.key === key);
    if (property !== undefined) return property;
  }
  return null;
}

function withoutKey(map: ReadonlyMap<string, string>, key: string): ReadonlyMap<string, string> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

interface ChecklistLineProps {
  readonly item: Item;
  readonly done: boolean;
  readonly boxRef: (element: HTMLInputElement | null) => void;
  readonly secondary: PropertyDefinition | null;
  readonly refusal: string | null;
  readonly onTick: (checked: boolean) => void;
  readonly onOpen: (itemId: string) => void;
}

function ChecklistLine(props: ChecklistLineProps): ReactNode {
  const { item, done, boxRef, secondary, refusal, onTick, onOpen } = props;
  const itemActions = useItemContextActions(onOpen);
  const openProps = useItemOpenProps(onOpen);
  const selection = useOptionalItemSelection();
  const isSelected = selection?.selected.has(item.id) === true;
  const selecting = selection !== null && selection.selected.size > 0;
  const title = item.title.length > 0 ? item.title : 'Untitled';
  const detail = secondary === null ? '' : readPropertyText(item, secondary.key);

  return (
    <ContextMenu
      label={`${title} actions`}
      items={() =>
        itemActions(item.id, item.title, [
          {
            kind: 'action',
            label: done ? 'Mark as not done' : 'Mark as done',
            onSelect: () => {
              onTick(!done);
            },
          },
        ])
      }
    >
      {(contextTarget) => (
        <li {...contextTarget} className={cn('group flex flex-col', isSelected && 'bg-accent/10')}>
          <div className="flex min-w-0 items-center gap-2">
            {selecting ? <SelectCheckbox item={item} /> : null}
            {/* Named by the line's title: "Buy milk, checkbox, not checked" is the sentence a screen
                reader should say. The text beside it ticks too, with a click handler and not a
                <label>: the context menu skips a press that starts on a label, so a label would
                lose long-press on the largest target in the row. The box stays the keyboard path. */}
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Checkbox
                ref={boxRef}
                aria-label={title}
                checked={done}
                onChange={(event) => {
                  onTick(event.target.checked);
                }}
              />
              {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- Justification: a pointer shortcut for the checkbox beside it, which stays the keyboard and screen-reader control. */}
              <span
                className="flex min-w-0 flex-1 cursor-default items-center py-0.5 any-pointer-coarse:min-h-(--control-lg)"
                onClick={() => {
                  onTick(!done);
                }}
              >
                <Text
                  as="span"
                  variant="body"
                  tone={done ? 'muted' : 'default'}
                  className={cn('min-w-0 break-words', done && 'line-through')}
                >
                  {title}
                </Text>
              </span>
            </div>
            {detail.length === 0 || secondary === null ? null : (
              <Text
                as="span"
                variant="caption"
                tone="muted"
                lines={1}
                className="min-w-0 max-w-1/3 truncate"
              >
                <span className="sr-only">{secondary.label}: </span>
                {detail}
              </Text>
            )}
            <button
              type="button"
              aria-label={`Open ${title}`}
              {...openProps(item.id)}
              className={cn(
                'inline-flex size-(--control-sm) shrink-0 items-center justify-center rounded-sm text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100 any-pointer-coarse:size-(--control-lg) any-pointer-coarse:opacity-100',
                focusRing,
              )}
            >
              <Icon icon={ArrowUpRight} size="sm" />
            </button>
          </div>
          {refusal === null ? null : (
            <Text as="p" variant="caption" tone="accent" role="alert">
              {refusal} The box is back as it was.
            </Text>
          )}
        </li>
      )}
    </ContextMenu>
  );
}

/**
 * The field at the foot of the checklist. Always open, and never disabled while a line saves: the
 * name is taken and the field cleared before the write goes out, so focus stays where the next
 * name will be typed. A refused line puts its name back so nothing typed is lost.
 */
function AddLine({
  onCreate,
}: {
  readonly onCreate: (title: string) => Promise<string | null>;
}): ReactNode {
  const [title, setTitle] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const refusalId = useId();

  function submit(event: { preventDefault: () => void }): void {
    event.preventDefault();
    const named = title.trim();
    if (named.length === 0) return;

    setTitle('');
    setRefusal(null);
    void onCreate(named).then((reason) => {
      if (reason !== null) {
        setRefusal(reason);
        setTitle((current) => (current.length === 0 ? named : current));
      }
    });
    fieldRef.current?.focus();
  }

  return (
    <li>
      <form onSubmit={submit} className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-flex size-(--control-sm) shrink-0 items-center justify-center text-muted any-pointer-coarse:size-(--control-lg)"
          >
            <Icon icon={Plus} size="sm" />
          </span>
          <Input
            ref={fieldRef}
            aria-label="Add a line"
            placeholder="Add a line"
            enterKeyHint="enter"
            value={title}
            {...(refusal === null ? {} : { 'aria-describedby': refusalId })}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
          {title.trim().length > 0 ? (
            <Button type="submit" variant="ghost">
              Add
            </Button>
          ) : null}
        </div>
        {refusal === null ? null : (
          <Text id={refusalId} as="p" variant="caption" tone="accent" role="alert">
            {refusal}
          </Text>
        )}
      </form>
    </li>
  );
}

/**
 * The one property a checklist shows beside each title. Stored as the view's first column, which
 * is what a list switched to a checklist already has there; a checklist has room for one, so this
 * is a single choice rather than the list's ordered column picker.
 */
export function ChecklistDetailChoice({
  view,
  fields,
  onChange,
}: ViewConfigurationEditorProps): ReactNode {
  const current = view.columns.find((key) => key !== 'title') ?? '';
  // The box is already on every line, so the property it ticks is not offered as the detail too.
  const done = resolveDoneProperty(fields, view.doneProperty);
  const offered = fields.filter(
    (field) => done.kind !== 'ready' || field.key !== done.property.key,
  );
  return (
    <Field label="Shown beside each line" hint="One property, read-only, after the title.">
      {(control) => (
        <Select
          {...control}
          value={current}
          onChange={(event) => {
            const value = event.target.value;
            onChange({ ...view, columns: value.length === 0 ? [] : [value] });
          }}
        >
          <option value="">Nothing</option>
          {offered.map((field) => (
            <option key={field.key} value={field.key}>
              {field.label}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}
