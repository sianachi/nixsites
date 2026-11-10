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
  useFlash,
  useUndo,
} from '@nix/ui';
import { ArrowUpRight, Plus } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { useOptionalItemCommands } from '@nix/web-collections/items/item-commands-context';
import { useItemOpenProps } from '@nix/web-collections/core/item-open-click';
import {
  ShownItems,
  useOptionalItemSelection,
} from '@nix/web-collections/core/item-selection-context';
import { SelectCheckbox } from '../core/select-checkbox';
import {
  readPropertyText,
  type Item,
  type PropertyDefinition,
  type View,
} from '@nix/web-collections/core/container-model';
import { TITLE_COLUMN_KEY } from '@nix/web-collections/core/columns';
import { propertyTypeWord, valueShapeOf } from '@nix/web-collections/core/property-types';
import type { ContainerData } from '@nix/web-collections/core/use-container';
import { useCompactCollection } from '@nix/web-foundation/layout/zen-presentation';
import { useItemContextActions } from '@nix/web-collections/core/use-item-context-actions';
import { drawable, undrawable, useViewChrome } from '../core/view-chrome';
import type { ViewConfigurationEditorProps } from '../core/view-kinds';
import { useViewState } from '@nix/web-collections/core/view-state';

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
  const undo = useUndo();
  const commands = useOptionalItemCommands();
  const [editing, setEditing] = useState<string | null>(null);
  // Lines fading out of "Clear done" and titles just added (for the enter motion).
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set());
  const [entering, setEntering] = useState<ReadonlySet<string>>(() => new Set());
  // The newest children, for an undo that runs later and must see what exists by then.
  const latest = useRef<readonly Item[]>(container.children);
  useEffect(() => {
    latest.current = container.children;
  });
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
        return;
      }
      const name = item.title.length > 0 ? item.title : 'Untitled';
      undo.push(`${checked ? 'Ticked' : 'Unticked'} ${name}`, async () => {
        await container.setProperties(item.id, { [doneProperty.key]: !checked });
      });
    });
  }

  /** Adds lines in order; one undo entry removes exactly the lines this call made. */
  async function addLines(titles: readonly string[]): Promise<string | null> {
    const before = new Set(latest.current.map((child) => child.id));
    let refusal: string | null = null;
    const made: string[] = [];
    for (const title of titles) {
      refusal = await container.create(title);
      if (refusal !== null) break;
      made.push(title);
    }
    if (made.length > 0) {
      setEntering((current) => new Set([...current, ...made]));
      window.setTimeout(() => {
        setEntering((current) => new Set([...current].filter((title) => !made.includes(title))));
      }, 1000);
      const tree = commands?.tree;
      if (tree !== undefined) {
        undo.push(
          made.length === 1 ? `Added ${made[0] ?? ''}` : `Added ${String(made.length)} lines`,
          async () => {
            const taken = new Set<string>();
            for (const title of made) {
              const child = latest.current.find(
                (candidate) =>
                  !before.has(candidate.id) &&
                  !taken.has(candidate.id) &&
                  candidate.title === title,
              );
              if (child === undefined) continue;
              taken.add(child.id);
              await tree.remove(child.id);
            }
          },
        );
      }
    }
    return refusal;
  }

  /** Removes every done line; Undo brings back exactly those lines. */
  function clearDone(): void {
    const tree = commands?.tree;
    const targets = items.filter(isDone);
    if (tree === undefined || targets.length === 0) return;
    setLeaving(new Set(targets.map((line) => line.id)));
    window.setTimeout(() => {
      void (async () => {
        const removed: string[] = [];
        for (const line of targets) {
          const outcome = await tree.remove(line.id);
          if (outcome.refusal === null) removed.push(line.id);
        }
        setLeaving(new Set());
        if (removed.length > 0) {
          undo.push(
            `Cleared ${String(removed.length)} done ${removed.length === 1 ? 'line' : 'lines'}`,
            async () => {
              for (const id of removed) await tree.restore(id);
            },
          );
        }
      })();
    }, 150);
  }

  async function saveEdit(item: Item, title: string, detail: string): Promise<void> {
    setEditing(null);
    const tree = commands?.tree;
    const name = title.trim();
    const writes: (() => Promise<unknown>)[] = [];
    const reverts: (() => Promise<unknown>)[] = [];
    if (tree !== undefined && name.length > 0 && name !== item.title) {
      writes.push(() => tree.rename(item.id, name));
      reverts.push(() => tree.rename(item.id, item.title));
    }
    if (
      secondary !== null &&
      secondary.type === 'text' &&
      detail.trim() !== readPropertyText(item, secondary.key)
    ) {
      const key = secondary.key;
      const before = item.properties[key] ?? '';
      writes.push(() => container.setProperties(item.id, { [key]: detail.trim() }));
      reverts.push(() => container.setProperties(item.id, { [key]: before }));
    }
    if (writes.length === 0) return;
    for (const write of writes) await write();
    // A rename goes through the tree, which does not tell this container; read the lines again.
    await container.reload();
    undo.push(`Edited ${item.title.length > 0 ? item.title : 'Untitled'}`, async () => {
      for (const revert of reverts) await revert();
      await container.reload();
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
          <div className="flex items-center gap-1">
            {commands !== null && doneCount > 0 ? (
              <Button variant="subtle" onClick={clearDone}>
                Clear done
              </Button>
            ) : null}
            <Button
              variant="subtle"
              aria-pressed={hideDone}
              onClick={() => {
                setHideDone((current) => !current);
              }}
            >
              Hide done
            </Button>
          </div>
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
            leaving={leaving.has(item.id)}
            entering={entering.has(item.title)}
            editing={editing === item.id}
            onEdit={() => {
              setEditing(item.id);
            }}
            onSave={(title, detail) => {
              void saveEdit(item, title, detail);
            }}
            onCancel={() => {
              setEditing(null);
            }}
            onTick={(checked) => {
              tick(item, checked);
            }}
            onOpen={onOpen}
          />
        ))}
        <AddLine onAdd={addLines} />
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
  readonly leaving: boolean;
  readonly entering: boolean;
  readonly editing: boolean;
  readonly onEdit: () => void;
  readonly onSave: (title: string, detail: string) => void;
  readonly onCancel: () => void;
  readonly onTick: (checked: boolean) => void;
  readonly onOpen: (itemId: string) => void;
}

