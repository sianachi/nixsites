import { isNixApiError, type SiteBuild } from '@nix/api-client';

/**
 * The words the Site pane uses for Core's refusals and the worker's failures. Codes are Core's
 * stable contract; the copy is ours, so a reworded server detail never changes what people read.
 */

const REFUSALS: Readonly<Record<string, string>> = {
  'sites.slug_taken': 'Another site already uses that address. Choose a different one.',
  'sites.slug_reserved': 'That address is reserved and cannot be used. Choose a different one.',
  'sites.hostname_taken': 'Another site already uses one of those hostnames.',
  'sites.hostname_reserved': 'One of those hostnames cannot be used for a site.',
  'sites.manager_required': 'Only a workspace owner can change or publish this site.',
  'sites.not_configured': 'Sites are not set up on this server.',
  'sites.exists': 'This item already has a site.',
  'sites.limit_reached': 'This account already has as many sites as it is allowed.',
  'sites.root_locked':
    'This item, or one it sits inside, is locked. Locked pages are never published.',
  'sites.root_unavailable':
    'This item cannot be published: it is in the trash, hidden, or left out of a site.',
  'sites.disclosure_required':
    'Confirm that you understand the site will be public before publishing it the first time.',
  'sites.build_in_progress':
    'A build, or a change to what is live, is already under way. Wait for it to finish.',
  'sites.too_many_pages': 'This site has more pages than one build can hold.',
  'sites.build_unavailable': 'That build can no longer be served again.',
  'sites.build_not_found': 'That build no longer exists.',
  'sites.not_published': 'The site is not live.',
  'sites.unpublish_first': 'Unpublish the site before deleting it.',
  'sites.purge_pending': 'The site’s files are still being removed. Try again in a minute.',
  'sites.path_taken': 'Another page already uses that path.',
  'sites.root_path_fixed': 'The home page’s path is always /.',
  'sites.page_not_found': 'That page is not part of the site.',
  'sites.item_outside_site': 'One of the chosen items is not inside this site.',
  'sites.not_found': 'This site no longer exists.',
};

/** What to tell somebody whose request Core refused, or that never reached Core. */
export function refusalMessage(error: unknown): string {
  if (!isNixApiError(error))
    return 'The request did not complete. Check your connection and try again.';
  const known = REFUSALS[error.code];
  if (known !== undefined) return known;
  if (error.code === 'sites.request_invalid')
    return error.detail === undefined
      ? 'Some settings are not valid.'
      : `Some settings are not valid. The server said: ${error.detail}`;
  return error.detail ?? 'The request did not complete. Try again.';
}

/** Whether a refusal means the item simply has no site yet. */
export function isNoSite(error: unknown): boolean {
  return isNixApiError(error) && error.code === 'sites.not_found';
}

const FAILURES: Readonly<Record<string, string>> = {
  site_manifest_invalid: 'The list of pages for this build was not valid.',
  site_body_withheld:
    'A page could not be read when the build ran, perhaps because it was locked or moved since.',
  site_image_corrupt: 'An image in the site could not be read.',
  site_render_failed: 'The pages could not be turned into a website.',
};

/** Why a build failed, in words, with what to do next. `hasLive` is whether a build is still served. */
export function failureMessage(build: SiteBuild, hasLive = true): string {
  const reason =
    (build.failureCode === null ? undefined : FAILURES[build.failureCode]) ??
    `The build failed${build.failureCode === null ? '' : ` (${build.failureCode})`}.`;
  return `${reason} ${hasLive ? 'Nothing live changed.' : 'Nothing was published.'} Publish again to retry.`;
}

/** The build's progress, as a sentence a live region can announce. */
export function progressMessage(build: SiteBuild): string {
  switch (build.status) {
    case 'queued':
      return 'Waiting for a worker to start the build.';
    case 'building':
      return `Building ${pages(build.pageCount)}.`;
    case 'sealed':
      return `Built ${pages(build.pageCount)}. Taking it live.`;
    case 'live':
      return `Live with ${pages(build.pageCount)}.`;
    case 'failed':
      return failureMessage(build);
    case 'superseded':
      return 'Replaced by a later build.';
    case 'purged':
      return 'Removed.';
  }
}

export function pages(count: number): string {
  return count === 1 ? '1 page' : `${String(count)} pages`;
}

/**
 * Loss lines arrive as `kind: detail`; the detail is the readable half. A line without a kind is
 * kept whole (the worker's own "N more were not listed").
 */
export function lossDetail(line: string): string {
  const match = /^[a-z][a-z-]*: (.+)$/.exec(line);
  return match?.[1] ?? line;
}
