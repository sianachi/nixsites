import { useState, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { within } from '@testing-library/dom';

import type {
  InteractiveFormDefinition,
  PropertyDefinition,
  View,
} from '../../collections/core/container-model';
import { storyContainer } from '../../collections/core/story-container';
import { FormView } from './form-view';
import { InteractiveFormEditor } from './interactive-form-editor';
import { InteractiveFormView } from './interactive-form-view';

export default { title: 'Nix/Views/Forms', parameters: { layout: 'padded' } };

const SCHEMA: readonly PropertyDefinition[] = [
  { key: 'mood', label: 'Mood', type: 'select', options: ['Good', 'Low'], required: true },
  {
    key: 'reflection',
    label: 'What would help tomorrow?',
    type: 'text',
    options: [],
    required: false,
  },
];

const FORM: InteractiveFormDefinition = {
  pages: [
    {
      id: 'first',
      title: 'Check in',
      description: 'Take a moment to reflect.',
      visibleWhen: [],
      blocks: [
        {
          id: 'mood',
          kind: 'field',
          propertyKey: 'mood',
          text: 'How was today?',
          help: null,
          required: true,
          identityRole: null,
          visibleWhen: [],
        },
      ],
    },
    {
      id: 'second',
      title: 'A plan for tomorrow',
      description: null,
      visibleWhen: [],
      blocks: [
        {
          id: 'reflection',
          kind: 'field',
          propertyKey: 'reflection',
          text: 'What would help tomorrow?',
          help: 'A small next step is enough.',
          required: false,
          identityRole: null,
          visibleWhen: [],
        },
      ],
    },
  ],
  titleMode: 'generated',
  titleFieldBlockId: null,
  confirmationTitle: 'Response received',
  confirmationMessage: 'Your reflection has been added.',
};

const VIEW: View = {
  id: 'form',
  name: 'Daily reflection',
  kind: 'form',
  columns: [],
  groupBy: null,
  groupOrder: [],
  rowBy: null,
  dateProperty: null,
  sortBy: null,
  sortDescending: false,
  mode: null,
  coverProperty: null,
  endDateProperty: null,
  cardSize: null,
  layout: null,
  filters: [],
};

function EntryFormExample(): ReactNode {
  return (
    <MemoryRouter>
      <section aria-label="Narrow form view" className="w-64 max-w-full">
        <FormView container={storyContainer([], SCHEMA)} view={VIEW} onOpen={() => undefined} />
      </section>
    </MemoryRouter>
  );
}

function InteractiveFormExample(): ReactNode {
  return (
    <MemoryRouter>
      <section aria-label="Narrow form view" className="w-64 max-w-full">
        <InteractiveFormView
          container={storyContainer([], SCHEMA)}
          view={{ ...VIEW, kind: 'interactive_form', interactiveForm: FORM }}
          onOpen={() => undefined}
        />
      </section>
    </MemoryRouter>
  );
}

function CompactDesignerExample(): ReactNode {
  const [form, setForm] = useState(FORM);
  return (
    <MemoryRouter>
      <section aria-label="Narrow form view" className="w-64 max-w-full">
        <InteractiveFormEditor
          form={form}
          schema={SCHEMA}
          itemId={null}
          viewId={VIEW.id}
          onChange={setForm}
          showPublishing={false}
        />
      </section>
    </MemoryRouter>
  );
}

function TemporaryCalculatorExample(): ReactNode {
  const fields: PropertyDefinition[] = [
    { key: 'sessions', label: 'Sessions completed', type: 'number', required: true, options: [] },
    { key: 'minutes', label: 'Minutes per session', type: 'number', required: true, options: [] },
    {
      key: 'total',
      label: 'Total training minutes',
      type: 'formula',
      expression: '[sessions] * [minutes]',
      required: false,
      options: [],
    },
  ];
  return (
    <MemoryRouter>
      <section aria-label="Narrow form view" className="w-64 max-w-full">
        <FormView
          container={storyContainer([], fields)}
          view={{ ...VIEW, mode: 'temporary', name: 'Training calculator' }}
          onOpen={() => undefined}
        />
      </section>
    </MemoryRouter>
  );
}

function checkNarrowForm({ canvasElement }: { readonly canvasElement: HTMLElement }): void {
  const region = within(canvasElement).getByRole('region', { name: 'Narrow form view' });
  if (region.scrollWidth > region.clientWidth) {
    throw new Error('Form fields and designer controls must fit within a narrow pane.');
  }
}

export const EntryForm = { render: EntryFormExample, play: checkNarrowForm };
export const InteractiveForm = { render: InteractiveFormExample, play: checkNarrowForm };
export const CompactDesigner = { render: CompactDesignerExample, play: checkNarrowForm };
export const TemporaryCalculator = { render: TemporaryCalculatorExample, play: checkNarrowForm };
export const DarkEntryForm = { ...EntryForm, globals: { ground: 'dark' } };
export const DarkInteractiveForm = { ...InteractiveForm, globals: { ground: 'dark' } };
export const DarkCompactDesigner = { ...CompactDesigner, globals: { ground: 'dark' } };
