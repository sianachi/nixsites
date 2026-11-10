/* global document, fetch, getComputedStyle, HTMLElement, innerHeight, innerWidth, matchMedia, requestAnimationFrame, URL */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import process from 'node:process';

function localOrigin(value) {
  const url = new URL(value);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Use local Storybook.');
  assert(['http:', 'https:'].includes(url.protocol), 'Use an HTTP or HTTPS origin.');
  assert.equal(url.href, `${url.origin}/`, 'Use an origin without paths or credentials.');
  return url.origin;
}

function primaryStory(entry) {
  return /^(Nix\/(Views|Charts|Habits|Shell|Creation|Notification|Graph|Companions|Editor\/Writing modes)|Controls\/(Input|Select|Textarea|Menu|Popover|Dialog|Segmented))/.test(
    entry.title,
  );
}

function selectedStory(entry, supplemental = false) {
  return (
    entry.type === 'story' &&
    (supplemental ? entry.title.startsWith('Nix/') && !primaryStory(entry) : primaryStory(entry)) &&
    !entry.name.startsWith('Dark ') &&
    // Closed intentionally renders no screen, so there is no layout to inspect.
    entry.name !== 'Closed'
  );
}

if (process.argv.includes('--self-test')) {
  assert.equal(localOrigin('http://localhost:6107'), 'http://localhost:6107');
  for (const value of ['https://nix.example.org', 'http://localhost/w/test', 'ftp://localhost']) {
    assert.throws(() => localOrigin(value));
  }
  assert(selectedStory({ type: 'story', title: 'Nix/Views/Board', name: 'Long Labels' }));
  assert(selectedStory({ type: 'story', title: 'Nix/Charts', name: 'Line' }));
  assert(!selectedStory({ type: 'story', title: 'Nix/Views/Board', name: 'Dark Plans' }));
  assert(!selectedStory({ type: 'docs', title: 'Nix/Views/Board', name: 'Docs' }));
  assert(
    selectedStory(
      { type: 'story', title: 'Nix/Editor/Spatial canvas', name: 'Phone Canvas' },
      true,
    ),
  );
  assert(
    !selectedStory({ type: 'story', title: 'Nix/Views/Forms', name: 'Temporary Calculator' }, true),
  );
  assert(!selectedStory({ type: 'story', title: 'Controls/Dialog', name: 'Closed' }));
  process.stdout.write('Responsive layout configuration checks passed.\n');
  process.exit(0);
}

const repository = resolve(import.meta.dirname, '../..');
const requireFromWeb = createRequire(resolve(repository, 'apps/web/package.json'));
const { chromium } = requireFromWeb('playwright');
const origin = localOrigin(process.env.NIX_RESPONSIVE_STORYBOOK_URL ?? 'http://localhost:6107');
const response = await fetch(`${origin}/index.json`);
assert(response.ok, 'Storybook index is unavailable.');
const index = await response.json();
const filter = process.env.NIX_RESPONSIVE_STORY_FILTER;
const supplemental = process.argv.includes('--supplemental');
const stories = Object.values(index.entries).filter(
  (entry) =>
    selectedStory(entry, supplemental) && (filter === undefined || entry.id.includes(filter)),
);
assert(stories.length > 0, 'No matching layout stories.');
const matrixSizes = [
  [320, 740],
  [360, 800],
  [390, 844],
  [430, 932],
  [768, 1024],
  [844, 390],
  [1024, 768],
  [1440, 900],
];
const sizes = process.argv.includes('--phone')
  ? matrixSizes.slice(0, 1)
  : process.argv.includes('--desktop')
    ? matrixSizes.slice(-2)
    : matrixSizes;
const browser = await chromium.launch({ headless: true });
const failures = [];
let checked = 0;

