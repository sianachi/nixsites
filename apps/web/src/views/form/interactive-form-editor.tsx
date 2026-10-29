import { Button, Field, Input, Select, Text, Textarea } from '@nix/ui';
import { Plus, ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { Icon } from '@nix/ui';
import { useState, type ReactNode } from 'react';

import type {
  InteractiveFormDefinition,
  PropertyDefinition,
} from '../../collections/core/container-model';
import { BlockEditor } from './editor/block-editor';
import { PageConditions } from './editor/conditions';
import { move } from './editor/move';
import { InteractiveFormRespondentPreview } from './editor/preview';
import { PublishingControls } from './editor/publishing-controls';
import { normalizeInteractiveForm } from './interactive-form-rules';

export { InteractiveFormRespondentPreview };

export const EMPTY_INTERACTIVE_FORM: InteractiveFormDefinition = {
  pages: [
    {
      id: 'page-1',
      title: 'Your response',
      description: null,
      visibleWhen: [],
      blocks: [],
    },
  ],
  titleMode: 'generated',
  titleFieldBlockId: null,
  confirmationTitle: 'Response received',
  confirmationMessage: 'Your response has been added.',
};

export function InteractiveFormEditor({
  form,
  schema,
  itemId,
  viewId,
  onChange,
  showPublishing = true,
}: {
  readonly form: InteractiveFormDefinition;
  readonly schema: readonly PropertyDefinition[];
  readonly itemId: string | null;
  readonly viewId: string;
  readonly onChange: (form: InteractiveFormDefinition) => void;
  readonly showPublishing?: boolean;
}): ReactNode {
  const [previewing, setPreviewing] = useState(false);
  const fields = form.pages
    .flatMap((page) => page.blocks)
    .filter((block) => block.kind === 'field');

  function commit(next: InteractiveFormDefinition): void {
    onChange(normalizeInteractiveForm(next, schema));
  }

  function updatePage(
    index: number,
    change: Partial<InteractiveFormDefinition['pages'][number]>,
  ): void {
    commit({
      ...form,
      pages: form.pages.map((page, position) =>
        position === index ? { ...page, ...change } : page,
      ),
    });
  }

  return (
    <section
      aria-label="Interactive form designer"
      className="@container flex min-w-0 flex-col gap-3 border-l-2 border-accent pl-2 sm:pl-3"
    >
      <div>
        <Text variant="h4" as="h3" className="wrap-anywhere">
          Form flow
        </Text>
        <Text variant="note" tone="muted">
          Conditions use answers from earlier fields.
        </Text>
      </div>
      <Button
        variant="secondary"
        className="self-start"
        onClick={() => {
          setPreviewing((current) => !current);
        }}
      >
        {previewing ? 'Close preview' : 'Preview'}
      </Button>
      {previewing ? <InteractiveFormRespondentPreview form={form} schema={schema} /> : null}

      {form.pages.map((page, pageIndex) => (
        <div key={page.id} className="flex min-w-0 flex-col gap-2 border border-divider p-3">
          <div className="flex flex-wrap items-end gap-2">
            <Field
              label={`Page ${String(pageIndex + 1)} title`}
              className="min-w-full @md:min-w-0 @md:flex-1"
            >
              {(control) => (
                <Input
                  {...control}
                  value={page.title}
                  onChange={(event) => {
                    updatePage(pageIndex, { title: event.target.value });
                  }}
                />
              )}
            </Field>
            {form.pages.length === 1 ? null : (
              <>
                <Button
                  variant="icon"
                  disabled={pageIndex === 0}
                  aria-label={`Move ${page.title} up`}
                  onClick={() => {
                    commit({ ...form, pages: move(form.pages, pageIndex, -1) });
                  }}
                >
                  <Icon icon={ChevronUp} size="sm" />
                </Button>
                <Button
                  variant="icon"
                  disabled={pageIndex === form.pages.length - 1}
                  aria-label={`Move ${page.title} down`}
                  onClick={() => {
                    commit({ ...form, pages: move(form.pages, pageIndex, 1) });
                  }}
                >
                  <Icon icon={ChevronDown} size="sm" />
                </Button>
                <Button
                  variant="icon"
                  aria-label={`Remove ${page.title}`}
                  onClick={() => {
                    commit({
                      ...form,
                      pages: form.pages.filter((_, index) => index !== pageIndex),
                    });
                  }}
                >
                  <Icon icon={Trash2} size="sm" />
                </Button>
              </>
            )}
          </div>
          <Field label="Introduction">
            {(control) => (
              <Textarea
                rows={3}
                {...control}
                value={page.description ?? ''}
                onChange={(event) => {
                  updatePage(pageIndex, { description: event.target.value || null });
                }}
              />
            )}
          </Field>
          <PageConditions
            conditions={page.visibleWhen}
            earlier={form.pages
              .slice(0, pageIndex)
              .flatMap((entry) => entry.blocks)
              .filter((entry) => entry.kind === 'field')}
            onChange={(visibleWhen) => {
              updatePage(pageIndex, { visibleWhen });
            }}
          />

          {page.blocks.map((block, blockIndex) => (
            <BlockEditor
              key={block.id}
              block={block}
              schema={schema}
              earlier={form.pages
                .slice(0, pageIndex)
                .flatMap((entry) => entry.blocks)
                .concat(page.blocks.slice(0, blockIndex))
                .filter((entry) => entry.kind === 'field')}
              onChange={(next) => {
                updatePage(pageIndex, {
                  blocks: page.blocks.map((entry, index) => (index === blockIndex ? next : entry)),
                });
              }}
              onRemove={() => {
                updatePage(pageIndex, {
                  blocks: page.blocks.filter((_, index) => index !== blockIndex),
                });
              }}
              onMove={(by) => {
                updatePage(pageIndex, { blocks: move(page.blocks, blockIndex, by) });
              }}
              canMoveUp={blockIndex > 0}
              canMoveDown={blockIndex < page.blocks.length - 1}
            />
          ))}

          <div className="flex flex-wrap gap-2">
            {(['field', 'heading', 'paragraph'] as const).map((kind) => (
              <Button
                key={kind}
                variant="secondary"
                onClick={() => {
                  const id = `block-${crypto.randomUUID()}`;
                  updatePage(pageIndex, {
                    blocks: [
                      ...page.blocks,
                      {
                        id,
                        kind,
                        propertyKey: kind === 'field' ? (schema[0]?.key ?? null) : null,
                        text:
                          kind === 'field'
                            ? (schema[0]?.label ?? 'Question')
                            : kind === 'heading'
                              ? 'Section heading'
                              : 'Helpful context',
                        help: null,
                        required: false,
                        identityRole: null,
                        visibleWhen: [],
                      },
                    ],
                  });
                }}
              >
                <Icon icon={Plus} size="sm" /> Add {kind}
              </Button>
            ))}
          </div>
        </div>
      ))}

      <Button
        variant="secondary"
        className="self-start"
        onClick={() => {
          commit({
            ...form,
            pages: [
              ...form.pages,
              {
                id: `page-${crypto.randomUUID()}`,
                title: `Page ${String(form.pages.length + 1)}`,
                description: null,
                visibleWhen: [],
                blocks: [],
              },
            ],
          });
        }}
      >
        <Icon icon={Plus} size="sm" /> Add page
      </Button>

      <div className="grid min-w-0 grid-cols-1 gap-2 @xl:grid-cols-2">
        <Field label="Response title">
          {(control) => (
            <Select
              {...control}
              value={form.titleMode === 'field' ? (form.titleFieldBlockId ?? '') : ''}
              onChange={(event) => {
                commit({
                  ...form,
                  titleMode: event.target.value ? 'field' : 'generated',
                  titleFieldBlockId: event.target.value || null,
                });
              }}
            >
              <option value="">Generate from form and time</option>
              {fields.map((field) => (
                <option key={field.id} value={field.id}>
                  Use “{field.text}”
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Confirmation heading">
          {(control) => (
            <Input
              {...control}
              value={form.confirmationTitle}
              onChange={(event) => {
                commit({ ...form, confirmationTitle: event.target.value });
              }}
            />
          )}
        </Field>
      </div>
      <Field label="Confirmation message">
        {(control) => (
          <Textarea
            rows={3}
            {...control}
            value={form.confirmationMessage}
            onChange={(event) => {
              commit({ ...form, confirmationMessage: event.target.value });
            }}
          />
        )}
      </Field>
      {showPublishing ? <PublishingControls itemId={itemId} viewId={viewId} /> : null}
    </section>
  );
}
