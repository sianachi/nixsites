import { Button, Segmented } from '@nix/ui';
import { ensureWorkflowFields } from '@nix/web-collections/core/workflow-fields';
import { useState, type ReactNode } from 'react';
import type { ViewRendererProps } from '../core/view-kinds';
import { FormView } from './form-view';
import { InteractiveFormView } from './interactive-form-view';
import { SubmissionsQueue } from './submissions-queue';
import { FORM_SOURCE, SUBMISSION_ASSIGNEE, SUBMISSION_STATUS } from './submission-fields';

const TABS = [
  { value: 'form', label: 'Form' },
  { value: 'submissions', label: 'Submissions' },
] as const;

export function FormWithSubmissions(props: ViewRendererProps): ReactNode {
  const { container, view, onOpen } = props;
  const [tab, setTab] = useState<'form' | 'submissions'>('form');
  const Renderer = view.kind === 'interactive_form' ? InteractiveFormView : FormView;
  if (view.mode === 'temporary' || container.itemId === null) return <Renderer {...props} />;
  const schema = container.schema;
  const publicFields =
    schema === null
      ? null
      : {
          ...schema,
          properties: schema.properties.filter(
            (field) =>
              field.key !== FORM_SOURCE.key &&
              field.key !== SUBMISSION_STATUS.key &&
              (view.columns.includes(field.key) || field.label !== SUBMISSION_ASSIGNEE.label),
          ),
        };
  const withSource = {
    ...container,
    schema: publicFields,
    create: async (...args: Parameters<typeof container.create>) => {
      const [title, properties, onCreated] = args;
      const refusal = await ensureWorkflowFields(container, [FORM_SOURCE]);
      return container.create(
        title,
        refusal === null ? { ...properties, [FORM_SOURCE.key]: view.id } : properties,
        onCreated,
      );
    },
  };
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label="Form workspace" options={TABS} value={tab} onChange={setTab} />
        {tab === 'submissions' && container.refreshError !== null ? (
          <Button variant="secondary" onClick={() => void container.reload()}>
            Retry refresh
          </Button>
        ) : null}
      </div>
      <div hidden={tab !== 'form'}>
        <Renderer {...props} container={withSource} />
      </div>
      {tab === 'submissions' ? (
        <SubmissionsQueue container={container} view={view} onOpen={onOpen} />
      ) : null}
    </div>
  );
}
