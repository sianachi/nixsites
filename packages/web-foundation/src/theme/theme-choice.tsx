import { Icon } from '@nix/ui';
import { Monitor, Moon, Sun } from 'lucide-react';
import type { ReactNode } from 'react';

import type { ThemePreference } from './theme-store';
import { useTheme } from './use-theme';

/**
 * Choosing the ground: follow the machine, or pick one.
 *
 * **Three options rather than a two-state switch.** Following the machine is a real choice, not
 * the absence of one - somebody whose desktop turns dark at dusk wants this to turn with it. A
 * toggle cannot say that: it can only record whichever ground they were on when they last touched
 * it, and then stop following.
 *
 * Rendered as a radio group rather than three buttons, because that is what it is: one choice from
 * a fixed set, exactly one of which is current. A screen reader announces the set, the current
 * member and its position, and arrow keys move between them - none of which three buttons would
 * give without being told to imitate a radio group.
 */

const OPTIONS: readonly { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

/** `inline` drops the menu section's rule and visible heading, for a toolbar such as the landing nav. */
export function ThemeChoice({ inline = false }: { readonly inline?: boolean }): ReactNode {
  const { preference, setPreference } = useTheme();

  return (
    <fieldset className={inline ? '' : 'border-t border-divider px-3 py-2'}>
      <legend className="sr-only">Appearance</legend>

      {/* text-primitive-exempt: `fieldLabel` one step down. This names the group inside a 240px
          account menu, where the published label step (`text-xs`) sits level with the option
          labels under it and stops reading as their heading. Everything else about it - family,
          caps, tracking, muted role - is the published treatment. */}
      {inline ? null : (
        <p
          aria-hidden="true"
          className="mb-1.5 font-heading text-2xs uppercase tracking-wider text-muted"
        >
          Appearance
        </p>
      )}

      <div className="flex gap-1">
        {OPTIONS.map((option) => {
          const current = option.value === preference;

          return (
            <label
              key={option.value}
              className={[
                'flex flex-1 cursor-default items-center justify-center gap-1 border px-2 py-1 pointer-coarse:min-h-(--control-lg)',
                'text-xs',
                'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent',
                current
                  ? 'border-divider bg-foreground/7 text-foreground'
                  : 'border-transparent text-muted hover:bg-foreground/5',
              ].join(' ')}
            >
              {/* The radio itself carries the semantics and the keyboard behaviour; it is placed
                  off-screen rather than hidden, because `display: none` would take it out of the
                  tab order and out of the accessibility tree along with it. */}
              <input
                type="radio"
                name="appearance"
                value={option.value}
                checked={current}
                onChange={() => {
                  setPreference(option.value);
                }}
                className="sr-only"
              />
              <Icon icon={option.icon} size="sm" />
              {option.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
