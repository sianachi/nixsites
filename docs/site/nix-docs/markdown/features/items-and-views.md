# Items and views

## One kind of item

Every item can hold children. There is no special folder type: a note can contain sub-notes, a canvas can contain tasks, and a spreadsheet can contain a reading list. You can nest items as deeply as you like, drag them to a new parent, and move them between workspaces. Nix refuses a move that would put an item inside itself.

An item's body is one of:

- **Note**: rich text with headings, lists, task lists, quotes, code, callouts, tables, images, links, columns, collapsible sections, colour, page breaks and embedded live sections of other notes.
- **Canvas**: a shared drawing surface. See [Canvas and diagrams](nix://item/01a130b0-0b36-7fdb-b62b-91fa0f4cd7d5).
- **Spreadsheet**: a grid with A1 formulas. See [Sheets](nix://item/01a130b0-0ff5-73d0-a7fd-ea8eb993feb7).
- **File**: an uploaded file with immutable versions and a preview.

Deleting an item moves it to the trash, with an Undo straight away and a restore later. Items can be bookmarked, or hidden from your own tree without affecting anyone else.

## Files

Uploaded files keep every version. You can replace a file in place, and Nix previews PDFs and images and has built-in viewers for EPUB, CSV, Markdown, Mermaid, audio, video and plain text. Files are delivered through short-lived signed links rather than through the API, and Nix checks each upload's size, type and checksum before publishing it.

## Item settings

Each item can switch on a few optional features for itself. Open the item's details and choose **Settings**. Everything is off until someone turns it on, and the server enforces it for every client.

- **Comments** (notes): let people discuss the note in threads. Turning it off hides the threads without deleting them.
- **Suggesting** (notes): offer a Suggesting mode that records edits as suggestions to accept or reject. Suggestions already in the text stay.
- **Full width** (notes): use the full width of the pane instead of a reading width.
- **Review states** (files): move each version through draft, in review and approved. Off, the newest version is the one shared.
- **Withhold from pets**: keep pets away from the item. See [The companion pet](nix://item/01a130b0-0c1b-7823-89c8-888caa577a6b).
- **Default view**: what the item opens as for everyone in the workspace.

## Public links

If your administrator has allowed public links, you can share a note with someone who has no account. Choose **Share public link…** from the note's menu in the Explorer, then copy the link. Anyone with the link can read the note without signing in, and it updates as you edit. Comments, properties and child items stay private. An attached file shows its newest version, or only an approved one when that file uses review states; files with no approved version are listed as not shown. Revoke the link at any time and access ends within a minute. Files can be shared the same way from the **Attachments** page, which also lists each file's public link.

Sharing the address of a Nix server's public pages shows a preview card, with a title, a description and an image, in chat and social apps. Published sites draw a card for each page.

## Views

A view shows a container's children. Every container can have several views, and one of them opens by default. A view can also be composed with a companion view beside or below it.

| View | What it shows |
| --- | --- |
| List | A table of rows with editable cells, optionally gathered into sections by a property |
| Board | Cards in columns, grouped by a single-select property |
| Calendar | Items placed on the day or hour a date property names, with an optional end |
| Gallery | Cards with cover pictures, in small, medium or large sizes |
| Timeline | Bars from a start date to an end date; items without an end are milestones |
| Spreadsheet | The children as rows and their properties as columns, edited with typed controls |
| Form | A form that creates a new child from the container's fields |
| Interactive form | A public form behind a revocable link; each response becomes a child item |
| Smart list | A saved query across containers, such as Today, Next 7 days, Overdue or Assigned to me |
| Chart | Column, pie, line or area charts, or a year grid, counting or totalling a property |
| Checklist | A list of boxes that tick a checkbox property |
| Matrix | Cards placed in a grid by two select or checkbox properties |
| Outline | The subtree as an indented, keyboard-driven outline |
| Drive | Files as a sortable list or a grid of tiles |
| Habit tracker | Habits with check-ins, streaks and charts |
| Chat | Messages as child items, in a conversation |
| Custom | A small program drawn over the children, written in a code editor or a visual designer |

Every view supports filters. List-like views support several sort keys, column summaries and a title search. Filters can combine any-of groups, structural fields such as the item's type, and relative day tokens such as today. Views never copy items; they are different ways of reading the same children.

Guided setup walks you through creating a structured container, and keeps your draft if you switch tabs part way through.

## Interactive forms

An interactive form gives people outside your workspace a way to submit something, such as feedback or a sign-up. It lives behind an opaque link you can revoke at any time. Responses arrive as ordinary child items. A person filling in the form never sees the workspace or anyone else's responses.

## Suggestions

Nix offers suggestions that do not use a language model: possible duplicates, property values you have used before, similar items, free calendar slots and filling a series down a column. They can be switched off.

## Properties

- title: Items and views

