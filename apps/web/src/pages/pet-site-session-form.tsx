import { defineCommand } from '@nix/api-client';
import { Button, Checkbox, Field, Input, Text, Toast, UNDO_VISIBLE_MS } from '@nix/ui';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type SubmitEvent,
} from 'react';
import { z } from 'zod';

const cookieFormat = z
  .array(
    z.strictObject({
      name: z.string().min(1).max(128),
      value: z.string().min(8).max(4096),
      path: z.string().min(1).max(512).startsWith('/'),
    }),
  )
  .min(1)
  .max(32);
const connectionSchema = z.object({ id: z.string() });
type Cookie = z.infer<typeof cookieFormat>[number];
type CookieField = keyof Cookie;
type CookieDraft = Cookie & { readonly id: number };
type CookieUndo =
  | { readonly kind: 'added'; readonly id: number }
  | { readonly kind: 'removed'; readonly cookie: CookieDraft; readonly index: number };

const cookieErrors: Readonly<Record<CookieField, string>> = {
  name: 'Enter a cookie name between 1 and 128 characters.',
  value: 'Enter a cookie value between 8 and 4096 characters.',
  path: 'Enter a path beginning with /, up to 512 characters.',
};

function blankCookie(id: number): CookieDraft {
  return { id, name: '', value: '', path: '/' };
}

