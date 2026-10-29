import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { earlierPieces, programPieces } from '../../openui/fence';
import { PetMessageText } from '../../pets/pet-message-text';

const workspace = '11111111-1111-4111-8111-111111111111';
const base =
  'root = Stack([title, note])\ntitle = Text("Small", "body")\nnote = Text("Keep me", "note")';
const patch = '```openui-lang patch\ntitle = Text("Bigger", "display")\n```';

function reply(
  text: string,
  earlier = earlierPieces([{ role: 'assistant', text: `\`\`\`openui-lang\n${base}\n\`\`\`` }]).at(
    -1,
  ),
) {
  return render(
    <MemoryRouter>
      <PetMessageText workspaceId={workspace} text={text} earlierPieces={earlier} />
    </MemoryRouter>,
  );
}

describe('patch blocks', () => {
  it('collect whole programs and patches in order, and only from replies', () => {
    expect(programPieces(`a\n\n\`\`\`openui-lang\n${base}\n\`\`\`\n\n${patch}`)).toEqual([
      { patch: false, source: `${base}\n` },
      { patch: true, source: 'title = Text("Bigger", "display")\n' },
    ]);
    const before = earlierPieces([
      { role: 'user', text: patch },
      { role: 'assistant', text: patch },
    ]);
    expect(before[0]).toEqual([]);
    expect(before[1]).toEqual([]);
    expect(before[2]).toHaveLength(1);
  });

  it('change the program from an earlier reply, keeping what they do not mention', async () => {
    reply(`Made it bigger.\n\n${patch}`);
    expect(await screen.findByText('Bigger')).toBeInTheDocument();
    expect(screen.getByText('Keep me')).toBeInTheDocument();
    expect(screen.queryByText('Small')).not.toBeInTheDocument();
  });

  it('change an earlier block in the same reply', async () => {
    reply(`\`\`\`openui-lang\n${base}\n\`\`\`\n\nAnd bigger:\n\n${patch}`, []);
    expect(await screen.findByText('Bigger')).toBeInTheDocument();
    expect(screen.getByText('Small')).toBeInTheDocument();
  });

  it('say so when the program they change is out of view', async () => {
    reply(patch, []);
    expect(
      await screen.findByText('This changes a component that is no longer in this conversation.'),
    ).toBeInTheDocument();
  });
});
