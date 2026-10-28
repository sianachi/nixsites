# Notes, tasks, and the rest

Everything addressable here is an item, a workspace, or a record hanging off an item. The [reference](reference.md) is the full list. This page is the map, including what each area can change.

## Notes

Create a note with `POST /api/v1/workspaces/{workspaceId}/items`. The body of that call sets the title, the parent, and the type (`note`). It does not set the document.

Rename with `PATCH /api/v1/items/{itemId}` and `{ "title": "…" }`. That changes the title only.

The prose, the canvas, and the spreadsheet live in the collaboration service. `nixctl note read` and `nixctl note write` use that service with the same exchanged bearer token. There is no REST route that reads or replaces a note body yet. When one exists, it will be a new operation in the reference; these item routes will still mean what they mean now.

Daily notes are `PUT /api/v1/workspaces/{workspaceId}/daily-notes/{date}` to open or create the day's note, and the settings routes under `daily-notes/settings`. Opening a daily note creates an item. It still does not write the day's prose.

## Tasks

A task is an item inside a container whose fields carry a due date, completion, and the rest. There is no separate task collection.

- List the tasks: `GET /api/v1/workspaces/{workspaceId}/items?parentId=<container-id>`.
- Set due date, status, and other fields: `PATCH /api/v1/items/{itemId}/properties`.
- Recurrence is the routes under `/api/v1/items/{itemId}/recurrence`. Completing one occurrence does not copy the item.
- A saved or ad-hoc query is `POST /api/v1/workspaces/{workspaceId}/query` (a read, allowed for a read scope). `query/aggregate` folds the same match.

These calls change properties, recurrence, and the item tree. They do not change the note body.

## Calendar

`GET /api/v1/workspaces/{workspaceId}/calendar` reads items that fall in a time window. It does not create events.

Two-way sync with Google or Outlook is the calendar-link routes under `/api/v1/me/calendar/`. Connecting an external account is an interactive session. Creating or deleting a link needs the admin scope. Asking a link to sync now is a write. Each linked calendar is a container of ordinary items, one per event, so editing an event's fields is the property route on that item.

## Habits

Habit routes hang off the habit item:

- `GET /api/v1/items/{itemId}/habit`
- `PUT /api/v1/items/{itemId}/habit` for settings
- `PUT /api/v1/items/{itemId}/habit/check-ins/{occurredOn}` to check in
- `DELETE` on that check-in path to undo
- `PUT /api/v1/items/{itemId}/habit/status`

Check-ins change the habit record. They do not edit a note body. The habit tracker view is still a view on the container (`PUT /api/v1/items/{itemId}/views`).

## Files, finance, search, and sites

**Files.** Upload, replace, and version routes are under the file tag in the reference. Bytes are delivered through short-lived capability URLs. The API response names the file; it does not stream the bytes as the resource body.

**Finance.** `/api/v1/items/{itemId}/finance` reads and writes accounts, lines, transactions, and months on a finance root. Deleting one of those records is the ordinary item delete.

**Search.** `GET /api/v1/search` finds items. `POST /api/v1/search/mentions` matches titles in a passage of text and changes nothing. A read scope is enough.

**Sites.** Creating, publishing, hostnames, and rollback are under `/api/v1/sites`. A token needs admin to change a site. Reading a site is a read.

**Trash.** `GET /api/v1/workspaces/{workspaceId}/items/trash` lists recoverable items. `POST /api/v1/items/{itemId}/restore` brings one back. `DELETE /api/v1/items/{itemId}/purge` removes a trashed item permanently.

## Properties

- title: Notes, tasks, and the rest
