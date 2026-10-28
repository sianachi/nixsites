import { TEXT_ALIGNMENTS } from '@nix/editor-schema';
import { Button, Dialog, Popover, Text, chromeSurface } from '@nix/ui';
import type { ItemInsertKind } from './item-insert-dialog';
import { TableSizePicker } from './table-size-picker';
import type { WritingMode } from './writing-mode';
import { Icon } from '@nix/ui';
import type { Editor } from '@tiptap/react';
import {
  AlignLeft,
  AlignCenter,
  AlignRight,
  ArrowDown,
  ArrowUp,
  Bold,
  ChevronDown,
  Code,
  Columns2,
  Columns3,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListOrdered,
  Maximize2,
  Minimize2,
  Minus,
  Pilcrow,
  Quote,
  Redo2,
  RotateCcw,
  Rows3,
  SquareCode,
  Strikethrough,
  Table as TableIcon,
  Trash2,
  Underline,
  Undo2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';

/**
 * The formatting toolbar.
 *
 * **Every control here is a shortcut somebody does not know yet.** The keyboard is the primary
 * interface for all of it - the marks have the shortcuts everybody already has in their fingers,
 * and the blocks have input rules, so `# ` makes a heading and `- ` makes a list. The toolbar
 * exists so none of that has to be discovered before the editor is usable.
 *
 * Grouped by what a control does to the document rather than by how often it is used: turn this
 * block into another kind, make this run of text look different, put something new here. A flat
 * row of twenty buttons is a row nobody reads.
 *
 * **The table group appears only inside a table.** Row and column operations are meaningless
 * anywhere else, and a permanent row of controls that do nothing most of the time teaches people
 * to stop looking at the toolbar.
 */

interface Control {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly run: () => void;
  /** Whether the control describes the selection right now. Omitted for inserts, which have no state. */
  readonly active?: boolean;
  /** Whether the command can run at all here. */
  readonly enabled?: boolean;
  /** The keys that do the same thing, shown in the tooltip. A control nobody can find is a control nobody uses. */
  readonly shortcut?: string;
  /** The platform-resolved form of `shortcut`, for assistive technology. */
  readonly ariaShortcut?: string;
}

// ProseMirror resolves `Mod` from this exact platform signal. Keeping the display tied to the same
// test prevents the toolbar from advertising Command while the keymap is listening for Control.
const navigatorPlatform: unknown =
  typeof navigator === 'undefined' ? undefined : Reflect.get(navigator, 'platform');
const applePlatform =
  typeof navigatorPlatform === 'string' && /Mac|iP(hone|[oa]d)/.test(navigatorPlatform);
const ariaModifier = applePlatform ? 'Meta' : 'Control';
const visibleModifier = applePlatform ? 'Command' : 'Ctrl';

export interface ToolbarProps {
  readonly editor: Editor;
  readonly compact?: boolean | undefined;
  readonly writingMode?: WritingMode;
  readonly writingModeControl?: ReactNode;
  readonly textWidthControl?: ReactNode;

  /** Opens the editor-owned image form without making this toolbar own modal state. */
  readonly onInsertImage: () => void;
  readonly onInsertItem?: (kind: ItemInsertKind) => void;
  readonly onPageBreak?: () => void;

  /** Opens the editor-owned link form for the current selection. */
  readonly onInsertLink: () => void;

  /**
   * The document's own history.
   *
   * Passed in rather than reached for, because this is a CRDT and its undo is not the editor's:
   * ProseMirror's default history would revert whichever edit came last, including a colleague's.
   * Keeping that knowledge outside the toolbar is what stops the wrong one being wired here later.
   */
  readonly onUndo: () => void;
  readonly onRedo: () => void;
}

export function EditorToolbar({
  editor,
  compact = false,
  writingMode = 'prose',
  writingModeControl,
  textWidthControl,
  onInsertImage,
  onInsertItem,
  onPageBreak,
  onInsertLink,
  onUndo,
  onRedo,
}: ToolbarProps): ReactNode {
  const [moreOpen, setMoreOpen] = useState(false);
  const [insertOpen, setInsertOpen] = useState(false);
  const [tablePickerOpen, setTablePickerOpen] = useState(false);
  const tableInsertRef = useRef<HTMLDivElement | null>(null);
  const insertTriggerRef = useRef<HTMLButtonElement | null>(null);
  // **A destroyed editor is a normal thing to be handed, and it used to crash the page.**
  // `useEditor` tears the old editor down and builds a new one whenever its dependencies change,
  // and React's strict mode does that on every mount in development. `destroy()` sets the
  // editor's command manager to null, so a render that lands between the teardown and the
  // replacement reached `editor.can()` on an editor that no longer has one - which threw out of
  // render and took the whole root down with it, repeatedly.
  //
  // Nothing is drawn rather than a row of disabled buttons: this state lasts a frame, and a
  // toolbar that flickers into a disabled version of itself is worse to look at than one that
  // appears a frame later.
  if (editor.isDestroyed) {
    return null;
  }

  const inTable = editor.isActive('table');
  const inColumns = editor.isActive('columnBlock');

  const blocks: readonly Control[] = [
    {
      id: 'paragraph',
      label: 'Text',
      icon: Pilcrow,
      active: editor.isActive('paragraph'),
      run: () => void editor.chain().focus().setParagraph().run(),
    },
    {
      id: 'heading-1',
      label: 'Heading 1',
      icon: Heading1,
      active: editor.isActive('heading', { level: 1 }),
      run: () => void editor.chain().focus().toggleHeading({ level: 1 }).run(),
    },
    {
      id: 'heading-2',
      label: 'Heading 2',
      icon: Heading2,
      active: editor.isActive('heading', { level: 2 }),
      run: () => void editor.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      id: 'heading-3',
      label: 'Heading 3',
      icon: Heading3,
      active: editor.isActive('heading', { level: 3 }),
      run: () => void editor.chain().focus().toggleHeading({ level: 3 }).run(),
    },
  ];

  const alignmentIcons = { left: AlignLeft, center: AlignCenter, right: AlignRight };
  const alignmentKeys = { left: 'L', center: 'E', right: 'R' };
  const alignment: readonly Control[] = TEXT_ALIGNMENTS.map((value) => ({
    id: `align-${value}`,
    label: `Align ${value}`,
    icon: alignmentIcons[value],
    active:
      editor.isActive({ textAlign: value }) ||
      (value === 'left' && editor.isActive({ textAlign: null })),
    enabled: editor.can().setTextAlign(value),
    shortcut: `${visibleModifier}+Shift+${alignmentKeys[value]}`,
    ariaShortcut: `${ariaModifier}+Shift+${alignmentKeys[value]}`,
    run: () =>
      void editor.chain().focus(undefined, { scrollIntoView: false }).setTextAlign(value).run(),
  }));

  const lists: readonly Control[] = [
    {
      id: 'bulletList',
      label: 'Bulleted list',
      icon: List,
      active: editor.isActive('bulletList'),
      run: () => void editor.chain().focus().toggleBulletList().run(),
    },
    {
      id: 'orderedList',
      label: 'Numbered list',
      icon: ListOrdered,
      active: editor.isActive('orderedList'),
      run: () => void editor.chain().focus().toggleOrderedList().run(),
    },
    {
      id: 'taskList',
      label: 'Task list',
      icon: ListChecks,
      active: editor.isActive('taskList'),
      run: () => void editor.chain().focus().toggleTaskList().run(),
    },
    {
      id: 'blockquote',
      label: 'Quote',
      icon: Quote,
      active: editor.isActive('blockquote'),
      run: () => void editor.chain().focus().toggleBlockquote().run(),
    },
    {
      id: 'codeBlock',
      label: 'Code block',
      icon: SquareCode,
      active: editor.isActive('codeBlock'),
      run: () => void editor.chain().focus().toggleCodeBlock().run(),
    },
  ];

  const poetry: readonly Control[] =
    writingMode === 'poetry'
      ? [
          {
            id: 'lineBreak',
            label: 'Line break',
            icon: Rows3,
            enabled: editor.can().setHardBreak(),
            run: () => void editor.chain().focus().setHardBreak().run(),
          },
          {
            id: 'stanza',
            label: 'New stanza',
            icon: Pilcrow,
            enabled: editor.isActive('paragraph') && editor.can().splitBlock(),
            run: () => void editor.chain().focus().splitBlock().run(),
          },
        ]
      : [];

  const marks: readonly Control[] = [
    {
      id: 'bold',
      label: 'Bold',
      icon: Bold,
      active: editor.isActive('bold'),
      run: () => void editor.chain().focus(undefined, { scrollIntoView: false }).toggleBold().run(),
    },
    {
      id: 'italic',
      label: 'Italic',
      icon: Italic,
      active: editor.isActive('italic'),
      run: () =>
        void editor.chain().focus(undefined, { scrollIntoView: false }).toggleItalic().run(),
    },
    {
      id: 'underline',
      label: 'Underline',
      icon: Underline,
      active: editor.isActive('underline'),
      run: () =>
        void editor.chain().focus(undefined, { scrollIntoView: false }).toggleUnderline().run(),
    },
    {
      id: 'strike',
      label: 'Strikethrough',
      icon: Strikethrough,
      active: editor.isActive('strike'),
      run: () =>
        void editor.chain().focus(undefined, { scrollIntoView: false }).toggleStrike().run(),
    },
    {
      id: 'code',
      label: 'Inline code',
      icon: Code,
      active: editor.isActive('code'),
      run: () => void editor.chain().focus(undefined, { scrollIntoView: false }).toggleCode().run(),
    },
    {
      id: 'highlight',
      label: 'Highlight',
      icon: Highlighter,
      active: editor.isActive('highlight'),
      run: () =>
        void editor.chain().focus(undefined, { scrollIntoView: false }).toggleHighlight().run(),
    },
    {
      id: 'link',
      label: editor.isActive('link') ? 'Remove link' : 'Add link',
      icon: LinkIcon,
      active: editor.isActive('link'),
      run: () => {
        if (editor.isActive('link')) {
          editor.chain().focus(undefined, { scrollIntoView: false }).unsetLink().run();
          return;
        }

        onInsertLink();
      },
    },
  ];

  const inserts: readonly Control[] = [
    {
      id: 'horizontalRule',
      label: 'Divider',
      icon: Minus,
      run: () => void editor.chain().focus().setHorizontalRule().run(),
    },
    {
      id: 'image',
      label: 'Image',
      icon: ImageIcon,
      run: onInsertImage,
    },
  ];

  /**
   * The table insert, which in the full toolbar opens a size picker instead of inserting.
   *
   * The compact toolbar keeps the fixed three-by-three: its controls are a flat list in a
   * dialog, where a grid to sweep with a pointer has neither the room nor the pointer.
   */
  const insertTable = (rows: number, cols: number): void =>
    void editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
  const tableInsert: Control = {
    id: 'table',
    label: 'Insert table',
    icon: TableIcon,
    run: () => {
      insertTable(3, 3);
    },
  };

  const history: readonly Control[] = [
    {
      id: 'undo',
      label: 'Undo',
      icon: Undo2,
      shortcut: `${visibleModifier}+Z`,
      ariaShortcut: `${ariaModifier}+Z`,
      run: onUndo,
    },
    {
      id: 'redo',
      label: 'Redo',
      icon: Redo2,
      shortcut: `${visibleModifier}+Shift+Z or ${visibleModifier}+Y`,
      ariaShortcut: `${ariaModifier}+Shift+Z ${ariaModifier}+Y`,
      run: onRedo,
    },
  ];

  /**
   * The keyboard's way to reorder a block, offered in the compact toolbar's sheet because there
   * is no drag handle to reach for on a screen this narrow - `note-editor.tsx` documents why
   * the handle itself stays pointer-only. The shortcut works everywhere; this is only its other
   * entrance.
   */
  const move: readonly Control[] = [
    {
      id: 'moveBlockUp',
      label: 'Move up',
      icon: ArrowUp,
      shortcut: `${visibleModifier}+Shift+↑`,
      ariaShortcut: `${ariaModifier}+Shift+ArrowUp`,
      run: () => void editor.chain().focus().moveBlockUp().run(),
      enabled: editor.can().moveBlockUp(),
    },
    {
      id: 'moveBlockDown',
      label: 'Move down',
      icon: ArrowDown,
      shortcut: `${visibleModifier}+Shift+↓`,
      ariaShortcut: `${ariaModifier}+Shift+ArrowDown`,
      run: () => void editor.chain().focus().moveBlockDown().run(),
      enabled: editor.can().moveBlockDown(),
    },
  ];

  /**
   * What a person can do to a row of columns once it exists.
   *
   * **Without this group the row is a trap.** The slash menu inserts two columns and the handles
   * resize them; nothing else in the interface could add a third, take one away, or get back to
   * ordinary flow - the only exit was deleting content until the normaliser unwrapped the row.
   * The keyboard shortcuts are the same commands, and they are in the tooltips because a
   * shortcut nobody is told about is not a shortcut.
   *
   * Shown at every width, unlike the resize handles: below the medium breakpoint the row stacks
   * and there is nothing to drag, so this is the only way a narrow screen has to operate it.
   */
  const columns: readonly Control[] = [
    {
      id: 'addColumnToRow',
      label: 'Add column',
      icon: Columns3,
      shortcut: 'Mod+Alt+Enter',
      run: () => void editor.chain().focus().addColumnToRow().run(),
      enabled: editor.can().addColumnToRow(),
    },
    {
      id: 'removeColumnFromRow',
      label: 'Remove column',
      icon: Columns2,
      shortcut: 'Mod+Alt+Backspace',
      // Removing the last column unwraps the row back into ordinary flow, which is also how
      // somebody leaves columns behind: it is the exit, not just a deletion.
      run: () => void editor.chain().focus().removeColumnFromRow().run(),
      enabled: editor.can().removeColumnFromRow(),
    },
  ];

  const table: readonly Control[] = [
    {
      id: 'addColumn',
      label: 'Add column',
      icon: Columns3,
      run: () => void editor.chain().focus().addColumnAfter().run(),
      enabled: editor.can().addColumnAfter(),
    },
    {
      id: 'addRow',
      label: 'Add row',
      icon: Rows3,
      run: () => void editor.chain().focus().addRowAfter().run(),
      enabled: editor.can().addRowAfter(),
    },
    {
      id: 'deleteColumn',
      label: 'Delete column',
      icon: Columns3,
      run: () => void editor.chain().focus().deleteColumn().run(),
      enabled: editor.can().deleteColumn(),
    },
    {
      id: 'deleteRow',
      label: 'Delete row',
      icon: Rows3,
      run: () => void editor.chain().focus().deleteRow().run(),
      enabled: editor.can().deleteRow(),
    },
    // A drag on the resize handle has no equivalent for a touchscreen or a keyboard; these three
    // make the same `colwidth` change - see `column-width.ts` - from a button instead.
    {
      id: 'columnNarrower',
      label: 'Column narrower',
      icon: Minimize2,
      run: () => void editor.chain().focus().columnNarrower().run(),
      enabled: editor.can().columnNarrower(),
    },
    {
      id: 'columnWider',
      label: 'Column wider',
      icon: Maximize2,
      run: () => void editor.chain().focus().columnWider().run(),
      enabled: editor.can().columnWider(),
    },
    {
      id: 'resetColumnWidth',
      label: 'Reset column width',
      icon: RotateCcw,
      run: () => void editor.chain().focus().resetColumnWidth().run(),
      enabled: editor.can().resetColumnWidth(),
    },
    {
      id: 'deleteTable',
      label: 'Delete table',
      icon: Trash2,
      run: () => void editor.chain().focus().deleteTable().run(),
      enabled: editor.can().deleteTable(),
    },
  ];

  if (compact) {
    const more = [
      ...blocks,
      ...lists,
      ...alignment,
      ...marks.filter((control) => !['bold', 'italic'].includes(control.id)),
      ...inserts,
      tableInsert,
      ...history,
      ...move,
      ...(inColumns ? columns : []),
      ...(inTable ? table : []),
    ];
    return (
      <div
        role="toolbar"
        aria-label="Formatting"
        className={`flex w-max items-center gap-1 ${chromeSurface}`}
      >
        <Group controls={marks.filter((control) => ['bold', 'italic'].includes(control.id))} />
        {writingMode === 'poetry' ? (
          <Group controls={poetry} label="Poetry tools" />
        ) : (
          <Group
            controls={lists.filter((control) =>
              writingMode === 'planning'
                ? ['taskList', 'orderedList'].includes(control.id)
                : control.id === 'bulletList',
            )}
          />
        )}
        {writingModeControl}
        <Button
          variant="ghost"
          className="shrink-0 whitespace-nowrap"
          onClick={() => {
            setMoreOpen(true);
          }}
        >
          More
        </Button>
        {moreOpen ? (
          <Dialog
            open
            swipeToClose
            title="Writing tools"
            onClose={() => {
              setMoreOpen(false);
            }}
          >
            <div className="grid grid-cols-2 gap-2">
              {more.map((control) => (
                <Button
                  key={control.id}
                  variant="ghost"
                  className="h-auto min-h-(--control-lg) min-w-0 justify-start whitespace-normal text-left any-pointer-coarse:h-auto"
                  disabled={control.enabled === false}
                  aria-pressed={control.active}
                  onClick={() => {
                    setMoreOpen(false);
                    control.run();
                  }}
                >
                  <Icon icon={control.icon} size="sm" />
                  {control.label}
                </Button>
              ))}
              {onInsertItem ? (
                <>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setMoreOpen(false);
                      onInsertItem('attachment');
                    }}
                  >
                    Attachment
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setMoreOpen(false);
                      onInsertItem('embed');
                    }}
                  >
                    Embed note
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setMoreOpen(false);
                      onInsertItem('subpage');
                    }}
                  >
                    New subpage
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={editor.state.selection.$from.depth > 1}
                    onClick={() => {
                      setMoreOpen(false);
                      onPageBreak?.();
                    }}
                  >
                    Page break
                  </Button>
                </>
              ) : null}
            </div>
          </Dialog>
        ) : null}
      </div>
    );
  }

  const blockChoices = [...blocks, ...lists];
  const currentBlock =
    lists.find((control) => control.active) ??
    blocks.find((control) => control.active) ??
    blocks[0];

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      aria-orientation="horizontal"
      className={`flex w-full flex-wrap items-center gap-1 py-1.5 ${chromeSurface}`}
    >
      <ControlPopover
        label="Block type"
        triggerLabel={currentBlock?.label ?? 'Text'}
        controls={blockChoices}
      />
      <Separator />
      <Group
        controls={marks.filter((control) => ['bold', 'italic', 'link'].includes(control.id))}
        label="Text formatting"
      />
      {writingMode === 'planning' ? (
        <Group
          controls={lists.filter((control) => ['taskList', 'orderedList'].includes(control.id))}
          label="Planning tools"
        />
      ) : null}
      {writingMode === 'poetry' ? <Group controls={poetry} label="Poetry tools" /> : null}
      {writingModeControl}
      {textWidthControl}
      <Popover
        label="Insert content"
        open={insertOpen}
        onOpenChange={(open) => {
          setInsertOpen(open);
          if (!open) setTablePickerOpen(false);
        }}
        trigger={(trigger) => (
          <Button
            variant="ghost"
            {...trigger}
            ref={(element) => {
              trigger.ref.current = element;
              insertTriggerRef.current = element;
            }}
          >
            Insert
            <Icon icon={ChevronDown} size="sm" />
          </Button>
        )}
      >
        <div role="group" aria-label="Insert content" className="flex flex-col gap-1">
          {inserts.map((control) => (
            <ControlOption
              key={control.id}
              control={control}
              onSelect={() => {
                setInsertOpen(false);
                if (control.id === 'image') insertTriggerRef.current?.focus();
                control.run();
              }}
            />
          ))}
          <div ref={tableInsertRef}>
            <ControlOption
              control={tableInsert}
              expanded={tablePickerOpen}
              onSelect={() => {
                setTablePickerOpen(!tablePickerOpen);
              }}
            />
            {tablePickerOpen ? (
              <TableSizePicker
                onPick={({ rows, cols }) => {
                  setTablePickerOpen(false);
                  setInsertOpen(false);
                  insertTable(rows, cols);
                }}
                onDismiss={() => {
                  setTablePickerOpen(false);
                  tableInsertRef.current?.querySelector('button')?.focus();
                }}
              />
            ) : null}
          </div>
          {onInsertItem !== undefined ? (
            <>
              {(['attachment', 'embed', 'subpage'] as const).map((kind) => (
                <Button
                  key={kind}
                  variant="ghost"
                  className="justify-start"
                  onClick={() => {
                    setInsertOpen(false);
                    insertTriggerRef.current?.focus();
                    onInsertItem(kind);
                  }}
                >
                  {{ attachment: 'Attachment', embed: 'Embed note', subpage: 'New subpage' }[kind]}
                </Button>
              ))}
            </>
          ) : null}
          {onPageBreak !== undefined ? (
            <Button
              variant="ghost"
              className="justify-start"
              disabled={editor.state.selection.$from.depth > 1}
              onClick={() => {
                setInsertOpen(false);
                onPageBreak();
              }}
            >
              Page break
            </Button>
          ) : null}
        </div>
      </Popover>
      <ControlPopover
        label="More writing tools"
        triggerLabel="More tools"
        sections={[
          {
            label: 'Text formatting',
            controls: marks.filter((control) => !['bold', 'italic', 'link'].includes(control.id)),
          },
          { label: 'Text alignment', controls: alignment },
          { label: 'Move block', controls: move },
        ]}
      />
      <Separator />
      <Group controls={history} label="History" />
      {inColumns ? <ControlPopover label="Columns" controls={columns} /> : null}
      {inTable ? <ControlPopover label="Table" controls={table} /> : null}
    </div>
  );
}

