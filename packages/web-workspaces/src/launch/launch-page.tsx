import { ScrollRegion, Blueprint, Button, SkeletonLines, Text, focusRing } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useAuth } from '@nix/web-platform/auth/auth-provider';
import { ErrorPanel } from '@nix/web-foundation/components/states/status-panels';
import { publishNotice } from '@nix/web-foundation/lib/notices';
import { useWorkspace } from '../workspaces/workspace-context';
import { createNote } from './create-note';
import { MAX_LAUNCH_FILES, receiveLaunchFiles, type LaunchedFiles } from './launch-files';
import {
  parseLaunchIntent,
  sharedNoteDocument,
  sharedNoteTitle,
  type LaunchIntent,
  type LaunchNavigationState,
} from './launch-intent';

interface CreatedNote {
  readonly itemId: string;
  readonly title: string;
}

interface Outcome {
  readonly created: readonly CreatedNote[];
  readonly problems: readonly string[];
}

type Phase =
  | { readonly name: 'confirm' }
  | { readonly name: 'working' }
  | ({ readonly name: 'finished' } & Outcome);

/**
 * The installed app's launch address inside a workspace: `/w/:workspaceId/launch/:action`.
 *
 * **Nothing is written on arrival.** This address is a plain link, and any page on the web can
 * send someone to it with a query of its own choosing. Opening today's note, search, or the
 * workspace is harmless, so those happen at once; creating a note - from the New note shortcut or
 * from something shared - waits for the person to say so, on a panel that names where it will go
 * and shows exactly what it will hold. Opened files are the one automatic write, because they only
 * ever arrive from the operating system's "Open with", never from a link.
 *
 * Each action replaces this address with where it leads, so Back never returns to a page that
 * would run it again.
 */
