import type { PropertyDefinition } from '@nix/web-collections/core/container-model';

export const FORM_SOURCE: PropertyDefinition = {
  key: 'nix_submission_form',
  label: 'Submission form',
  type: 'text',
  options: [],
  required: false,
};
export const SUBMISSION_STATUS: PropertyDefinition = {
  key: 'nix_submission_status',
  label: 'Review status',
  type: 'select',
  options: ['New', 'In review', 'Reviewed', 'Follow-up'],
  required: false,
};
export const SUBMISSION_ASSIGNEE: PropertyDefinition = {
  key: 'assignee',
  label: 'Assigned reviewer',
  type: 'assignee',
  options: [],
  required: false,
};
export const SUBMISSION_COMPLETION: PropertyDefinition = {
  key: 'completion',
  label: 'Complete',
  type: 'completion',
  options: [],
  required: false,
};