/** Toggle controls keep their pressed state inside a disclosure, with ordinary Tab navigation. */
function ControlPopover({
  label,
  triggerLabel = label,
  controls,
  sections,
}: {
  readonly label: string;
  readonly triggerLabel?: string;
  readonly controls?: readonly Control[];
  readonly sections?: readonly { readonly label: string; readonly controls: readonly Control[] }[];
}): ReactNode {
  const [open, setOpen] = useState(false);
  const groups = sections ?? [{ label, controls: controls ?? [] }];

  return (
    <Popover
      label={label}
      open={open}
      onOpenChange={setOpen}
      trigger={(trigger) => (
        <Button
          variant="ghost"
          aria-label={label === 'Block type' ? `${label}: ${triggerLabel}` : triggerLabel}
          {...trigger}
        >
          {triggerLabel}
          <Icon icon={ChevronDown} size="sm" />
        </Button>
      )}
    >
      {groups.map((group) => (
        <div
          key={group.label}
          role="group"
          aria-label={group.label}
          className="flex flex-col gap-1"
        >
          {sections !== undefined ? (
            <Text variant="caption" tone="muted">
              {group.label}
            </Text>
          ) : null}
          {group.controls.map((control) => (
            <ControlOption
              key={control.id}
              control={control}
              onSelect={() => {
                // The command restores editor focus. Popover.close returns focus to the trigger,
                // so reserve that path for Escape and close controlled state on a selection.
                setOpen(false);
                control.run();
              }}
            />
          ))}
        </div>
      ))}
    </Popover>
  );
}

