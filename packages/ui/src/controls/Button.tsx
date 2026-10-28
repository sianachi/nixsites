import { cva } from 'class-variance-authority';
import { type ComponentPropsWithRef, type ReactNode } from 'react';

import { cn } from '../lib/cn';
import { blueprintFrame } from '../primitives/Blueprint';
import {
  accentFillStates,
  accentWashStates,
  disabledState,
  focusRing,
  inkWashStates,
} from '../primitives/interaction';

/**
 * <Button> - the action control, in the four shapes the Industry system
 * defines.
 *
 * - `primary`   the one solid accent object on the board. It is the only
 *               filled button, and it keeps the blueprint registration marks.
 * - `secondary` a hairline outlined box on the ground.
 * - `ghost`     type only, no box, for tertiary actions.
 * - `icon`      a square outlined box holding a single glyph.
 *
 * The frame's radius comes from `blueprintFrame`, so a button turns its corner
 * the same way a card does; there is no size or
 * radius prop to soften them. Interaction states come from
 * `primitives/interaction` so hover, pressed, focus and disabled read the same
 * on every control in the library.
 *
 * Contrast, and why `primary` fills with `--color-accent-fill` rather than the
 * base accent: the base accent is tuned to about 3:1 against the ground, and
 * that ceiling is a property of the fill, not of the label - even pure white on
 * `--color-accent` reaches only 4.1:1, under the 4.5:1 AA floor for a body-size
 * label. `--color-accent-fill` is defined as the accent step that clears 4.5:1
 * against `--color-background`, and contrast is symmetric, so the role used as
 * a *fill* under a `--color-background` label clears 4.5:1 by construction - on
 * both grounds, without either colour being named here. It is accent-700 on
 * paper (5.8:1, exactly what this button used to hard-code) and accent-300 on
 * ink (12.1:1).
 *
 * It is a separate role from `--color-accent-text` even though the two start
 * equal, because their hover steps move in opposite directions: text moves
 * towards the ground, a fill has to move away from it. See `interaction.ts`.
 *
 * The button is still the one solid accent object; it just sits at the step the
 * design system already reserves for accent-carrying-text.
 *
 * The frame is drawn by the button element itself rather than by a
 * <Blueprint> wrapper: a wrapping div would put the border and the marks
 * outside the focus target, so the focus ring and the frame would disagree.
 * Both halves still come from the frame primitive - `blueprintFrame` for the
 * hairline square box and `RegistrationMarks` for the corners - so there is
 * exactly one definition of the grammar, not a lookalike.
 *
 * Size comes from the sheet's two scales (ADR-0008): the label is `text-md` and
 * every variant is one `--control-md` tall. That height used to belong to the
 * icon button alone, as a literal, while the boxed variants were whatever their
 * padding and line height happened to add up to - 32.4px, so a button never
 * quite lined up with the icon button beside it. Naming the step fixes the row
 * and moves the icon button by nothing.
 *
 * On a coarse pointer the box grows to `--control-lg`, the 44px step the scale
 * already reserves for a touch target, and stays at `--control-md` under a
 * fine-only device. `any-pointer-coarse:` also keeps the touch target when a
 * tablet has a mouse attached.
 */

/**
 * The boxed variants' inset: 1.2 of the design system's third spacing step,
 * exactly as its `.btn` writes it, and derived from `--spacing` so a change of
 * density moves it. Only horizontal - the vertical measure is the control
 * height, which the base class owns.
 */
const boxPadding = 'px-[calc(var(--spacing)*3.6)]';

const buttonVariants = cva(
  cn(
    blueprintFrame,
    'inline-flex cursor-default items-center justify-center gap-2 select-none',
    'h-(--control-md) any-pointer-coarse:h-(--control-lg) any-pointer-coarse:min-w-(--control-lg) font-heading text-md font-semibold no-underline',
    'transition-colors',
    focusRing,
    disabledState,
  ),
  {
    variants: {
      variant: {
        primary: cn(
          `border-accent-fill bg-accent-fill text-background ${boxPadding}`,
          accentFillStates,
        ),
        secondary: cn(`border-divider text-foreground ${boxPadding}`, inkWashStates),
        ghost: cn('text-accent-text border-transparent px-1', accentWashStates),
        icon: cn(
          'border-divider text-foreground w-(--control-md) any-pointer-coarse:w-(--control-lg) p-0',
          inkWashStates,
        ),
      },
      fullWidth: {
        true: 'w-full',
        false: '',
      },
    },
    defaultVariants: { variant: 'primary', fullWidth: false },
  },
);

type ButtonBaseProps = Omit<ComponentPropsWithRef<'button'>, 'style'> & {
  /** Stretch to the container's width - the design system's block button. */
  fullWidth?: boolean;
  /** Layout only - margin, grid placement. Never a restyle of the control. */
  className?: string;
};

/**
 * An icon button has no visible text, so its accessible name has to come from
 * `aria-label`. Making that a type error rather than an axe finding is the
 * whole point of encoding the variant in the type.
 */
export type ButtonProps =
  | (ButtonBaseProps & { variant?: 'primary' | 'secondary' | 'ghost' })
  | (ButtonBaseProps & { variant: 'icon'; 'aria-label': string });

export function Button(props: ButtonProps): ReactNode {
  const {
    variant = 'primary',
    fullWidth = false,
    className,
    children,
    type = 'button',
    ...rest
  } = props;

  return (
    <button type={type} className={cn(buttonVariants({ variant, fullWidth }), className)} {...rest}>
      {children}
    </button>
  );
}
