/**
 * Realistic model outputs, one per way a model's Markdown has gone wrong, with the node types each
 * must convert to. Add every new case found in the wild. `rawKinds` lists syntax that stays literal text
 * on purpose (see the plan's "Left out on purpose"); everything else must leave no raw syntax.
 */
export interface ModelOutputCase {
  readonly name: string;
  readonly markdown: string;
  /** Node types that must appear in the converted document. */
  readonly nodes: readonly string[];
  /** Mark types that must appear. */
  readonly marks?: readonly string[];
  /** Raw-syntax kinds known to stay literal text. Every other case must leave none. */
  readonly rawKinds?: readonly string[];
}

export const MODEL_OUTPUTS: readonly ModelOutputCase[] = [
  {
    name: 'task list',
    markdown: 'Things to do:\n\n- [ ] Book venue\n- [x] Send invites\n- [ ] Order food',
    nodes: ['taskList', 'taskItem'],
  },
  {
    name: 'callout marker on the first line of the quote',
    markdown: '> [!warning] Careful with the deadline.\n> It moves on Friday.',
    nodes: ['callout'],
  },
  {
    name: 'callout marker alone',
    markdown: '> [!tip]\n>\n> Use the shortcut.',
    nodes: ['callout'],
  },
  {
    name: 'bold next to punctuation',
    markdown: '**Note:**text follows, **"hi"**there, and **(x)**next.',
    nodes: ['paragraph'],
    marks: ['bold'],
  },
  {
    name: 'whole reply inside a markdown fence',
    markdown: '```markdown\n# Plan\n\n- one\n- two\n```',
    nodes: ['heading', 'bulletList'],
  },
  {
    name: 'numbered list starting at 2 with no blank line',
    markdown: 'The steps are:\n2. Second thing\n3. Third thing',
    nodes: ['orderedList'],
  },
  {
    name: 'bullet list directly after a paragraph line',
    markdown: 'Ingredients\n- flour\n- eggs',
    nodes: ['bulletList'],
  },
  {
    name: 'table directly after a paragraph line',
    markdown: 'Results\n| name | score |\n| --- | --- |\n| Ada | 3 |',
    nodes: ['table', 'tableHeader', 'tableCell'],
  },
  {
    name: 'line break tag',
    markdown: 'First line<br>second line<br/>third line',
    nodes: ['hardBreak'],
  },
  {
    name: 'bare URL',
    markdown: 'See https://example.com/docs for details.',
    nodes: ['paragraph'],
    marks: ['link'],
  },
  {
    name: 'nested lists',
    markdown: '- fruit\n  - apple\n  - pear\n- veg\n  1. leek\n  2. kale',
    nodes: ['bulletList', 'orderedList'],
  },
  {
    name: 'task list nested in a bullet list',
    markdown: '- Launch\n  - [x] Draft\n  - [ ] Review',
    nodes: ['bulletList', 'taskList'],
  },
  {
    name: 'mermaid fence',
    markdown: 'Flow:\n\n```mermaid\ngraph TD\n  A --> B\n```',
    nodes: ['codeBlock'],
  },
  {
    name: 'code block holding Markdown-looking text',
    markdown:
      'Write it like this:\n\n```\n- [ ] not a task\n> [!note] not a callout\n**not bold**\n| a | b |\n```',
    nodes: ['codeBlock'],
  },
  {
    name: 'markdown fence nested in an outer fence',
    markdown: '````md\nExample:\n\n```js\nconst a = 1;\n```\n````',
    nodes: ['codeBlock'],
  },
  {
    name: 'text indented four spaces',
    markdown: 'Intro\n\n    indented like code',
    nodes: ['codeBlock'],
  },
  {
    name: 'heading without a space',
    markdown: '#Title\n\nBody',
    nodes: ['paragraph'],
    rawKinds: [],
  },
  {
    name: 'underline tag',
    markdown: 'Some <u>underlined</u> text',
    nodes: ['paragraph'],
    rawKinds: ['html-tag'],
  },
  {
    name: 'maths, highlight and footnote',
    markdown: 'Energy $E=mc^2$ and ==marked== text[^1].\n\n[^1]: A footnote.',
    nodes: ['paragraph'],
    rawKinds: ['math', 'highlight', 'footnote'],
  },
];
