import {
  isCanceledError,
  structure,
  type AutomationRuleResponse as AutomationRule,
  type AutomationRunResponse as AutomationRun,
  type AutomationTestResponse as AutomationTestResult,
  type PropertyDefinition,
} from '@nix/api-client';
import { Button, Dialog, Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { TemplateItemPicker } from '../collections/items/template-item-picker';
import {
  describeRunReason,
  describeRunStatus,
  draftFromRule,
  ruleInputFromDraft,
  summarizeTrigger,
  validateDraft,
  type AutomationDraft,
  type DraftErrors,
  type Violation,
} from './automation-draft';
import { AutomationEditor, type ItemPickerProps } from './automation-editor';
import { AutomationRunLog } from './automation-run-log';
import { useAutomationRuns, type AutomationsState, type SaveOutcome } from './use-automations';

/**
 * One rule: its editor, the Run now and Test controls, its run log and its deletion - or, for a
 * new rule, the editor alone.
 */

interface ScopeProperties {
  readonly properties: readonly PropertyDefinition[] | null;
  readonly loading: boolean;
}

/** The properties items inside the scope carry, for the editor's key pickers. */
function useScopeProperties(scopeItemId: string | null): ScopeProperties {
  const client = useApiClient();
  const [loaded, setLoaded] = useState<{
    readonly scopeItemId: string;
    readonly properties: readonly PropertyDefinition[] | null;
  } | null>(null);

  useEffect(() => {
    if (scopeItemId === null) return;
    const controller = new AbortController();
    void client
      .query(structure.effectiveSchema(scopeItemId), { signal: controller.signal })
      .then((schema) => {
        if (!controller.signal.aborted) setLoaded({ scopeItemId, properties: schema.properties });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || isCanceledError(cause)) return;
        // Typing a key still works without the list, so a failed read degrades the picker rather
        // than blocking the form.
        setLoaded({ scopeItemId, properties: null });
      });
    return () => {
      controller.abort();
    };
  }, [client, scopeItemId]);

  if (scopeItemId === null) return { properties: null, loading: false };
  if (loaded?.scopeItemId !== scopeItemId) return { properties: null, loading: true };
  return { properties: loaded.properties, loading: false };
}

function renderItemPicker(props: ItemPickerProps): ReactNode {
  return (
    <TemplateItemPicker
      label={`Search for ${props.label.charAt(0).toLowerCase()}${props.label.slice(1)}`}
      {...(props.hint === undefined ? {} : { hint: props.hint })}
      choiceLabel={props.label}
      noneLabel={props.label === 'Scope' ? 'The whole workspace' : 'No item chosen'}
      value={props.value ?? ''}
      loadedItems={[]}
      onChange={props.onChange}
    />
  );
}

/** A readable name for the part of the rule a server violation points at. */
function describePath(path: string | null): string {
  if (path === null) return 'The automation';
  if (path === 'name') return 'Name';
  if (path === 'scopeItemId') return 'Scope';
  const indexed = /^(conditions|actions)\[(\d+)\]/.exec(path);
  if (indexed !== null) {
    const number = String(Number(indexed[2]) + 1);
    return indexed[1] === 'conditions' ? `Condition ${number}` : `Action ${number}`;
  }
  if (path.startsWith('trigger')) return 'Trigger';
  if (path.startsWith('conditions')) return 'Conditions';
  if (path.startsWith('actions')) return 'Actions';
  return path;
}

function violationErrors(violations: readonly Violation[]): DraftErrors {
  const errors: Record<string, string> = {};
  for (const violation of violations) {
    if (violation.path !== null && errors[violation.path] === undefined) {
      const reason = violation.reason;
      errors[violation.path] = `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`;
    }
  }
  return errors;
}

export interface AutomationDetailProps {
  readonly workspaceId: string;
  readonly state: AutomationsState;
  /** The saved rule, or null while composing a new one. */
  readonly rule: AutomationRule | null;
  /** The draft a new rule starts from. */
  readonly initialDraft: AutomationDraft | null;
  readonly itemHref: (itemId: string) => string;
  readonly onSaved: (rule: AutomationRule) => void;
  readonly onDeleted: (rule: AutomationRule) => void;
  readonly onClose: () => void;
}

export function AutomationDetail(props: AutomationDetailProps): ReactNode {
  const { rule, initialDraft } = props;
  // Keyed by revision so a saved or reloaded rule resets the editor to what is stored.
  const start = rule === null ? initialDraft : draftFromRule(rule);
  return (
    <div className="flex min-w-0 flex-col gap-8">
      {start === null ? (
        rule === null ? null : (
          <UneditableRule rule={rule} />
        )
      ) : (
        <RuleForm
          key={rule === null ? 'new' : `${rule.id}:${String(rule.revision)}`}
          {...props}
          start={start}
        />
      )}
      {rule === null ? null : <RuleTools {...props} rule={rule} />}
    </div>
  );
}

