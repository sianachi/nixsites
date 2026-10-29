import {
  createLibrary,
  defineComponent,
  FormNameContext,
  FormValidationContext,
  parseStructuredRules,
  useCreateFormValidation,
  useFormName,
  useFormValidation,
  useIsStreaming,
  useStateField,
  useTriggerAction,
  type ComponentRenderer,
} from '@openuidev/react-lang';
import {
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  Select,
  Table,
  Text,
  Textarea,
  cn,
  type TableColumn,
} from '@nix/ui';
import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { z } from 'zod';

import { seriesStyle } from '@nix/web-views/chart/chart-model';
import { ChartTable } from '@nix/web-views/chart/chart-table';
import { ColumnChart, LineChart, PieChart } from '@nix/web-views/chart/svg-charts';
import { CONTRACTS, type ContractName, type ContractProps } from './contracts';
import { DesignFrame, OpenUiDesign } from './design-frame';
import { isContainer } from './designer-model';
import { NIX_FUNCTIONS } from './functions';

/** The workspaces a block may link into: the conversation's, or the artifact's own. */
export const OpenUiScope = createContext<readonly string[]>([]);

const UUID = /^[a-f0-9-]{36}$/;

/** A list prop as given, or empty: a query's value is null until it first loads, and a program
 * may pass anything; the schema is checked by the parser, not at every render. */
function list<T>(value: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : [];
}

function show(value: unknown): string {
  if (typeof value === 'number')
    return Number.isFinite(value) ? String(Math.round(value * 1e6) / 1e6) : '–';
  return typeof value === 'string' ? value : '';
}

type Rules = ContractProps<'TextInput'>['rules'];

/** Registers an input's rules with the Form around it, so submit checks them, and returns the
 * field's error once a submit has failed. Outside a Form, or without rules, it does nothing. */
