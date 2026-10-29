import { Textarea } from '@nix/ui';
import { useState, type ReactNode } from 'react';

import { readPropertyText } from '../../core/container-model';

import { type PropertyInputProps } from './types';
import { ValueShell } from './shell';
import { useDraft } from './drafts';

/**
 * Plain text that runs to several lines. Commits on blur, as the one-line field does, but Enter is
 * a line break here rather than the explicit "done" gesture - which is the whole reason this is not
 * a `TypedValue` kind. Escape puts back the text this field last handed over, so a cancelled edit
 * is not written by the blur that follows it.
 *
 * In a cell the box rests as one unwrapped row, so the cell shows the first line like a one-line
 * value does, and opens out to the whole text only while somebody is editing it.
 */
export function LongTextValue(props: PropertyInputProps): ReactNode {
  const { item, property, onCommit, disabled = false, density = 'panel' } = props;

  const stored = readPropertyText(item, property.key);
  const { draft, setDraft, sent, send } = useDraft(stored, onCommit);
  const [editing, setEditing] = useState(false);
  const collapsed = density !== 'panel' && !editing;

  function commit(): void {
    if (draft === sent) {
      return;
    }

    send(draft, draft.length === 0 ? null : draft);
  }

  return (
    <ValueShell {...props}>
      {(control) => (
        <Textarea
          {...control}
          tabIndex={props.tabIndex}
          autoGrow={!collapsed}
          rows={collapsed ? (density === 'card' ? 3 : 1) : undefined}
          wrap={collapsed && density === 'cell' ? 'off' : 'soft'}
          maxLength={8000}
          // At rest in a cell, the box is one line at the height of the one-line fields beside it,
          // with no resize grip. A text area paints overflow into its own padding, so padding cannot
          // hide the second line; with no vertical border while collapsed, a line exactly as tall
          // as the box centres the first line like an input does and puts the second out of sight.
          className={
            collapsed && density === 'cell'
              ? 'h-(--control-md) min-h-0 resize-none overflow-hidden border-y-0 py-0 leading-(--control-md) any-pointer-coarse:h-(--control-lg) any-pointer-coarse:leading-(--control-lg)'
              : 'max-h-64'
          }
          tone={density === 'cell' ? 'plain' : 'default'}
          value={draft}
          required={property.required}
          disabled={disabled}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onFocus={() => {
            setEditing(true);
          }}
          onBlur={() => {
            setEditing(false);
            commit();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setDraft(sent);
            }
          }}
        />
      )}
    </ValueShell>
  );
}
