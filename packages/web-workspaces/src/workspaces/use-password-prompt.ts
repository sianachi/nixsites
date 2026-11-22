import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type RefObject,
  type SyntheticEvent,
} from 'react';

/**
 * The state of a password prompt: the typed password, the refusal shown on the field, and a busy
 * flag while the check runs. Each prompt keeps its own markup and copy.
 *
 * A prompt that replaces something that was open (`reason` set) takes focus; on a first visit it
 * leaves focus alone. A refusal puts focus back on the field for another try.
 */
export function usePasswordPrompt(
  reason: string | null,
  onUnlock: (password: string) => Promise<string | null>,
): {
  readonly error: string | null;
  readonly busy: boolean;
  readonly input: {
    readonly ref: RefObject<HTMLInputElement | null>;
    readonly type: 'password';
    readonly autoComplete: 'current-password';
    readonly readOnly: boolean;
    readonly value: string;
    readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  };
  readonly onSubmit: (event: SyntheticEvent<HTMLFormElement>) => void;
} {
  const inputRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (reason !== null) inputRef.current?.focus();
  }, [reason]);

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    if (password.length === 0) {
      setError('Enter the password.');
      inputRef.current?.focus();
      return;
    }

    setBusy(true);
    const refused = await onUnlock(password);
    setBusy(false);
    // Cleared either way: on a refusal the field is ready for another try, and on success the
    // prompt is usually replaced (when it stays it is asking for a second lock's password).
    setPassword('');
    if (refused !== null) {
      setError(refused);
      inputRef.current?.focus();
    }
  }

  return {
    error,
    busy,
    input: {
      ref: inputRef,
      type: 'password',
      autoComplete: 'current-password',
      readOnly: busy,
      value: password,
      onChange: (event) => {
        setPassword(event.target.value);
        setError(null);
      },
    },
    onSubmit: (event) => {
      void submit(event);
    },
  };
}
