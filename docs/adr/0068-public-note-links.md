# ADR-0068: Public note links read live through Core

## Status

Accepted by owner decision, 6 November 2026. Narrows the rule in AGENTS.md that anonymous readers
never reach Core: that rule still holds for published sites; public forms already reach Core, and
public links join them.

## Context

A public link lets someone without an account read one note or file. A published site is a static
build, so its readers need nothing live. A link to a note must show the note as it is now and stop
the moment the link is revoked, the note is trashed or locked, or a file is no longer approved.
A static copy cannot do that.

## Decision

- `GET /public/v1/links/{token}` reaches Core. Core verifies the token against a live link row and
  acts as a read-only service principal bound to the link, never as the person who made it.
- Core asks collaboration to render the note body. The shared secret only says which service is
  calling. Collaboration calls back to Core to confirm the link, and again to classify every file
  the body names, before it emits markup.
- The renderer is `renderProse` from `packages/site-render`, which escapes its output. Before it
  runs, embedded items are removed, item links and mentions become plain text, and only accepted
  content is drawn: pending suggestions are rejected. Comments, properties and children are never
  emitted.
- File rule. An attachment or file reference downloads only if the file has an approved version,
  and serves the latest approved one. An inline image serves its approved version, else its current
  version if it is PNG, JPEG, WebP or AVIF. Anything else shows its name with a note that it is not
  available, and is listed as withheld to the person managing the link. A file that is trashed,
  locked, in another workspace or not a file shows a neutral placeholder and no name.
- Files are served by `GET /public/v1/links/{token}/files/{fileItemId}`. Core re-renders the note,
  requires the id in the servable set of the current body, and redirects to a signed URL that lives
  60 seconds. Responses are `no-store` and `noindex`. Every dead path answers the same way.

## Consequences

- Anonymous traffic now costs a Core request and a collaboration render per view and per file. The
  public-link rate limit bounds it. Caching is deliberately absent so revocation is immediate.
- Because a note link is live, an image added to the note later becomes public. This is documented
  for people creating links.
- A revoked link stops note text at once and new file downloads within 60 seconds. A transfer
  already under way may finish.
- Item link and mention labels are body text and appear as written.
