import type { ToolSpec } from '@openuidev/react-lang';

import { OPENUI_LANGUAGE } from './fence';
import { STARTER_PROGRAM } from './starter-program';
import { nixLibrary } from './library';
import { MUTATION_TOOLS } from './tool-provider';

/**
 * The pet's instructions for interactive replies, generated from the same library the renderer
 * draws with so the two cannot drift. `openui-prompt.test.ts` writes it to the Go worker's
 * embedded catalog (`apps/go-workers/internal/companion/catalog/openui.txt`) as a file snapshot:
 * `vitest -u` regenerates it, and a stale copy fails the test.
 */

const item = { type: 'object', properties: { id: {}, title: {}, type: {}, workspaceId: {} } };

const TOOLS: ToolSpec[] = [
  {
    name: 'search',
    description: 'Find items by name or content. query needs at least 3 characters.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    outputSchema: { type: 'object', properties: { results: { type: 'array', items: item } } },
  },
  {
    name: 'list_items',
    description:
      'The children of parentId (omit it for the workspace root), with their property values. Ids come from workspaceMap or an earlier read.',
    inputSchema: { type: 'object', properties: { parentId: { type: 'string' } } },
    outputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: {}, title: {}, type: {}, dueDate: {}, completed: {}, properties: {} },
          },
        },
      },
    },
  },
  {
    name: 'read_item',
    description: 'One item and its property values.',
    inputSchema: {
      type: 'object',
      properties: { itemId: { type: 'string' } },
      required: ['itemId'],
    },
    outputSchema: { type: 'object', properties: { id: {}, title: {}, type: {}, properties: {} } },
  },
  {
    name: 'read_view',
    description:
      'A bounded sample of a saved view. itemId is the container; query is {viewId, pageSize} with the exact viewId from nix_read_structure.',
    inputSchema: {
      type: 'object',
      properties: { itemId: { type: 'string' }, query: { type: 'object' } },
      required: ['itemId', 'query'],
    },
    outputSchema: { type: 'object', properties: { results: { type: 'array' }, chart: {} } },
  },
  {
    name: 'read_calendar',
    description: 'What is scheduled between two yyyy-MM-dd days, at most 62 days apart.',
    inputSchema: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: {}, title: {}, containerTitle: {}, value: {}, completed: {} },
          },
        },
      },
    },
  },
];

const PREAMBLE = `## Interactive replies

You can answer with a live, interactive component: write a program in OpenUI Lang inside a fenced code block tagged ${OPENUI_LANGUAGE}. Nix renders it in the conversation, and the owner can keep it as an artifact outside the chat.

Pick the form of each reply in this order:
1. A component, when the owner asks for a tool, calculator, converter, estimator, quiz, game, checklist, planner, comparison, table, chart or dashboard, or when the answer is a list of their items, a schedule, or figures that read better as a table or chart. "Build me a calculator", "make a quiz", "show me" and "compare" ask for a component.
2. Plain text, for a short factual answer, advice or an explanation.
3. Nix items (nix_create_note, nix_build_blueprint and the other write tools), only when the owner asks to create, add, save, track, record or set up something in their workspace, or accepts your offer to. A component is never a reason to create items. After a component you may offer, in one sentence, to save or track something as Nix items.

### Components over the owner's data
- "Show", "list", "which" or "chart" over the owner's items is a component request, not a question to answer in prose. Learn only what the component's Query needs, in at most two nix_ reads: the container id (from workspaceMap or nix_search) and, for values, its field keys (nix_read_structure). Then write the component; its Query fetches the items live when it renders.
- Never read each item or note one by one for a component, and never also list the items in prose or add a Sources line: the component is the answer.
- A form that adds, logs or ticks things off is a component with a Mutation. Build it as soon as you know the container id and field keys; do not describe the form instead.`;

const RULES = [
  `Write one ${OPENUI_LANGUAGE} block per reply (or one patch), with one short sentence before it. Do not restate the component in prose.`,
  'Build interactive tools from the generic components: $variables for state, inputs bound to them, Button with Action([@Set(...)]) or @Reset(...), and Text or Stat whose value is an expression. Let expressions compute every result; never compute figures yourself.',
  "For dates inside a component use @Today(), @AddDays, @DaysBetween and @FormatDate, so the component stays right on later days; never type today's date into it.",
  "For the owner's Nix data, use Query with the Available Tools so the component stays live and respects permissions and locks. Never type out item titles, note text or values you read; you may call nix_ read tools first to learn ids, field keys and the data's shape.",
  'Pass query results straight to components: ItemList(results.results), ItemList(items.items), ItemList(week.entries). A query that touches locked content returns locked: true and no rows; say so if it matters.',
  'Only the components and functions listed exist. Never put HTML, Markdown, CSS, scripts or outside URLs inside the block.',
  'Declare every $variable at the end of the program with a sensible default. Saved artifacts keep their $variables, so give state names that read well later.',
];