function UneditableRule({ rule }: { readonly rule: AutomationRule }): ReactNode {
  return (
    <section className="flex flex-col gap-2 border border-divider p-3">
      <Text variant="h5" as="h2">
        {rule.name}
      </Text>
      <Text variant="note" tone="muted">
        {summarizeTrigger(rule.trigger)}
      </Text>
      <Text variant="note">
        This automation uses settings this version of Nix cannot edit, so it is shown read-only. It
        still runs as it was saved. You can test it, run it, read its log or delete it.
      </Text>
    </section>
  );
}

function RuleForm(props: AutomationDetailProps & { readonly start: AutomationDraft }): ReactNode {
  const { state, rule, start, onSaved, onClose } = props;
  const [draft, setDraft] = useState(start);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [serverViolations, setServerViolations] = useState<readonly Violation[]>([]);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const { properties, loading } = useScopeProperties(draft.scopeItemId);
  const sectionRef = useRef<HTMLElement>(null);

  // A save or a reload re-keys this form, which removes the control that had focus. Put focus at
  // the top of the fresh form rather than leaving it on the page body, where the next Tab starts
  // over from the skip link.
  useEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) sectionRef.current?.focus();
  }, []);

  async function submit(): Promise<void> {
    const local = validateDraft(draft);
    setErrors(local);
    setServerViolations([]);
    setRefusal(null);
    setConflict(null);
    if (Object.keys(local).length > 0) return;

    setSaving(true);
    const input = ruleInputFromDraft(draft);
    const outcome: SaveOutcome =
      rule === null ? await state.create(input) : await state.update(rule, input);
    setSaving(false);
    switch (outcome.kind) {
      case 'saved':
        onSaved(outcome.rule);
        return;
      case 'conflict':
        setConflict(outcome.message);
        return;
      case 'invalid':
        setErrors(violationErrors(outcome.violations));
        setServerViolations(outcome.violations);
        return;
      case 'refused':
        setRefusal(outcome.message);
        return;
    }
  }

  async function reloadSaved(): Promise<void> {
    if (rule === null) return;
    setReloading(true);
    const outcome = await props.state.fetchRule(rule.id);
    setReloading(false);
    if (outcome.kind !== 'found') {
      setRefusal(
        outcome.kind === 'missing'
          ? 'This automation no longer exists. It may have been deleted.'
          : 'The saved automation could not be reloaded. Try again.',
      );
      return;
    }
    // A fresh revision re-keys the form, which resets the draft to what is stored.
    if (outcome.rule.revision === rule.revision) setConflict(null);
  }

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      aria-labelledby="automation-editor-heading"
      className="flex min-w-0 flex-col gap-4 outline-none"
    >
      <Text id="automation-editor-heading" variant="h5" as="h2">
        {rule === null ? 'New automation' : `Edit ${rule.name}`}
      </Text>
      {conflict === null ? null : (
        <div role="alert" className="flex flex-col gap-2 border border-divider p-3">
          <Text variant="note">{conflict}</Text>
          <Text variant="note" tone="muted">
            Reloading replaces what is on screen with the saved version.
          </Text>
          <div>
            <Button
              type="button"
              variant="secondary"
              disabled={reloading}
              className="h-auto min-h-(--control-md) max-w-full whitespace-normal py-2 any-pointer-coarse:h-auto any-pointer-coarse:min-h-(--control-lg)"
              onClick={() => {
                void reloadSaved();
              }}
            >
              {reloading ? 'Reloading…' : 'Reload the saved automation'}
            </Button>
          </div>
        </div>
      )}
      {refusal === null ? null : (
        <Text variant="note" role="alert">
          {refusal}
        </Text>
      )}
      {serverViolations.length === 0 ? null : (
        <div role="alert" className="flex flex-col gap-2 border border-divider p-3">
          <Text variant="note">The automation could not be saved:</Text>
          <ul className="flex list-disc flex-col gap-1 pl-5">
            {serverViolations.map((violation, index) => (
              <li key={index}>
                <Text variant="note" as="span">
                  {describePath(violation.path)}: {violation.reason}
                </Text>
              </li>
            ))}
          </ul>
        </div>
      )}
      <AutomationEditor
        draft={draft}
        onChange={(next) => {
          setDraft(next);
        }}
        errors={errors}
        properties={properties}
        propertiesLoading={loading}
        renderItemPicker={renderItemPicker}
        busy={saving}
        submitLabel={rule === null ? 'Create automation' : 'Save changes'}
        onSubmit={() => {
          void submit();
        }}
        onCancel={onClose}
      />
    </section>
  );
}

function needsItem(rule: AutomationRule): boolean {
  return rule.trigger.type === 'date_arrives' || rule.trigger.type === 'property_changed';
}

