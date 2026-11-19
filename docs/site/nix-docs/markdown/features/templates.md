# Templates

A template is a reusable tree of items: their bodies, fields, views and selected references. Applying a template creates ordinary items. There is no special template type to maintain afterwards.

## Using templates

Choose **New > From a template**, or open **Templates** on the rail to browse what your workspace has. A template can ask for initialisation inputs when you apply it, such as a project name or a start date. Dates in a template can be relative, so a weekly planner always starts this week.

Nix ships a set of managed templates, including:

- Weekly planner
- Meeting notes
- Project hub
- Research notebook
- Team wiki
- Content calendar
- Onboarding plan
- Product spec (RFC)
- Incident review
- Customer feedback

The library also has twelve personal templates: Habit tracker, Priority matrix, Goals, Trip plan, Reading list, People, Daily journal, Document vault, Inbox, Job hunt, Meal plan and Personal dashboard. Each opens with sample rows and several views.

The built-in templates are offered in the library of every workspace. Using one adds it to that workspace first. People who cannot manage a workspace's templates do not see them.

## Making your own

Capture any subtree as a template. Nix shows you what will be captured before it saves, takes the content as it stood at that moment, and validates the result. You can then edit the template's draft, preview it, save a new revision or discard the changes. Attachments travel with the template.

Templates can be exported as archives and imported into another workspace or another Nix instance.

```sh
nixctl template list <workspace-id>
nixctl template capture <workspace-id> <source-item-id>
nixctl template apply <template-id> --parent <item-id> --title "Q4 launch"
```

## Properties

- title: Templates

