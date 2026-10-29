/**
 * The component vocabulary the pet may write in an `openui-lang` block, with no React in it, so
 * the prompt generator (Step 2 of the OpenUI plan) can import the same signatures the renderer
 * binds. Arguments are positional in OpenUI Lang, so each object's key order is its signature.
 *
 * Generic primitives only, by owner decision: state, inputs, buttons that set state, expressions
 * and layout are enough for the model to build calculators, quizzes and converters itself, so no
 * purpose-built widget belongs here. Nix data comes through `Query` (see `tool-provider.ts`),
 * never as copied titles or bodies.
 */
import { action, reactive } from '@openuidev/react-lang';
import { z } from 'zod';

const children = z.array(z.any());
const scalar = z.union([z.string(), z.number()]);
/** Checked when the Form around an input is submitted; the keys are OpenUI's built-in validators. */
const rules = z
  .object({
    required: z.boolean(),
    email: z.boolean(),
    url: z.boolean(),
    numeric: z.boolean(),
    min: z.number(),
    max: z.number(),
    minLength: z.number(),
    maxLength: z.number(),
    pattern: z.string(),
  })
  .partial()
  .optional();

export const CONTRACTS = {
  Stack: {
    description: 'Vertical layout. The root of every program.',
    props: z.object({ children, gap: z.enum(['s', 'm', 'l']).optional() }),
  },
  Row: {
    description: 'Horizontal layout that wraps on narrow screens.',
    props: z.object({ children, align: z.enum(['start', 'center', 'between']).optional() }),
  },
  Grid: {
    description: 'Equal-width grid, for keypads, option tiles and stat rows.',
    props: z.object({ children, columns: z.number().int().min(1).max(6) }),
  },
  Card: {
    description: 'A titled, bordered group.',
    props: z.object({ title: z.string(), children }),
  },
  Text: {
    description: 'Text or a computed value. display is large, for a calculator screen or a result.',
    props: z.object({
      value: scalar,
      variant: z.enum(['display', 'title', 'body', 'note', 'caption']).optional(),
      tone: z.enum(['default', 'muted', 'accent']).optional(),
    }),
  },
  Stat: {
    description: 'A labelled figure, such as a result or a total.',
    props: z.object({ label: z.string(), value: scalar, unit: z.string().optional() }),
  },
  Button: {
    description: 'Runs an Action: @Set or @Reset state, @Run a query, or ask the pet.',
    props: z.object({
      label: z.string(),
      action: action(),
      variant: z.enum(['primary', 'secondary', 'ghost']).optional(),
    }),
  },
  NumberInput: {
    description: 'A number field bound to a $variable.',
    props: z.object({
      label: z.string(),
      value: reactive(z.number()),
      min: z.number().optional(),
      max: z.number().optional(),
      step: z.number().optional(),
      rules,
    }),
  },
  TextInput: {
    description: 'A text field bound to a $variable.',
    props: z.object({
      label: z.string(),
      value: reactive(z.string()),
      placeholder: z.string().optional(),
      rules,
    }),
  },
  TextArea: {
    description: 'Multi-line text bound to a $variable, for notes and longer answers.',
    props: z.object({
      label: z.string(),
      value: reactive(z.string()),
      rows: z.number().int().min(2).max(20).optional(),
      rules,
    }),
  },
  Select: {
    description: 'A choice from a list, bound to a $variable holding the chosen value.',
    props: z.object({
      label: z.string(),
      value: reactive(z.string()),
      options: z.array(z.object({ value: z.string(), label: z.string() })),
      rules,
    }),
  },
  Slider: {
    description: 'A range slider bound to a $variable.',
    props: z.object({
      label: z.string(),
      value: reactive(z.number()),
      min: z.number(),
      max: z.number(),
      step: z.number().optional(),
    }),
  },
  Toggle: {
    description: 'A checkbox bound to a true/false $variable.',
    props: z.object({ label: z.string(), value: reactive(z.boolean()), rules }),
  },
  Form: {
    description:
      'Groups inputs whose rules are checked when submit (a Button) is pressed; the action runs only when every field passes.',
    props: z.object({ name: z.string(), submit: z.any(), fields: children }),
  },
  Table: {
    description: 'Rows of cells under column headers.',
    props: z.object({
      columns: z.array(z.string()),
      rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
      caption: z.string().optional(),
    }),
  },
  Chart: {
    description: 'A column, line or pie chart over labelled buckets, with its figures as a table.',
    props: z.object({
      kind: z.enum(['column', 'line', 'pie']),
      caption: z.string(),
      labels: z.array(z.string()),
      series: z.array(z.object({ label: z.string(), values: z.array(z.number()) })),
    }),
  },
  ItemList: {
    description:
      'Nix items that open on click. Pass Query results (search.results, items.items), never typed-out titles.',
    props: z.object({
      items: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          type: z.string().optional(),
          workspaceId: z.string().optional(),
        }),
      ),
      empty: z.string().optional(),
    }),
  },
} as const;

export type ContractName = keyof typeof CONTRACTS;
export type ContractProps<N extends ContractName> = z.infer<(typeof CONTRACTS)[N]['props']>;
