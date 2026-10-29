import { Icon, Text, cn, focusRing } from '@nix/ui';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useId, type ReactNode } from 'react';

import type { AxisGroup } from '@nix/web-collections/core/view-axis';

interface ListSectionsProps {
  readonly sections: readonly AxisGroup[];
  readonly collapsed: ReadonlySet<string>;
  readonly onToggle: (group: string) => void;
  readonly renderRows: (section: AxisGroup) => ReactNode;
}

/**
 * A grouped list: one heading per section, each with its count and a disclosure that folds it.
 *
 * **The heading is a real heading holding a real button.** The heading is what a screen reader's
 * heading list offers to jump between, and the button inside it is what folds the section - with
 * `aria-expanded` saying which state it is in and `aria-controls` naming what it hides - the
 * disclosure pattern rather than a clickable `<h3>`, which a keyboard cannot reach.
 *
 * Each section's rows are the list's own table, captioned with the section's name, so row headers,
 * in-place cells, context menus and windowing past a hundred rows behave exactly as an ungrouped
 * list's do: the sections reuse the rows rather than drawing a second kind of row.
 */
export function ListSections(props: ListSectionsProps): ReactNode {
  const { sections, collapsed, onToggle, renderRows } = props;
  const baseId = useId();

  return (
    <div className="flex flex-col gap-4">
      {sections.map((section, index) => {
        const open = !collapsed.has(section.group);
        const bodyId = `${baseId}-section-${String(index)}`;
        return (
          <section key={section.group} className="flex flex-col gap-2">
            <Text as="h3" variant="h6">
              <button
                type="button"
                aria-expanded={open}
                aria-controls={bodyId}
                onClick={() => {
                  onToggle(section.group);
                }}
                className={cn(
                  'flex w-full items-center gap-2 text-left pointer-coarse:min-h-(--control-lg)',
                  focusRing,
                )}
              >
                <Icon icon={open ? ChevronDown : ChevronRight} size="sm" />
                <span className="min-w-0">{section.label}</span>
                <Text as="span" variant="caption" tone="muted">
                  {section.items.length}
                  <span className="sr-only"> {section.items.length === 1 ? 'item' : 'items'}</span>
                </Text>
              </button>
            </Text>
            <div id={bodyId} hidden={!open}>
              {open ? renderRows(section) : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}
