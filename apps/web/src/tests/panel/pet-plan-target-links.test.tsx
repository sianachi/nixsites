import type { PetPlanPreparedStep } from '@nix/api-client';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { PetPlanTargetLinks } from '../../panel/pet-plan-preview';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const templateId = '22222222-2222-4222-8222-222222222222';
const itemId = '33333333-3333-4333-8333-333333333333';
const parentId = '44444444-4444-4444-8444-444444444444';
function step(capability: string, args: PetPlanPreparedStep['arguments']): PetPlanPreparedStep {
  return {
    id: templateId,
    capability,
    arguments: args,
    executor: 'server',
    status: 'pending',
    fields: [],
    effect: { description: 'Review the prepared operation', parameters: {} },
  };
}

it.each(['workspace.read_template', 'workspace.apply_template'])(
  'reviews the template identity in %s without treating it as an item',
  (capability) => {
    render(
      <PetPlanTargetLinks
        workspaceId={workspaceId}
        step={step(capability, { itemId: templateId, parentId })}
      />,
    );
    expect(screen.getByRole('link', { name: 'Review template' })).toHaveAttribute(
      'href',
      `/w/${workspaceId}/templates/${templateId}/create`,
    );
    expect(screen.getByRole('link', { name: 'Inspect destination' })).toHaveAttribute(
      'href',
      `/w/${workspaceId}?item=${parentId}`,
    );
    expect(screen.queryByRole('link', { name: 'Inspect target item' })).not.toBeInTheDocument();
  },
);
it('keeps an item source distinct from an explicit template identity', () => {
  render(
    <PetPlanTargetLinks
      workspaceId={workspaceId}
      step={step('workspace.save_as_template', { itemId, templateId })}
    />,
  );
  expect(screen.getByRole('link', { name: 'Inspect target item' })).toHaveAttribute(
    'href',
    `/w/${workspaceId}?item=${itemId}`,
  );
  expect(screen.getByRole('link', { name: 'Review template' })).toHaveAttribute(
    'href',
    `/w/${workspaceId}/templates/${templateId}/create`,
  );
});
