import { Blueprint, Button, Dialog, Field, Icon, Input, Text, fieldLabel } from '@nix/ui';
import { Copy } from 'lucide-react';
import { useRef, useState, type ReactElement, type ReactNode } from 'react';

import type { CreatedAccessToken, CreateTokenOutcome } from './use-access-tokens';

/**
 * The three scope spellings the API accepts, in the order the interface offers them.
 *
 * Restated here because `@nix/api-client`'s root barrel does not yet re-export its access-token
 * schema module, where `ACCESS_TOKEN_SCOPES` lives; when it grows that line, this constant folds
 * into an import. The server validates scopes regardless, so a drift here is a rejected mint
 * rendered honestly, never a token with a scope the API does not grant.
 */
const ACCESS_TOKEN_SCOPES = ['read', 'write', 'admin'] as const;

/**
 * Minting a token: the form, and then - once - the secret.
 *
 * The dialog has two faces and they are deliberately not two dialogs. The form collects the name,
 * the scopes and the expiry; a successful mint replaces it, in place, with the one and only
 * showing of the secret. Splitting them would let the secret surface be dismissed by an unmount
 * the form's owner did not mean, and this is the single worst place in the product to lose a
 * message: the server keeps only a hash, so a secret nobody copied is a token nobody can use.
 *
 * **Nothing is chosen for the person.** Scopes start unchecked and the expiry starts unpicked,
 * because both are security decisions: a default silently applied is a decision the person never
 * made about a credential that acts as them. The form refuses to submit until both are chosen,
 * and says which is missing.
 *
 * **Every close path reports whether a token was minted**, so the owner knows to refresh the
 * list. Escape, the backdrop, the corner close control and the primary Done button all funnel
 * through one dismissal; a dialog that only refreshed on its happy-path button would leave a
 * freshly minted token invisible after an Escape.
 */

/** What each scope lets a client do, said next to the box that grants it. */
const SCOPE_DESCRIPTIONS: Readonly<Record<(typeof ACCESS_TOKEN_SCOPES)[number], string>> = {
  read: 'Read items and search',
  write: 'Create and change items',
  admin: 'Administrative endpoints',
};

/** The expiries offered as one press, in days. Anything else is the custom field. */
const EXPIRY_PRESETS = [7, 30, 90, 365] as const;

type ExpiryChoice = (typeof EXPIRY_PRESETS)[number] | 'custom';

export interface AccessTokenCreateDialogProps {
  readonly open: boolean;

  /**
   * Asked to close, by any path. `createdToken` is true when a token was minted during this
   * opening, so the owner can refresh the list it renders.
   */
  readonly onClose: (createdToken: boolean) => void;

  /** Performs the mint. The dialog renders the outcome; the hook owns the request. */
  readonly create: (request: {
    readonly name: string;
    readonly scopes: readonly string[];
    readonly expiresInDays: number;
  }) => Promise<CreateTokenOutcome>;
}

