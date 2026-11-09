/**
 * A scripted stand-in for `codex app-server`, spawned by the tests through the real launcher. It
 * speaks newline-delimited JSON-RPC on stdio and records how it was started under $HOME.
 */
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const home = process.env.HOME ?? '';
writeFileSync(
  `${home}/launch.json`,
  JSON.stringify({ args: process.argv.slice(2), env: process.env, cwd: process.cwd() }),
);
process.stderr.write('stderr noise with account data\n');

const send = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};
let message = '';

createInterface({ input: process.stdin }).on('line', (line) => {
  const packet = JSON.parse(line) as {
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
  };
  if (packet.method === undefined) {
    // A reply to the tool call this peer made: finish the turn.
    send({
      method: 'item/completed',
      params: {
        threadId: 'thr-1',
        item: {
          id: 'f',
          type: 'agentMessage',
          phase: 'final_answer',
          text: `tool said: ${JSON.stringify(packet.result)}`,
        },
      },
    });
    send({
      method: 'turn/completed',
      params: { threadId: 'thr-1', turn: { status: 'completed' } },
    });
    return;
  }
  const reply = (result: unknown): void => {
    send({ id: packet.id, result });
  };
  switch (packet.method) {
    case 'initialize':
      reply({});
      break;
    case 'account/read':
      reply({ account: { type: 'chatgpt' } });
      break;
    case 'model/list':
      reply({
        data: [
          {
            model: 'gpt-fake',
            displayName: 'Fake',
            isDefault: true,
            supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
          },
        ],
      });
      break;
    case 'thread/start':
    case 'thread/resume':
      reply({ thread: { id: 'thr-1' } });
      break;
    case 'turn/start': {
      const input = (packet.params?.input as { text: string }[] | undefined)?.[0]?.text ?? '{}';
      message = (JSON.parse(input) as { message: string }).message;
      reply({ turn: { id: 'turn-1' } });
      setTimeout(() => {
        if (message === 'tool') {
          send({
            id: 'srv-1',
            method: 'item/tool/call',
            params: {
              threadId: 'thr-1',
              tool: 'nix_read_note',
              callId: 'call-1',
              arguments: { itemId: '66666666-6666-4666-8666-666666666666' },
            },
          });
        } else if (message === 'crash') {
          process.exit(1);
        } else if (message === 'tool-forbidden') {
          send({
            id: 'srv-2',
            method: 'item/commandExecution/requestApproval',
            params: { threadId: 'thr-1' },
          });
        } else if (message !== 'hang') {
          send({
            method: 'item/agentMessage/delta',
            params: { threadId: 'thr-1', itemId: 'f', delta: 'Hel' },
          });
          send({
            method: 'item/completed',
            params: {
              threadId: 'thr-1',
              item: {
                id: 'f',
                type: 'agentMessage',
                phase: 'final_answer',
                text: `echo: ${message}`,
              },
            },
          });
          send({
            method: 'turn/completed',
            params: { threadId: 'thr-1', turn: { status: 'completed' } },
          });
        }
      }, 5);
      break;
    }
    case 'turn/interrupt':
      reply({});
      send({
        method: 'turn/completed',
        params: { threadId: 'thr-1', turn: { status: 'interrupted' } },
      });
      break;
    default:
      reply({});
  }
});
