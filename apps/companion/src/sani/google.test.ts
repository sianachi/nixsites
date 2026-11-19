import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createConnectorRouter } from './connector.ts';
import { googleActions } from './google.ts';

const localToken = 'fixture-google-access-token';
const executionId = '1d4e2d81-1948-471f-a10d-7dbf56e52a6a';
const allowedLabel = 'Label_review';
const allowedFolder = 'folder_a';
const allowedCalendar = 'team+schedule@group.calendar.google.com';
type Reply = (request: Request) => Response | Promise<Response>;

function fixture(...replies: Reply[]) {
  const observed: { method: string; url: URL }[] = [];
  const run = createConnectorRouter(googleActions, async (input, init) => {
    const request = new Request(input, init);
    expect(request.headers.get('authorization')).toBe(`Bearer ${localToken}`);
    expect(request.redirect).toBe('error');
    observed.push({ method: request.method, url: new URL(request.url) });
    const next = replies.shift();
    if (!next) throw new Error('Unexpected provider request.');
    return next(request);
  });
  return {
    observed,
    catalog: () => run({ operation: 'catalog' }),
    execute: async (action: string, resourceId: string, args: unknown) => {
      const call = { action, resourceId, args };
      const result = await run({ operation: 'prepare', ...call });
      const parsed = z.object({ schemaHash: z.string() }).safeParse(result);
      if (!parsed.success) return result;
      return run({
        operation: 'execute',
        ...call,
        executionId,
        accessToken: localToken,
        schemaHash: parsed.data.schemaHash,
      });
    },
  };
}

const mail = {
  id: 'message_a',
  threadId: 'thread_a',
  historyId: '1037803355555555',
  labelIds: [allowedLabel],
  payload: {
    headers: [
      { name: 'From', value: 'Original Author <author@example.com>' },
      { name: 'Reply-To', value: 'Support Desk <support@example.com>' },
      { name: 'Subject', value: 'Order question' },
      { name: 'Message-ID', value: '<msg-a@example.com>' },
    ],
  },
};
const reviewedReply = {
  messageId: mail.id,
  historyId: mail.historyId,
  to: 'support@example.com',
  subject: 'Re: Order question',
  body: 'Thanks for the update.\nWe will follow up tomorrow.',
};

const driveFile = {
  id: 'file_a',
  name: 'Support report',
  mimeType: 'application/vnd.google-apps.document',
  parents: [allowedFolder],
  trashed: false,
  version: '492',
};
const calendarEvent = {
  id: 'old_event',
  status: 'confirmed',
  etag: '"604"',
  attendees: [{ email: 'reviewer@example.com', responseStatus: 'accepted' }],
};
const draft = {
  summary: 'Release review',
  description: 'Check the new task handoff.',
  schedule: { kind: 'timed', start: '2026-11-18T16:00:00Z', end: '2026-11-18T17:00:00Z' },
  attendees: ['reviewer@example.com'],
};