export function AccessTokenCreateDialog(props: AccessTokenCreateDialogProps): ReactElement {
  const { open, onClose, create } = props;

  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ReadonlySet<string>>(new Set());
  const [expiry, setExpiry] = useState<ExpiryChoice | null>(null);
  const [customDays, setCustomDays] = useState('');

  // Null until a submit has been attempted, so the form does not open covered in red. After one,
  // every message reflects the current inputs - fixing a field clears its sentence on the next
  // attempt rather than lingering as a stale accusation.
  const [nameError, setNameError] = useState<string | null>(null);
  const [scopesError, setScopesError] = useState<string | null>(null);
  const [expiryError, setExpiryError] = useState<string | null>(null);

  /** The server's refusal, verbatim where it names the fault. */
  const [refusal, setRefusal] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);

  /** The minted token. Its presence is what flips the dialog to the secret face. */
  const [minted, setMinted] = useState<CreatedAccessToken | null>(null);

  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const nameFieldRef = useRef<HTMLInputElement>(null);

  function dismiss(): void {
    const createdToken = minted !== null;

    // Reset everything so the next opening starts clean: a create dialog that remembered the last
    // secret would be a second showing of a thing promised to appear once.
    setName('');
    setScopes(new Set());
    setExpiry(null);
    setCustomDays('');
    setNameError(null);
    setScopesError(null);
    setExpiryError(null);
    setRefusal(null);
    setSubmitting(false);
    setMinted(null);
    setCopyState('idle');

    onClose(createdToken);
  }

  function toggleScope(scope: string): void {
    setScopes((current) => {
      const next = new Set(current);
      if (next.has(scope)) {
        next.delete(scope);
      } else {
        next.add(scope);
      }
      return next;
    });
  }

  /** The chosen expiry in days, or null while the choice is missing or unusable. */
  function chosenDays(): number | null {
    if (expiry === null) {
      return null;
    }

    if (expiry !== 'custom') {
      return expiry;
    }

    const parsed = Number(customDays);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 365 ? parsed : null;
  }

  async function submit(): Promise<void> {
    const trimmed = name.trim();
    const days = chosenDays();

    const nameFault =
      trimmed.length === 0
        ? 'Give the token a name.'
        : trimmed.length > 100
          ? 'Keep the name to 100 characters.'
          : null;
    const scopesFault = scopes.size === 0 ? 'Choose at least one scope.' : null;
    const expiryFault =
      expiry === null
        ? 'Choose how long the token lives.'
        : days === null
          ? 'A custom expiry is a whole number of days, from 1 to 365.'
          : null;

    setNameError(nameFault);
    setScopesError(scopesFault);
    setExpiryError(expiryFault);
    setRefusal(null);

    if (nameFault !== null || scopesFault !== null || expiryFault !== null || days === null) {
      return;
    }

    setSubmitting(true);
    try {
      // The scopes are sent in the order the interface offers them rather than the order they
      // were clicked, so two tokens with the same grant read identically in the list.
      const outcome = await create({
        name: trimmed,
        scopes: ACCESS_TOKEN_SCOPES.filter((scope) => scopes.has(scope)),
        expiresInDays: days,
      });

      if (outcome.created === null) {
        setRefusal(outcome.refusal ?? 'The token could not be created.');
        return;
      }

      setMinted(outcome.created);
    } finally {
      setSubmitting(false);
    }
  }

  function copySecret(secret: string): void {
    // jsdom and older browsers have no clipboard at all; a copy control that threw would take the
    // secret's one showing down with it. Failure is reported, and the secret stays selectable.
    if (!('clipboard' in navigator)) {
      setCopyState('failed');
      return;
    }

    navigator.clipboard.writeText(secret).then(
      () => {
        setCopyState('copied');
      },
      () => {
        setCopyState('failed');
      },
    );
  }

  return (
    <Dialog
      open={open}
      title={minted === null ? 'Create an access token' : 'Copy your new token now'}
      onClose={dismiss}
      closeLabel={minted === null ? 'Close without creating a token' : 'Close'}
      initialFocus={nameFieldRef}
      dirty={
        minted === null &&
        (name.length > 0 || scopes.size > 0 || expiry !== null || customDays.length > 0)
      }
      actions={
        minted === null ? (
          <>
            <Button variant="secondary" onClick={dismiss}>
              Cancel
            </Button>
            {/* The footer stays in the dialog's fixed action area while the longer form scrolls. */}
            <Button form="access-token-create-form" type="submit" disabled={submitting}>
              {submitting ? 'Creating the token' : 'Create the token'}
            </Button>
          </>
        ) : null
      }
    >
      {minted === null ? (
        <form
          id="access-token-create-form"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {refusal === null ? null : (
            <Text variant="note" role="alert">
              {refusal}
            </Text>
          )}

          <Field
            label="Name"
            hint="What this token is for - the script or machine that will hold it."
            error={nameError}
            required
          >
            {(field) => (
              <Input
                {...field}
                ref={nameFieldRef}
                value={name}
                maxLength={100}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            )}
          </Field>

          <fieldset className="flex flex-col gap-1 border-0 p-0">
            <legend className={fieldLabel}>
              Scopes
              <span aria-hidden="true" className="ml-1 text-accent-text">
                *
              </span>
            </legend>
            {ACCESS_TOKEN_SCOPES.map((scope) => (
              <label key={scope} className="flex min-h-11 flex-wrap items-center gap-x-2">
                <input
                  type="checkbox"
                  checked={scopes.has(scope)}
                  onChange={() => {
                    toggleScope(scope);
                  }}
                />
                <Text as="span" variant="bodySmall">
                  {scope}
                </Text>
                <Text as="span" variant="note" tone="muted">
                  {SCOPE_DESCRIPTIONS[scope]}
                </Text>
              </label>
            ))}
            {/* Said because it is surprising: most systems nest their scopes, this one does not,
                and a write-only token that cannot read is a support question waiting to be a
                sentence instead. */}
            <Text variant="note" tone="muted">
              Scopes are independent: write does not include read.
            </Text>
            {scopesError === null ? null : (
              <Text variant="note" role="alert">
                {scopesError}
              </Text>
            )}
          </fieldset>

          <fieldset className="flex flex-col gap-1 border-0 p-0">
            <legend className={fieldLabel}>
              Expires after
              <span aria-hidden="true" className="ml-1 text-accent-text">
                *
              </span>
            </legend>
            <div className="flex flex-wrap items-center gap-3">
              {EXPIRY_PRESETS.map((days) => (
                <label key={days} className="flex min-h-11 items-center gap-1.5">
                  <input
                    type="radio"
                    name="token-expiry"
                    checked={expiry === days}
                    onChange={() => {
                      setExpiry(days);
                    }}
                  />
                  <Text as="span" variant="bodySmall">
                    {String(days)} days
                  </Text>
                </label>
              ))}
              <label className="flex min-h-11 items-center gap-1.5">
                <input
                  type="radio"
                  name="token-expiry"
                  checked={expiry === 'custom'}
                  onChange={() => {
                    setExpiry('custom');
                  }}
                />
                <Text as="span" variant="bodySmall">
                  Custom
                </Text>
              </label>
              {expiry === 'custom' ? (
                <label
                  htmlFor="token-custom-expiry-days"
                  className="flex min-h-11 items-center gap-1.5"
                >
                  <span className="sr-only">Custom expiry in days</span>
                  <Input
                    id="token-custom-expiry-days"
                    type="number"
                    min={1}
                    max={365}
                    value={customDays}
                    onChange={(event) => {
                      setCustomDays(event.target.value);
                    }}
                    className="w-24"
                  />
                  <Text as="span" variant="note" tone="muted">
                    days, 1 to 365
                  </Text>
                </label>
              ) : null}
            </div>
            {expiryError === null ? null : (
              <Text variant="note" role="alert">
                {expiryError}
              </Text>
            )}
          </fieldset>
        </form>
      ) : (
        <SecretSurface minted={minted} copyState={copyState} onCopy={copySecret} onDone={dismiss} />
      )}
    </Dialog>
  );
}

