import { Button, Text } from '@nix/ui';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { EmptyPanel, LoadingPanel } from '@nix/web-foundation/components/states/status-panels';
import type { Item, PropertyDefinition, PropertyValue } from '../core/container-model';
import { PropertyInput } from './property-input';

/**
 * An item's properties, on the item.
 *
 * Until now the only way to set a property was to drag a card on a board or on a calendar, which
 * writes the one property that view groups by. A note with a status and an owner had no way to
 * carry either from the note itself; this is that way.
 *
 * **The panel writes one property per request, and only the one that changed.** The contract merges
 * - a member set to null clears that property, anything unmentioned is left alone - so there is no
 * reason to send the whole bag back and every reason not to: sending properties nobody touched
 * would make one person's edit overwrite another's, and would turn a value this build could not
 * render into a value this build deleted.
 *
 * **Which properties exist is the schema's decision.** They come from the folder the item
 * is in and from the folders above it, which is exactly what the empty state has to say - otherwise
 * "no properties" reads as a fault rather than as a folder that has not declared any. Compact
 * details initially show required, computed and populated values; disclosure keeps the rest reachable.
 */

export interface PropertyPanelProps {
  readonly item: Item;

  /** The effective schema's properties: what this item declares plus what it inherits. */
  readonly properties: readonly PropertyDefinition[];

  /**
   * Stores the changed properties and answers with the reason they were refused, or null when they
   * were stored.
   *
   * A reason rather than a boolean, because the server names the property at fault and somebody has
   * to be shown that sentence - "false" cannot say which property is wrong or why.
   */
  readonly onChange: (changes: Record<string, unknown>) => Promise<string | null>;

  /** The schema has not arrived yet. Distinct from a folder that declares nothing. */
  readonly loading?: boolean;

  /** No write is permitted from here - a read-only share, say. */
  readonly disabled?: boolean;
  /** Details panels start with required, computed and populated values. Forms can show all. */
  readonly compact?: boolean;
}

/**
 * The title is not a property this panel edits.
 *
 * It is on the item itself and the rename path owns it; offering a second control for it here would
 * be a second way to write one field, and the two would disagree the first time one of them lost a
 * race. The server refuses to have it redeclared for the same reason.
 */
const TITLE_KEY = 'title';

interface Refusal {
  readonly key: string;
  readonly reason: string;
}

export function PropertyPanel(props: PropertyPanelProps): ReactNode {
  const { item, properties, onChange, loading = false, disabled = false, compact = false } = props;

  const headingId = useId();
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const focusOnReveal = useRef<string | null>(null);

  useLayoutEffect(() => {
    const key = focusOnReveal.current;
    if (!expanded || key === null) return;
    focusOnReveal.current = null;
    const field = [
      ...(panelRef.current?.querySelectorAll<HTMLElement>('[data-property-key]') ?? []),
    ].find((element) => element.dataset.propertyKey === key);
    const control = field?.querySelector<HTMLElement>(
      'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])',
    );
    (control ?? panelRef.current)?.focus();
  }, [expanded]);

  // The key that just finished saving, cleared a moment later. "Saved" is a fact about the last
  // write, not the field's ongoing state, so it does not linger the way "Saving…" is allowed to.
  const [saved, setSaved] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (savedTimer.current !== null) {
        clearTimeout(savedTimer.current);
      }
    };
  }, []);

  if (loading) {
    return <LoadingPanel label="this item's properties" />;
  }

  const editable = properties.filter((property) => property.key !== TITLE_KEY);
  const visible =
    !compact || expanded
      ? editable
      : editable.filter((property) => {
          const value = item.properties[property.key];
          return (
            property.required ||
            property.type === 'formula' ||
            property.type === 'rollup' ||
            (value !== undefined &&
              value !== null &&
              (typeof value !== 'string' || value.trim() !== '') &&
              (!Array.isArray(value) || value.length > 0))
          );
        });

  if (editable.length === 0) {
    return (
      <EmptyPanel
        title="No properties here"
        detail="Properties come from the item this one is in, and from the items above it. None of them declares any yet, so there is nothing to fill in - add a property further up and it appears here."
      />
    );
  }

  async function commit(key: string, value: PropertyValue): Promise<void> {
    setSaving(key);
    setRefusal(null);
    setSaved(null);
    if (savedTimer.current !== null) {
      clearTimeout(savedTimer.current);
      savedTimer.current = null;
    }

    const reason = await onChange({ [key]: value });

    setSaving(null);

    if (reason !== null) {
      // Verbatim, and attached to the property it is about. The server names the property at fault;
      // rewording it here would be a second validator that can disagree with the first, and a
      // panel-wide banner would leave somebody hunting for which field it meant.
      setRefusal({ key, reason });
      return;
    }

    // Briefly, and only for this field. `aria-busy` on the section already tells an assistive
    // reader something is happening; this is the sighted half of the same fact, so a save on a slow
    // link is not indistinguishable from a click that did nothing.
    setSaved(key);
    savedTimer.current = setTimeout(() => {
      setSaved(null);
    }, 2000);
  }

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      aria-labelledby={headingId}
      aria-busy={saving !== null}
      className="flex flex-col gap-4"
    >
      <Text variant="h6" as="h2" id={headingId}>
        Properties
      </Text>

      {visible.map((property) => (
        <div key={property.key} data-property-key={property.key} className="flex flex-col gap-1">
          <PropertyInput
            item={item}
            property={property}
            disabled={disabled}
            error={refusal?.key === property.key ? refusal.reason : null}
            onCommit={(value) => {
              void commit(property.key, value);
            }}
          />

          {/* Quiet and polite: a save is not an interruption, so it is announced without moving
              focus or grabbing an `alert`'s attention, the same distinction `ErrorPanel` and
              `LoadingPanel` draw between `alert` and `status`. */}
          <span aria-live="polite">
            {saving === property.key ? (
              <Text variant="note" tone="muted">
                Saving…
              </Text>
            ) : saved === property.key ? (
              <Text variant="note" tone="muted">
                Saved
              </Text>
            ) : null}
          </span>
        </div>
      ))}
      {compact && visible.length < editable.length ? (
        <Button
          variant="ghost"
          className="justify-start"
          onClick={() => {
            focusOnReveal.current =
              editable.find((property) => !visible.includes(property))?.key ?? null;
            setExpanded(true);
          }}
        >
          More details ({String(editable.length - visible.length)})
        </Button>
      ) : null}
    </section>
  );
}
