---
name: nix-interaction-principles
description: Interaction-design rules for Nix and nixsites UI - how creating, moving, completing, deleting and editing things should look and feel. Use this whenever you build or change any interactive surface in Nix (boards, lists, tables, calendars, notes, item panels, menus, toolbars, create flows), add a gesture such as drag and drop or a keyboard shortcut, decide whether an action needs a confirmation dialog, add undo, or touch animation - even if the request only says "add a button", "let me reorder cards" or "make this faster" and never mentions UX.
---

# Nix interaction principles

Nix is a personal life-OS for people who want to get things done quickly. The interface should feel
obvious: one clear way to do each thing, results you can see at once, and mistakes you can take back.

## Simplicity comes first

Everything below serves simplicity; none of it is a feature list to tick off. When a principle seems
to ask for more controls, more shortcuts or more code, pick the simpler design that still honours it.

- **Build what was asked, and nothing next to it.** If the request is "reorder cards and manage
  columns", do not also add card deletion, column colours or extra shortcuts. Mention a gap in one
  line instead of building it.
- **One visible way per action.** Each action gets exactly one obvious control. Add a second route
  only where the platform already expects one: drag and drop on desktop, Enter to submit, Escape to
  cancel, Ctrl/Cmd+Z to undo. Do not invent extra shortcuts (Alt+arrows, F2, double-click to
  rename) on top of a visible control that already does the job.
- **Show the action the task is about; don't hide it.** If an item has one or two actions, put them
  directly on it as small, quiet controls (↑ ↓ buttons, "Rename" / "Remove" in a column header). A
  "⋯" menu is for three or more secondary actions, not a place to tuck away the main one.
- **Fewest moving parts.** Reuse the existing structure and code paths. If the result is far longer
  than the change needs, cut until it isn't.

**Fewer features, never less finish.** Simplicity limits *what* you build, not how well. Every
action that does get built gets the full treatment below: shown in place, an Undo toast, motion in
and out, hover and press states, a visible signifier. A person comparing two versions should find
the simpler one easier, not emptier.

**Simplicity never removes.** Keep every action the view already offers (open, download, move to,
copy link, a context menu) unless the person asked to drop it, and build every part of the request:
a task that says "reorder" gets reordering, even if a simpler design tempts you to skip it.
Simplicity is about not adding the unasked, never about cutting what exists or what was asked.

**Show less, mean more.** Each item shows only what helps the person decide or act; other details
(sizes, ids, timestamps, long paths) go one tap away. Prefer a recognisable icon or colour over a
word where one exists: a file-type icon for each file, a tint per quadrant or status.

**Bring what you touch up to standard.** If the view you are changing already has a gesture or
control that falls short of these principles (a drag with no grip handle, a reversible action with
no undo), fix that too. That is finishing the surface, not adding a feature. The same goes for an
existing bug that blocks the task (a tap that doesn't select the row the toolbar acts on): fix it.

## 1. Clear next steps

After any action the person should know what to do next without thinking.

- After creating something, keep the add field focused and empty so the next item is one keystroke
  away.
- After moving or removing something, put focus on something that still exists (the moved item, the
  next item), never `<body>`.
- Every reversible action leads to "Undo" as its obvious next step.

## 2. Guided, minimal screens

- The common action is the visible default; choose sensible defaults instead of asking (a new card
  lands in the column it was added from; a new column gets an editable name in place).
- Edit in place instead of opening a dialog or a form.
- Keep controls quiet: muted until hover or focus, so the screen stays calm (see 7 for touch).

## 3. Immediate results with undo

- Show the result where the item already is, at once. Don't navigate away or open a panel.
- **No confirmation dialogs for reversible actions** (delete, move, complete, remove a column). Do
  it, then show a toast: "Removed 'Doing' - Undo". Never `window.confirm`. Confirm only what truly
  cannot be undone.
- Undo restores exactly the previous state: same column, same position, any cards a removed column
  held. Keep a stack, so several actions in a row can each be undone, and push the entry at the
  moment the action is taken (not after an exit animation finishes).
- Undo reverses only its own action: record what the action changed and put that back, rather than
  restoring a whole-page snapshot that would also erase anything done since.
- Every reversible action shows the toast, including moves, adds and field edits. After an undo,
  the toast keeps an Undo button while there is still something to undo.
- **The undo notice goes away on its own.** After a few seconds the whole toast, Undo button
  included, leaves the screen unless a mouse is over it or the keyboard is on it. Never leave a
  persistent Undo button or box behind. The history outlives the toast: `Ctrl/Cmd+Z` still works,
  and the next action or undo brings the toast back. The toast and its Undo button never cover the
  controls the person is using, and the button is 44 px on touch.
- `Ctrl/Cmd+Z` undoes the last action whenever focus is not in a text field that has its own text
  undo. Toasts use `role="status"`; a hidden toast must not leave a focusable Undo button behind.
- In the Nix codebase use the house `<Toast>` (`packages/ui/src/controls/Toast.tsx`) and
  `useUndoRemove` (`packages/web-views/src/core/use-undo-remove.tsx`), which already undoes from
  the current state so later edits survive.

## 4. Consistent patterns

The same action looks and behaves the same in every view: completing is the same checkbox and the
same undo in a list, a board, a calendar or a table. Find how other views already do it and reuse
that component rather than drawing a new one.

## 5. Fewer clicks, flexible input

- **One command per action.** Write each action once (`moveCard(id, column, index)`), and have the
  visible control and the drag both call it, so they give the same result and the same undo entry.
- Every result a gesture can reach is also reachable through one visible control; drag is mouse-only
  in practice.
- Typed shortcuts for fields (e.g. "Call dentist !high @tomorrow") are fine when the task asks for
  speed, as long as a plain title is never altered unexpectedly and the parsed result is shown
  before saving. Match whole tokens only: "@monkey" stays in the title rather than becoming Monday,
  and an impossible date (Feb 30) is left as text, not saved.

## 6. Micro-interactions: every action visibly lands

Every action ends with a small animation, at the place it happened, that says "done". The person
should never have to wonder whether a tap worked, and never have to look away from where they acted
to find out.

- **Press:** every control reacts the moment it is touched, before anything else happens: a press
  state (slight scale or darker fill, ~100 ms) plus hover on pointer devices. Write each
  `:hover`/`:active` rule on the same selector as the element's base style (`.toast button:hover`,
  not a bare `button:hover`), because a more specific base rule silently overrides a generic one.
  Native checkboxes and selects get feedback too.
