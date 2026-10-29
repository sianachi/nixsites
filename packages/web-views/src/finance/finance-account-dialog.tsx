import { Button, Dialog, Field, Input, Select, Text } from '@nix/ui';
import type {
  Finance,
  FinanceAccount,
  FinanceAccountInput,
  FinanceAccountType,
} from '@nix/api-client';
import { useState, type SyntheticEvent, type ReactNode } from 'react';
import { WriteError } from './finance-shared';
import { parseAmount } from './money';
import type { FinanceState } from './use-finance';

const ACCOUNT_TYPES: readonly { readonly value: FinanceAccountType; readonly label: string }[] = [
  { value: 'current', label: 'Current account' },
  { value: 'savings', label: 'Savings account' },
  { value: 'debit', label: 'Debit card or prepaid' },
  { value: 'credit_card', label: 'Credit card, paid in full' },
  { value: 'loan', label: 'Loan' },
];

export function accountTypeLabel(type: FinanceAccountType): string {
  return ACCOUNT_TYPES.find((option) => option.value === type)?.label ?? type;
}

interface AccountDialogProps {
  readonly state: FinanceState;
  readonly finance: Finance;
  /** The account to edit, or null to add one. */
  readonly account: FinanceAccount | null;
  readonly open: boolean;
  readonly onClose: () => void;
}

export function AccountDialog(props: AccountDialogProps): ReactNode {
  return props.open ? <AccountForm {...props} /> : null;
}

function AccountForm({ state, finance, account, onClose }: AccountDialogProps): ReactNode {
  const cashAccounts = finance.accounts.filter(
    (candidate) =>
      candidate.type !== 'credit_card' && candidate.type !== 'loan' && !candidate.archived,
  );
  const [name, setName] = useState(account?.name ?? '');
  const [type, setType] = useState<FinanceAccountType>(account?.type ?? 'current');
  const [limit, setLimit] = useState(account?.limit == null ? '' : String(account.limit));
  const [opening, setOpening] = useState(String(account?.openingBalance ?? 0));
  const [settlesFrom, setSettlesFrom] = useState(account?.settlesFrom ?? cashAccounts[0]?.id ?? '');
  const [apr, setApr] = useState(account?.apr == null ? '' : String(account.apr * 100));
  const [payment, setPayment] = useState(account?.payment == null ? '' : String(account.payment));
  const [overpayment, setOverpayment] = useState(String(account?.overpayment ?? 0));
  const [target, setTarget] = useState(account?.target == null ? '' : String(account.target));
  const [archived, setArchived] = useState(account?.archived ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    const openingBalance = parseAmount(opening);
    if (openingBalance === null) {
      setError('The opening balance must be an amount.');
      return;
    }
    const optional = (text: string): number | null =>
      text.trim() === '' ? null : parseAmount(text);
    const rate = apr.trim() === '' ? null : Number(apr) / 100;
    const input: FinanceAccountInput = {
      name: name.trim(),
      type,
      limit: type === 'credit_card' ? optional(limit) : null,
      openingBalance,
      settlesFrom: type === 'credit_card' ? (settlesFrom === '' ? null : settlesFrom) : null,
      apr:
        type === 'loan'
          ? rate === null || !Number.isFinite(rate)
            ? null
            : Math.round(rate * 1_000_000) / 1_000_000
          : null,
      payment: type === 'loan' ? optional(payment) : null,
      overpayment: type === 'loan' ? (optional(overpayment) ?? 0) : null,
      target: type === 'savings' ? optional(target) : null,
      archived,
    };
    setBusy(true);
    const refusal =
      account === null
        ? await state.createAccount(input)
        : await state.setAccount(account.id, input);
    setBusy(false);
    setError(refusal);
    if (refusal === null) onClose();
  };

  return (
    <Dialog
      open
      title={account === null ? 'Add an account' : `Edit ${account.name}`}
      onClose={onClose}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <Field label="Name">
          {(control) => (
            <Input
              {...control}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Type">
          {(control) => (
            <Select
              {...control}
              value={type}
              onChange={(event) => {
                setType(event.target.value as FinanceAccountType);
              }}
            >
              {ACCOUNT_TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label={
            type === 'credit_card'
              ? 'Statement balance carried into the first month'
              : type === 'loan'
                ? 'Balance owed at the start'
                : 'Balance at the start'
          }
          {...(type === 'credit_card'
            ? { hint: 'Collected in the first month of the plan.' }
            : type === 'loan'
              ? { hint: 'The day before the first month of the plan.' }
              : {})}
        >
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              value={opening}
              onChange={(event) => {
                setOpening(event.target.value);
              }}
            />
          )}
        </Field>
        {type === 'credit_card' ? (
          <>
            <Field label="Credit limit" hint="Drives the utilisation check; keep it under 30%.">
              {(control) => (
                <Input
                  {...control}
                  inputMode="decimal"
                  value={limit}
                  onChange={(event) => {
                    setLimit(event.target.value);
                  }}
                />
              )}
            </Field>
            <Field label="Paid in full from">
              {(control) => (
                <Select
                  {...control}
                  value={settlesFrom}
                  onChange={(event) => {
                    setSettlesFrom(event.target.value);
                  }}
                >
                  {cashAccounts.length === 0 ? (
                    <option value="">Add a current account first</option>
                  ) : null}
                  {cashAccounts.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </>
        ) : null}
        {type === 'loan' ? (
          <>
            <Field label="Annual rate, percent" hint="11 for eleven percent.">
              {(control) => (
                <Input
                  {...control}
                  inputMode="decimal"
                  value={apr}
                  onChange={(event) => {
                    setApr(event.target.value);
                  }}
                />
              )}
            </Field>
            <Field label="Standard monthly payment">
              {(control) => (
                <Input
                  {...control}
                  inputMode="decimal"
                  value={payment}
                  onChange={(event) => {
                    setPayment(event.target.value);
                  }}
                />
              )}
            </Field>
            <Field
              label="Overpayment each month"
              hint="Try a figure on the Accounts page before committing to it here."
            >
              {(control) => (
                <Input
                  {...control}
                  inputMode="decimal"
                  value={overpayment}
                  onChange={(event) => {
                    setOverpayment(event.target.value);
                  }}
                />
              )}
            </Field>
          </>
        ) : null}
        {type === 'savings' ? (
          <Field label="Saving towards" hint="Optional. Progress is shown against it.">
            {(control) => (
              <Input
                {...control}
                inputMode="decimal"
                value={target}
                onChange={(event) => {
                  setTarget(event.target.value);
                }}
              />
            )}
          </Field>
        ) : null}
        {account === null ? null : (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={archived}
              onChange={(event) => {
                setArchived(event.target.checked);
              }}
            />
            <Text as="span" variant="bodySmall">
              Archived: kept for history, offered nowhere new
            </Text>
          </label>
        )}
        <WriteError message={error} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {account === null ? 'Add account' : 'Save'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
