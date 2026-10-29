import { describe, expect, it, vi } from 'vitest';

import { reportFormValidity } from '../../../form/form-validity';

function formInput(
  type: string,
  value: string,
): { form: HTMLFormElement; input: HTMLInputElement } {
  const form = document.createElement('form');
  const input = document.createElement('input');
  input.type = type;
  input.value = value;
  form.append(input);
  document.body.append(form);
  return { form, input };
}

describe('native form format validation', () => {
  it('leaves missing required values to the form feedback', () => {
    const { form, input } = formInput('text', '');
    input.required = true;
    expect(input.validity.valueMissing).toBe(true);
    expect(reportFormValidity(form)).toBe(true);
    form.remove();
  });

  it('reports invalid URLs and focuses their control', () => {
    const { form, input } = formInput('url', 'invalid address');
    const report = vi.spyOn(input, 'reportValidity');
    expect(reportFormValidity(form)).toBe(false);
    expect(report).toHaveBeenCalledOnce();
    expect(input).toHaveFocus();
    form.remove();
  });

  it('retains number step validation', () => {
    const { form, input } = formInput('number', '1.5');
    input.step = '1';
    expect(input.validity.stepMismatch).toBe(true);
    expect(reportFormValidity(form)).toBe(false);
    input.step = 'any';
    expect(reportFormValidity(form)).toBe(true);
    form.remove();
  });

  it('retains custom validity even alongside a missing required value', () => {
    const { form, input } = formInput('text', '');
    input.required = true;
    input.setCustomValidity('Choose a supported answer.');
    expect(reportFormValidity(form)).toBe(false);
    form.remove();
  });
});