- **Confirm in place, per action type** (120-300 ms, `transform`/`opacity`, ease-out):
  - Create: the new item slides/fades in at its spot and briefly highlights (a soft tint that fades).
  - Complete/tick: the checkbox pops with a check-draw, the title strikes through, counts update.
  - Move: the item glides from where it was to where it lands (FLIP), then flashes once at the
    destination; if the destination is off screen or in another tab, scroll it into view or say where
    it went ("Moved to Done").
  - Edit/save a field: a small check (✓ "Saved") appears beside the field and fades.
  - Remove: the item fades and its row collapses so the gap closes smoothly, never a jump. Undo plays
    the same animation in reverse; items leaving and returning are animated just like arriving ones.
  - Refused action: a brief shake or a tinted message on the item that says why ("Already first").
- **Say it in words too.** The toast or a status line names what happened and where: "Moved 'Renew
  passport' to Important, Urgent", "Indented 'Beta' under 'Alpha'". Motion alone is not
  confirmation; it is missed by people who look away or turn motion off.
- **Show progress where there is progress.** Anything that takes time or has steps shows how far
  along it is, in place:
  - Work over ~300 ms: the button that started it shows a spinner or "Saving…", then a check.
  - Uploads and batches: a progress bar per file or a running count ("3 of 10 uploaded"), with a
    clear done or failed state and a retry for failures.
  - Goals and lists: "4 of 12 done" with a small bar; habit and goal progress as a filling bar or
    ring (5/8); multi-step forms show "Step 2 of 4" or a step bar.
  Progress updates animate (the bar grows, the count ticks) rather than jumping.
- Animate only the item that changed, never replay every card's entrance on each re-render.
- Under `prefers-reduced-motion: reduce` keep the confirmation but drop the movement: a static tint
  or check instead of a slide or pop. The state change and the words still happen.

## 7. Show what can be acted on

A person should see what they can do before they try it.

- **Draggable things say so:** a grip handle (⋮⋮) on each draggable item, shown on hover and focus,
  `cursor: grab` over the draggable area (`grabbing` while dragging). Make the whole card draggable,
  not only its title. While dragging, show an insertion line where it will land and highlight the
  drop target.
- Clickable and editable things look it (hover tint, edit cursor); nothing interactive looks like
  plain text.
- Controls that appear on hover, grip handles included, also appear on keyboard focus and are
  always visible on touch screens (`@media (hover: none)`), never hidden there.
- Icon-only controls get an `aria-label` and a `title`.

## 8. Phone, tablet and desktop

Every view works at phone (about 390 px), tablet (about 820 px) and desktop (1280 px and up) widths,
with the same actions available at each.

- Phone: one column of content, no horizontal page scroll (a board shows one column at a time with a
  picker, a table scrolls inside its own frame), touch targets at least 44 px, and no action that
  needs hover or a right-click. Native drag does not work on touch, so the visible control is the
  phone's way to move things.
- Tablet: use the width (two or three board columns, a sidebar that fits), but assume touch, so the
  phone rules on targets and hover still apply.
- Desktop: hover-revealed controls, drag and drop and keyboard shortcuts are welcome extras on top
  of the visible controls. Use the width: don't cap the whole view at a phone-like column (~700 px)
  and leave the rest empty; widen grids, show side-by-side panels (list plus detail, form plus
  results), or more columns.
- Toolbars on phone: give icon buttons a short text label when they are the main way to act
  ("Indent", "Move up"), since there is no hover tooltip on touch.

## Accessibility

Every action has a keyboard path through its visible control, focus is visible, and drag always has
the non-drag control from 5.

## Before you finish

1. Open the page in a browser (Playwright or similar, if you cannot look yourself) and run the
   main path the person asked for at least twice in a row, e.g. add three cards, reorder twice,
   remove a column with cards and undo. Syntax checks don't catch a field that never clears.
   Do it at phone, tablet and desktop widths (390, 820, 1280 px).
   While there, hover a button and confirm its style really changes (a more specific selector
   often overrides `button:hover`), and confirm the console shows no errors.
2. Check the result against this list:
   - Only what was asked was built; each action has one visible control.
   - No `confirm()` or modal for reversible actions; toast Undo and Ctrl/Cmd+Z restore the exact
     previous state, several steps deep.
   - Drag and visible control share one function; draggable items show a grip and grab cursor.
   - Focus lands somewhere useful after each action.
   - Every action you can take shows a confirmation animation where it happened, plus words saying
     what happened; removals and undos animate too; anything slow or multi-step shows progress.
   - The undo toast leaves on its own after a few seconds; nothing it covers is unreachable.
   - Every action the view had before still exists, and every part of the request was built.
   - Controls have hover/press feedback, reduced motion keeps the confirmation without movement.