export function PetSiteSessionForm({
  workspaceId,
  disabled = false,
  onRegistered,
}: {
  readonly workspaceId: string;
  readonly disabled?: boolean;
  readonly onRegistered: () => void;
}): ReactElement {
  const client = useApiClient();
  const [cookies, setCookies] = useState<readonly CookieDraft[]>([blankCookie(0)]);
  const nextCookieId = useRef(1);
  const [history, setHistory] = useState<readonly CookieUndo[]>([]);
  const [notice, setNotice] = useState<{ readonly id: number; readonly text: string } | null>(null);
  const noticeId = useRef(0);
  const [dismissedNotice, setDismissedNotice] = useState<number | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const nameRefs = useRef(new Map<number, HTMLInputElement>());
  const focus = useRef<number | 'add' | null>(null);
  const [busy, setBusy] = useState(false);
  const [originError, setOriginError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<number, Partial<Record<CookieField, string>>>>
  >({});
  const [message, setMessage] = useState<{
    readonly text: string;
    readonly failed: boolean;
  } | null>(null);

  useEffect(() => {
    if (focus.current === 'add') addRef.current?.focus();
    else if (focus.current !== null) nameRefs.current.get(focus.current)?.focus();
    focus.current = null;
  }, [cookies]);

  function showNotice(text: string): void {
    setNotice({ id: ++noticeId.current, text });
  }

  function changeCookie(id: number, field: CookieField, value: string): void {
    setCookies((current) =>
      current.map((cookie) => (cookie.id === id ? { ...cookie, [field]: value } : cookie)),
    );
    setFieldErrors((current) => {
      const next = { ...current, [id]: { ...current[id] } };
      delete next[id]?.[field];
      return next;
    });
  }

  function addCookie(): void {
    const id = nextCookieId.current++;
    const undo: CookieUndo = { kind: 'added', id };
    focus.current = id;
    setCookies((current) => [...current, blankCookie(id)]);
    setHistory((current) => [...current, undo].slice(-20));
    showNotice('Added session cookie.');
  }

  function removeCookie(cookie: CookieDraft, index: number): void {
    const undo: CookieUndo = { kind: 'removed', cookie, index };
    focus.current = 'add';
    setCookies((current) => current.filter((row) => row.id !== cookie.id));
    setHistory((current) => [...current, undo].slice(-20));
    showNotice('Removed session cookie.');
  }

  function undoCookie(): void {
    const previous = history.at(-1);
    if (previous === undefined || busy || disabled) return;
    setHistory((current) => current.slice(0, -1));
    if (previous.kind === 'added') {
      focus.current = 'add';
      setCookies((current) => current.filter((cookie) => cookie.id !== previous.id));
    } else {
      focus.current = previous.cookie.id;
      setCookies((current) => [
        ...current.slice(0, previous.index),
        previous.cookie,
        ...current.slice(previous.index),
      ]);
    }
    showNotice('Undid the last cookie change.');
  }

  function onKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    if (
      event.key.toLowerCase() !== 'z' ||
      !(event.metaKey || event.ctrlKey) ||
      event.shiftKey ||
      event.altKey ||
      event.defaultPrevented ||
      history.length === 0 ||
      !(event.target instanceof HTMLElement) ||
      event.target.isContentEditable ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    undoCookie();
  }

  async function importSite(form: HTMLFormElement): Promise<void> {
    setMessage(null);
    const data = new FormData(form);
    const providedOrigin = data.get('origin');
    const origin = typeof providedOrigin === 'string' ? providedOrigin.trim() : '';
    const allowSubmissions = data.has('allow-submissions');
    let validOrigin = false;
    try {
      const target = new URL(origin);
      validOrigin = target.protocol === 'https:' && target.origin === origin;
    } catch {
      validOrigin = false;
    }
    setOriginError(validOrigin ? '' : 'Enter the HTTPS website address without a path.');
    const parsed = cookieFormat.safeParse(
      cookies.map(({ name, value, path }) => ({ name, value, path })),
    );
    const errors: Partial<Record<number, Partial<Record<CookieField, string>>>> = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const [index, field] = issue.path;
        if (
          typeof index !== 'number' ||
          (field !== 'name' && field !== 'value' && field !== 'path')
        )
          continue;
        const row = cookies[index];
        if (row !== undefined) errors[row.id] = { ...errors[row.id], [field]: cookieErrors[field] };
      }
    }
    setFieldErrors(errors);
    if (!validOrigin || !parsed.success) return;
    if (JSON.stringify(parsed.data).length > 32768) {
      setMessage({
        text: 'Use fewer cookies or shorter cookie values for this session.',
        failed: true,
      });
      return;
    }
    setBusy(true);
    try {
      await client.execute(
        defineCommand({
          method: 'POST',
          path:
            '/api/v1/workspaces/' +
            encodeURIComponent(workspaceId) +
            '/pet-connections/browser-site',
          operation: 'SavePetBrowserSite',
          body: {
            origin,
            cookies: parsed.data,
            allowSubmissions,
          },
          schema: connectionSchema,
        }),
      );
    } catch {
      setMessage({
        text: 'The website session could not be confirmed. Your entries are still here. Try again.',
        failed: true,
      });
      return;
    } finally {
      setBusy(false);
    }
    form.reset();
    setCookies([blankCookie(nextCookieId.current++)]);
    setHistory([]);
    setNotice(null);
    setFieldErrors({});
    setMessage({ text: 'Website session connected.', failed: false });
    onRegistered();
  }

  function submit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!busy && !disabled) void importSite(event.currentTarget);
  }

  return (
    <div className="flex flex-col gap-2">
      <Text as="h4" variant="bodySmall">
        Website session
      </Text>
      <form
        aria-label="Website session"
        onSubmit={submit}
        onKeyDownCapture={onKeyDown}
        autoComplete="off"
        className="flex min-w-0 flex-col gap-2"
      >
        <Field label="HTTPS origin" error={originError} required>
          {(control) => (
            <Input
              {...control}
              name="origin"
              type="url"
              placeholder="https://example.com"
              maxLength={2048}
              disabled={busy || disabled}
              onChange={() => {
                setOriginError('');
              }}
            />
          )}
        </Field>
        {cookies.map((cookie, index) => (
          <fieldset
            key={cookie.id}
            data-enter=""
            className="flex min-w-0 flex-col gap-2 rounded-md border border-divider p-3"
          >
            <legend>
              <Text as="span" variant="bodySmall">
                Session cookie {index + 1}
              </Text>
            </legend>
            <div className="flex min-w-0 flex-wrap gap-2">
              <Field
                label="Name"
                required
                error={fieldErrors[cookie.id]?.name ?? null}
                className="grow basis-48"
              >
                {(control) => (
                  <Input
                    {...control}
                    ref={(element) => {
                      if (element === null) nameRefs.current.delete(cookie.id);
                      else nameRefs.current.set(cookie.id, element);
                    }}
                    name={`cookie-name-${String(cookie.id)}`}
                    value={cookie.name}
                    maxLength={128}
                    autoComplete="off"
                    disabled={busy || disabled}
                    onChange={(event) => {
                      changeCookie(cookie.id, 'name', event.target.value);
                    }}
                  />
                )}
              </Field>
              <Field
                label="Value"
                required
                error={fieldErrors[cookie.id]?.value ?? null}
                className="grow basis-64"
              >
                {(control) => (
                  <Input
                    {...control}
                    name={`cookie-value-${String(cookie.id)}`}
                    type="password"
                    value={cookie.value}
                    minLength={8}
                    maxLength={4096}
                    autoComplete="off"
                    disabled={busy || disabled}
                    onChange={(event) => {
                      changeCookie(cookie.id, 'value', event.target.value);
                    }}
                  />
                )}
              </Field>
              <Field
                label="Path"
                required
                error={fieldErrors[cookie.id]?.path ?? null}
                className="grow basis-40"
              >
                {(control) => (
                  <Input
                    {...control}
                    name={`cookie-path-${String(cookie.id)}`}
                    value={cookie.path}
                    maxLength={512}
                    autoComplete="off"
                    disabled={busy || disabled}
                    onChange={(event) => {
                      changeCookie(cookie.id, 'path', event.target.value);
                    }}
                  />
                )}
              </Field>
            </div>
            <div>
              <Button
                variant="ghost"
                disabled={busy || disabled || cookies.length === 1}
                onClick={() => {
                  removeCookie(cookie, index);
                }}
              >
                Remove cookie
              </Button>
            </div>
          </fieldset>
        ))}
        <div>
          <Button
            ref={addRef}
            variant="secondary"
            disabled={busy || disabled || cookies.length >= 32}
            onClick={addCookie}
          >
            Add cookie
          </Button>
        </div>
        <Checkbox
          name="allow-submissions"
          label="Allow reviewed form submissions"
          disabled={busy || disabled}
        />
        <div>
          <Button type="submit" variant="secondary" disabled={busy || disabled}>
            {busy ? 'Connecting…' : 'Connect website session'}
          </Button>
        </div>
        {notice !== null && notice.id !== dismissedNotice && !busy && !disabled ? (
          <Toast
            key={notice.id}
            message={notice.text}
            duration={UNDO_VISIBLE_MS}
            {...{ autoFocus: false }}
            returnFocusRef={addRef}
            {...(history.length === 0
              ? {}
              : {
                  action: {
                    label: history.length > 1 ? `Undo (${String(history.length)})` : 'Undo',
                    onAction: undoCookie,
                  },
                })}
            onDismiss={() => {
              setDismissedNotice(notice.id);
            }}
          />
        ) : null}
      </form>
      {message && (
        <Text variant="note" role={message.failed ? 'alert' : 'status'}>
          {message.text}
        </Text>
      )}
    </div>
  );
}
