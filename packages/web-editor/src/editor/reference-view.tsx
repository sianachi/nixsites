import { focusRing, cn } from '@nix/ui';
import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { type ReactNode } from 'react';

import { useSelectedItem } from '@nix/web-platform/routing/selected-item';
import { proseClasses } from './prose';
import { useReference } from './reference-resolution';

/**
 * How a reference is drawn once the server has been asked about it.
 *
 * The four states of {@link useReference}, and each one is a different sentence:
 *
 * - **resolved** - the item's title as it is now, and a control that opens it. Not the stored
 *   label, so renaming the target is reflected everywhere it is mentioned.
 * - **loading** - the stored label, which is exactly what it was cached for.
 * - **refused** - a stub, and never the label.
 * - **unavailable** - the stored label again, and a note saying it could not be checked. A failed
 *   lookup is a fact about the network; drawing it as a refusal would tell the reader something
 *   about their own permissions that nobody established.
 *
 * **What the refused stub is and is not worth.** The label is already in the reader's hands: it
 * travels inside the document, the CRDT delivered it, and `@nix/editor-schema`'s own `renderHTML`
 * puts it on the page for every consumer that cannot ask anybody anything - the collaboration
 * service, an export. So refusing to draw it here does not keep a secret from somebody determined
 * to read the update log; it keeps a *stale, unverified* title out of the interface, and stops the
 * product presenting it as though it were current. That is a smaller claim than "the label is
 * confidential", and it is the true one - which is why `loading` and `unavailable` may show it and
 * `refused` may not: those two mean "not checked yet", and this one means "checked, and it is not
 * yours". Anything stronger needs the label out of the document, which is a schema change and a
 * different goal.
 *
 * A person mentioned with `@` gets the label and no navigation: a principal is not somewhere the
 * item panes can open, and there is no people surface for it to lead to yet.
 */
export function ReferenceView(props: ReactNodeViewProps): ReactNode {
  const attrs = props.node.attrs as {
    readonly kind?: unknown;
    readonly targetId?: unknown;
    readonly label?: unknown;
  };

  const kind = attrs.kind === 'principal' ? 'principal' : 'item';
  const targetId = typeof attrs.targetId === 'string' ? attrs.targetId : null;
  const label =
    typeof attrs.label === 'string' && attrs.label.length > 0 ? attrs.label : 'Untitled';

  // Only items are resolved. A principal reference has nothing to resolve against yet, and asking
  // the item endpoint about a principal identifier would answer "refused" - which would draw every
  // mention of a colleague as something the reader is not allowed to see.
  const state = useReference(kind === 'item' ? targetId : null);
  const { select } = useSelectedItem();

  if (kind === 'item' && state.status === 'refused') {
    return (
      <NodeViewWrapper as="span" className="inline" contentEditable={false}>
        <span className="text-muted italic">
          Unavailable
          {/*
            The explanation is in the accessible name rather than a `title`, which a keyboard
            cannot reach and a touch device cannot hover.

            And it names all three possibilities, because the server deliberately reports one
            answer for them: deleted, never existed, and not shared with you. Saying "you do not
            have access" - as this did - picks the most alarming of the three and states it as
            fact, so somebody who deleted their own document and came back to a note that
            referenced it was told they lacked access to their own item.
          */}
          <span className="sr-only">
            {' '}
            - this link cannot be opened. It may have been deleted, or it may not be shared with
            you.
          </span>
        </span>
      </NodeViewWrapper>
    );
  }

  if (kind === 'item' && state.status === 'resolved' && targetId !== null) {
    return (
      <NodeViewWrapper as="span" className="inline" contentEditable={false}>
        {/*
          **`onMouseDown` with `preventDefault`, not `onClick` alone.** This button lives inside a
          `contenteditable`, where ProseMirror handles the pointer first: it treats the press as a
          selection change on the atom, takes the focus, and the click that would have followed
          never reaches React. That is why nothing happened when somebody clicked a reference. The
          same failure is documented on `note-editor.tsx`'s disclosure toggle, and the wrapper's
          `contentEditable={false}` is the other half of the fix - it is what makes this an island
          the editor does not own.

          `onClick` stays for the keyboard: Enter and Space on a focused button raise a click and
          no pointer event at all.
        */}
        <button
          type="button"
          className={cn(proseClasses.reference, focusRing)}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            select(targetId);
          }}
          onClick={(event) => {
            // Already handled on press; without this a pointer click would navigate twice.
            if (event.detail === 0) {
              select(targetId);
            }
          }}
        >
          {state.title ?? 'Untitled'}
        </button>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper as="span" className="inline" contentEditable={false}>
      {/*
        Not a button, and drawn without the underline the resolved state carries: these two states
        do nothing when clicked, and a link that looks identical to a working one is a click
        somebody makes and learns nothing from.
      */}
      <span className="text-muted">
        {label}
        {state.status === 'unavailable' ? (
          <span className="sr-only">
            {' '}
            - this link could not be checked just now. The name shown is the one it had when the
            link was made.
          </span>
        ) : null}
      </span>
    </NodeViewWrapper>
  );
}