export function LaunchPage(): ReactNode {
  const { action } = useParams<{ action: string }>();
  const [search] = useSearchParams();
  const { workspaceId, workspace } = useWorkspace();
  const client = useApiClient();
  const { getAccessToken } = useAuth();
  const navigate = useNavigate();
  // The launch is read once per address; the effect below owns the one automatic run.
  const [intent] = useState(() => parseLaunchIntent(action, search));
  const [phase, setPhase] = useState<Phase>(() =>
    intent?.kind === 'new' || intent?.kind === 'share' ? { name: 'confirm' } : { name: 'working' },
  );
  // Guards the automatic run against StrictMode's replayed effect, which would otherwise import
  // every opened file twice; `mounted` is what a run that outlives this page checks first.
  const started = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const home = `/w/${workspaceId}`;

  useEffect(() => {
    if (started.current || phase.name !== 'working') return;
    started.current = true;
    const openNote = (itemId: string): void => {
      void navigate(`${home}?item=${encodeURIComponent(itemId)}`, { replace: true });
    };

    async function importFiles(received: LaunchedFiles | null): Promise<Outcome> {
      const created: CreatedNote[] = [];
      const problems = skippedProblems(received);
      if (received === null || received.files.length === 0) {
        if (problems.length === 0)
          problems.push(
            'No Markdown file arrived with this launch. Open a .md file with Nix to import it.',
          );
        return { created, problems };
      }
      for (const file of received.files) {
        const note = await createNote({
          client,
          workspaceId,
          title: file.title,
          body: { markdown: file.markdown },
          getAccessToken,
        });
        if (!note.ok) {
          problems.push(`${file.title} was not imported: ${note.error}`);
          continue;
        }
        created.push({ itemId: note.itemId, title: file.title });
        if (note.bodyError !== null)
          problems.push(`${file.title} was created, but its text was not saved: ${note.bodyError}`);
      }
      return { created, problems };
    }

    async function run(): Promise<void> {
      if (intent === null) {
        void navigate(home, { replace: true });
        return;
      }
      if (intent.kind === 'today') {
        if (workspace.canUseDailyNotes) {
          void navigate(`${home}/daily`, { replace: true });
          return;
        }
        // The shortcut names a feature this workspace has switched off. The daily address would
        // only bounce to the workspace in silence, so land there directly and say why, with the
        // way to switch them on for whoever may. Published a microtask late: on a cold launch the
        // shell mounts with this page, and its notice subscription is an effect that runs after
        // this child's.
        void navigate(home, { replace: true });
        queueMicrotask(() => {
          publishNotice({
            key: 'launch-daily-off',
            message: `Daily notes are switched off in ${workspace.name}.`,
            ...(workspace.canRename
              ? {
                  action: {
                    label: 'Turn on',
                    onAction: () => {
                      void navigate(`${home}/settings?tab=daily-notes`);
                    },
                  },
                }
              : {}),
          });
        });
        return;
      }
      if (intent.kind === 'search') {
        const state: LaunchNavigationState = { openSearch: true };
        void navigate(home, { replace: true, state });
        return;
      }
      if (intent.kind !== 'open') return;

      const outcome = await importFiles(await receiveLaunchFiles());
      if (!mounted.current) return;
      const [first] = outcome.created;
      if (outcome.problems.length === 0 && first !== undefined) openNote(first.itemId);
      else setPhase({ name: 'finished', ...outcome });
    }

    void run();
  }, [
    client,
    getAccessToken,
    home,
    intent,
    navigate,
    phase.name,
    workspace.canRename,
    workspace.canUseDailyNotes,
    workspace.name,
    workspaceId,
  ]);

  async function confirm(chosen: Extract<LaunchIntent, { kind: 'new' | 'share' }>): Promise<void> {
    started.current = true;
    setPhase({ name: 'working' });
    const title = chosen.kind === 'share' ? sharedNoteTitle(chosen) : 'Untitled note';
    const note = await createNote({
      client,
      workspaceId,
      title,
      ...(chosen.kind === 'share' ? { body: { doc: sharedNoteDocument(chosen) } } : {}),
      getAccessToken,
    });
    if (!mounted.current) return;
    if (!note.ok) {
      setPhase({ name: 'finished', created: [], problems: [note.error] });
    } else if (note.bodyError !== null) {
      setPhase({
        name: 'finished',
        created: [{ itemId: note.itemId, title }],
        problems: [`The note was created, but its text was not saved: ${note.bodyError}`],
      });
    } else {
      void navigate(`${home}?item=${encodeURIComponent(note.itemId)}`, { replace: true });
    }
  }

  if (phase.name === 'confirm' && (intent?.kind === 'new' || intent?.kind === 'share')) {
    return (
      <ConfirmLaunch
        intent={intent}
        workspaceName={workspace.name}
        onConfirm={() => {
          void confirm(intent);
        }}
        onCancel={() => {
          void navigate(home, { replace: true });
        }}
      />
    );
  }

  if (phase.name === 'finished') {
    const [first] = phase.created;
    return (
      <div className="mx-auto flex min-w-0 w-full max-w-3xl flex-col gap-3 p-3 sm:p-6">
        <ErrorPanel
          title={
            phase.created.length === 0
              ? 'Nix could not finish opening that'
              : `Some of what arrived was not opened`
          }
          detail={
            phase.created.length === 0
              ? 'Nothing was created.'
              : `${String(phase.created.length)} ${phase.created.length === 1 ? 'note was' : 'notes were'} created.`
          }
          action={
            <div className="flex min-w-0 w-full flex-col gap-3">
              <ul className="flex min-w-0 list-disc flex-col gap-1 pl-5">
                {phase.problems.map((problem) => (
                  <Text as="li" variant="bodySmall" className="wrap-anywhere" key={problem}>
                    {problem}
                  </Text>
                ))}
              </ul>
              <div className="flex flex-wrap gap-2">
                {first === undefined ? null : (
                  <Button
                    className="h-auto min-h-(--control-md) min-w-0 max-w-full wrap-anywhere whitespace-normal py-2 any-pointer-coarse:h-auto any-pointer-coarse:min-h-(--control-lg)"
                    onClick={() =>
                      void navigate(`${home}?item=${encodeURIComponent(first.itemId)}`, {
                        replace: true,
                      })
                    }
                  >
                    <span className="min-w-0 wrap-anywhere">Open {first.title}</span>
                  </Button>
                )}
                <Button
                  variant="secondary"
                  className="h-auto min-h-(--control-md) max-w-full whitespace-normal py-2 any-pointer-coarse:h-auto any-pointer-coarse:min-h-(--control-lg)"
                  onClick={() => void navigate(home, { replace: true })}
                >
                  Go to the workspace
                </Button>
              </div>
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto min-w-0 w-full max-w-3xl p-3 sm:p-8">
      <SkeletonLines label={workingLabel(intent?.kind)} heading />
    </div>
  );
}

/** What the files that were not read come to, said as sentences for the report. */
function skippedProblems(received: LaunchedFiles | null): string[] {
  if (received === null) return [];
  const { overLimit, notMarkdown, tooLarge } = received.skipped;
  const count = (value: number): string =>
    `${String(value)} ${value === 1 ? 'file was' : 'files were'}`;
  const problems: string[] = [];
  if (overLimit > 0)
    problems.push(
      `${count(overLimit)} not opened: Nix opens up to ${String(MAX_LAUNCH_FILES)} files at once.`,
    );
  if (notMarkdown > 0) problems.push(`${count(notMarkdown)} not Markdown, so not opened.`);
  if (tooLarge > 0) problems.push(`${count(tooLarge)} larger than 8 MB, so not opened.`);
  return problems;
}

/**
 * The one step between a launch address and a new note: where it goes, what it will say, and a
 * button that is the only way to make it. Shared text is shown as the plain text it will become.
 */
export function ConfirmLaunch(props: {
  readonly intent: Extract<LaunchIntent, { kind: 'new' | 'share' }>;
  readonly workspaceName: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const { intent, workspaceName, onConfirm, onCancel } = props;
  return (
    <div className="mx-auto min-w-0 w-full max-w-2xl p-3 sm:p-6">
      <Blueprint className="flex min-w-0 flex-col gap-4 p-3 sm:p-6">
        <Text as="h1" variant="h5" className="wrap-anywhere">
          {intent.kind === 'share'
            ? `Save this to ${workspaceName}?`
            : `Create a note in ${workspaceName}?`}
        </Text>
        {intent.kind === 'share' ? (
          <div role="group" aria-label="What will be saved" className="flex min-w-0 flex-col gap-2">
            <Text as="h2" variant="h6" className="wrap-anywhere">
              {sharedNoteTitle(intent)}
            </Text>
            {intent.text === '' ? null : (
              <ScrollRegion
                aria-label="Shared text"
                className={`${focusRing} max-h-64 overflow-y-auto`}
              >
                <Text as="p" variant="bodySmall" className="wrap-anywhere whitespace-pre-wrap">
                  {intent.text}
                </Text>
              </ScrollRegion>
            )}
            {intent.url === null || intent.text.includes(intent.url) ? null : (
              <Text as="p" variant="bodySmall" className="break-all">
                {intent.url}
              </Text>
            )}
          </div>
        ) : (
          <Text as="p" variant="body" tone="muted">
            An untitled note is added at the top of the workspace and opened.
          </Text>
        )}
        <div className="flex flex-wrap gap-2">
          <Button onClick={onConfirm}>
            {intent.kind === 'share' ? 'Save note' : 'Create note'}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </Blueprint>
    </div>
  );
}

function workingLabel(kind: string | undefined): string {
  switch (kind) {
    case 'new':
      return 'Creating a note…';
    case 'share':
      return 'Saving what you shared…';
    case 'open':
      return 'Opening the file…';
    default:
      return 'Opening Nix…';
  }
}