function ControlOption({
  control,
  expanded,
  onSelect,
}: {
  readonly control: Control;
  readonly expanded?: boolean;
  readonly onSelect: () => void;
}): ReactNode {
  return (
    <Button
      variant="ghost"
      className={[
        'w-full justify-start',
        control.active === true ? 'bg-accent/18 text-foreground' : '',
      ].join(' ')}
      disabled={control.enabled === false}
      aria-pressed={control.active}
      aria-expanded={expanded}
      aria-keyshortcuts={control.ariaShortcut}
      title={
        control.shortcut === undefined ? control.label : `${control.label} (${control.shortcut})`
      }
      onClick={onSelect}
    >
      <Icon icon={control.icon} size="sm" />
      {control.label}
    </Button>
  );
}

function Group({
  controls,
  label,
}: {
  readonly controls: readonly Control[];
  readonly label?: string;
}): ReactNode {
  return (
    <div role="group" aria-label={label} className="flex shrink-0 items-center gap-0.5">
      {controls.map((control) => (
        <ToolbarButton key={control.id} control={control} />
      ))}
    </div>
  );
}

function ToolbarButton({
  control,
  expanded,
}: {
  readonly control: Control;
  /** Only for a control that opens a layer, which has an open and a closed. */
  readonly expanded?: boolean;
}): ReactNode {
  const disabled = control.enabled === false;

  return (
    <button
      type="button"
      aria-label={control.label}
      aria-expanded={expanded}
      aria-keyshortcuts={control.ariaShortcut}
      title={
        control.shortcut === undefined ? control.label : `${control.label} (${control.shortcut})`
      }
      // Only where the control has an on and an off. An insert is an action, not a state, and
      // aria-pressed="false" on one would tell a screen reader it is a toggle that is currently
      // off - which is a different and untrue thing.
      aria-pressed={control.active}
      disabled={disabled}
      onClick={control.run}
      className={[
        'flex size-7 max-xl:min-h-(--control-lg) max-xl:min-w-(--control-lg) any-pointer-coarse:min-h-(--control-lg) any-pointer-coarse:min-w-(--control-lg) items-center justify-center rounded-sm',
        'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
        disabled
          ? 'cursor-not-allowed text-muted opacity-40'
          : control.active === true
            ? 'bg-accent/18 text-foreground'
            : 'text-muted hover:bg-foreground/7 hover:text-foreground',
      ].join(' ')}
    >
      <Icon icon={control.icon} size="sm" />
    </button>
  );
}

function Separator(): ReactNode {
  return <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-divider" />;
}
