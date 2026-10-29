/** Keep native format checks while each form supplies its own required-field feedback. */
export function reportFormValidity(form: HTMLFormElement | null): boolean {
  for (const control of form?.elements ?? []) {
    if (!(
      control instanceof HTMLInputElement ||
      control instanceof HTMLSelectElement ||
      control instanceof HTMLTextAreaElement
    ))
      continue;
    const validity = control.validity;
    if (!validity.valid && (!validity.valueMissing || validity.badInput || validity.customError)) {
      control.reportValidity();
      control.focus();
      return false;
    }
  }
  return true;
}