/**
 * The one showing of the secret.
 *
 * The warning is stated in full rather than implied by styling, because it is the one fact the
 * person must leave this dialog holding: there is no second showing, by design - the server keeps
 * a hash, not the token.
 */
function SecretSurface(props: {
  readonly minted: CreatedAccessToken;
  readonly copyState: 'idle' | 'copied' | 'failed';
  readonly onCopy: (secret: string) => void;
  readonly onDone: () => void;
}): ReactNode {
  const { minted, copyState, onCopy, onDone } = props;

  return (
    <div className="flex flex-col gap-4">
      <Text variant="bodySmall">
        The token named {minted.details.name} was created. This is the only time the secret will be
        shown - it is not stored and cannot be recovered. Copy it now and keep it somewhere safe.
      </Text>

      <Blueprint className="p-4">
        <div className="flex min-w-0 flex-col items-start gap-3 sm:flex-row">
          <code className="min-w-0 flex-1 break-all font-mono text-sm">{minted.token}</code>
          <Button
            variant="secondary"
            onClick={() => {
              onCopy(minted.token);
            }}
          >
            <Icon icon={Copy} size="sm" />
            Copy token
          </Button>
        </div>
      </Blueprint>

      {/* A live region rather than a color change: whether the copy worked has to reach a screen
          reader, and it has to be honest when it did not - jsdom aside, clipboards fail on real
          machines behind real policies. */}
      <Text variant="note" tone={copyState === 'idle' ? 'muted' : 'default'} role="status">
        {copyState === 'copied'
          ? 'Copied to the clipboard.'
          : copyState === 'failed'
            ? 'The clipboard could not be reached. Select the token above and copy it yourself.'
            : 'Once this dialog closes, the secret is gone for good; only its name and scopes stay visible.'}
      </Text>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}
