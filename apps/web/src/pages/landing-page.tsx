import { Icon, Text } from '@nix/ui';
import { FileText, type LucideIcon } from 'lucide-react';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { selectIsBusy, useSessionStore } from '@nix/web-foundation/lib/session-store';
import { ThemeChoice } from '@nix/web-foundation/theme/theme-choice';
import { findViewKind } from '@nix/web-views/core/view-kinds';

export interface LandingPageProps {
  /** Starts the redirect to the identity provider. */
  readonly onSignIn: () => void;
  /** Whether this install offers `/demo`. */
  readonly demo: boolean;
}

const REPOSITORY = 'https://github.com/sianachi/nixsites';
const DOCS = 'https://nix.nixsites.com/';

// design-token-exempt: the landing design's page measure, wider than any panel width on the scale.
const PAGE = 'mx-auto w-full max-w-[1200px] px-4 sm:px-10';
const RULE = 'border-divider';
const BUTTON =
  'inline-flex min-h-11 items-center rounded-md px-5 font-bold no-underline outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent';
const PRIMARY = `${BUTTON} bg-accent-fill text-background hover:bg-accent-fill-hover`;
const SECONDARY = `${BUTTON} border ${RULE} text-foreground hover:bg-surface`;
const NAV_LINK = 'flex min-h-11 items-center text-muted no-underline hover:text-foreground';
// The design's display sizes sit between the scale's steps; the phone keeps the scale's 40px and 28px.
const HERO = 'leading-tight font-bold sm:text-[56px] sm:leading-[1.05]'; // design-token-exempt: the design's 56px display hero
const SECTION_HEAD = 'leading-tight font-bold sm:text-[36px] sm:leading-[1.1]'; // design-token-exempt: the design's 36px section heads
const LEAD = 'text-lg sm:text-[19px] sm:leading-normal'; // design-token-exempt: the design's 19px lead

function Kicker({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <Text variant="kicker" as="p" tone="muted">
      {children}
    </Text>
  );
}

function Shot(props: {
  readonly src: string;
  readonly alt: string;
  readonly large?: boolean;
  readonly eager?: boolean;
}): ReactNode {
  return (
    <div
      className={`overflow-hidden border ${RULE} bg-surface ${props.large === true ? 'rounded-lg' : 'rounded-md'}`}
    >
      <img
        src={props.src}
        alt={props.alt}
        width={1600}
        height={1000}
        loading={props.eager === true ? 'eager' : 'lazy'}
        className="block h-auto w-full"
      />
    </div>
  );
}

function Point({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <div className={`border-b ${RULE} py-5 pr-6`}>
      <Text variant="h4" as="h3" className="mb-1 font-bold">
        {title}
      </Text>
      <Text variant="bodySmall" as="p" tone="muted">
        {children}
      </Text>
    </div>
  );
}

// Looked up at render: the kinds register at start-up, after this module is evaluated.
const kindIcon = (kind: string | null): LucideIcon =>
  (kind === null ? null : findViewKind(kind))?.icon ?? FileText;

