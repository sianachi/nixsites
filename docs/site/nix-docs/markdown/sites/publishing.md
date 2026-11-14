# Publishing

Publishing turns the current state of a page tree into a fixed set of files, writes them to storage, and then switches the site's addresses to the new build in one step. Readers see either the old build or the new one, never a mixture.

## What is eligible

A build starts at the root and walks down the tree. An item is left out, together with everything under it, when it is:

- in the trash or archived;
- a template;
- excluded from the site;
- under a password lock, whoever has it open: a page you have unlocked in your own browser is still not published;
- a post in a dated collection whose date is empty, unreadable or in the future.

A site whose root is locked, trashed or not visible to you cannot be published at all. A build can hold up to 5,000 pages.

The build runs as the person who publishes, within what that person can read. Files are checked by the same rules: only files inside the published tree, and only PNG, JPEG, WebP and SVG images and PDF, TXT and CSV downloads, are copied.

## The lifecycle

1. **Request.** A manager publishes from the Site panel or with `nixctl site publish`. The first publish, and the first after an unpublish, must confirm that the content will become public and may be copied. Only one build or activation can run at a time.
2. **Approval, where required.** If the instance requires operator approval, that first publish waits. The manager asks for approval; an operator approves or rejects it with a note the managers can read. On approval the publish runs as the manager who asked, and their rights are checked again at that moment. Later publishes of a live site do not need approval.
3. **The build manifest.** Core works out the eligible pages and freezes them into a build manifest: the site settings, layout, canonical address, dated collections, redirects and one row per page with its path, title, properties, views and the exact revision of its body. Once written, the manifest does not change. Edits made after this point belong to the next build.
4. **The build.** A separate sites worker picks the job up from RabbitMQ. It reads the manifest through Core's internal routes, using a credential tied to that one job, reads each body at the pinned revision from the collaboration service, and fetches files through short-lived signed links that Core issues only for files the manifest allows. It renders every page, feed, sitemap and search index in memory. If any page body cannot be read, the build fails rather than publishing an incomplete site.
5. **Upload.** The worker never chooses where files go. For each file, Core derives the storage key and signs a create-only upload bound to the file's exact size and checksum. Pages are written under a directory for the build; images and downloads are stored once by their content hash and shared between builds.
6. **Seal.** Core checks the uploaded build against what the worker reported: the number of files, the total size, the home page and the digest of the build index. Only a build that matches is sealed.
7. **Go live.** Core writes a small host manifest for each of the site's served hostnames, naming the build to serve. The worker writes these last, so an interrupted build is never served. The serving process picks up the change within about ten seconds, and ignores a host manifest older than the one it already has.

The previous live build becomes superseded. Nix keeps the five most recent builds by default and deletes older superseded and failed builds in the background.

## Rolling back

You can roll a live site back to any superseded build that has not yet been deleted. The host manifests are rewritten to point at it, and it is served exactly as it was built, including pages that have since been locked, trashed or left out. Publish again to bring the site up to date.

## Unpublishing

Unpublishing removes the host manifests, so the site stops answering, and deletes all of its builds. The site's settings remain, and publishing again starts afresh, with approval if the instance requires it. Copies that search engines, archives or readers made while the site was public are outside Nix's control.

A site can only be deleted when it is not live. Deleting it also removes any DNS records Nix created for its hostnames.

## Republish modes

| Mode | What happens |
| --- | --- |
| Manual (manual) | The site changes only when a manager publishes |
| Automatic (auto) | A confirmed edit anywhere in the tree, including moving something to the trash, schedules a rebuild after a settling delay of 1 minute to 1 hour (5 minutes by default) |
| On release (on\_release) | Meant for product documentation that should change when the Nix server is updated. Nix schedules nothing for these sites: whoever runs a release publishes them as one of its steps, for example with nixctl site publish |

Automatic builds run as the manager who switched automatic mode on, and include only what that person can read. If that person leaves the workspace or stops being a manager, the site falls back to manual and the change is recorded in the audit log. Switching to automatic from `nixctl` needs `--yes`, because every saved edit will then become public.

Every publish, rollback, unpublish and approval decision is written to the audit log, as are hostname and path changes.

## Properties

- title: Publishing

