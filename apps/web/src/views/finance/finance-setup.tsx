import { Button, Dialog, Field, Input } from '@nix/ui';
import type { Finance } from '@nix/api-client';
import { useState, type SyntheticEvent, type ReactNode } from 'react';
import { localTimeZone } from '@nix/web-foundation/lib/date-format';
import { WriteError } from './finance-shared';
import { parseAmount } from './money';
import type { FinanceState } from './use-finance';

// Three forms, one shape: local draft state, a submit that hands the draft to Core and shows
// what Core said if it refused. Validation lives on the server; these forms only turn typed
// text into numbers and refuse to send something that is not one.

function readerTimezone(): string {
  try {
    return localTimeZone();
  } catch {
    return 'UTC';
  }
}

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

interface SettingsDialogProps {
  readonly state: FinanceState;
  readonly finance: Finance | null;
  readonly open: boolean;
  readonly onClose: () => void;
}

// Each dialog mounts its form only while open, so the form's state starts from the record it
// was opened for and is thrown away on close; nothing has to be reset in an effect.
export function SettingsDialog(props: SettingsDialogProps): ReactNode {
  return props.open ? <SettingsForm {...props} /> : null;
}

function SettingsForm({ state, finance, onClose }: SettingsDialogProps): ReactNode {
  const settings = finance?.settings;
  const [currency, setCurrency] = useState(settings?.currency ?? 'GBP');
  const [startMonth, setStartMonth] = useState(settings?.startMonth ?? thisMonth());
  const [horizon, setHorizon] = useState(String(settings?.horizonMonths ?? 17));
  const [openingCash, setOpeningCash] = useState(String(settings?.openingCash ?? 0));
  const [emergency, setEmergency] = useState(String(settings?.emergencyFundMonths ?? 3));
  const [timezone, setTimezone] = useState(settings?.timezone ?? readerTimezone());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    const cash = parseAmount(openingCash);
    const months = Number(horizon);
    const buffer = Number(emergency);
    if (cash === null) {
      setError('Opening cash must be an amount.');
      return;
    }
    if (!Number.isInteger(months) || months < 1) {
      setError('The horizon is a whole number of months.');
      return;
    }
    if (!Number.isFinite(buffer) || buffer < 0) {
      setError('The emergency fund is a number of months.');
      return;
    }
    setBusy(true);
    const refusal = await state.setSettings({
      currency: currency.trim().toUpperCase(),
      startMonth,
      horizonMonths: months,
      openingCash: cash,
      emergencyFundMonths: buffer,
      timezone: timezone.trim(),
    });
    setBusy(false);
    setError(refusal);
    if (refusal === null) onClose();
  };

  return (
    <Dialog
      open
      title={finance === null ? 'Set up finances' : 'Finance settings'}
      onClose={onClose}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <Field label="Currency" hint="A three-letter code such as GBP.">
          {(control) => (
            <Input
              {...control}
              value={currency}
              maxLength={3}
              onChange={(event) => {
                setCurrency(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="First month of the plan" hint="Opening balances are as at the day before it.">
          {(control) => (
            <Input
              {...control}
              type="month"
              value={startMonth}
              onChange={(event) => {
                setStartMonth(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Months to plan" hint="How far the budget and the projection run.">
          {(control) => (
            <Input
              {...control}
              type="number"
              min={1}
              max={120}
              value={horizon}
              onChange={(event) => {
                setHorizon(event.target.value);
              }}
            />
          )}
        </Field>
        <Field
          label="Cash at the start"
          hint="Across current and savings accounts, before the first month's card bill goes out."
        >
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              value={openingCash}
              onChange={(event) => {
                setOpeningCash(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Emergency fund, in months of outgoings">
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              value={emergency}
              onChange={(event) => {
                setEmergency(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Timezone" hint="Where today is decided, such as Europe/London.">
          {(control) => (
            <Input
              {...control}
              value={timezone}
              onChange={(event) => {
                setTimezone(event.target.value);
              }}
            />
          )}
        </Field>
        <WriteError message={error} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {finance === null ? 'Create' : 'Save'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// Importers reach the account and line forms through this module.
export { AccountDialog, accountTypeLabel } from './finance-account-dialog';
export { LineDialog } from './finance-line-dialog';
