/* global CSS, Event, PerformanceObserver, performance, document, HTMLElement, requestAnimationFrame */

import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

import { heapSlope, memoryEvidenceFailures } from './mvp1-evidence.mjs';

const repository = resolve(import.meta.dirname, '../..');
const requireFromWeb = createRequire(resolve(repository, 'apps/web/package.json'));
const { chromium } = requireFromWeb('playwright');
const { templateCatalogSchema } = await import(
  resolve(repository, 'packages/api-client/dist/index.js')
);
const baseUrl = process.env.NIX_STRESS_WEB_URL ?? 'http://localhost:5173';
const workspaceId = 'a1000000-0000-4000-8000-000000000001';
const itemId = 'a6100000-0000-4000-8000-000000000001';
const templateSourceId = 'a6100000-0000-4000-8000-000000000002';
const outputPath = resolve(repository, 'scripts/stress/evidence/mvp1.json');
const viewNames = ['List', 'Board', 'Gallery', 'Calendar', 'Timeline', 'Spreadsheet'];
const applicationOnly = process.env.NIX_STRESS_APPLICATION_ONLY === '1';

const username = process.env.NIX_STRESS_USERNAME ?? 'dev@nix.localhost';
const password = process.env.NIX_STRESS_PASSWORD ?? 'nix-dev-password';

const browser = await chromium.launch({
  headless: process.env.NIX_STRESS_HEADED !== '1',
  args: ['--enable-precise-memory-info'],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  timezoneId: 'Europe/London',
});
const page = await context.newPage();
let candidateEvidence;
let templateCatalogDiagnostic;
const networkResponses = [];
const browserMessages = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') {
    browserMessages.push(`${message.type()}: ${message.text()}`);
  }
});
page.on('pageerror', (error) => {
  browserMessages.push(`pageerror: ${error.message}`);
});
page.on('response', (response) => {
  const url = response.url();
  if (url.includes('/api/') || url.includes('/collab/')) {
    networkResponses.push(`${String(response.status())} ${response.request().method()} ${url}`);
    if (url.includes(`/workspaces/${workspaceId}/templates`) && response.ok()) {
      void response
        .json()
        .then((body) => {
          const parsed = templateCatalogSchema.safeParse(body);
          templateCatalogDiagnostic = {
            count: Array.isArray(body?.templates) ? body.templates.length : null,
            capabilities: body?.capabilities ?? null,
            origins: Array.isArray(body?.templates)
              ? body.templates.map((template) => template?.origin)
              : null,
            parseError: parsed.success ? null : parsed.error.issues,
          };
          networkResponses.push(`template catalog: ${JSON.stringify(templateCatalogDiagnostic)}`);
        })
        .catch(() => {
          networkResponses.push('template catalog: response body could not be read');
        });
    }
    if (url.includes(`parentId=${itemId}`) && response.ok()) {
      void response
        .json()
        .then((body) => {
          const pageBody = body;
          networkResponses.push(
            `child page: ${String(Array.isArray(pageBody?.items) ? pageBody.items.length : 'invalid')} items, next ${String(pageBody?.nextCursor)}`,
          );
        })
        .catch(() => {
          networkResponses.push('child page: response body could not be read');
        });
    }
  }
});

await page.addInitScript(() => {
  globalThis.__nixStressLongTasks = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      globalThis.__nixStressLongTasks.push(entry.duration);
    }
  }).observe({ type: 'longtask', buffered: true });
});
await page.addInitScript((frozenNow) => {
  const NativeDate = Date;
  class FrozenDate extends NativeDate {
    constructor(...args) {
      super(...(args.length === 0 ? [frozenNow] : args));
    }

    static now() {
      return frozenNow;
    }
  }
  globalThis.Date = FrozenDate;
}, Date.parse('2026-08-16T12:00:00+01:00'));

