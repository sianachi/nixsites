# Properties and formulas

## Fields that cascade

A container declares fields for the items inside it. Those definitions cascade down the tree: a grandchild sees the fields its grandparent declared, as well as its own parent's. **Inherited from above** shows where each one comes from, and **Ignore fields from items above this one** stops inheritance at a chosen container.

The server computes each item's effective fields and validates every write against them, so a value of the wrong type is refused rather than stored.

## Property types

| Type | Holds |
| --- | --- |
| Text | One line of text |
| Long text | Several lines, kept as written |
| Number | A number |
| Select | One of a list of options |
| Multi-select | Any of a list of options |
| Date | A day |
| Date and time | A moment, with its time zone |
| Date or time | Either an all-day date or a timed moment |
| Checkbox | True or false |
| Link | A URL |
| Picture | An image shown as a cover in galleries |
| Due date, Start date | Task dates that smart lists and timelines understand |
| Completion | Whether a task is done |
| Priority | 1 to 4 |
| Estimate | An estimate of effort |
| Assignee | A workspace member |
| Reminder | When Nix should remind you |
| Formula | A value calculated from the item's other fields |
| Rollup | A value folded across the item's children |

A field's key is set from its name when it is first saved. Renaming the label later does not change the key or the values stored under it.

## Formulas

A formula field calculates a read-only value from the item's other fields. Refer to a field by its key in square brackets. Do not start a formula with `=`.

```text
[price] * [quantity]
```

Formulas can read fields inherited from ancestors, and other formulas. Nix evaluates each formula after the ones it depends on, whatever order you added them in:

```text
subtotal: [price] * [quantity]
total:    ROUND([subtotal] * (1 + [tax_rate]), 2)
```

The language is deliberately small and safe. It has numbers, text in double quotes, `TRUE` and `FALSE`, the operators `+ - * / ^ %`, text joining with `&`, and comparisons `= <> < <= > >=`. Use `AND`, `OR` and `NOT` for logic.

Functions:

- **Maths:** SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, ROUND, ROUNDUP, ROUNDDOWN, ABS, INT, MOD, SQRT, POWER
- **Text:** CONCATENATE, LEN, LEFT, RIGHT, MID, TRIM, UPPER, LOWER, CONTAINS, VALUE
- **Logic:** IF, IFERROR, ISBLANK, AND, OR, NOT
- **Dates:** DAYS(end, start)

Some worked examples:

```text
IF(OR(ISBLANK([price]), ISBLANK([quantity])), "Enter price and quantity", ROUND([price] * [quantity], 2))
IFERROR(ROUND([done] / [total] * 100, 1), 0)
IF([complete], "Done", "Open")
DAYS([end], [start])
```

A blank number counts as zero in arithmetic. Use `ISBLANK` when an incomplete row should show a prompt instead.

### Errors

| Error | Meaning |
| --- | --- |
| \#PARSE! | The expression cannot be parsed |
| \#NAME? | A field key or function name is unknown |
| \#VALUE! | A value cannot be used by an operator or function |
| \#DIV/0! | Division by zero |
| \#REF! | A formula field tried to read spreadsheet cells |
| \#CYCLE! | A formula refers back to itself, directly or through others |
| \#LIMIT! | The expression, its text or its work exceeded a bound |

The editor checks syntax, function names, argument counts and field keys as you type, and points at the position of any mistake.

### Limits

A formula may be up to 1,024 characters long. All the formulas on one item share a budget of 5,000 evaluation steps. Joined text may be up to 32,768 characters. The language has no network or file access, no clock, no randomness and no scripts, and it cannot read another item by ID. Numbers are ordinary floating point, not exact decimal money.

## Rollups

A rollup folds a field across an item's children on the server: how many, total, average, smallest, largest, any of them or all of them. A project can show the number of open tasks inside it, or the sum of their estimates.

## Charts

A chart view counts items or totals a number field, grouped by a select or placed along a date. It can split a series by a choice field and stack it. Charts are computed on the server over the same permission-filtered rows the other views use, and they say when items fall outside the chosen window rather than leaving them out silently.

## Properties

- title: Properties and formulas

