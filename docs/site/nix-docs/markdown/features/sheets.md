# Sheets

Nix has two kinds of spreadsheet: a spreadsheet body, which is a grid of cells inside one item, and a spreadsheet view, which shows a container's children as rows.

## Spreadsheet bodies

Choose **New > Sheet** to create an item whose body is a grid. Cells hold values or formulas that start with `=`:

```text
=SUM(B2:B13)
=ROUND(C4 * $F$1, 2)
=IF(D7 > 0, "Over", "Within budget")
```

- A1 references, absolute references such as `$A$1`, and rectangular ranges such as `A1:B5`.
- The same function library as formula fields: SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, ROUND, ROUNDUP, ROUNDDOWN, ABS, INT, MOD, SQRT, POWER, CONCATENATE, LEN, LEFT, RIGHT, MID, TRIM, UPPER, LOWER, CONTAINS, VALUE, IF, IFERROR, ISBLANK, AND, OR, NOT and DAYS.
- Dependency tracking: Nix knows which cells depend on which and recalculates them in the right order.
- Cycle checks: a circular reference shows `#CYCLE!` rather than looping.
- Resizable columns.

A sheet supports up to 10,000 rows, columns A to ZZ, 50,000 non-empty cells and 2,048 characters per cell. Sheets are collaborative: several people can edit the same grid at once.

## Spreadsheet view

The spreadsheet view shows a container's children as rows and their fields as columns. Each cell is edited with the control its field type calls for: a date picker for dates, a menu for selects, a checkbox for checkboxes. Formula and rollup columns are read-only and recalculate as you edit. Select cells and press **Mod+Shift+D** to fill them down as a series.

Use the spreadsheet view when each row is a real item you also want to open, link to, put on a calendar or chart. Use a spreadsheet body when you need a free-form grid of cells.

## Properties

- title: Sheets

