import {
  Button,
  Checkbox,
  Field,
  Input,
  Segmented,
  Select,
  Text,
  cn,
  type InputProps,
} from '@nix/ui';
import {
  useDeferredValue,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { OpenUiDesign, type DragPayload } from './design-frame';
import {
  addComponent,
  addItemsQuery,
  bindItems,
  dataOf,
  deleteComponent,
  describe,
  ITEM_BINDINGS,
  isContainer,
  liftInline,
  locate,
  moveComponent,
  outline,
  PALETTE,
  setProp,
  setStatement,
  type Edit,
  type OutlineNode,
  type PropView,
} from './designer-model';
import OpenUiBlock from './openui-block';
import { withContainer } from './starter-program';

type Section = 'components' | 'canvas' | 'inspector';
const SECTIONS = [
  { value: 'components', label: 'Components' },
  { value: 'canvas', label: 'Canvas' },
  { value: 'inspector', label: 'Inspector' },
] as const;

/** Outline indent per depth; deeper levels share the last step. */
const INDENT = ['ps-2', 'ps-6', 'ps-10', 'ps-14', 'ps-18'];

/** Past the end of any list: where "into this container" lands. */
const END = Number.MAX_SAFE_INTEGER;
/** How many undo steps are kept. */
const HISTORY = 100;

function flatten(node: OutlineNode | null): OutlineNode[] {
  return node ? [node, ...node.children.flatMap((child) => flatten(child))] : [];
}

/** A text field that tells its owner what was typed when the person is done (Enter or leaving
 * the field), not on every key, so one edit is one undo step and a half-typed value is never
 * written into the program. The owner re-keys it when the program's text for it changes. */
function CommitInput({
  value,
  onCommit,
  className,
  ...rest
}: Omit<InputProps, 'value' | 'onChange' | 'onBlur' | 'onKeyDown'> & {
  readonly value: string;
  readonly onCommit: (value: string) => void;
}): ReactNode {
  const [draft, setDraft] = useState(value);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <Input
      {...rest}
      {...(className === undefined ? {} : { className })}
      value={draft}
      onChange={(event) => {
        setDraft(event.currentTarget.value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
      }}
    />
  );
}

/** One prop of the selected component: a control for a literal, a code field for anything else. */
function PropField({
  owner,
  view,
  onSet,
}: {
  readonly owner: string;
  readonly view: PropView;
  readonly onSet: (text: string) => string | null;
}): ReactNode {
  const { info, text, literal } = view;
  const [error, setError] = useState<string | null>(null);
  const [expression, setExpression] = useState(false);
  const set = (next: string) => {
    setError(onSet(next));
  };
  if (info.kind === 'children')
    return (
      <Text variant="note" tone="muted">
        {info.name}:{' '}
        {view.count === null
          ? 'computed by an expression.'
          : `${String(view.count)} in the outline; add, move and delete them there.`}
      </Text>
    );
  const key = `${owner}:${info.name}:${text}`;
  const shape =
    info.kind === 'string'
      ? typeof literal === 'string'
      : info.kind === 'number'
        ? typeof literal === 'number'
        : info.kind === 'boolean'
          ? typeof literal === 'boolean'
          : info.kind === 'enum'
            ? typeof literal === 'string' && (info.options ?? []).includes(literal)
            : false;
  const eligible = !info.reactive && ['string', 'number', 'boolean', 'enum'].includes(info.kind);
  const asValue = eligible && !expression && (shape || text === '');
  const unset = info.optional ? '' : null;
  return (
    <div className="flex flex-col gap-1">
      {asValue && info.kind === 'boolean' ? (
        <>
          <Checkbox
            label={info.name}
            checked={literal === true}
            onChange={(event) => {
              set(String(event.currentTarget.checked));
            }}
          />
          {error ? (
            <Text variant="note" role="alert">
              {error}
            </Text>
          ) : null}
        </>
      ) : (
        <Field label={info.name} required={!info.optional} error={error}>
          {(control) =>
            asValue && info.kind === 'enum' ? (
              <Select
                {...control}
                value={typeof literal === 'string' ? literal : ''}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  set(next === '' ? '' : JSON.stringify(next));
                }}
              >
                {info.optional ? <option value="">(none)</option> : null}
                {(info.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            ) : asValue && info.kind === 'number' ? (
              <CommitInput
                {...control}
                key={`${key}:number`}
                type="number"
                step="any"
                value={typeof literal === 'number' ? String(literal) : ''}
                onCommit={(next) => {
                  if (next.trim() === '') set(unset ?? '0');
                  else if (Number.isFinite(Number(next))) set(String(Number(next)));
                  else setError('Enter a number.');
                }}
              />
            ) : asValue ? (
              <CommitInput
                {...control}
                key={`${key}:text`}
                value={typeof literal === 'string' ? literal : ''}
                onCommit={(next) => {
                  set(next === '' && info.optional ? '' : JSON.stringify(next));
                }}
              />
            ) : (
              <CommitInput
                {...control}
                key={`${key}:code`}
                value={text}
                className="font-mono"
                onCommit={set}
              />
            )
          }
        </Field>
      )}
      {eligible && (asValue || (expression && shape)) ? (
        <div>
          <Button
            variant="ghost"
            onClick={() => {
              setExpression(!expression);
            }}
          >
            {expression ? 'Use a value' : 'Use an expression'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The component structure as an ARIA tree: arrows move, Enter selects, rows can be dragged. */
function Outline({
  root,
  selected,
  onSelect,
  onDragStart,
  onDragEnd,
  onDropInto,
  onDropBefore,
}: {
  readonly root: OutlineNode;
  readonly selected: string | null;
  readonly onSelect: (node: OutlineNode) => void;
  readonly onDragStart: (id: string) => void;
  readonly onDragEnd: () => void;
  readonly onDropInto: (id: string) => void;
  readonly onDropBefore: (node: OutlineNode) => void;
}): ReactNode {
  const list = useRef<HTMLUListElement>(null);
  const flat = flatten(root);
  const focusAt = (key: string | undefined) => {
    if (key === undefined) return;
    list.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus();
  };
  const move = (event: KeyboardEvent, node: OutlineNode) => {
    const at = flat.findIndex((candidate) => candidate.key === node.key);
    const parent = flat.find((candidate) => candidate.children.includes(node));
    const target =
      event.key === 'ArrowDown'
        ? flat[at + 1]
        : event.key === 'ArrowUp'
          ? flat[at - 1]
          : event.key === 'Home'
            ? flat[0]
            : event.key === 'End'
              ? flat[flat.length - 1]
              : event.key === 'ArrowRight'
                ? node.children[0]
                : event.key === 'ArrowLeft'
                  ? parent
                  : undefined;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(node);
    } else if (
      ['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft'].includes(event.key)
    ) {
      event.preventDefault();
      focusAt(target?.key);
    }
  };
  // One stop in the tab order: the selected row, or the root.
  const stop = flat.find((node) => node.id !== null && node.id === selected)?.key ?? root.key;
  const item = (node: OutlineNode, level: number): ReactNode => {
    const current = node.id !== null && node.id === selected;
    const container = node.kind === 'component' && isContainer(node.type);
    const draggable = node.id !== null && node.at !== null;
    return (
      <li
        key={node.key}
        role="treeitem"
        aria-label={node.id === null ? node.type : `${node.type} ${node.id}`}
        aria-level={level}
        aria-selected={current}
        data-key={node.key}
        tabIndex={node.key === stop ? 0 : -1}
        className="group/item flex flex-col outline-none"
        onKeyDown={(event) => {
          if (event.target === event.currentTarget) move(event, node);
        }}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(node);
        }}
      >
        <div
          draggable={draggable}
          onDragStart={(event) => {
            event.stopPropagation();
            // Firefox starts no drag without data; the dragged thing itself is held in state.
            event.dataTransfer.setData('text/plain', node.id ?? '');
            if (node.id !== null) onDragStart(node.id);
          }}
          onDragEnd={onDragEnd}
          onDragOver={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (container && node.id !== null) onDropInto(node.id);
            else onDropBefore(node);
          }}
          className={cn(
            INDENT[Math.min(level - 1, INDENT.length - 1)],
            'cursor-pointer rounded-sm px-2 py-1 group-focus-visible/item:outline group-focus-visible/item:outline-2 group-focus-visible/item:outline-accent',
            current ? 'bg-accent/15' : 'hover:bg-surface',
          )}
        >
          <Text as="span" variant="note" className="font-mono">
            {node.type}
          </Text>
          {node.id !== null ? (
            <Text as="span" variant="note" tone="muted">
              {` ${node.id}`}
            </Text>
          ) : node.kind === 'inline' ? (
            <Text as="span" variant="note" tone="muted">
              {' (inline)'}
            </Text>
          ) : null}
        </div>
        {node.children.length > 0 ? (
          <ul role="group" className="flex flex-col">
            {node.children.map((child) => item(child, level + 1))}
          </ul>
        ) : null}
      </li>
    );
  };
  return (
    <ul ref={list} role="tree" aria-label="Component outline" className="flex flex-col">
      {item(root, 1)}
    </ul>
  );
}

export interface ProgramDesignerProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly workspaceId: string;
  /** For a view: the collection `$container` stands for, which also offers the items helper. */
  readonly containerId?: string | null | undefined;
}

/**
 * A visual designer over an openui-lang program. The program text stays the only state: every
 * action calls a pure transform in `designer-model` and hands the new text to `onChange`, so the
 * Code mode beside it always shows exactly what is designed, and undo is a stack of texts.
 *
 * The canvas is the same read-only preview Code mode has, drawn with selectable frames: nothing
 * here can run a Mutation, and the frames swallow clicks before a control hears them.
 *
 * shortcut: a program is arranged only where components are written as a literal list; a computed
 * child list (`@Each`) is edited in Code. Add per-reference handles if shared components matter.
 */
export default function ProgramDesigner({
  value,
  onChange,
  workspaceId,
  containerId,
}: ProgramDesignerProps): ReactNode {
  const [picked, setPicked] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<{ past: string[]; future: string[] }>({
    past: [],
    future: [],
  });
  const [dragging, setDragging] = useState<DragPayload | null>(null);
  const [section, setSection] = useState<Section>('canvas');
  const tree = useMemo(() => outline(value), [value]);
  const nodes = useMemo(() => flatten(tree), [tree]);
  const selected = picked !== null && nodes.some((node) => node.id === picked) ? picked : null;
  const node = nodes.find((candidate) => candidate.id !== null && candidate.id === selected);
  const shown = useDeferredValue(value);
  const program = useMemo(
    () => (containerId === undefined ? shown : withContainer(shown, containerId)),
    [shown, containerId],
  );

  /** Applies an edit; returns why it was refused, or null. */
  function apply(edit: Edit): string | null {
    if ('error' in edit) return edit.error;
    setHistory(({ past }) => ({ past: [...past, value].slice(-HISTORY), future: [] }));
    onChange(edit.source);
    if (edit.id !== undefined) setPicked(edit.id);
    return null;
  }
  const act = (edit: Edit) => {
    setNotice(apply(edit));
  };

  function undo() {
    const previous = history.past[history.past.length - 1];
    if (previous === undefined) return;
    setHistory({ past: history.past.slice(0, -1), future: [value, ...history.future] });
    onChange(previous);
  }
  function redo() {
    const next = history.future[0];
    if (next === undefined) return;
    setHistory({ past: [...history.past, value], future: history.future.slice(1) });
    onChange(next);
  }

  /** Where a click on the palette puts a component: into the selected container, else after the
   * selected component, else at the end of the root. */
  function insertion(type: string): Edit {
    if (node?.id && node.kind === 'component' && isContainer(node.type))
      return addComponent(value, { parent: node.id }, type);
    if (node?.at)
      return addComponent(
        value,
        { parent: node.at.parent, prop: node.at.prop, index: node.at.index + 1 },
        type,
      );
    return addComponent(value, { parent: 'root' }, type);
  }

  function select(target: OutlineNode) {
    if (target.id !== null) setPicked(target.id);
    else if (target.kind === 'inline' && target.at) act(liftInline(value, target.at));
  }

  function dropInto(containerId: string, index = END) {
    const drag = dragging;
    setDragging(null);
    if (!drag) return;
    act(
      drag.kind === 'new'
        ? addComponent(value, { parent: containerId, index }, drag.type)
        : moveComponent(value, drag.id, { parent: containerId, index }),
    );
  }
  function dropBefore(target: OutlineNode) {
    if (!target.at) return;
    const from = dragging?.kind === 'move' ? locate(value, dragging.id) : null;
    // Lifting the dragged one out of the same list shifts everything after it up by one.
    const shift =
      from?.parent === target.at.parent &&
      from.prop === target.at.prop &&
      from.index < target.at.index
        ? 1
        : 0;
    dropInto(target.at.parent, target.at.index - shift);
  }

  const siblings = node?.at
    ? (nodes
        .find((candidate) => candidate.id === node.at?.parent)
        ?.children.filter((child) => child.at?.prop === node.at?.prop).length ?? 0)
    : 0;
  const nudge = (delta: number) => {
    if (selected !== null && node?.at)
      act(
        moveComponent(value, selected, {
          parent: node.at.parent,
          prop: node.at.prop,
          index: node.at.index + delta,
        }),
      );
  };

  const description = selected === null ? null : describe(value, selected);
  const data = dataOf(value);
  const bindable = description !== null && description.type in ITEM_BINDINGS;
  const design = useMemo(
    () => ({
      selected,
      select: setPicked,
      dragging,
      drop: (target: string) => {
        dropInto(target);
      },
    }),
    // dropInto closes over the program and the drag, which are what this depends on
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, dragging, value],
  );

  if (tree === null)
    return (
      <div className="flex flex-col gap-2">
        <Text variant="note" role="status">
          {value.trim() === ''
            ? 'Nothing is designed yet.'
            : 'Design needs a program that parses and has a root. Fix it in Code.'}
        </Text>
        {value.trim() === '' ? (
          <div>
            <Button
              onClick={() => {
                act({ source: 'root = Stack([])' });
              }}
            >
              Start with an empty layout
            </Button>
          </div>
        ) : null}
      </div>
    );

  const pane = (name: Section) => cn(section === name ? 'flex' : 'hidden', '@3xl:flex');

  return (
    // Scopes undo and redo to the designer; the keys do nothing else here.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="@container flex min-w-0 flex-col gap-3"
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
          event.preventDefault();
          if (event.shiftKey) redo();
          else undo();
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" disabled={history.past.length === 0} onClick={undo}>
          Undo
        </Button>
        <Button variant="secondary" disabled={history.future.length === 0} onClick={redo}>
          Redo
        </Button>
        <Segmented
          className="w-full max-w-sm @3xl:hidden"
          label="Designer section"
          options={SECTIONS}
          value={section}
          onChange={setSection}
        />
      </div>
      {notice ? (
        <Text variant="note" role="alert">
          {notice}
        </Text>
      ) : null}
      <div className="grid min-w-0 gap-3 @3xl:grid-cols-[auto_minmax(0,1fr)_auto]">
        <section
          aria-label="Components"
          className={cn(pane('components'), 'min-w-0 flex-col gap-3 @3xl:w-60')}
        >
          {PALETTE.map((group) => (
            <div
              key={group.label}
              role="group"
              aria-label={group.label}
              className="flex flex-col gap-1"
            >
              <Text variant="kicker" tone="muted">
                {group.label}
              </Text>
              <div className="flex flex-wrap gap-1">
                {group.components.map((type) => (
                  <Button
                    key={type}
                    variant="secondary"
                    draggable
                    aria-label={`Add ${type}`}
                    onClick={() => {
                      act(insertion(type));
                    }}
                    onDragStart={(event) => {
                      event.dataTransfer.setData('text/plain', type);
                      setDragging({ kind: 'new', type });
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                    }}
                  >
                    {type}
                  </Button>
                ))}
              </div>
            </div>
          ))}
          <div className="flex flex-col gap-1">
            <Text variant="kicker" tone="muted">
              Outline
            </Text>
            <div className="flex flex-wrap gap-1">
              <Button
                variant="secondary"
                disabled={!node?.at || node.at.index === 0}
                onClick={() => {
                  nudge(-1);
                }}
              >
                Move up
              </Button>
              <Button
                variant="secondary"
                disabled={!node?.at || node.at.index >= siblings - 1}
                onClick={() => {
                  nudge(1);
                }}
              >
                Move down
              </Button>
              <Button
                variant="secondary"
                disabled={selected === null || selected === 'root'}
                onClick={() => {
                  if (selected !== null) act(deleteComponent(value, selected));
                }}
              >
                Delete
              </Button>
            </div>
            <Outline
              root={tree}
              selected={selected}
              onSelect={select}
              onDragStart={(id) => {
                setDragging({ kind: 'move', id });
              }}
              onDragEnd={() => {
                setDragging(null);
              }}
              onDropInto={dropInto}
              onDropBefore={dropBefore}
            />
          </div>
        </section>
        <section
          aria-label="Canvas"
          className={cn(pane('canvas'), 'min-w-0 flex-col @3xl:max-h-128 @3xl:overflow-auto')}
        >
          <OpenUiDesign.Provider value={design}>
            {/* Reads only, like the Code preview: a design never asks for a write. */}
            <OpenUiBlock
              source={program}
              readOnly
              workspaceIds={[workspaceId]}
              fallback={
                <Text variant="note" tone="muted">
                  The program does not render yet.
                </Text>
              }
            />
          </OpenUiDesign.Provider>
        </section>
        <section
          aria-label="Inspector"
          className={cn(
            pane('inspector'),
            'min-w-0 flex-col gap-3 @3xl:w-72 @3xl:max-h-128 @3xl:overflow-auto',
          )}
        >
          {description === null ? (
            <Text variant="note" tone="muted">
              Select a component on the canvas or in the outline to edit it.
            </Text>
          ) : (
            <>
              <Text variant="h6" as="h3">
                {description.type}{' '}
                <Text as="span" variant="note" tone="muted">
                  {description.id}
                </Text>
              </Text>
              {description.props.map((view) => (
                <PropField
                  key={view.info.name}
                  owner={description.id}
                  view={view}
                  onSet={(text) => apply(setProp(value, description.id, view.info.name, text))}
                />
              ))}
              {bindable && containerId !== undefined ? (
                <div>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      act(bindItems(value, description.id));
                    }}
                  >
                    Show items in this collection
                  </Button>
                </div>
              ) : null}
            </>
          )}
          {selected === null || selected === 'root' ? (
            <div role="group" aria-label="Program data" className="flex flex-col gap-2">
              <Text variant="h6" as="h3">
                Data
              </Text>
              {data.length === 0 ? (
                <Text variant="note" tone="muted">
                  No queries, mutations or state yet.
                </Text>
              ) : null}
              {data.map((statement) => (
                <DataField
                  key={`${statement.id}:${statement.text}`}
                  statement={statement}
                  onSet={(text) => apply(setStatement(value, statement.id, text))}
                />
              ))}
              {containerId !== undefined ? (
                <div>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      act(addItemsQuery(value));
                    }}
                  >
                    Add data: items in this collection
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function DataField({
  statement,
  onSet,
}: {
  readonly statement: { readonly id: string; readonly kind: string; readonly text: string };
  readonly onSet: (text: string) => string | null;
}): ReactNode {
  const [error, setError] = useState<string | null>(null);
  return (
    <Field label={`${statement.id} (${statement.kind})`} error={error}>
      {(control) => (
        <CommitInput
          {...control}
          value={statement.text}
          className="font-mono"
          onCommit={(text) => {
            setError(onSet(text));
          }}
        />
      )}
    </Field>
  );
}