function ChecklistLine(props: ChecklistLineProps): ReactNode {
  const {
    item,
    done,
    boxRef,
    secondary,
    refusal,
    leaving,
    entering,
    editing,
    onEdit,
    onSave,
    onCancel,
    onTick,
    onOpen,
  } = props;
  const flash = useFlash(item.updatedAt);
  const commands = useOptionalItemCommands();
  const compact = useCompactCollection();
  const itemActions = useItemContextActions(onOpen, editing ? { includeOpen: true } : {});
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
          ...(compact
            ? []
            : [
                {
                  kind: 'action' as const,
                  label: done ? 'Mark as not done' : 'Mark as done',
                  onSelect: () => {
                    onTick(!done);
                  },
                },
              ]),
          ...(commands === null
            ? []
            : [{ kind: 'action' as const, label: 'Edit', onSelect: onEdit }]),
        ])
      }
    >
      {(contextTarget) => (
        <li
          {...contextTarget}
          {...flash}
          data-enter={entering ? '' : undefined}
          data-leave={leaving ? '' : undefined}
          className={cn('group flex flex-col', isSelected && 'bg-accent/10')}
        >
          {editing ? (
            <EditLine
              title={item.title}
              detail={detail}
              detailLabel={secondary !== null && secondary.type === 'text' ? secondary.label : null}
              onSave={onSave}
              onCancel={onCancel}
            />
          ) : (
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
          )}
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

export function pastedLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*\u2022]|\[[ xX]?\])\s*/, '').trim())
    .filter((line) => line.length > 0);
}

/** Edit in place: Enter or leaving the row saves, Escape cancels. */
function EditLine(props: {
  readonly title: string;
  readonly detail: string;
  readonly detailLabel: string | null;
  readonly onSave: (title: string, detail: string) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const { title, detail, detailLabel, onSave, onCancel } = props;
  const [name, setName] = useState(title);
  const [note, setNote] = useState(detail);
  // Escape sets this so the blur it causes does not save what was just cancelled.
  const cancelled = useRef(false);
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape cancels the inline edit from any of its fields
    <form
      className="flex gap-2 py-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(name, note);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          cancelled.current = true;
          onCancel();
        }
      }}
      onBlur={(event) => {
        if (cancelled.current || event.currentTarget.contains(event.relatedTarget)) return;
        onSave(name, note);
      }}
    >
      <Input
        // eslint-disable-next-line jsx-a11y/no-autofocus -- Justification: the person just chose Edit; focus belongs in the field.
        autoFocus
        aria-label="Name"
        value={name}
        onFocus={(event) => {
          event.target.select();
        }}
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      {detailLabel === null ? null : (
        <Input
          aria-label={detailLabel}
          placeholder={detailLabel}
          className="w-1/3"
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
      )}
      <button type="submit" hidden>
        Save
      </button>
    </form>
  );
}

/**
 * The field at the foot of the checklist. Always open, and never disabled while a line saves: the
 * name is taken and the field cleared before the write goes out, so focus stays where the next
 * name will be typed. A refused line puts its name back so nothing typed is lost.
 */
function AddLine({
  onAdd,
}: {
  readonly onAdd: (titles: readonly string[]) => Promise<string | null>;
}): ReactNode {
  const [title, setTitle] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const refusalId = useId();

  function add(titles: readonly string[], restore: string): void {
    setRefusal(null);
    void onAdd(titles).then((reason) => {
      if (reason !== null) {
        setRefusal(reason);
        setTitle((current) => (current.length === 0 ? restore : current));
      }
    });
    fieldRef.current?.focus();
  }

  function submit(event: { preventDefault: () => void }): void {
    event.preventDefault();
    const named = title.trim();
    if (named.length === 0) return;

    setTitle('');
    add([named], named);
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
            onPaste={(event) => {
              // A pasted list becomes one line per row, bullets and tick boxes stripped.
              const text = event.clipboardData.getData('text');
              if (!text.trim().includes('\n')) return;
              event.preventDefault();
              const lines = pastedLines(text);
              if (lines.length > 0) add(lines, lines.join('\n'));
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