/** Writes from a component, replacing the library's generic Mutation section: the operations
 * are the pet's own write tools, and every call waits on the owner's approval card. */
const MUTATIONS = `## Mutation — Changes to the workspace

A component may change the owner's workspace only through a Mutation, and only when the owner asked for a tool that changes things (log, tick off, add, save):
\`\`\`
save = Mutation("create_entries", {parentId: "<container id>", spec: {entries: [{title: $name, values: {<field key>: $amount}}]}})
\`\`\`
- The first argument is the operation; the second takes exactly the parameters of the nix_<operation> tool you already have. Operations: ${MUTATION_TOOLS.join(', ')}.
- A Mutation runs only when a Button's action runs it: Button("Save", Action([@Run(save), @Run(entries), @Reset($name)]), "primary"). Re-run the Query that shows the data after it.
- Every run shows the owner Nix's approval card first; they may edit or decline it. result.status is "idle", "loading", "success" or "error" (declined or failed): show it, for example Text(save.status == "success" ? "Saved" : save.status == "error" ? "Not saved" : "", "note").
- Use ids from your own reads or the input (workspaceMap, currentItemId); never invent one. Values are keyed by field key, never by label.
- Never put trash_item, move_item or other destructive operations in a component unless the owner asked for that exact tool.`;

/** Form validation, replacing the library's Forms section, which names components Nix lacks. */
const FORMS = `## Forms

Form(name, submitButton, [fields]) groups inputs that have rules; its submit Button runs its action only when every field passes, and shows each field's error otherwise. Rules are the last argument of an input: {required: true, min: 1, max: 500, minLength: 2, maxLength: 240, email: true, url: true, numeric: true, pattern: "^[A-Z]"}. Put a Mutation's Button in a Form whenever the owner types what it saves.`;

/** Edit mode: how to change the component the pet just made, and an artifact the owner opened. */
const EDITING = `## Changing a component

- When the owner asks to change the component you just made, reply with a patch: a fenced block tagged \`${OPENUI_LANGUAGE} patch\` holding only the statements that change or are new, under the same names. Nix merges it into the latest program in this conversation. Repeat root only when its children change. Use a whole new block for a different component.
  \`\`\`${OPENUI_LANGUAGE} patch
  result = Stat("Each pays", @Round($bill * (1 + $tip / 100) / $people, 0), "EUR")
  \`\`\`
- When currentItemId is an artifact (a saved component), its body is one ${OPENUI_LANGUAGE} block. Read it with nix_read_note and change it with nix_replace_passage, finding the exact statements to replace; the approval card shows the component before and after. Change only what was asked. Its body may also hold an openui-state block with the values people saved: leave that block alone.
- Before a write tool call you may add one small read-only block that explains the change (a table or chart, no Mutation and no @Run). The approval card is what the owner approves; never claim the block is the change.`;
/** Custom views: a program kept in a view rather than a reply (`custom-view.tsx` draws it). */
const CUSTOM_VIEWS = `## Custom views

A custom view stores one ${OPENUI_LANGUAGE} program that Nix draws over a collection for everyone who opens it. Add one with nix_add_view (kind "custom", the program in program) only when the owner asks for a custom view or no other view kind fits; the program goes in the view, not in a fenced block in your reply.
- \`$container\` stands for the collection's id: read its children with \`Query("list_items", {parentId: $container}, {items: []})\`. Never type the id; the same program then works in any collection. Use \`$container\` only for that, never as a variable you declare or set.
- Every component, function, Query tool and Mutation operation in these instructions works there. Reads run as the person viewing; every Mutation shows them an approval card. $variables hold each viewer's own values in their browser and never change the view.
- To change a custom view, read its program from nix_read_structure, then send the whole new program as patch.program in nix_update_view. Change only what was asked.

Start from this program and build on it:
\`\`\`${OPENUI_LANGUAGE}
${STARTER_PROGRAM}
\`\`\``;
// A form-style tool, a live query, and a stepped quiz: between them every pattern the owner's
// requests need (bound inputs, expressions, Query, @Set state machines, conditional parts).
const EXAMPLES = [
  `root = Stack([title, inputs, total])
title = Text("Tip splitter", "title")
inputs = Grid([bill, tip, people], 3)
bill = NumberInput("Bill", $bill, 0)
tip = Slider("Tip %", $tip, 0, 30)
people = NumberInput("People", $people, 1, 20)
total = Stat("Each pays", @Round($bill * (1 + $tip / 100) / $people, 2))
$bill = 60
$tip = 15
$people = 2`,
  `root = Stack([question, controls, result])
question = Text($step == 0 ? "Do you nap 12 hours a day?" : $step == 1 ? "Do you sit in small boxes?" : "", "body")
controls = $step < 2 ? Row([yes, no]) : again
yes = Button("Yes", Action([@Set($score, $score + 1), @Set($step, $step + 1)]), "primary")
no = Button("No", @Set($step, $step + 1))
again = Button("Start over", @Reset($step, $score))
result = Text($step < 2 ? "Question " + ($step + 1) + " of 2" : $score == 2 ? "You are a cat." : "Probably not a cat.", "display")
$step = 0
$score = 0`,
];