function PreviewList({ result }: { readonly result: AutomationTestResult }): ReactNode {
  if (!result.wouldRun) {
    return (
      <Text variant="note">
        It would not run now. {result.reason === null ? '' : describeRunReason(result.reason)}
      </Text>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <Text variant="note">It would run now, and would:</Text>
      <ol className="flex list-decimal flex-col gap-1 pl-5">
        {result.actions.map((action) => (
          <li key={action.index}>
            <Text variant="note" as="span">
              {action.type === 'notify'
                ? `Send you "${action.title ?? ''}"${action.body ? `: ${action.body}` : ''}`
                : action.type === 'set_property'
                  ? `Set ${action.key ?? 'a property'} on an item`
                  : action.type === 'create_item'
                    ? `Create "${action.title ?? 'an item'}"`
                    : `Run a ${action.type} action`}
            </Text>
          </li>
        ))}
      </ol>
    </div>
  );
}

function RuleTools(props: AutomationDetailProps & { readonly rule: AutomationRule }): ReactNode {
  const { rule, state, itemHref, onDeleted } = props;
  const runs = useAutomationRuns(rule.id);
  const [itemId, setItemId] = useState<string | null>(null);
  const [busy, setBusy] = useState<'run' | 'test' | null>(null);
  const [lastRun, setLastRun] = useState<AutomationRun | null>(null);
  const [testResult, setTestResult] = useState<AutomationTestResult | null>(null);
  const [toolRefusal, setToolRefusal] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteRefusal, setDeleteRefusal] = useState<string | null>(null);

  async function runNow(): Promise<void> {
    setBusy('run');
    setToolRefusal(null);
    setTestResult(null);
    const outcome = await state.run(rule.id, itemId);
    setBusy(null);
    if (outcome.kind === 'refused') {
      setLastRun(null);
      setToolRefusal(outcome.message);
      return;
    }
    setLastRun(outcome.run);
    runs.reload();
    void state.fetchRule(rule.id);
  }

  async function test(): Promise<void> {
    setBusy('test');
    setToolRefusal(null);
    setLastRun(null);
    const outcome = await state.test(rule.id, itemId);
    setBusy(null);
    if (outcome.kind === 'refused') {
      setTestResult(null);
      setToolRefusal(outcome.message);
      return;
    }
    setTestResult(outcome.result);
  }

  async function confirmDelete(): Promise<void> {
    setDeleting(true);
    setDeleteRefusal(null);
    const { refusal } = await state.remove(rule);
    setDeleting(false);
    if (refusal !== null) {
      setDeleteRefusal(refusal);
      return;
    }
    setConfirmingDelete(false);
    onDeleted(rule);
  }

  return (
    <>
      <section aria-labelledby="automation-tools-heading" className="flex min-w-0 flex-col gap-3">
        <Text id="automation-tools-heading" variant="h6" as="h3">
          Test or run it
        </Text>
        <Text variant="note" tone="muted">
          Both use the saved version. A test shows what would happen and changes nothing. Run now
          does it for real and records it in the log.
        </Text>
        {needsItem(rule) ? (
          <div className="max-w-xl">
            {renderItemPicker({
              label: 'Item to run it against',
              hint: 'This automation acts on the item that sets it off, so choose one to try it with.',
              value: itemId,
              onChange: setItemId,
            })}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => {
              void test();
            }}
          >
            {busy === 'test' ? 'Testing…' : 'Test'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => {
              void runNow();
            }}
          >
            {busy === 'run' ? 'Running…' : 'Run now'}
          </Button>
        </div>
        <div role="status" className="empty:hidden">
          {testResult === null ? null : <PreviewList result={testResult} />}
          {lastRun === null ? null : (
            <Text variant="note">
              {describeRunStatus(lastRun.status)}.{' '}
              {lastRun.reason === null ? '' : describeRunReason(lastRun.reason)}
            </Text>
          )}
        </div>
        {toolRefusal === null ? null : (
          <Text variant="note" role="alert">
            {toolRefusal}
          </Text>
        )}
      </section>

      <AutomationRunLog
        status={runs.status}
        runs={runs.runs}
        error={runs.error}
        hasMore={runs.hasMore}
        loadingMore={runs.loadingMore}
        onLoadMore={runs.loadMore}
        onRetry={runs.reload}
        itemHref={itemHref}
      />

      <section aria-labelledby="automation-delete-heading" className="flex flex-col gap-2">
        <Text id="automation-delete-heading" variant="h6" as="h3">
          Delete
        </Text>
        <Text variant="note" tone="muted">
          Deleting stops it for good and removes its run log. Turning it off keeps both.
        </Text>
        <div>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setDeleteRefusal(null);
              setConfirmingDelete(true);
            }}
          >
            Delete automation
          </Button>
        </div>
      </section>

      {confirmingDelete ? (
        <Dialog
          open
          title={`Delete ${rule.name}?`}
          closeLabel="Keep the automation"
          onClose={() => {
            if (!deleting) setConfirmingDelete(false);
          }}
          actions={
            <>
              <Button
                variant="secondary"
                disabled={deleting}
                onClick={() => {
                  setConfirmingDelete(false);
                }}
              >
                Cancel
              </Button>
              <Button
                disabled={deleting}
                onClick={() => {
                  void confirmDelete();
                }}
              >
                {deleting ? 'Deleting…' : 'Delete automation'}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-2">
            <Text variant="bodySmall">
              It stops running, anything it had planned is cancelled, and its run log is removed.
              This cannot be undone.
            </Text>
            {deleteRefusal === null ? null : (
              <Text variant="note" role="alert">
                {deleteRefusal}
              </Text>
            )}
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
