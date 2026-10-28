import type { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as PetsModule from './commands/pets.ts';

const petCommand = vi.fn<typeof PetsModule.petCommand>(() => Promise.resolve());

// commander only copies a command's `_exitCallback` onto a subcommand at the moment the
// subcommand is created (`Command.copyInheritedSettings`); `buildProgram()` has already built
// the whole `pet` subtree by the time it returns, so `program.exitOverride()` alone never reaches
// `pet`'s own option parser. Apply it to every command in the tree instead, so an invalid
// `--after` throws a CommanderError here rather than calling the real `process.exit`.
function overrideExitRecursively(command: Command): void {
  command.exitOverride();
  for (const sub of command.commands) {
    overrideExitRecursively(sub);
  }
}

vi.mock('./commands/pets.ts', async () => {
  const actual = await vi.importActual<typeof PetsModule>('./commands/pets.ts');
  return {
    ...actual,
    petCommand: (...args: Parameters<typeof actual.petCommand>) => petCommand(...args),
  };
});

// buildProgram() is imported after the mock above is registered, so `pet <operation>`'s action
// calls the stub instead of driving a real session and network request.
const { buildProgram } = await import('./index.ts');

describe('public health command', () => {
  it('passes an explicit Core origin to the anonymous health probe', async () => {
    const healthModule = await import('./commands/health.ts');
    const spy = vi.spyOn(healthModule, 'readHealth').mockResolvedValue();
    try {
      const program = buildProgram();
      overrideExitRecursively(program);
      await program.parseAsync(['--json', 'health', '--api-url', 'http://localhost:5014'], {
        from: 'user',
      });
      expect(spy).toHaveBeenCalledWith(
        'http://localhost:5014',
        expect.objectContaining({ json: true }),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('requires an explicit origin before making a request', async () => {
    const program = buildProgram();
    overrideExitRecursively(program);
    await expect(program.parseAsync(['health'], { from: 'user' })).rejects.toThrow(/--api-url/);
  });
});

describe('pet --after validation', () => {
  afterEach(() => {
    petCommand.mockClear();
  });

  it('accepts a non-negative integer and passes it through to petCommand', async () => {
    const program = buildProgram();
    overrideExitRecursively(program);

    await program.parseAsync(
      ['pet', 'watch', '--workspace', 'w1', '--pet', 'p1', '--after', '42'],
      { from: 'user' },
    );

    expect(petCommand).toHaveBeenCalledTimes(1);
    const options = petCommand.mock.calls[0]?.[2];
    expect(options?.after).toBe(42);
  });

  it.each([
    ['a negative', '-1'],
    ['a non-integer', '1.5'],
  ])('rejects %s --after before petCommand ever runs', async (_case, after) => {
    const program = buildProgram();
    overrideExitRecursively(program);

    await expect(
      program.parseAsync(['pet', 'watch', '--workspace', 'w1', '--pet', 'p1', '--after', after], {
        from: 'user',
      }),
    ).rejects.toThrow(/non-negative integer/);
    expect(petCommand).not.toHaveBeenCalled();
  });
});

describe('auth login flag collection', () => {
  it('defaults to browser login and accepts a manual approval URL', async () => {
    const authModule = await import('./commands/auth.ts');
    const spy = vi.spyOn(authModule, 'login').mockImplementation(() => Promise.resolve());
    try {
      const program = buildProgram();
      overrideExitRecursively(program);
      await program.parseAsync(
        ['auth', 'login', '--api-url', 'http://localhost:5173', '--no-browser'],
        { from: 'user' },
      );
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          apiUrl: 'http://localhost:5173',
          browser: false,
          token: undefined,
        }),
        expect.anything(),
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe('automations create flag collection', () => {
  it('collects repeatable flags and leaves unused ones absent', async () => {
    const automationsModule = await import('./commands/automations.ts');
    const spy = vi
      .spyOn(automationsModule, 'createAutomation')
      .mockImplementation(() => Promise.resolve());
    try {
      const program = buildProgram();
      overrideExitRecursively(program);
      await program.parseAsync(
        [
          'automations',
          'create',
          '--workspace',
          'w1',
          '--name',
          'n',
          '--when-changed',
          'status',
          '--if',
          'a=1',
          '--if',
          'b!=2',
          '--set',
          'c=3',
        ],
        { from: 'user' },
      );
      const options = spy.mock.calls[0]?.[1];
      expect(options?.if).toEqual(['a=1', 'b!=2']);
      expect(options?.set).toEqual(['c=3']);
      expect(options?.createProp).toBeUndefined();
      expect(options?.ifEmpty).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