describe('Google connector actions', () => {
  it('publishes named actions with separate read and write scopes', async () => {
    const { catalog } = fixture();
    const descriptor = z.object({
      id: z.string(),
      kind: z.enum(['read', 'write']),
      resourceKind: z.string(),
    });
    const { actions } = z.object({ actions: z.array(descriptor) }).parse(await catalog());
    expect(actions).toHaveLength(15);
    expect(actions.find(({ id }) => id === 'gmail.list-messages')).toEqual({
      id: 'gmail.list-messages',
      kind: 'read',
      resourceKind: 'gmail-label',
    });
    expect(actions.find(({ id }) => id === 'gmail.send-reply')).toEqual({
      id: 'gmail.send-reply',
      kind: 'write',
      resourceKind: 'gmail-label',
    });
    expect(actions.find(({ id }) => id === 'google-drive.export-file')).toEqual({
      id: 'google-drive.export-file',
      kind: 'write',
      resourceKind: 'drive-folder',
    });
    expect(actions.find(({ id }) => id === 'google-calendar.free-busy')).toEqual({
      id: 'google-calendar.free-busy',
      kind: 'read',
      resourceKind: 'calendar',
    });
  });

  it('checks the Gmail label before reading message content and ignores text attachments', async () => {
    const { execute, observed } = fixture(
      () => Response.json(mail),
      () =>
        Response.json({
          ...mail,
          payload: {
            mimeType: 'multipart/mixed',
            parts: [
              {
                filename: 'attachment.txt',
                mimeType: 'text/plain',
                body: { data: Buffer.from('Attachment text').toString('base64url') },
              },
              {
                mimeType: 'text/plain',
                body: {
                  data: Buffer.from('Please change delivery to Thursday.').toString('base64url'),
                },
              },
            ],
          },
        }),
    );
    await expect(
      execute('gmail.get-message', allowedLabel, { messageId: mail.id }),
    ).resolves.toMatchObject({
      result: {
        id: mail.id,
        historyId: mail.historyId,
        replyTo: 'support@example.com',
        replySubject: 'Re: Order question',
        body: 'Please change delivery to Thursday.',
        bodySource: 'plain-text',
      },
    });
    expect(observed.map(({ url }) => url.searchParams.get('format'))).toEqual(['metadata', 'full']);

    const other = fixture(() => Response.json({ ...mail, labelIds: ['Label_elsewhere'] }));
    await expect(
      other.execute('gmail.get-message', allowedLabel, { messageId: mail.id }),
    ).resolves.toEqual({ failure: 'provider_unavailable' });
    expect(other.observed).toHaveLength(1);
  });

  it('sends exactly the reviewed Gmail reply only while the source and recipient match', async () => {
    const { execute, observed } = fixture(
      () => Response.json(mail),
      async (request) => {
        const value = z
          .object({ raw: z.string(), threadId: z.string() })
          .parse(await request.json());
        const mime = Buffer.from(value.raw, 'base64url').toString();
        const [headers, body = ''] = mime.split('\r\n\r\n');
        expect(value.threadId).toBe(mail.threadId);
        expect(headers?.split('\r\n')).toContain('To: support@example.com');
        expect(headers?.split('\r\n')).toContain('Subject: Re: Order question');
        expect(headers?.split('\r\n')).toContain('In-Reply-To: <msg-a@example.com>');
        expect(headers).not.toContain('Bcc:');
        expect(Buffer.from(body, 'base64').toString()).toBe(
          reviewedReply.body.replaceAll('\n', '\r\n'),
        );
        return Response.json({ id: 'reply_b', threadId: value.threadId });
      },
    );
    await expect(execute('gmail.send-reply', allowedLabel, reviewedReply)).resolves.toEqual({
      result: { id: 'reply_b', threadId: 'thread_a', to: 'support@example.com' },
    });
    expect(observed.map(({ method, url }) => [method, url.pathname])).toEqual([
      ['GET', '/gmail/v1/users/me/messages/message_a'],
      ['POST', '/gmail/v1/users/me/messages/send'],
    ]);

    const changed = fixture(() => Response.json(mail));
    await expect(
      changed.execute('gmail.send-reply', allowedLabel, {
        ...reviewedReply,
        to: 'elsewhere@example.com',
      }),
    ).resolves.toEqual({ failure: 'unknown_outcome' });
    expect(changed.observed.map(({ method }) => method)).toEqual(['GET']);
  });

  it('holds the Gmail checkpoint during pagination and reports when history has expired', async () => {
    const { execute, observed } = fixture(
      () =>
        Response.json({
          historyId: '1037803355555565',
          nextPageToken: 'next',
          history: [
            {
              messagesAdded: [{ message: mail }],
              labelsAdded: [
                { message: mail, labelIds: [allowedLabel] },
                {
                  message: { id: 'different', threadId: 'external' },
                  labelIds: ['different-label'],
                },
              ],
            },
          ],
        }),
      () => new Response('private upstream error', { status: 404 }),
    );
    const call = { after: mail.historyId };
    const first = await execute('gmail.list-changes', allowedLabel, call);
    const {
      result: { nextPageToken },
    } = z.object({ result: z.object({ nextPageToken: z.string() }) }).parse(first);
    expect(first).toEqual({
      result: {
        status: 'ready',
        messages: [{ id: mail.id, threadId: mail.threadId }],
        historyId: mail.historyId,
        nextPageToken,
      },
    });
    expect(nextPageToken).not.toBe('next');
    await expect(
      execute('gmail.list-changes', 'Label_elsewhere', { ...call, pageToken: nextPageToken }),
    ).resolves.toEqual({ failure: 'provider_unavailable' });
    expect(observed).toHaveLength(1);
    await expect(
      execute('gmail.list-changes', allowedLabel, { ...call, pageToken: nextPageToken }),
    ).resolves.toEqual({
      result: { status: 'resync_required' },
    });
    expect(observed[0]?.url.searchParams.get('labelId')).toBe(allowedLabel);
    expect(observed[1]?.url.searchParams.get('startHistoryId')).toBe(mail.historyId);
    expect(observed[1]?.url.searchParams.get('pageToken')).toBe('next');
  });

  it('queries Drive children in the selected folder and scopes native document reads', async () => {
    const { execute, observed } = fixture(
      () =>
        Response.json({
          files: [driveFile, { ...driveFile, id: 'outside', parents: ['outside'] }],
        }),
      () => Response.json(driveFile),
      () => new Response('Meeting notes'),
      () => Response.json(driveFile),
    );
    await expect(
      execute('google-drive.list-files', allowedFolder, { nameContains: "Ada's notes" }),
    ).resolves.toMatchObject({
      result: { files: [driveFile] },
    });
    expect(observed[0]?.url.searchParams.get('q')).toBe(
      "'folder_a' in parents and trashed = false and name contains 'Ada\\'s notes'",
    );
    await expect(
      execute('google-drive.read-file', allowedFolder, { fileId: driveFile.id }),
    ).resolves.toMatchObject({
      result: {
        ...driveFile,
        content: 'Meeting notes',
        contentType: 'text/markdown',
        truncated: false,
      },
    });
    expect(observed[2]?.url.pathname).toBe('/drive/v3/files/file_a/export');
    expect(observed[2]?.url.searchParams.get('mimeType')).toBe('text/markdown');

    const moved = fixture(() => Response.json({ ...driveFile, parents: ['elsewhere'] }));
    await expect(
      moved.execute('google-drive.read-file', allowedFolder, { fileId: driveFile.id }),
    ).resolves.toEqual({
      failure: 'provider_unavailable',
    });
    expect(moved.observed).toHaveLength(1);
  });

  it('uploads the exact text only to the configured active folder', async () => {
    const { execute, observed } = fixture(
      () =>
        Response.json({
          ...driveFile,
          id: allowedFolder,
          mimeType: 'application/vnd.google-apps.folder',
        }),
      async (request) => {
        expect(request.headers.get('content-type')).toMatch(/^multipart\/related; boundary=nix-/);
        expect(await request.text()).toContain(
          JSON.stringify({
            name: 'Reviewed notes.md',
            mimeType: 'text/markdown',
            parents: [allowedFolder],
          }),
        );
        return Response.json({
          ...driveFile,
          name: 'Reviewed notes.md',
          mimeType: 'text/markdown',
        });
      },
    );
    await expect(
      execute('google-drive.export-file', allowedFolder, {
        name: 'Reviewed notes.md',
        mimeType: 'text/markdown',
        content: 'One approved paragraph',
      }),
    ).resolves.toMatchObject({ result: { id: driveFile.id, parents: [allowedFolder] } });
    expect(observed[1]?.url.pathname).toBe('/upload/drive/v3/files');
  });

  it('uses one Google Calendar id for availability and an exact guest list for creation', async () => {
    const expectedId = executionId.replaceAll('-', '');
    const busy = [{ start: draft.schedule.start, end: draft.schedule.end }];
    const { execute, observed } = fixture(
      async (request) => {
        expect(await request.json()).toEqual({
          timeMin: draft.schedule.start,
          timeMax: draft.schedule.end,
          items: [{ id: allowedCalendar }],
        });
        return Response.json({ calendars: { [allowedCalendar]: { busy }, other: { busy: [] } } });
      },
      async (request) => {
        expect(await request.json()).toMatchObject({
          id: expectedId,
          attendees: [{ email: 'reviewer@example.com' }],
        });
        return Response.json({ ...calendarEvent, id: expectedId });
      },
    );
    await expect(
      execute('google-calendar.free-busy', allowedCalendar, {
        start: draft.schedule.start,
        end: draft.schedule.end,
      }),
    ).resolves.toMatchObject({ result: { calendarId: allowedCalendar, busy } });
    await expect(
      execute('google-calendar.create-event', allowedCalendar, {
        ...draft,
        notifyAttendees: true,
      }),
    ).resolves.toMatchObject({ result: { id: expectedId } });
    expect(observed[1]?.url.searchParams.get('sendUpdates')).toBe('all');
    expect(observed[1]?.url.pathname).toBe(
      '/calendar/v3/calendars/team%2Bschedule%40group.calendar.google.com/events',
    );
  });

  it('fences an approved Calendar edit with the reviewed provider revision', async () => {
    const args = {
      ...draft,
      eventId: calendarEvent.id,
      etag: calendarEvent.etag,
      previousAttendees: draft.attendees,
      notifyAttendees: false,
    };
    const { execute, observed } = fixture(
      () => Response.json(calendarEvent),
      async (request) => {
        expect(request.headers.get('if-match')).toBe(calendarEvent.etag);
        expect(await request.json()).toMatchObject({
          attendees: [{ email: 'reviewer@example.com', responseStatus: 'accepted' }],
        });
        return Response.json({ ...calendarEvent, etag: '"605"' });
      },
    );
    await expect(
      execute('google-calendar.update-event', allowedCalendar, args),
    ).resolves.toMatchObject({ result: { etag: '"605"' } });
    expect(observed.map(({ method }) => method)).toEqual(['GET', 'PATCH']);
    expect(observed[1]?.url.searchParams.get('sendUpdates')).toBe('none');

    const stale = fixture(() => Response.json({ ...calendarEvent, etag: '"different"' }));
    await expect(
      stale.execute('google-calendar.update-event', allowedCalendar, args),
    ).resolves.toEqual({ failure: 'unknown_outcome' });
    expect(stale.observed.map(({ method }) => method)).toEqual(['GET']);
    const guestChanged = fixture(() =>
      Response.json({
        ...calendarEvent,
        attendees: [{ email: 'guest@example.com' }],
      }),
    );
    await expect(
      guestChanged.execute('google-calendar.update-event', allowedCalendar, args),
    ).resolves.toEqual({
      failure: 'unknown_outcome',
    });
    expect(guestChanged.observed.map(({ method }) => method)).toEqual(['GET']);
  });
});
