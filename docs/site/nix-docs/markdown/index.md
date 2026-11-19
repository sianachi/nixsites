# Nix

Nix is a free, open-source workspace where people and their AI agents work together: notes, tasks, habits, calendars, spreadsheets, files and automations in one place. Run it on your own server, or try the [live demo](https://nixsites.com/demo) first.

Everything in Nix is an item. A note, a project, a reading list and a trip plan are the same kind of thing: an item with an optional body, a set of properties and any number of children. What changes is how you look at those children. The same tasks can be a list on Monday, a board on Tuesday and a calendar on Friday, without copying anything.

## What you can do with it

- **Write.** Rich collaborative notes with headings, tables, callouts, columns, collapsible sections, code, images and Mermaid diagrams. Optional Vim and Emacs keyboard modes.
- **Structure.** Give a container fields that cascade to everything inside it, then add formulas, rollups and charts.
- **See things differently.** List, board, calendar, gallery, timeline, spreadsheet, chart, form, interactive form, smart list, checklist, matrix, outline, drive, chat, custom and habit tracker views over the same children. The [landing page](https://nixsites.com/#views) shows them in light and dark, on desktop and phone.
- **Plan.** Due dates, recurring tasks, reminders with quiet hours, automations and two-way sync with Google Calendar and Microsoft Outlook.
- **Draw and calculate.** Canvas bodies for diagrams and whiteboards, spreadsheet bodies with A1 formulas.
- **Work with AI.** Every workspace has a companion that can do anything you can do in Nix and asks before it changes anything. It searches your notes by meaning, answers with tables and charts you can edit, and remembers what you ask it to.
- **Work together.** Real-time editing, comments, suggesting mode and a Commenter role, on desktop, or on your phone and tablet.
- **Bring your own agents.** `nixctl` gives you every operation from a terminal, with JSON output, and its MCP server gives agents such as Claude and Codex the same reach, under the same permissions as you. Hosted clients such as claude.ai and ChatGPT can connect with a sign-in and a consent page.
- **Leave whenever you like.** Export a page or a whole subtree as a lossless `.nix` archive, Markdown, PDF or Word, with any losses reported before you export.
- **Sign in without extra software.** Nix signs people in itself, with a password and an authenticator code as a second step, or with a passkey, so a self-hosted install needs no separate identity provider.
- **Publish.** Turn any page tree into a static website. This site is one.

## Apps

Nix runs in any modern browser, and you can install the web app on your phone or computer. Apps for iOS, Android, macOS, Windows and Linux open your server's own web app. iOS and the desktop apps keep a full offline copy of your workspaces. The desktop apps are early builds from source: unsigned, with no automatic updates, and the Windows and Linux builds are untested. The Android app has no offline sync yet. None of them is in an app store, and the [landing page](https://nixsites.com/#apps) shows each as "Coming soon" or "Early build, from source".

Nix is open source. If it is useful to you, a [star on GitHub](https://github.com/sianachi/nixsites) helps other people find it.

## Why it is built this way

**A life is split across too many tools.** Notes, tasks, dates, habits and files usually live in separate applications that do not talk to each other. Nix keeps them in one tree.

**AI should work where you work, and ask first.** An assistant is most useful when it can see and change your real notes and tasks, and safest when every change is shown to you before it happens.

**Rigid hierarchies do not match real work.** Separating an item's body from its views means structure follows what you need, not what the app was designed for.

**Permission failures are security failures.** Roles live in the database, permission checks happen while queries run, and the web app, the CLI and MCP all go through the same authorisation path.

**Self-hosted software should be safe to operate.** Nix ships CI-built images for amd64 and arm64, keeps derived data rebuildable, and reports partial or lossy results instead of implying success.

## Properties

- title: Nix

