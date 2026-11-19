# Locks and protections

Nix has three ways to guard content. A **lock** hides an item behind a password. A **protection** stops structural changes such as deletion. A **workspace password** closes a whole workspace. You can also withhold an item from pets.

## Password locks

Lock any item with a password. Until someone opens the lock, Nix withholds:

- the item's body;
- its children, its views and its rollups;
- the titles of everything inside it, in search, mentions, related items and the graph.

The locked item's own title stays visible in its parent, so you can still find it and open it. Opening the lock lasts for a limited time on that device. Locked notes are never downloaded for offline use, and the companion pet treats anything it read from a locked note with extra care (see [The companion pet](nix://item/01a130b0-0c1b-7823-89c8-888caa577a6b)).

```sh
nixctl lock status <item-id>
nixctl lock set <item-id>            # reads the password from stdin
nixctl lock set <item-id> --change   # change an existing password
```

A lock protects against casual reading by other members of a workspace. It is not end-to-end encryption: the server stores the content as normal.

## Protections

Anyone who can edit an item can set these protections on it:

- **No delete:** the item cannot be moved to the trash, and neither can any container above it while it is inside.
- **No children:** nothing new can be created under the item, moved into it, uploaded to it, imported into it or applied from a template. Reordering existing children is still allowed.

A third switch, collaboration, controls whether several people may edit the item at once. Turn it off and only one person edits at a time.

```sh
nixctl item protect <item-id> --delete on
nixctl item protect <item-id> --children on
nixctl item protect <item-id> --collaboration off
```

Protections guard against slips rather than against colleagues: anyone with edit rights can turn them off again.

## Workspace passwords

A workspace owner can close a whole workspace behind one password, in **Settings > Workspace > Password**. Until a member enters it, they see only the workspace's name and that it is locked: no items, titles, search, graph, files, comments or offline copy. The password must be at least 8 characters. Entering it unlocks the workspace in that browser for 15 minutes at a time, and **Lock now** closes it again. Changing the password closes the workspace in every other session.

The same password lets anyone in your organisation who signs in and opens the workspace's join link join as a viewer. The password hides the workspace; it is not encryption, and a forgotten password cannot be recovered.

```sh
nixctl ws password set <workspace-id>     # reads the password from stdin
nixctl ws unlock <workspace-id>
nixctl ws relock <workspace-id>
```

## Withholding an item from pets

Switch on **Withhold from pets** in an item's **Settings** tab, in its details. A pet then cannot use that item or its contents in a job or a handoff. Workspace owners and administrators see the switch. See [The companion pet](nix://item/01a130b0-0c1b-7823-89c8-888caa577a6b).

## Managed items

Some items are owned by an integration. When you link an external calendar to a container, the container and its synced events become managed: they cannot be deleted from the tree, and events cannot be moved out of their calendar. You remove them by unlinking the calendar in settings, where you choose to keep the items as ordinary ones or move them to the trash. Workspace owners can see and unlink any calendar linked into their workspace.

## Properties

- title: Locks and protections