const EXAMPLES_WITH_TOOLS = [
  `root = Stack([title, box, list])
title = Text("Notes about the launch", "title")
box = TextInput("Search", $q)
found = Query("search", {query: $q}, {results: []})
list = ItemList(found.results, "No matches yet.")
$q = "launch"`,
  `root = Stack([title, form, said, log])
title = Text("Weight log", "title")
form = Form("Log weight", save, [kg])
kg = NumberInput("Weight (kg)", $kg, 30, 250, 0.1, {required: true, min: 30, max: 250})
save = Button("Log it", Action([@Run(entry), @Run(rows)]), "primary")
entry = Mutation("create_entries", {parentId: "<weight log id>", spec: {entries: [{title: @FormatDate(@Today(), "short"), values: {weight: $kg}}]}})
said = Text(entry.status == "success" ? "Logged" : entry.status == "error" ? "Not logged" : "", "note")
rows = Query("list_items", {parentId: "<weight log id>"}, {items: []})
log = ItemList(rows.items, "No entries yet.")
$kg = 70`,
  `root = Stack([title, left, done])
title = Text("Days to the launch", "title")
left = Stat("Days left", @DaysBetween(@Today(), "2026-12-01"))
done = Text(@DaysBetween(@Today(), "2026-12-01") < 0 ? "It has launched." : "Launch is " + @FormatDate("2026-12-01", "long"), "body")`,
  ...EXAMPLES,
];

/** What a button may do here, replacing the library's generic section, which allows any URL. */
const ACTIONS = `## Action — Button Behavior

A Button's action is one @step, or Action([@steps...]) for several; steps run in order, and a failed @Run of a Mutation stops the rest.
- @Set($variable, value) — set state to a value or an expression.
- @Reset($a, $b) — restore $variables to their declared defaults.
- @Run(ref) — run a Mutation (after the owner approves it), or re-fetch a Query.
- @ToAssistant("message") — put a message to you in the owner's composer; they read it and send it. Use it for follow-ups ("Tell me more about this week").
- @OpenUrl("/w/{workspaceId}?item={itemId}") — open a Nix item. Any other URL is ignored.`;

/** Library sections that describe components or writes this library does not have. */
const DROPPED = new Set([
  'Mutation — Write Operations',
  'Interactive Filters',
  'Forms',
  'Data Workflow',
  'Action — Button Behavior',
]);

const MUTATION_LINE =
  "Use these with Query() for read operations or Mutation() for write operations. The LLM decides which is appropriate based on the tool's purpose.";

const MOCK_DATA_RULE =
  "CRITICAL: Use ONLY the tools listed above in Query() and Mutation() calls. Do NOT invent or guess tool names. If the user asks for functionality that doesn't match any available tool, use realistic mock data instead of fabricating a tool call.";

/** Every program the prompt teaches by example; each must parse cleanly (openui-prompt.test.ts). */
export const PROMPT_EXAMPLES: readonly string[] = EXAMPLES_WITH_TOOLS;

export function openUiPrompt(): string {
  const generated = nixLibrary.prompt({
    preamble: PREAMBLE,
    additionalRules: RULES,
    tools: TOOLS,
    toolExamples: EXAMPLES_WITH_TOOLS,
  });
  // Both lines are replaced by exact text, so an upstream rewording must fail loudly here.
  if (!generated.includes(MOCK_DATA_RULE) || !generated.includes(MUTATION_LINE))
    throw new Error('The OpenUI tool rules changed upstream.');
  const sections = generated
    .replace(
      MUTATION_LINE,
      'Use these with Query(); every one of them is a read. Writes are Mutations (see Mutation).',
    )
    .replace(
      MOCK_DATA_RULE,
      'CRITICAL: Use ONLY these tools in Query() and only the listed operations in Mutation(). Never invent tool names or data; if no tool provides what the owner asked for, say so in prose.',
    )
    .split(/\n(?=## )/)
    .filter((section) => !DROPPED.has(/^## (.+)/.exec(section)?.[1]?.trim() ?? ''));
  const signatures = sections.findIndex((section) => section.startsWith('## Built-in Functions'));
  sections.splice(signatures, 0, ACTIONS, MUTATIONS, FORMS, EDITING, CUSTOM_VIEWS);
  return sections.join('\n');
}