try {
  for (const [width, height] of sizes) {
    const context = await browser.newContext({
      viewport: { width, height },
      hasTouch: width < 1024,
      isMobile: width < 1024,
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      globalThis.__nixResponsiveCoarsePointer = matchMedia('(any-pointer: coarse)').matches;
      let channel;
      Object.defineProperty(globalThis, '__STORYBOOK_ADDONS_CHANNEL__', {
        configurable: true,
        get: () => channel,
        set: (value) => {
          channel = value;
          value.on('storyFinished', (event) => {
            globalThis.__nixResponsiveStoryFinished = event;
          });
        },
      });
    });
    for (const story of stories) {
      const errors = [];
      const onError = (error) => errors.push(error.message);
      page.on('pageerror', onError);
      try {
        await page.goto(`${origin}/iframe.html?id=${story.id}&viewMode=story`, {
          waitUntil: 'domcontentloaded',
        });
        await page.locator('#storybook-root > *').first().waitFor({ timeout: 20_000 });
        await page.waitForFunction(
          (id) => globalThis.__nixResponsiveStoryFinished?.storyId === id,
          story.id,
          { timeout: 20_000 },
        );
        const finished = await page.evaluate(() => {
          const event = globalThis.__nixResponsiveStoryFinished;
          return {
            status: event.status,
            reporters: event.reporters
              .filter((report) => report.status === 'failed')
              .map((report) => ({
                type: report.type,
                violations: report.result?.violations?.map((violation) => ({
                  id: violation.id,
                  impact: violation.impact,
                  nodes: violation.nodes.map((node) => node.target),
                })),
              })),
          };
        });
        assert.equal(
          finished.status,
          'success',
          `Story checks failed: ${JSON.stringify(finished.reporters)}`,
        );
        await page.evaluate(
          () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
        );
        const issues = await page.evaluate((viewportWidth) => {
          const findings = [];
          if (innerWidth > viewportWidth + 1) {
            findings.push(`Layout viewport ${innerWidth} exceeds device width ${viewportWidth}`);
          }
          const describe = (element) =>
            `${element.tagName.toLowerCase()} ${element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 100) ?? ''}`;
          if (document.documentElement.scrollWidth > viewportWidth + 1) {
            findings.push(
              `Page width ${document.documentElement.scrollWidth} exceeds ${viewportWidth}`,
            );
          }
          for (const element of document.querySelectorAll('[data-pane-viewport]')) {
            if (element.scrollWidth > element.clientWidth + 1) {
              findings.push(`Pane scrolls horizontally: ${describe(element)}`);
            }
          }
          for (const element of document.querySelectorAll(
            'dialog[open],[popover]:popover-open,[role="menu"]',
          )) {
            const rect = element.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            if (rect.top < -1 || rect.bottom > innerHeight + 1) {
              findings.push(`Floating surface escapes vertically: ${describe(element)}`);
            }
          }
          for (const element of document.querySelectorAll(
            'button,input,textarea,select,[contenteditable="true"],[role="button"],a,dialog',
          )) {
            if (!(element instanceof HTMLElement) || element.closest('.sb-preparing-story'))
              continue;
            const rect = element.getBoundingClientRect();
            if (
              rect.width === 0 ||
              rect.height === 0 ||
              getComputedStyle(element).visibility === 'hidden'
            )
              continue;
            if (
              globalThis.__nixResponsiveCoarsePointer &&
              element.matches('input,textarea,select,[contenteditable="true"]') &&
              !element.matches(
                'input[type="checkbox"],input[type="radio"],input[type="range"],input[type="file"]',
              ) &&
              Number.parseFloat(getComputedStyle(element).fontSize) < 16
            ) {
              findings.push(`Editable text can trigger touch focus zoom: ${describe(element)}`);
            }
            if (element.tagName === 'BUTTON' && element.scrollHeight > element.clientHeight + 1) {
              for (const label of element.querySelectorAll('span,p')) {
                const textBox = label.getBoundingClientRect();
                if (
                  textBox.width > 1 &&
                  textBox.height > 1 &&
                  label.textContent?.trim() &&
                  !label.closest('.sr-only') &&
                  (textBox.top < rect.top - 1 || textBox.bottom > rect.bottom + 1)
                ) {
                  findings.push(`Button text is clipped: ${describe(element)}`);
                  break;
                }
              }
            }
            if (rect.left >= -1 && rect.right <= viewportWidth + 1) continue;
            let contained = false;
            for (let parent = element.parentElement; parent; parent = parent.parentElement) {
              const box = parent.getBoundingClientRect();
              const overflow = getComputedStyle(parent).overflowX;
              const grid = parent.parentElement?.querySelector('[role="grid"]');
              const followsGrid =
                overflow === 'hidden' &&
                element.getAttribute('aria-label')?.startsWith('Sort by ') &&
                grid &&
                /^(auto|scroll)$/.test(getComputedStyle(grid).overflowX);
              if (
                (/^(auto|scroll)$/.test(overflow) || followsGrid) &&
                parent.scrollWidth > parent.clientWidth + 1 &&
                box.left >= -1 &&
                box.right <= viewportWidth + 1
              ) {
                contained = true;
                break;
              }
            }
            if (!contained)
              findings.push(
                `Control escapes: ${describe(element)} [${Math.round(rect.left)},${Math.round(rect.right)}]`,
              );
          }
          return [...new Set(findings)];
        }, width);
        for (const issue of [...issues, ...errors]) {
          const failure = `${width}x${height} ${story.id}: ${issue}`;
          failures.push(failure);
          process.stdout.write(`${failure}\n`);
        }
      } catch (error) {
        if (page.isClosed() || !browser.isConnected()) throw error;
        const failure = `${width}x${height} ${story.id}: ${error.message.split('\n')[0]}`;
        failures.push(failure);
        process.stdout.write(`${failure}\n`);
      } finally {
        page.off('pageerror', onError);
        checked += 1;
      }
    }
    await context.close();
    process.stdout.write(`Checked ${stories.length} stories at ${width}x${height}.\n`);
  }
} finally {
  await browser.close();
}

process.stdout.write(`${checked} layout cases, ${failures.length} failures.\n`);
assert.equal(failures.length, 0, 'Responsive layout failures are listed above.');
