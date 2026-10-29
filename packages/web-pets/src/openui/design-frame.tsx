import { Text, cn } from '@nix/ui';
import { createContext, useState, type ReactNode } from 'react';

/** What a drag in the designer carries: a component to add, or one already placed to move. */
export type DragPayload =
  { readonly kind: 'new'; readonly type: string } | { readonly kind: 'move'; readonly id: string };

export interface DesignContextValue {
  readonly selected: string | null;
  readonly select: (id: string) => void;
  /** What is being dragged now. Held in state, as the board does: the browser hides a drag's
   * payload from dragover, which is where a drop target has to decide whether to accept it. */
  readonly dragging: DragPayload | null;
  /** Drops the current drag into the end of a container. */
  readonly drop: (containerId: string) => void;
}

/**
 * Present only while a program is drawn for the designer. The library's renderers read it to
 * wrap each statement-backed component in a selectable frame; without it (everywhere else) they
 * render exactly as before. Design mode is a view of the program, never a way to run it: the
 * canvas is the read-only preview, and the frame swallows clicks before a control hears them.
 */
export const OpenUiDesign = createContext<DesignContextValue | null>(null);

export function DesignFrame({
  design,
  id,
  type,
  container,
  children,
}: {
  readonly design: DesignContextValue;
  readonly id: string;
  readonly type: string;
  readonly container: boolean;
  readonly children: ReactNode;
}): ReactNode {
  const selected = design.selected === id;
  const [over, setOver] = useState(false);
  return (
    // A frame is a selectable stand-in for the component inside it, so it takes pointer and key
    // input without being a control itself.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      role="group"
      aria-label={`${type} ${id}`}
      aria-current={selected ? 'true' : undefined}
      data-design-frame={id}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- selectable by keyboard
      tabIndex={0}
      className={cn(
        'relative min-w-0 cursor-pointer rounded-sm outline-offset-2 hover:outline hover:outline-1 hover:outline-divider',
        selected && 'outline outline-2 outline-accent hover:outline-accent',
        over && design.dragging !== null && 'bg-accent/10',
      )}
      // The nearest frame under the pointer takes the click; stopping it here, before the target
      // sees it, is what keeps a button or a link on the canvas from doing anything.
      onClickCapture={(event) => {
        if ((event.target as Element).closest('[data-design-frame]') !== event.currentTarget)
          return;
        event.stopPropagation();
        event.preventDefault();
        design.select(id);
      }}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          design.select(id);
        }
      }}
      onDragOver={(event) => {
        if (!container || design.dragging === null) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(true);
      }}
      onDragLeave={() => {
        setOver(false);
      }}
      onDrop={(event) => {
        setOver(false);
        if (!container || design.dragging === null) return;
        event.preventDefault();
        event.stopPropagation();
        design.drop(id);
      }}
    >
      {selected ? (
        <Text
          as="span"
          variant="caption"
          className="absolute -top-3 left-1 z-10 rounded-sm bg-accent px-1 text-background"
        >
          {type}
        </Text>
      ) : null}
      {/* A leaf is inert: its controls neither take focus nor answer the keyboard. */}
      {container ? children : <div inert>{children}</div>}
    </div>
  );
}
