# Collaboration and offline

## Live collaboration

Notes, canvases and sheets are edited live. Several people can work in the same document at once, see each other's cursors and presence, and never overwrite each other's changes. Edits are merged with a CRDT and saved to an append-only log. A connection indicator shows whether your changes have reached the server.

Every edit is checked against your role when it arrives, and a session is re-authorised while it stays open, so removing someone from a workspace takes effect in documents they already have open.

## Roles

Each member of a workspace has one role: owner, editor, commenter or viewer. A commenter can read and comment on notes but cannot change them. A viewer can only read.

## Comments and suggesting

Comments are threaded. Select text in a note to comment on it, or start a thread on the note as a whole. You can reply, mention people, edit your comment, and resolve or reopen a thread. The **Comments** tab in the item's details lists the threads.

Suggesting mode records edits as suggestions that someone with edit rights can accept or reject, one at a time or all at once. Both are off until someone switches them on for a note, in the note's **Settings** tab (see [Items and views](nix://item/01a130b0-0d81-79b5-8927-e37cdc15a7d3)).

## Version history

Every document has a history built from its edit log.

- Browse revisions. A revision is a run of edits by one person without a long pause.
- See the document as it stood at any revision.
- Restore an earlier state. A restore is added as a new revision, so nothing is lost.
- Name a revision. Named versions are kept permanently, whatever the history retention.

## Phones, tablets and the desktop

On phones, Nix takes a compact shape: a floating top row with the Explorer, details and your profile, and a floating bottom bar for back, forward, find, new note and open tabs. Calendar, Inbox, your pet and Settings are in the bottom bar's menu. On a tablet the layout follows the window's shape: held upright it uses the phone layout, and held sideways it uses the desktop layout with touch-sized controls.

## The installed app

Install Nix from your browser to get an app with its own window, launch shortcuts for New note, Today and Search, a share target and a Markdown file handler. It remembers where you were and offers right-click menus and keyboard shortcuts like a desktop application. The installed web app needs a connection: without one it shows a reconnect screen, and it does not keep your notes.

## Apps with offline sync

Every app opens your server's own web app, so it stays in step with the server. The apps are not in an app store yet, so you build them from source (see the README).

| App | What it does |
| --- | --- |
| iOS (iPhone and iPad) | Full offline sync |
| Desktop (macOS, Windows, Linux) | The same offline sync, with sign-in in your normal browser. Early: unsigned, no automatic updates, and the Windows and Linux builds are untested |
| Android | The web app in a native shell. No offline sync and no passkey sign-in yet |

With offline sync, the app keeps a copy of every workspace you can reach: the item tree, properties, note text and files.

- **Read offline.** Everything opens without a connection, and the app shows a small Offline notice.
- **Edit offline.** You can edit note text, create notes, and create, rename, move, trash and edit the properties of items. Smart lists, charts, the calendar and habit trackers are recalculated from the offline copy. A view the app cannot recalculate exactly says it needs a connection.
- **Sync.** Changes sync when you reconnect, and shortly after you make them while online. Concurrent edits from other people merge rather than conflict, and a retried creation never produces a duplicate. The app shows how many changes are waiting and why a change was not applied. A change the server refuses is listed with a way to dismiss it, and the rest still go through.
- **Sync now.** **Settings > About** shows how much space the offline copy uses, when it last synced, and a **Sync now** button.

A few things to know:

- Restoring versions, changing protections, changing schemas and views, and creating structured items still need a connection.
- Password-locked notes are never stored offline.
- Signing out removes the offline copy. A copy on a device cannot learn that your access was revoked until it reconnects.
- A proxy or sign-in page that answers instead of Nix does not delete the copy; only a refusal from Nix itself does.
- Device storage is not a backup.

## Properties

- title: Collaboration and offline