function useRules(name: string, rules: Rules, value: unknown): string | null {
  const form = useFormValidation();
  const current = useRef(value);
  useEffect(() => {
    current.current = value;
    if (rules && form?.getFieldError(name))
      form.validateField(name, value, parseStructuredRules(rules));
  }, [form, name, rules, value]);
  const key = JSON.stringify(rules ?? null);
  useEffect(() => {
    if (!form || !rules) return;
    form.registerField(name, parseStructuredRules(rules), () => current.current);
    return () => {
      form.unregisterField(name);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is `rules` by value
  }, [form, name, key]);
  return form?.getFieldError(name) ?? null;
}

const GAP = { s: 'gap-2', m: 'gap-3', l: 'gap-5' } as const;
const ALIGN = { start: 'justify-start', center: 'justify-center', between: 'justify-between' };
const COLUMNS = [
  '',
  'grid-cols-1',
  'grid-cols-2',
  'grid-cols-3',
  'grid-cols-4',
  'grid-cols-5',
  'grid-cols-6',
];

const renderers: { [N in ContractName]: ComponentRenderer<ContractProps<N>> } = {
  Stack: ({ props, renderNode }) => (
    <div className={cn('flex min-w-0 flex-col', GAP[props.gap ?? 'm'])}>
      {props.children.map((child, index) => (
        <div key={index} className="min-w-0">
          {renderNode(child)}
        </div>
      ))}
    </div>
  ),
  Row: ({ props, renderNode }) => (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-2', ALIGN[props.align ?? 'start'])}>
      {props.children.map((child, index) => (
        <div key={index}>{renderNode(child)}</div>
      ))}
    </div>
  ),
  Grid: ({ props, renderNode }) => (
    <div className={cn('grid min-w-0 gap-2', COLUMNS[props.columns])}>
      {props.children.map((child, index) => (
        <div key={index} className="min-w-0 [&>button]:w-full">
          {renderNode(child)}
        </div>
      ))}
    </div>
  ),
  Card: ({ props, renderNode }) => (
    <Card title={props.title} headingLevel={3}>
      <div className="flex flex-col gap-3">
        {props.children.map((child, index) => (
          <div key={index}>{renderNode(child)}</div>
        ))}
      </div>
    </Card>
  ),
  Text: ({ props }) => {
    const variant = props.variant ?? 'body';
    return variant === 'display' ? (
      <Text
        as="p"
        variant="h2"
        aria-live="polite"
        className="rounded-sm border border-divider bg-surface px-3 py-2 text-right font-mono tabular-nums"
      >
        {show(props.value)}
      </Text>
    ) : (
      <Text
        as="p"
        variant={variant === 'title' ? 'h4' : variant}
        tone={props.tone ?? 'default'}
        className="whitespace-pre-wrap"
      >
        {show(props.value)}
      </Text>
    );
  },
  Stat: ({ props }) => (
    <div className="flex flex-col">
      <Text variant="kicker" tone="muted">
        {props.label}
      </Text>
      <Text as="p" variant="h3" aria-live="polite" className="tabular-nums">
        {show(props.value)}
        {props.unit ? (
          <Text as="span" variant="body" tone="muted">
            {` ${props.unit}`}
          </Text>
        ) : null}
      </Text>
    </div>
  ),
  Button: ({ props }) => {
    const trigger = useTriggerAction();
    const streaming = useIsStreaming();
    const formName = useFormName();
    const form = useFormValidation();
    return (
      <Button
        variant={props.variant ?? 'secondary'}
        disabled={streaming}
        onClick={() => {
          // Inside a Form the button is its submit: nothing runs until every rule passes.
          if (form && !form.validateForm()) return;
          // The schema's legacy shape types `params` as optional-undefined; the runtime reads both.
          void trigger(props.label, formName, props.action as Parameters<typeof trigger>[2]);
        }}
      >
        {props.label}
      </Button>
    );
  },
  NumberInput: ({ props }) => {
    const field = useStateField(props.label, props.value);
    const error = useRules(props.label, props.rules, field.value);
    return (
      <Field label={props.label} error={error} required={props.rules?.required === true}>
        {(control) => (
          <Input
            {...control}
            type="number"
            inputMode="decimal"
            min={props.min}
            max={props.max}
            step={props.step ?? 'any'}
            value={
              typeof field.value === 'number' && Number.isFinite(field.value) ? field.value : ''
            }
            onChange={(event) => {
              const next = event.currentTarget.valueAsNumber;
              field.setValue(Number.isNaN(next) ? 0 : next);
            }}
          />
        )}
      </Field>
    );
  },
  TextInput: ({ props }) => {
    const field = useStateField(props.label, props.value);
    const error = useRules(props.label, props.rules, field.value);
    return (
      <Field label={props.label} error={error} required={props.rules?.required === true}>
        {(control) => (
          <Input
            {...control}
            placeholder={props.placeholder}
            value={typeof field.value === 'string' ? field.value : ''}
            onChange={(event) => {
              field.setValue(event.currentTarget.value);
            }}
          />
        )}
      </Field>
    );
  },
  TextArea: ({ props }) => {
    const field = useStateField(props.label, props.value);
    const error = useRules(props.label, props.rules, field.value);
    return (
      <Field label={props.label} error={error} required={props.rules?.required === true}>
        {(control) => (
          <Textarea
            {...control}
            rows={props.rows ?? 4}
            value={typeof field.value === 'string' ? field.value : ''}
            onChange={(event) => {
              field.setValue(event.currentTarget.value);
            }}
          />
        )}
      </Field>
    );
  },
  Select: ({ props }) => {
    const field = useStateField(props.label, props.value);
    const error = useRules(props.label, props.rules, field.value);
    return (
      <Field label={props.label} error={error} required={props.rules?.required === true}>
        {(control) => (
          <Select
            {...control}
            value={typeof field.value === 'string' ? field.value : ''}
            onChange={(event) => {
              field.setValue(event.currentTarget.value);
            }}
          >
            {list(props.options).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
    );
  },
  Slider: ({ props }) => {
    const field = useStateField(props.label, props.value);
    const value = typeof field.value === 'number' ? field.value : props.min;
    return (
      <Field label={`${props.label}: ${show(value)}`}>
        {(control) => (
          <input
            {...control}
            type="range"
            className="w-full accent-[var(--color-accent)]"
            min={props.min}
            max={props.max}
            step={props.step ?? 1}
            value={value}
            onChange={(event) => {
              field.setValue(event.currentTarget.valueAsNumber);
            }}
          />
        )}
      </Field>
    );
  },
  Toggle: ({ props }) => {
    // A bound $variable starts as null until set, whatever the schema says.
    const field = useStateField(props.label, props.value as unknown);
    // An unticked box reads as empty, so `required` means "must be ticked".
    const error = useRules(props.label, props.rules, field.value === true ? true : null);
    return (
      <div className="flex flex-col gap-1">
        <Checkbox
          label={props.label}
          checked={field.value === true}
          onChange={(event) => {
            field.setValue(event.currentTarget.checked);
          }}
        />
        {error ? (
          <Text variant="note" role="alert">
            {error}
          </Text>
        ) : null}
      </div>
    );
  },
  Form: ({ props, renderNode }) => <OpenUiForm {...props} renderNode={renderNode} />,
  Table: ({ props }) => {
    const rows = list(props.rows).map((cells, index) => ({ cells: list(cells), index }));
    const columns: TableColumn<(typeof rows)[number]>[] = list(props.columns).map(
      (header, column) => ({
        key: String(column),
        header,
        rowHeader: column === 0,
        cell: (row) => show(row.cells[column]),
      }),
    );
    return (
      <Table
        caption={props.caption ?? 'Table'}
        columns={columns}
        rows={rows}
        rowKey={(row) => String(row.index)}
        emptyMessage="No rows."
      />
    );
  },
  Chart: ({ props }) => <OpenUiChart {...props} />,
  ItemList: ({ props }) => <OpenUiItemList {...props} />,
};

function OpenUiForm({
  name,
  submit,
  fields,
  renderNode,
}: ContractProps<'Form'> & { readonly renderNode: (value: unknown) => ReactNode }): ReactNode {
  const validation = useCreateFormValidation();
  return (
    <FormNameContext.Provider value={name}>
      <FormValidationContext.Provider value={validation}>
        <form
          aria-label={name}
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
          }}
        >
          {fields.map((field, index) => (
            <div key={index}>{renderNode(field)}</div>
          ))}
          <div>{renderNode(submit)}</div>
        </form>
      </FormValidationContext.Provider>
    </FormNameContext.Provider>
  );
}

function OpenUiChart(props: ContractProps<'Chart'>): ReactNode {
  const labels = list(props.labels);
  const given = list(props.series);
  const series = given.map((entry, index) => ({
    key: String(index),
    label: entry.label,
    values: labels.map((_, bucket) => Math.max(0, list(entry.values)[bucket] ?? 0)),
    style: seriesStyle(index, false),
  }));
  const axis = { labels: labels, shortLabels: labels, whole: false };
  return (
    <figure className="flex min-w-0 flex-col gap-3">
      {props.kind === 'pie' ? (
        <PieChart
          slices={labels.map((label, index) => ({
            key: String(index),
            label,
            value: series[0]?.values[index] ?? 0,
            style: seriesStyle(index, false),
          }))}
        />
      ) : props.kind === 'line' ? (
        <LineChart {...axis} series={series} area={false} stacked={false} />
      ) : (
        <ColumnChart {...axis} series={series} stacked={false} />
      )}
      <ChartTable
        caption={props.caption}
        rowHeader=""
        rows={labels.map((label, index) => ({ key: String(index), label }))}
        columns={given.map((entry, index) => ({
          key: String(index),
          label: entry.label,
          values: entry.values,
        }))}
      />
    </figure>
  );
}

function OpenUiItemList(props: ContractProps<'ItemList'>): ReactNode {
  const workspaceIds = useContext(OpenUiScope);
  const items = list(props.items);
  if (items.length === 0)
    return (
      <Text variant="note" tone="muted">
        {props.empty ?? 'Nothing found.'}
      </Text>
    );
  return (
    <ul aria-label="Items" className="flex flex-col divide-y divide-divider">
      {items.map((item, index) => {
        const workspaceId = item.workspaceId ?? workspaceIds[0] ?? '';
        // Links stay inside the block's own workspaces, the rule assistant text links follow.
        const linkable = UUID.test(item.id) && workspaceIds.includes(workspaceId);
        return (
          <li key={index} className="flex items-center justify-between gap-2 py-2">
            {linkable ? (
              <Link to={`/w/${workspaceId}?item=${item.id}`} className="min-w-0 truncate underline">
                {item.title || 'Untitled'}
              </Link>
            ) : (
              <Text as="span" className="min-w-0 truncate">
                {item.title || 'Untitled'}
              </Text>
            )}
            {item.type ? (
              <Text as="span" variant="caption" tone="muted">
                {item.type}
              </Text>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function bind<T extends z.ZodObject>(
  name: ContractName,
  contract: { readonly description: string; readonly props: T },
  component: ComponentRenderer<z.infer<T>>,
) {
  // Out of design mode this is the renderer itself plus one context read; in it, a selectable frame.
  const Framed: ComponentRenderer<z.infer<T>> = (args) => {
    const design = useContext(OpenUiDesign);
    // Every renderer here is synchronous; the type allows an async one.
    const body = component(args) as ReactNode;
    return design !== null && args.statementId !== undefined ? (
      <DesignFrame design={design} id={args.statementId} type={name} container={isContainer(name)}>
        {body}
      </DesignFrame>
    ) : (
      body
    );
  };
  return defineComponent({
    name,
    description: contract.description,
    props: contract.props,
    component: Framed,
  });
}

export const nixLibrary = createLibrary({
  root: 'Stack',
  functions: NIX_FUNCTIONS,
  components: [
    bind('Stack', CONTRACTS.Stack, renderers.Stack),
    bind('Row', CONTRACTS.Row, renderers.Row),
    bind('Grid', CONTRACTS.Grid, renderers.Grid),
    bind('Card', CONTRACTS.Card, renderers.Card),
    bind('Text', CONTRACTS.Text, renderers.Text),
    bind('Stat', CONTRACTS.Stat, renderers.Stat),
    bind('Button', CONTRACTS.Button, renderers.Button),
    bind('NumberInput', CONTRACTS.NumberInput, renderers.NumberInput),
    bind('TextInput', CONTRACTS.TextInput, renderers.TextInput),
    bind('TextArea', CONTRACTS.TextArea, renderers.TextArea),
    bind('Select', CONTRACTS.Select, renderers.Select),
    bind('Slider', CONTRACTS.Slider, renderers.Slider),
    bind('Toggle', CONTRACTS.Toggle, renderers.Toggle),
    bind('Table', CONTRACTS.Table, renderers.Table),
    bind('Chart', CONTRACTS.Chart, renderers.Chart),
    bind('ItemList', CONTRACTS.ItemList, renderers.ItemList),
    bind('Form', CONTRACTS.Form, renderers.Form),
  ],
});