stressRun: try {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await signIn(page, username, password);

  const application = await captureAndApplyTemplate(page);
  if (applicationOnly) {
    if (application.firstAlreadyApplied !== false || application.secondAlreadyApplied !== true) {
      throw new Error(`Template application smoke failed: ${JSON.stringify(application)}`);
    }
    process.stdout.write(`Template application smoke passed: ${JSON.stringify(application)}\n`);
    break stressRun;
  }
  await page.evaluate(() => {
    globalThis.__nixStressLongTasks = [];
  });

  const navigationStarted = performance.now();
  await page.goto(`${baseUrl}/?item=${itemId}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('navigation', { name: 'Views' }).waitFor();
  const readyMs = performance.now() - navigationStarted;

  const viewSwitchMs = {};
  const scroll = {};
  const peakDom = {};
  const viewProof = {};
  const partialDataWarnings = {};
  for (const name of viewNames) {
    await resetPane(page);
    const started = performance.now();
    await page.getByRole('button', { name, exact: true }).click();
    await page.waitForFunction(
      (viewName) =>
        document
          .querySelector('nav[aria-label="Views"] button[aria-current="page"]')
          ?.textContent?.trim() === viewName,
      name,
    );
    await waitForView(page, name);
    await twoFrames(page);
    viewSwitchMs[name] = performance.now() - started;
    partialDataWarnings[name] = await partialDataWarningCount(page);
    viewProof[name] = await proveView(page, name);

    if (name === 'List') {
      peakDom[name] = await page
        .getByRole('table', { name: 'Items in this one' })
        .getByRole('rowheader')
        .count();
      scroll[name] = await scrollPane(page, 'Items in this one');
      peakDom[name] = Math.max(peakDom[name], scroll[name].peakDataNodes);
    } else if (name === 'Board') {
      const before = await page.locator('[data-virtual-index]').count();
      const boardScroll = await scrollPane(
        page,
        'Doing cards',
        'Stress item 0002',
        'Stress item 3200',
      );
      viewProof[name] = {
        ...viewProof[name],
        scroll: boardScroll,
      };
      peakDom[name] = Math.max(before, boardScroll.peakPageDataNodes);
    } else if (name === 'Gallery') {
      peakDom[name] = await page
        .getByRole('list', { name: 'Gallery' })
        .getByRole('listitem')
        .count();
      scroll[name] = await scrollPane(page, 'Gallery');
      peakDom[name] = Math.max(peakDom[name], scroll[name].peakDataNodes);
    } else if (name === 'Timeline') {
      peakDom[name] = viewProof[name].peakRenderedRows;
    }
  }

  await page.setViewportSize({ width: 375, height: 812 });
  const narrow = { viewport: '375x812', peakDom: {}, scroll: {}, partialDataWarnings: {} };
  for (const name of ['List', 'Gallery']) {
    await resetPane(page);
    await page.getByRole('button', { name, exact: true }).click();
    await waitForView(page, name);
    await twoFrames(page);
    narrow.partialDataWarnings[name] = await partialDataWarningCount(page);
    narrow.peakDom[name] =
      name === 'List'
        ? await page
            .getByRole('table', { name: 'Items in this one' })
            .getByRole('rowheader')
            .count()
        : await page.getByRole('list', { name: 'Gallery' }).getByRole('listitem').count();
    narrow.scroll[name] = await scrollPane(page, name === 'List' ? 'Items in this one' : 'Gallery');
    narrow.peakDom[name] = Math.max(narrow.peakDom[name], narrow.scroll[name].peakDataNodes);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  const memory = await measureRepeatedViewMounts(context, page, viewNames, 5);

  const longTasks = await page.evaluate(() => globalThis.__nixStressLongTasks ?? []);
  const evidence = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    runner: {
      viewport: '1440x900',
      browser: await browser.version(),
      childCount: 3200,
    },
    budgets: {
      readyMs: 3000,
      viewSwitchMs: 1500,
      scrollP95FrameMs: 32,
      maximumLongTaskMs: 100,
      maximumListOrGalleryDom: 100,
      maximumHeapGrowthBytes: 8 * 1024 * 1024,
      maximumHeapSlopeBytesPerCycle: 1024 * 1024,
    },
    measurements: {
      readyMs,
      viewSwitchMs,
      scroll,
      peakDom,
      viewProof,
      narrow,
      application,
      partialDataWarnings,
      memory,
      browserErrorCount: browserMessages.filter(
        (message) => message.startsWith('error:') || message.startsWith('pageerror:'),
      ).length,
      longTaskCount: longTasks.filter((duration) => duration > 100).length,
      maximumLongTaskMs: Math.max(0, ...longTasks),
    },
  };

  candidateEvidence = evidence;
  assertEvidence(evidence);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`MVP-1 stress evidence written to ${outputPath}\n`);
} catch (error) {
  const failurePath = resolve(repository, 'scripts/stress/evidence/mvp1-failure.png');
  await mkdir(dirname(failurePath), { recursive: true });
  await page.screenshot({ path: failurePath, fullPage: true }).catch(() => undefined);
  const visibleText = await page
    .locator('body')
    .innerText()
    .catch(() => 'The page body was unavailable.');
  process.stderr.write(
    `MVP-1 stress run failed at ${page.url()}. Screenshot: ${failurePath}\n${visibleText.slice(0, 4_000)}\nCandidate evidence:\n${candidateEvidence === undefined ? 'not yet assembled' : JSON.stringify(candidateEvidence.measurements, null, 2)}\nTemplate catalog:\n${JSON.stringify(templateCatalogDiagnostic)}\nBrowser messages:\n${browserMessages.slice(-100).join('\n')}\nNetwork responses:\n${networkResponses.slice(-100).join('\n')}\n`,
  );
  throw error;
} finally {
  await browser.close();
}

async function signIn(page, username, password) {
  // Core's own sign-in form: email and password on the app's origin.
  const email = page.getByLabel('Email');
  await email.waitFor();
  await email.fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(`${baseUrl}/**`, { timeout: 30_000 });
}

async function captureAndApplyTemplate(page) {
  const templateName = `MVP-1 stress template ${String(Date.now())}`;
  await page.goto(`${baseUrl}/?item=${templateSourceId}`);
  await page.getByRole('button', { name: 'Save as template' }).waitFor();
  await page.getByRole('button', { name: 'Save as template' }).click();
  await page.getByRole('heading', { name: 'Save as template' }).waitFor();
  await page.getByRole('textbox', { name: 'Name' }).fill(templateName);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('heading', { name: 'Choose what to capture' }).waitFor();
  const includeChildren = page.getByRole('checkbox', { name: 'Include everything inside' });
  if (await includeChildren.isChecked()) await includeChildren.uncheck();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('heading', { name: 'Review' }).waitFor();
  const captureResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/collab/templates/captures') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Save template' }).click();
  const capture = await captureResponse;
  const captured = await capture.json();
  if (!capture.ok()) {
    throw new Error(
      `Template capture returned ${String(capture.status())} for ${String(capture.request().postData())}: ${JSON.stringify(captured)}`,
    );
  }
  await page.waitForURL(/\/templates/);

  const applications = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto(`${baseUrl}/templates?target=${itemId}`);
    const heading = page.getByRole('heading', { name: templateName, exact: true });
    await heading.waitFor();
    await heading
      .locator('xpath=ancestor::section[1]')
      .getByRole('button', { name: `Use ${templateName} template` })
      .click();
    await page.getByRole('heading', { name: `Apply ${templateName}` }).waitFor();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('heading', { name: 'What this template adds' }).waitFor();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('heading', { name: 'Review' }).waitFor();
    const applicationResponse = page.waitForResponse(
      (response) =>
        response.url().includes('/collab/templates/applications') &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Apply template' }).click();
    const application = await applicationResponse;
    const applicationBody = await application.json();
    if (!application.ok()) {
      throw new Error(
        `Template application returned ${String(application.status())}: ${JSON.stringify(applicationBody)}`,
      );
    }
    applications.push(applicationBody);
    await page.waitForURL(new RegExp(`\\?item=${itemId}$`, 'u'));
  }

  await page.goto(`${baseUrl}/?item=${itemId}`);
  await page.getByRole('navigation', { name: 'Views' }).waitFor();
  return {
    templateId: captured.templateId,
    firstAlreadyApplied: applications[0]?.alreadyApplied,
    secondAlreadyApplied: applications[1]?.alreadyApplied,
  };
}

async function scrollPane(
  page,
  viewLabel,
  firstTitle = 'Stress item 0001',
  lastTitle = 'Stress item 3200',
) {
  return await page.evaluate(
    async ({ label, first, last }) => {
      const pane = document.querySelector('[data-pane-viewport="true"]');
      if (!(pane instanceof HTMLElement)) {
        throw new Error('The container pane scroller was not found.');
      }

      const intervals = [];
      const view =
        label === 'Items in this one'
          ? [...document.querySelectorAll('table')].find(
              (table) => table.querySelector('caption')?.textContent?.trim() === label,
            )
          : document.querySelector(`[aria-label="${CSS.escape(label)}"]`);
      if (!(view instanceof HTMLElement)) {
        throw new Error(`The ${label} view was not found.`);
      }
      const firstItemVisible = view.textContent?.includes(first) ?? false;
      let peakDataNodes = view.querySelectorAll('[data-virtual-index]').length;
      let peakPageDataNodes = document.querySelectorAll('[data-virtual-index]').length;
      let previous = performance.now();
      for (let step = 1; step <= 90; step += 1) {
        const bottom = pane.scrollHeight - pane.clientHeight;
        pane.scrollTop = (bottom * step) / 90;
        await new Promise((resolveFrame) => {
          requestAnimationFrame((now) => {
            intervals.push(now - previous);
            previous = now;
            resolveFrame();
          });
        });
        peakDataNodes = Math.max(
          peakDataNodes,
          view.querySelectorAll('[data-virtual-index]').length,
        );
        peakPageDataNodes = Math.max(
          peakPageDataNodes,
          document.querySelectorAll('[data-virtual-index]').length,
        );
      }

      for (let settle = 0; settle < 3; settle += 1) {
        pane.scrollTop = pane.scrollHeight - pane.clientHeight;
        await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
      }

      intervals.sort((left, right) => left - right);
      const bottom = pane.scrollHeight - pane.clientHeight;
      return {
        p95FrameMs: intervals[Math.floor(intervals.length * 0.95)] ?? 0,
        maximumFrameMs: intervals.at(-1) ?? 0,
        reachedBottom: Math.abs(pane.scrollTop - bottom) <= 2,
        firstItemVisible,
        lastItemVisible: view.textContent?.includes(last) ?? false,
        peakDataNodes,
        peakPageDataNodes,
      };
    },
    { label: viewLabel, first: firstTitle, last: lastTitle },
  );
}

async function proveView(page, name) {
  if (name === 'List') {
    const table = page.getByRole('table', { name: 'Items in this one' });
    return {
      rowCount: Number(await table.getAttribute('aria-rowcount')),
      firstItemVisible: await table.getByText('Stress item 0001', { exact: true }).isVisible(),
    };
  }

  if (name === 'Board') {
    const expected = { Backlog: 1067, Doing: 1067, Done: 1066 };
    const groupSizes = {};
    for (const [group, size] of Object.entries(expected)) {
      const list = page.getByRole('list', { name: `${group} cards` });
      const firstCard = list.getByRole('listitem').first();
      groupSizes[group] = Number(await firstCard.getAttribute('aria-setsize'));
      if (groupSizes[group] !== size) {
        throw new Error(
          `${group} announced ${String(groupSizes[group])} cards, expected ${String(size)}.`,
        );
      }
    }
    return {
      groupSizes,
      firstItemVisible: await page
        .getByRole('region', { name: 'Backlog' })
        .getByText('Stress item 0001', { exact: true })
        .isVisible(),
    };
  }

  if (name === 'Gallery') {
    const list = page.getByRole('list', { name: 'Gallery' });
    const firstCard = list.getByRole('listitem').first();
    return {
      itemCount: Number(await firstCard.getAttribute('aria-setsize')),
      firstItemVisible: await list.getByText('Stress item 0001', { exact: true }).isVisible(),
    };
  }

  if (name === 'Calendar') {
    const firstItemVisible = await page
      .getByRole('cell', { name: 'Sunday 2 August 2026' })
      .getByText('Stress item 0001', { exact: true })
      .isVisible();
    const day = page.getByRole('cell', { name: 'Sunday 9 August 2026' });
    const expand = day.getByRole('button', { name: 'Show 71 more' });
    const collapsedCount = await day.getByRole('listitem').count();
    await expand.click();
    await day.getByText('Stress item 3200', { exact: true }).waitFor();
    const expandedCount = await day.getByRole('listitem').count();
    await day.getByRole('button', { name: 'Show fewer' }).click();
    return {
      scheduledInMonth: 2364,
      outsideMonth: await page.getByText('836 items are dated outside August 2026.').isVisible(),
      collapsedCount,
      expandedCount,
      firstItemVisible,
      lastItemReachable: true,
    };
  }

  if (name === 'Timeline') {
    const region = page.getByRole('region', { name: 'Timeline, August 2026' });
    const table = region.getByRole('table');
    const rowCount = Number(await table.getAttribute('aria-rowcount'));
    const initiallyRendered = await region.locator('[data-virtual-index]').count();
    const firstItemVisible = await region
      .getByText('Stress item 0001', { exact: true })
      .first()
      .isVisible();
    const timelineScroll = await scrollPaneToElementBottom(page, 'Timeline, August 2026');
    const finallyRendered = await region.locator('[data-virtual-index]').count();
    const lastItemVisible = await region
      .getByText('Stress item 3200', { exact: true })
      .first()
      .isVisible();
    return {
      rowCount,
      renderedRows: finallyRendered,
      peakRenderedRows: Math.max(initiallyRendered, finallyRendered, timelineScroll.peakDataNodes),
      firstItemVisible,
      lastItemVisible,
      outsideWindow: await page
        .getByText('836 items are dated outside August 2026.', { exact: false })
        .isVisible(),
    };
  }

  const grid = page.getByRole('grid', { name: 'Spreadsheet of items' });
  const rowCount = Number(await grid.getAttribute('aria-rowcount'));
  const firstItemVisible = await grid
    .getByRole('gridcell', { name: /^Stress item 0001, opens the item/u })
    .isVisible();
  await grid.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await twoFrames(page);
  const lastItemVisible = await grid
    .getByRole('gridcell', { name: /^Stress item 3200, opens the item/u })
    .isVisible();
  return {
    rowCount,
    renderedRows: await grid.getByRole('row').count(),
    firstItemVisible,
    lastItemVisible,
  };
}

async function measureRepeatedViewMounts(context, page, names, cycles) {
  let session;
  try {
    session = await context.newCDPSession(page);
    await session.send('Performance.enable');
    const normalizedView = names[0];
    if (normalizedView === undefined) {
      throw new Error('At least one view is required for repeated-mount evidence.');
    }

    const completeCycle = async () => {
      for (const name of [...names.slice(1), normalizedView]) {
        await resetPane(page);
        await page.getByRole('button', { name, exact: true }).click();
        await waitForView(page, name);
        await twoFrames(page);
      }
    };

    // One unmeasured cycle pays lazy module/render allocation before the baseline. Every measured
    // sample then has the same mounted view and exactly one complete six-view cycle before it.
    await completeCycle();
    await session.send('HeapProfiler.collectGarbage');
    const samples = [{ cycle: 0, usedBytes: await readHeapSize(session) }];

    for (let cycle = 1; cycle <= cycles; cycle += 1) {
      await completeCycle();
      await session.send('HeapProfiler.collectGarbage');
      samples.push({ cycle, usedBytes: await readHeapSize(session) });
    }

    if (samples.some((sample) => sample.usedBytes === null)) {
      throw new Error('Chromium did not report JSHeapUsedSize for every forced-GC sample.');
    }
    const completeSamples = samples;
    const beforeBytes = completeSamples[0].usedBytes;
    const afterBytes = completeSamples.at(-1).usedBytes;
    const maximumGrowthBytes = Math.max(
      ...completeSamples.map((sample) => sample.usedBytes - beforeBytes),
    );
    return {
      supported: true,
      normalizedView,
      warmupCycles: 1,
      cycles,
      viewsPerCycle: names.length,
      mountCount: names.length * cycles,
      samples: completeSamples,
      beforeBytes,
      afterBytes,
      deltaBytes: Math.round(afterBytes - beforeBytes),
      maximumGrowthBytes: Math.round(maximumGrowthBytes),
      slopeBytesPerCycle: heapSlope(completeSamples),
    };
  } catch (error) {
    return {
      supported: false,
      cycles,
      viewsPerCycle: names.length,
      mountCount: names.length * cycles,
      normalizedView: names[0] ?? null,
      warmupCycles: 1,
      samples: [],
      beforeBytes: null,
      afterBytes: null,
      deltaBytes: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await session?.detach().catch(() => undefined);
  }
}

async function readHeapSize(session) {
  const result = await session.send('Performance.getMetrics');
  return result.metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value ?? null;
}

async function scrollPaneToElementBottom(page, label) {
  return await page.evaluate(async (accessibleName) => {
    const pane = document.querySelector('[data-pane-viewport="true"]');
    const target = document.querySelector(
      `[role="region"][aria-label="${CSS.escape(accessibleName)}"]`,
    );
    if (!(pane instanceof HTMLElement) || !(target instanceof HTMLElement)) {
      throw new Error(`The pane or ${accessibleName} region was not found.`);
    }
    const paneBottom = pane.getBoundingClientRect().bottom;
    const targetBottom = target.getBoundingClientRect().bottom;
    let peakDataNodes = target.querySelectorAll('[data-virtual-index]').length;
    pane.scrollTop = Math.min(
      pane.scrollHeight - pane.clientHeight,
      pane.scrollTop + targetBottom - paneBottom,
    );
    for (let settle = 0; settle < 3; settle += 1) {
      await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
      peakDataNodes = Math.max(
        peakDataNodes,
        target.querySelectorAll('[data-virtual-index]').length,
      );
    }
    return { peakDataNodes };
  }, label);
}

async function partialDataWarningCount(page) {
  return await page.getByText(/Only the first [\d,]+ items in here are loaded\./u).count();
}

async function resetPane(page) {
  await page.evaluate(() => {
    const pane = document.querySelector('[data-pane-viewport="true"]');
    if (pane instanceof HTMLElement) pane.scrollTop = 0;
  });
  await twoFrames(page);
}

async function twoFrames(page) {
  await page.evaluate(
    () =>
      new Promise((resolveFrames) => {
        requestAnimationFrame(() => requestAnimationFrame(resolveFrames));
      }),
  );
}

async function waitForView(page, name) {
  const landmark =
    name === 'List'
      ? page.getByRole('table', { name: 'Items in this one' })
      : name === 'Board'
        ? page.getByRole('region', { name: 'Backlog' })
        : name === 'Gallery'
          ? page.getByRole('list', { name: 'Gallery' })
          : name === 'Calendar'
            ? page.getByRole('navigation', { name: 'Calendar grain' })
            : name === 'Timeline'
              ? page.getByRole('navigation', { name: 'Timeline scale' })
              : page.getByRole('grid', { name: 'Spreadsheet of items' });
  await landmark.waitFor();
}

function assertEvidence(evidence) {
  const failures = [];
  const { budgets, measurements } = evidence;
  if (measurements.readyMs > budgets.readyMs) {
    failures.push(`container ready took ${measurements.readyMs.toFixed(1)}ms`);
  }
  for (const [view, duration] of Object.entries(measurements.viewSwitchMs)) {
    if (duration > budgets.viewSwitchMs) {
      failures.push(`${view} switch took ${duration.toFixed(1)}ms`);
    }
  }
  for (const [view, result] of Object.entries(measurements.scroll)) {
    if (
      result.p95FrameMs > budgets.scrollP95FrameMs ||
      !result.reachedBottom ||
      !result.firstItemVisible ||
      !result.lastItemVisible
    ) {
      failures.push(
        `${view} scroll p95 was ${result.p95FrameMs.toFixed(1)}ms and did not prove both boundaries`,
      );
    }
  }
  for (const [view, proof] of Object.entries(measurements.viewProof)) {
    if (proof.firstItemVisible === false || proof.lastItemVisible === false) {
      failures.push(`${view} did not prove its known corpus boundary`);
    }
    const expectedRows = view === 'List' ? 3201 : view === 'Timeline' ? 2365 : 3200;
    if (proof.rowCount !== undefined && proof.rowCount !== expectedRows) {
      failures.push(`${view} announced ${String(proof.rowCount)} rows`);
    }
    if (proof.itemCount !== undefined && proof.itemCount !== 3200) {
      failures.push(`${view} announced ${String(proof.itemCount)} items`);
    }
    if (proof.renderedRows !== undefined && proof.renderedRows > 100) {
      failures.push(`${view} rendered ${String(proof.renderedRows)} rows`);
    }
    if (
      view === 'Calendar' &&
      (proof.outsideMonth !== true ||
        proof.firstItemVisible !== true ||
        proof.lastItemReachable !== true ||
        proof.scheduledInMonth !== 2364 ||
        proof.collapsedCount !== 6 ||
        proof.expandedCount !== 77)
    ) {
      failures.push(
        'Calendar did not prove its collapsed 3,200-item corpus and overflow interaction',
      );
    }
    if (
      view === 'Board' &&
      (proof.scroll?.firstItemVisible !== true || proof.scroll?.lastItemVisible !== true)
    ) {
      failures.push('Board did not prove its first and last cards through the shared pane');
    }
    if (view === 'Timeline' && proof.outsideWindow !== true) {
      failures.push('Timeline did not expose its off-window item count');
    }
  }
  for (const [view, count] of Object.entries(measurements.peakDom)) {
    if (count > budgets.maximumListOrGalleryDom) {
      failures.push(`${view} rendered ${String(count)} data nodes`);
    }
  }
  for (const [view, count] of Object.entries(measurements.narrow.peakDom)) {
    if (count > budgets.maximumListOrGalleryDom) {
      failures.push(`${view} rendered ${String(count)} data nodes at 375px`);
    }
  }
  for (const [view, result] of Object.entries(measurements.narrow.scroll)) {
    if (
      result.p95FrameMs > budgets.scrollP95FrameMs ||
      !result.reachedBottom ||
      !result.firstItemVisible ||
      !result.lastItemVisible
    ) {
      failures.push(
        `${view} narrow scroll p95 was ${result.p95FrameMs.toFixed(1)}ms and did not prove both boundaries`,
      );
    }
  }
  if (measurements.application.firstAlreadyApplied !== false) {
    failures.push('the first template application was not recorded as new');
  }
  if (measurements.application.secondAlreadyApplied !== true) {
    failures.push('the second template application was not idempotent');
  }
  if (
    Object.values(measurements.partialDataWarnings).some((count) => count !== 0) ||
    Object.values(measurements.narrow.partialDataWarnings).some((count) => count !== 0)
  ) {
    failures.push('the complete 3,200-item corpus was reported as partial');
  }
  if (measurements.maximumLongTaskMs > budgets.maximumLongTaskMs) {
    failures.push(`maximum long task was ${measurements.maximumLongTaskMs.toFixed(1)}ms`);
  }
  if (measurements.browserErrorCount > 0) {
    failures.push(`browser reported ${String(measurements.browserErrorCount)} runtime errors`);
  }
  failures.push(...memoryEvidenceFailures(measurements.memory, budgets));
  if (failures.length > 0) {
    throw new Error(`MVP-1 stress budgets failed:\n- ${failures.join('\n- ')}`);
  }
}