/** Every view the hero can show, captured from the demo by apps/web/scripts/capture-landing.mjs. */
const VIEWS: readonly {
  readonly id: string;
  readonly label: string;
  /** The view kind whose icon the tab shows; null for the note, which is not a view. */
  readonly kind: string | null;
  readonly src: string;
  readonly alt: string;
}[] = [
  {
    id: 'note',
    label: 'Notes',
    kind: null,
    src: '/landing/note.jpg',
    alt: 'A launch brief note with headings, a list and a table',
  },
  {
    id: 'board',
    label: 'Board',
    kind: 'board',
    src: '/landing/board.jpg',
    alt: 'Launch tasks as a board, in columns by status',
  },
  {
    id: 'list',
    label: 'List',
    kind: 'list',
    src: '/landing/list.jpg',
    alt: 'Launch tasks as a list with status, priority and due date',
  },
  {
    id: 'calendar',
    label: 'Calendar',
    kind: 'calendar',
    src: '/landing/calendar.jpg',
    alt: 'Launch tasks on a month calendar by due date',
  },
  {
    id: 'timeline',
    label: 'Timeline',
    kind: 'timeline',
    src: '/landing/timeline.jpg',
    alt: 'Launch tasks as bars on a quarter timeline',
  },
  {
    id: 'sheet',
    label: 'Spreadsheet',
    kind: 'sheet',
    src: '/landing/sheet.jpg',
    alt: 'Launch tasks as an editable spreadsheet',
  },
  {
    id: 'gallery',
    label: 'Gallery',
    kind: 'gallery',
    src: '/landing/gallery.jpg',
    alt: 'Launch tasks as gallery cards',
  },
  {
    id: 'checklist',
    label: 'Checklist',
    kind: 'checklist',
    src: '/landing/checklist.jpg',
    alt: 'Launch tasks as a checklist with ticked items',
  },
  {
    id: 'matrix',
    label: 'Matrix',
    kind: 'matrix',
    src: '/landing/matrix.jpg',
    alt: 'Priorities in an urgent and important matrix',
  },
  {
    id: 'outline',
    label: 'Outline',
    kind: 'outline',
    src: '/landing/outline.jpg',
    alt: 'Launch tasks as an outline with nested steps',
  },
  {
    id: 'chart',
    label: 'Chart',
    kind: 'chart',
    src: '/landing/chart.jpg',
    alt: 'A chart counting launch tasks by status',
  },
  {
    id: 'form',
    label: 'Form',
    kind: 'form',
    src: '/landing/form.jpg',
    alt: 'A form that adds a launch task',
  },
  {
    id: 'habits',
    label: 'Habit tracker',
    kind: 'habit_tracker',
    src: '/landing/habits.png',
    alt: 'Habit tracker view in Nix',
  },
  {
    id: 'companion',
    label: 'Companion',
    kind: 'chat',
    src: '/landing/companion.png',
    alt: 'Companion chat in Nix',
  },
];

