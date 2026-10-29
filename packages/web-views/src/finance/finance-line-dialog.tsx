import { Button, Dialog, Field, Input, Select, Text } from '@nix/ui';
import type { BudgetLine, BudgetLineInput, Finance } from '@nix/api-client';
import { useState, type SyntheticEvent, type ReactNode } from 'react';
import { WriteError } from './finance-shared';
import { parseAmount } from './money';
import type { FinanceState } from './use-finance';

interface LineDialogProps {
  readonly state: FinanceState;
  readonly finance: Finance;
  /** The line to edit, or null to add one. */
  readonly line: BudgetLine | null;
  readonly open: boolean;
  readonly onClose: () => void;
}

export function LineDialog(props: LineDialogProps): ReactNode {
  return props.open ? <LineForm {...props} /> : null;
}

function LineForm({ state, finance, line, onClose }: LineDialogProps): ReactNode {
  const spendable = finance.accounts.filter(
    (account) => account.type !== 'loan' && !account.archived,
  );
  const loans = finance.accounts.filter((account) => account.type === 'loan' && !account.archived);
  const sections = [...new Set(finance.lines.map((candidate) => candidate.section))];
  const [name, setName] = useState(line?.name ?? '');
  const [section, setSection] = useState(line?.section ?? '');
  const [flow, setFlow] = useState<'income' | 'expense'>(line?.flow ?? 'expense');
  const [accountId, setAccountId] = useState(line?.accountId ?? spendable[0]?.id ?? '');
  const [amount, setAmount] = useState(String(line?.amount ?? 0));
  const [scheduled, setScheduled] = useState(line?.scheduled ?? false);
  const [dueDay, setDueDay] = useState(String(line?.dueDay ?? 1));
  const [loanAccount, setLoanAccount] = useState(line?.loanAccount ?? '');
  const [archived, setArchived] = useState(line?.archived ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    const planned = parseAmount(amount);
    if (planned === null) {
      setError('The planned amount must be an amount.');
      return;
    }
    const day = Number(dueDay);
    const input: BudgetLineInput = {
      name: name.trim(),
      section: section.trim(),
      flow,
      accountId,
      amount: planned,
      overrides: line?.overrides ?? null,
      scheduled,
      dueDay: scheduled ? (Number.isInteger(day) ? day : null) : null,
      loanAccount: loanAccount === '' ? null : loanAccount,
      archived,
    };
    setBusy(true);
    const refusal =
      line === null ? await state.createLine(input) : await state.setLine(line.id, input);
    setBusy(false);
    setError(refusal);
    if (refusal === null) onClose();
  };

  return (
    <Dialog
      open
      title={line === null ? 'Add a budget line' : `Edit ${line.name}`}
      onClose={onClose}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <Field label="Name" hint="Rent, Groceries, Salary.">
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
        <Field label="Section" hint="The heading it sits under: Housing, Commitments, Income.">
          {(control) => (
            <>
              <Input
                {...control}
                list="finance-line-sections"
                value={section}
                onChange={(event) => {
                  setSection(event.target.value);
                }}
              />
              <datalist id="finance-line-sections">
                {sections.map((known) => (
                  <option key={known} value={known} />
                ))}
              </datalist>
            </>
          )}
        </Field>
        <Field label="Flow">
          {(control) => (
            <Select
              {...control}
              value={flow}
              onChange={(event) => {
                setFlow(event.target.value === 'income' ? 'income' : 'expense');
              }}
            >
              <option value="expense">Expense</option>
              <option value="income">Income</option>
            </Select>
          )}
        </Field>
        <Field label={flow === 'income' ? 'Paid into' : 'Paid from'}>
          {(control) => (
            <Select
              {...control}
              value={accountId}
              onChange={(event) => {
                setAccountId(event.target.value);
              }}
            >
              {spendable.length === 0 ? <option value="">Add an account first</option> : null}
              {spendable.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {flow === 'expense' && loans.length > 0 ? (
          <Field
            label="Loan repayment for"
            hint="When set, the plan is that loan's payment plus overpayment."
          >
            {(control) => (
              <Select
                {...control}
                value={loanAccount}
                onChange={(event) => {
                  setLoanAccount(event.target.value);
                }}
              >
                <option value="">Not a loan repayment</option>
                {loans.map((loan) => (
                  <option key={loan.id} value={loan.id}>
                    {loan.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        {loanAccount === '' ? (
          <Field label="Planned amount each month" hint="Change one month from the Budget page.">
            {(control) => (
              <Input
                {...control}
                inputMode="decimal"
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value);
                }}
              />
            )}
          </Field>
        ) : null}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={scheduled}
            onChange={(event) => {
              setScheduled(event.target.checked);
            }}
          />
          <Text as="span" variant="bodySmall">
            Leaves on its own, as a direct debit or subscription; post it from the plan
          </Text>
        </label>
        {scheduled ? (
          <Field label="Day of the month it goes out">
            {(control) => (
              <Input
                {...control}
                type="number"
                min={1}
                max={31}
                value={dueDay}
                onChange={(event) => {
                  setDueDay(event.target.value);
                }}
              />
            )}
          </Field>
        ) : null}
        {line === null ? null : (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={archived}
              onChange={(event) => {
                setArchived(event.target.checked);
              }}
            />
            <Text as="span" variant="bodySmall">
              Archived: planned no further, transactions still count
            </Text>
          </label>
        )}
        <WriteError message={error} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {line === null ? 'Add line' : 'Save'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
