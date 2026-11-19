# The companion pet

A Nix pet is an AI conversation with a small animated character and a controlled set of workspace tools. You can ask it to explain a note, tidy a list or build a whole project structure, all in the same chat. The character is the presentation; what matters is that every change it proposes goes through Nix's own permission checks and, unless you say otherwise, waits for you.

## Setting it up

Open **Settings > Companion** and add a pet. You choose which service it uses:

- **ChatGPT:** connect your own ChatGPT account once with a device sign-in. The connection is private to your account. The operator of your Nix instance needs the companion runtime enabled.
- **Claude** or **OpenRouter:** save your own API key. The key is yours alone.

You have one pet. It has a name, an appearance, a model, and instructions in your own words (up to 2,000 characters). Instructions never grant extra access. The pet keeps a separate conversation for each workspace.

Nix has 19 appearances to choose from: Owl, Neko, Fox, Octopus, Axolotl, Moth, Pangolin, Phoenix Chick, Mushroom Sprite, Origami Crane, Jumping Spider, Lantern Spirit, Hermit Crab, Kirin Fawn, Gecko, Pocket Whale, Crystal Golem, Fruit Bat and Dust Bunny. You can change it at any time.

## The chat

Where the chat opens is a setting for each device: a floating panel, a right-hand drawer (the default), its own page, its own page on phones only, or both. Replies, tool activity and approvals stream in as they happen. Conversations are saved, can be searched and renamed, and can be saved as chat notes.

## What it can do

With workspace access switched on, the pet has 34 tools.

**Reading:** list a container's children, search by meaning as well as by words, search within a long note, read an item, read a note, read a container's fields and views, run a view, list and read templates, and read your calendar for a date range.

**Writing:**

- create notes, append to them, replace a section under a heading or a passage of text;
- rename, move, trash and restore items;
- set properties and complete tasks;
- create structured containers, add and edit fields, add and update views, edit forms and set recurrence;
- create entries in a collection;
- apply templates, save a subtree as a template, and build a blueprint;
- remember something you ask it to remember;
- find and run other Nix operations by name.

A **blueprint** is a whole design (containers, fields, views and sample entries) that the pet proposes in one go. Nix validates it, shows you the tree it will build, and then creates ordinary items through the normal API, reporting each step as done, failed or skipped. The pet looks at your existing templates first and asks a few questions when it needs to.

Operations reserved for people, such as workspace passwords, are refused to the pet.

## Memory

In **Settings > Companion > Memory** you choose what happens when the pet learns something lasting about you: it does not remember, asks before remembering (the default), or remembers automatically. Every remembered fact is listed there, and you can edit it, forget it or add your own. Each saved fact offers Undo in the chat. The pet does not save what notes or other people say, and nothing from a conversation that has read locked content.

## Consent and approval

- **Workspace access** starts off for each pet and workspace on a new device. With it off, the pet is just a conversation and cannot see your workspace.
- **Reads** run without asking by default, because they change nothing. You can require approval for reads too, in the chat's settings. Remember that anything the pet reads is sent to the model service you chose.
- **Writes** show a preview built from the live state of the items involved: the destination, the affected items, and for note edits the changed block before and after. You approve or decline.
- **Apply changes without asking** lets writes run without a click. You can set the default in Settings > Companion and change it in a conversation.

Some changes always wait for you, even with Apply changes without asking on: moves, trashing, saving as a template, updating a view, anything that adds an external link, a note edit that would lose formatting, and completing a repeating task. After the pet has read anything from a locked note, every later write in that conversation waits for your approval.

Just before a write runs, Nix checks that the items have not changed since the preview. If they have, it asks you to review again. The pet only reports success after Nix confirms what actually happened.

### Withholding an item

To keep one item away from pets, open its **Settings** tab in the item's details and switch on **Withhold from pets**. A pet then cannot use that item or its contents in a job or a handoff. Workspace owners and administrators see this switch.

## Inline writing

Turn on **Use AI while writing notes** in Settings > Companion, then select text in a note to ask the pet for help with it. Inline writing uses a separate, short-lived conversation with no workspace tools, and the result is a suggestion you insert yourself. Locked notes are never sent.

## Pet jobs

On installs where the operator has enabled it for a workspace, a pet can take on work as a job. Send a work request in the conversation, or from the pet dialog on an item, and the pet proposes what it will do. You review or revise the proposal before anything changes. A job can include the item's text, specific sources you choose, or the whole workspace, and you decide which abilities it may use for that job. Jobs can be scheduled to repeat daily. A job that needs an answer waits in the conversation, and Nix's inbox links to decisions waiting for you. Jobs carry on after a restart. If a job fails, it shows a plain reason and a Retry action.

What a job can do depends on the abilities you allow:

- **Canvas drafts.** The pet fits a draft to a canvas, and you review it in the canvas area. You can apply it, with native shapes, strokes, groups, attached arrows and linked Nix cards, or ask for changes. Undo keeps your own separate edits.
- **Sheets.** Proposed edits show the exact before and after values or formulas.
- **Tasks.** The pet can post a comment on a task or rename it.
- **Browsing.** The pet can search the web and browse public websites, or use a saved session for one exact website. Before it submits a supported form, you review the destination and the fields. When a form needs you to finish it yourself, you can open the reviewed page from the pet dialog.
- **Connected services.** See below.
- **Routines.** Schedule a named routine from the pet dialog. A routine's owner can allow one exact, reversible task rename to apply automatically. Everything else it proposes still asks for review.

### Connections

In **Settings > Connections**, you can set up scoped pet connections to supported mail, drive, messaging, calendar, issue and code services (Google, Microsoft, Slack, GitHub and Linear). Each connection names one resource and the actions it allows, and can be reconnected or disconnected at any time. You review outbound changes in the pet dialog before they happen. You can also register one remote MCP tool, or another agent, with its own grant, and save a website session for browsing.

### Watching mail

From the pet dialog you can watch a connected Gmail label or Outlook folder. Each new message queues one pet job. Reading a message and replying still ask for review in that conversation.

### Linear

Connect Linear read-only in **Settings > Connections**. You can link an issue from an authorised Linear team to a Nix task, refresh its status, and copy the reviewed value into the task. Nix flags status edits made independently on either side and keeps conflicting values. In the task's pet dialog you can also ask Claude or Codex to look an issue up. You approve the lookup, and the pet then posts its suggested next step as a comment on the task.

Pet jobs, connections and routines are off by default and are switched on for chosen workspaces by whoever runs your Nix instance.

## Properties

- title: The companion pet

