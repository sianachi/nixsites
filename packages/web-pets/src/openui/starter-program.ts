/**
 * What a new custom view starts with: a heading and a table of the collection's children. It
 * reads the collection through `$container`, which {@link withContainer} turns into the collection's
 * id, so the same text works in any collection. Dependency-free, so the view editor can offer
 * it without loading the renderer.
 */
export const STARTER_PROGRAM = `root = Stack([heading, table])
heading = Text("Items", "title")
rows = Query("list_items", {parentId: $container}, {items: []})
table = Table(["Title", "Type"], @Each(rows.items, "item", [item.title, item.type]), "Items in this collection")`;

/**
 * The program with `$container` replaced by the id of the collection it is drawn in, as a string
 * literal. A literal because nothing else reaches a Query's arguments reliably: they are read at
 * run time from state and other queries only, so a plain `container = "..."` statement reads as
 * empty there, and a `$container` state variable makes the renderer drop the first result of a
 * Query that uses it. The replacement keeps every line where it was, so line numbers still match.
 *
 * shortcut: a `$container` inside a string literal is replaced too; add a token-aware pass if
 * programs need to print the word.
 */
export function withContainer(program: string, containerId: string | null): string {
  return program.replace(/\$container(?![\w$])/g, JSON.stringify(containerId ?? ''));
}