/** The hero: one screenshot per view, chosen from a tab list (arrow keys move between tabs). */
function ViewGallery(): ReactNode {
  const [active, setActive] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = VIEWS[active] ?? VIEWS[0];
  const select = (index: number): void => {
    const next = (index + VIEWS.length) % VIEWS.length;
    setActive(next);
    tabs.current[next]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (step !== undefined) {
      event.preventDefault();
      select(active + step);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      select(event.key === 'Home' ? 0 : VIEWS.length - 1);
    }
  };
  if (current === undefined) return null;

  return (
    <div className="flex flex-col gap-4">
      <div
        role="tablist"
        aria-label="Views"
        className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0"
      >
        {VIEWS.map((view, index) => {
          const selected = index === active;
          return (
            <button
              key={view.id}
              ref={(element) => {
                tabs.current[index] = element;
              }}
              type="button"
              role="tab"
              id={`view-tab-${view.id}`}
              aria-selected={selected}
              aria-controls="view-panel"
              tabIndex={selected ? 0 : -1}
              onKeyDown={onKeyDown}
              onClick={() => {
                setActive(index);
              }}
              className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md border px-3 text-sm whitespace-nowrap outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent ${selected ? 'border-divider bg-foreground/7 text-foreground' : 'border-transparent text-muted hover:bg-foreground/5'}`}
            >
              <Icon icon={kindIcon(view.kind)} size="sm" />
              {view.label}
            </button>
          );
        })}
      </div>
      <div id="view-panel" role="tabpanel" aria-labelledby={`view-tab-${current.id}`}>
        <Shot src={current.src} alt={current.alt} large eager />
      </div>
    </div>
  );
}

/**
 * The front door for an install that turns it on (`landing` in web-config.json), after the landing
 * design. Shown only to an anonymous visitor at `/`; a deep link still gets sign-in.
 */
export function LandingPage({ onSignIn, demo }: LandingPageProps): ReactNode {
  const isBusy = useSessionStore(selectIsBusy);
  const signIn = (
    <button type="button" onClick={onSignIn} disabled={isBusy} className={SECONDARY}>
      {isBusy ? 'Redirecting…' : 'Sign in'}
    </button>
  );

  return (
    <div className="min-h-dvh bg-background text-md text-foreground">
      <header className={`border-b ${RULE}`}>
        <div className={`${PAGE} flex flex-wrap items-center gap-x-6 gap-y-1 py-3 sm:py-4`}>
          <a
            href="#top"
            className="mr-auto flex min-h-11 items-center font-heading text-xl font-bold text-foreground no-underline"
          >
            Nix
          </a>
          <nav
            aria-label="Primary"
            className="order-last flex w-full flex-wrap items-center gap-x-6 sm:order-none sm:w-auto"
          >
            <a href="#views" className={NAV_LINK}>
              Views
            </a>
            <a href="#agents" className={NAV_LINK}>
              AI agents
            </a>
            <a href="#own-it" className={NAV_LINK}>
              Own your data
            </a>
            <a href={REPOSITORY} className={NAV_LINK}>
              GitHub
            </a>
          </nav>
          <div className="flex items-center gap-3 sm:gap-6">
            <ThemeChoice inline />
            {signIn}
          </div>
        </div>
      </header>

      <main>
        <section id="top" className={`${PAGE} pt-14 pb-16 sm:pt-22`}>
          <div className="flex max-w-3xl flex-col gap-6">
            <Kicker>Free · open source · AGPL-3.0</Kicker>
            <Text variant="h1" as="h1" className={`${HERO} text-balance`}>
              Where people and their AI agents work together.
            </Text>
            <Text variant="body" as="p" tone="muted" className={`${LEAD} max-w-2xl text-pretty`}>
              Nix is a free, open-source workspace where people and their AI agents work together:
              notes, tasks, habits, calendars, spreadsheets, files and automations in one place. Run
              it yourself, bring the AI you already use, and take your data with you whenever you
              like.
            </Text>
            <div className="flex flex-wrap items-center gap-3 pt-2">
              {demo ? (
                <a href="/demo" className={PRIMARY}>
                  Open the live demo
                </a>
              ) : null}
              <a href={REPOSITORY} className={SECONDARY}>
                View on GitHub
              </a>
            </div>
          </div>
          <div className="mt-14">
            <ViewGallery />
          </div>
        </section>

        <section id="views" className={`border-t ${RULE}`}>
          <div className={`${PAGE} flex flex-col gap-12 py-20`}>
            <div className="flex max-w-2xl flex-col gap-3">
              <Kicker>One tree, many views</Kicker>
              <Text variant="h2" as="h2" className={`${SECTION_HEAD} text-balance`}>
                Keep the content. Change how you look at it.
              </Text>
              <Text variant="body" as="p" tone="muted" className="text-lg text-pretty">
                A note, canvas or spreadsheet is separate from how its children are shown. The same
                items can be a list, a board, a calendar, a timeline, a gallery, a chart, a habit
                tracker or a finance ledger.
              </Text>
            </div>
            <div className="grid gap-8 md:grid-cols-3">
              {[
                {
                  src: '/landing/calendar.jpg',
                  alt: 'Calendar view in Nix',
                  title: 'Calendar',
                  detail: 'Google and Outlook calendars sync both ways, with a visible log.',
                },
                {
                  src: '/landing/habits.png',
                  alt: 'Habit tracker view in Nix',
                  title: 'Habits',
                  detail:
                    'Automations create tasks and send reminders as quiet push notifications.',
                },
                {
                  src: '/landing/note.jpg',
                  alt: 'A rich note open in Nix',
                  title: 'Notes',
                  detail:
                    'Real-time editing with presence, version history and password-locked subtrees.',
                },
              ].map((figure) => (
                <figure key={figure.title} className="m-0 flex flex-col gap-3">
                  <Shot src={figure.src} alt={figure.alt} />
                  <figcaption>
                    <Text variant="h4" as="h3" className="font-bold">
                      {figure.title}
                    </Text>
                    <Text variant="bodySmall" as="p" tone="muted" className="mt-1">
                      {figure.detail}
                    </Text>
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        </section>

        <section id="agents" className={`border-y ${RULE} bg-surface`}>
          <div className={`${PAGE} flex flex-col gap-12 py-20`}>
            <div className="grid items-center gap-12 md:grid-cols-5">
              <div className="flex min-w-0 flex-col gap-4 md:col-span-2">
                <Kicker>AI agents</Kicker>
                <Text variant="h2" as="h2" className={`${SECTION_HEAD} text-balance`}>
                  Your agents work where you work. They ask before they act.
                </Text>
                <Text variant="body" as="p" tone="muted" className="text-lg text-pretty">
                  Every workspace has a companion that can do anything you can do in Nix. Bring your
                  own agents too: Claude, Codex or any MCP client reaches the same workspace through
                  the same permission checks as you.
                </Text>
              </div>
              <div className="min-w-0 md:col-span-3">
                <Shot
                  src="/landing/companion.png"
                  alt="The companion planning launch week: a generated table, approved changes and a remembered preference"
                  large
                />
              </div>
            </div>
            <div className={`grid border-t ${RULE} sm:grid-cols-2 lg:grid-cols-3`}>
              <Point title="Asks before it acts">
                Every change arrives as an approval card showing the exact request. Permanent
                deletes, access changes and publishing carry a warning.
              </Point>
              <Point title="Answers from your notes">
                It searches by meaning across the workspace, even a 200-page document, and links the
                notes it answered from.
              </Point>
              <Point title="Remembers what matters">
                It keeps the facts and preferences you tell it, asks before saving by default, and
                lets you edit or forget each one.
              </Point>
              <Point title="Replies you can use">
                Answers can be tables, charts and cards you can edit, and an approved change applies
                in place.
              </Point>
              <Point title="Your model, your key">
                Sign in with ChatGPT, or add an Anthropic or OpenRouter key. Search runs on a small
                model inside your server, with no key and no cost.
              </Point>
              <Point title="Every agent, every action">
                <code className="font-mono">nixctl</code> and its MCP server give AI tools every
                operation Nix has, except credentials, and nothing more than you could do.
              </Point>
            </div>
          </div>
        </section>

        <section id="own-it">
          <div className={`${PAGE} flex flex-col gap-12 py-20`}>
            <div className="flex max-w-2xl flex-col gap-3">
              <Kicker>Own it</Kicker>
              <Text variant="h2" as="h2" className={`${SECTION_HEAD} text-balance`}>
                Runs on your machine. Leaves whenever you do.
              </Text>
            </div>
            <div className="grid items-start gap-12 md:grid-cols-2">
              <div className={`grid min-w-0 border-t ${RULE} sm:grid-cols-2`}>
                <Point title="No lock-in">
                  Lossless .nix archives, plus PDF, DOCX and Markdown export. Markdown, DOCX, PDF
                  and Obsidian import.
                </Point>
                <Point title="Safe by construction">
                  Permissions are enforced by Postgres row-level security. The web app, CLI and MCP
                  server share one authorisation path.
                </Point>
                <Point title="Publish a subtree">
                  Turn part of your tree into a static site. The live demo and docs are one.
                </Point>
                <Point title="An HTTP API">
                  The same workspace is a REST API, with a published OpenAPI contract.
                </Point>
              </div>
              <div className="min-w-0">
                <Shot src="/landing/dark-theme.jpg" alt="Nix in its dark theme" large />
              </div>
            </div>
          </div>
        </section>

        <section className={`border-t ${RULE}`}>
          <div className={`${PAGE} flex flex-wrap items-center justify-between gap-6 py-18`}>
            <Text variant="h2" as="h2" className="max-w-xl font-bold text-balance">
              {demo ? 'See it before you install it.' : 'Already running Nix here?'}
            </Text>
            {demo ? (
              <a href="/demo" className={PRIMARY}>
                Open the live demo
              </a>
            ) : (
              signIn
            )}
          </div>
        </section>
      </main>

      <footer className={`border-t ${RULE}`}>
        <div className={`${PAGE} flex flex-wrap justify-between gap-x-6 gap-y-2 py-6`}>
          <Text variant="bodySmall" as="p" tone="muted" className="flex min-h-11 items-center">
            Nix is open source under AGPL-3.0.
          </Text>
          <nav aria-label="Project" className="flex flex-wrap gap-x-6 gap-y-2 text-base">
            <a
              href={REPOSITORY}
              className="flex min-h-11 items-center text-accent-text underline underline-offset-2"
            >
              Source
            </a>
            <a
              href={`${REPOSITORY}/releases/latest`}
              className="flex min-h-11 items-center text-accent-text underline underline-offset-2"
            >
              Releases
            </a>
            <a
              href={DOCS}
              className="flex min-h-11 items-center text-accent-text underline underline-offset-2"
            >
              Docs
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
