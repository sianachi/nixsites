import { createHash } from 'node:crypto';
import type { Page } from 'playwright';

import { BrowserFault, proposalSchema, type Attachment, type FormProposal } from './contracts.ts';
import { publicUrl } from './network.ts';

interface Control {
  readonly name: string;
  readonly kind: string;
  readonly required: boolean;
  readonly options?: readonly string[];
}

interface Form {
  readonly action: string;
  readonly method: string;
  readonly enctype: string;
  readonly controls: readonly Control[];
  readonly unsupported: boolean;
  readonly markup: string;
}

export type FormSummary =
  | { index: number; supported: false }
  | {
      index: number;
      supported: true;
      method: 'POST';
      target: string;
      enctype: string;
      revision: string;
      fields: Control[];
    };

const typedFields = new Set([
  'text',
  'email',
  'url',
  'tel',
  'number',
  'search',
  'textarea',
  'select',
]);

export function readForms(page: Page): Promise<Form[]> {
  return page.evaluate(() =>
    [...document.forms].slice(0, 20).map((form) => {
      const markup = form.outerHTML;
      let unsupported =
        markup.length > 65_536 ||
        form.elements.length > 30 ||
        (form.target !== '' && form.target !== '_self');
      const controls = [];
      for (const input of [...form.elements].slice(0, 30)) {
        if (!(input instanceof HTMLElement) || input.matches(':disabled')) continue;
        if (
          input instanceof HTMLButtonElement ||
          (input instanceof HTMLInputElement && ['button', 'reset', 'submit'].includes(input.type))
        ) {
          unsupported ||= [
            'formaction',
            'formmethod',
            'formenctype',
            'formtarget',
            'formnovalidate',
          ].some((attr) => input.hasAttribute(attr));
          unsupported ||= input.name.length > 0 && input.type === 'submit';
          continue;
        }
        if (input instanceof HTMLInputElement) {
          if (input.name.length === 0) {
            unsupported ||= input.required;
            continue;
          }
          unsupported ||= input.multiple || input.type === 'hidden';
          controls.push({
            name: input.name.slice(0, 129),
            kind: input.type,
            required: input.required,
          });
        } else if (input instanceof HTMLSelectElement) {
          if (input.name.length === 0) {
            unsupported ||= input.required;
            continue;
          }
          unsupported ||= input.multiple || input.options.length > 25;
          const options = [...input.options]
            .slice(0, 25)
            .filter((option) => !option.disabled && !option.closest('optgroup[disabled]'))
            .map((option) => option.value.slice(0, 257));
          controls.push({
            name: input.name.slice(0, 129),
            kind: 'select',
            required: input.required,
            options,
          });
        } else if (input instanceof HTMLTextAreaElement) {
          if (input.name.length === 0) {
            unsupported ||= input.required;
            continue;
          }
          controls.push({
            name: input.name.slice(0, 129),
            kind: 'textarea',
            required: input.required,
          });
        } else if (!(input instanceof HTMLFieldSetElement)) {
          unsupported = true;
        }
      }
      return {
        action: form.action.slice(0, 2049),
        method: form.method,
        enctype: form.enctype,
        controls,
        unsupported,
        markup: markup.slice(0, 65_537),
      };
    }),
  );
}

function eligible(form: Form, pageUrl: URL): URL {
  const target = publicUrl(form.action);
  if (
    form.unsupported ||
    form.method !== 'post' ||
    target.protocol !== 'https:' ||
    target.origin !== pageUrl.origin ||
    target.search ||
    !['application/x-www-form-urlencoded', 'multipart/form-data'].includes(form.enctype) ||
    form.controls.some(
      ({ name, kind, options }) =>
        name.length > 128 ||
        /^\s*$|\p{Cc}/u.test(name) ||
        (kind !== 'file' && !typedFields.has(kind)) ||
        options?.some((value) => value.length > 256),
    ) ||
    new Set(form.controls.map(({ name }) => name)).size !== form.controls.length
  ) {
    throw new BrowserFault('website_form_needs_takeover');
  }
  return target;
}

function formRevision(form: Form, page: string): string {
  return createHash('sha256').update(page).update(JSON.stringify(form)).digest('hex');
}

export function describeForms(forms: Form[], pageUrl: URL, page: string): FormSummary[] {
  return forms.map((form, index) => {
    try {
      const target = eligible(form, pageUrl);
      return {
        index,
        supported: true,
        method: 'POST',
        target: target.href,
        enctype: form.enctype,
        revision: formRevision(form, page),
        fields: [...form.controls],
      };
    } catch {
      return { index, supported: false };
    }
  });
}

export function prepareForm(
  form: Form | undefined,
  pageUrl: URL,
  page: string,
  index: number,
  fields: FormProposal['fields'],
  attachments: Attachment[],
): { proposal: FormProposal; enctype: string } {
  if (!form) throw new BrowserFault('website_form_missing');
  const target = eligible(form, pageUrl);
  const fieldValues = new Map(fields.map(({ name, value }) => [name, value]));
  const files = new Set(attachments.map(({ field }) => field));
  const controls = new Map(form.controls.map((control) => [control.name, control]));
  if (
    fieldValues.size !== fields.length ||
    files.size !== attachments.length ||
    (files.size !== 0 && form.enctype !== 'multipart/form-data') ||
    attachments.reduce((total, file) => total + file.size, 0) > 4 << 20 ||
    [...files].some((field) => controls.get(field)?.kind !== 'file')
  ) {
    throw new BrowserFault('website_fields_invalid');
  }
  for (const [name, value] of fieldValues) {
    const control = controls.get(name);
    if (
      !control ||
      !typedFields.has(control.kind) ||
      (control.required && value.trim() === '') ||
      (control.kind === 'select' && !control.options?.includes(value))
    ) {
      throw new BrowserFault('website_fields_invalid');
    }
  }
  if (
    form.controls.some(
      ({ name, kind, required }) =>
        required && (kind === 'file' ? !files.has(name) : !fieldValues.has(name)),
    )
  ) {
    throw new BrowserFault('website_fields_invalid');
  }
  const revision = formRevision(form, page);
  const proposal = proposalSchema.parse({
    pageUrl: pageUrl.href,
    target: target.href,
    method: 'POST',
    formIndex: index,
    fields,
    attachments,
    revision,
  });
  return { proposal, enctype: form.enctype };
}

export function sameProposal(actual: FormProposal, approved: FormProposal): boolean {
  return (
    actual.pageUrl === approved.pageUrl &&
    actual.target === approved.target &&
    actual.formIndex === approved.formIndex &&
    actual.revision === approved.revision &&
    JSON.stringify(actual.fields) === JSON.stringify(approved.fields) &&
    JSON.stringify(actual.attachments) === JSON.stringify(approved.attachments)
  );
}
