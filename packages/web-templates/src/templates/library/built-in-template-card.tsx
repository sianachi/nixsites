import { Blueprint, Button, Icon, Text } from '@nix/ui';
import { LayoutTemplate } from 'lucide-react';
import type { ReactNode } from 'react';

import { ViewPreviewImage } from '../template-view-preview';
import type { BuiltInTemplate } from './built-in-catalog';

export function BuiltInTemplateCard({
  template,
  adding,
  disabled,
  onUse,
}: {
  readonly template: BuiltInTemplate;
  readonly adding: boolean;
  readonly disabled: boolean;
  readonly onUse: () => void;
}): ReactNode {
  const views = template.viewKinds.length;
  return (
    <div role="group" aria-label={`${template.name} template`} className="min-w-0">
      <Blueprint as="section" className="flex min-w-0 flex-col gap-3 bg-surface p-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Text variant="h4" as="h2">
            {template.name}
          </Text>
          <div className="flex flex-wrap gap-x-2">
            <Text variant="caption" tone="muted">
              Built in
            </Text>
            <Text variant="caption" tone="muted">
              {`${String(views)} ${views === 1 ? 'view' : 'views'} · ${String(template.itemCount)} ${template.itemCount === 1 ? 'item' : 'items'}`}
            </Text>
          </div>
          <Text variant="bodySmall" tone="muted" lines={2}>
            {template.description}
          </Text>
        </div>
        {template.preview === null ? null : (
          <ViewPreviewImage title={template.name} {...template.preview} />
        )}
        <Text variant="caption" tone="muted">
          Adds this template to the workspace library.
        </Text>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            aria-label={`Add and use ${template.name} template`}
            className="w-full sm:w-auto"
            disabled={disabled}
            onClick={onUse}
          >
            <Icon icon={LayoutTemplate} size="sm" /> {adding ? 'Adding…' : 'Add and use template'}
          </Button>
        </div>
      </Blueprint>
    </div>
  );
}
