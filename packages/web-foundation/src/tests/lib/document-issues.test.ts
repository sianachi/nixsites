import { afterEach, expect, it, vi } from 'vitest';
import {
  acknowledgeDocumentIssues,
  documentIssuesSnapshot,
  removeDocumentIssues,
  subscribeDocumentIssues,
  updateDocumentIssues,
} from '../../lib/document-issues';

const ids = ['p1', 'p2'];
const save = { key: 'save', message: 'Could not save' };
const conn = { key: 'conn', message: 'Offline' };

afterEach(() => {
  for (const id of ids) removeDocumentIssues(id);
});

it('merges sources sharing a key into one issue', () => {
  updateDocumentIssues('p1', [save], null, false);
  updateDocumentIssues('p2', [save], null, false);
  expect(documentIssuesSnapshot().issues).toEqual([save]);
});

it('hides every issue while any source is paused', () => {
  updateDocumentIssues('p1', [save], null, false);
  updateDocumentIssues('p2', [], null, true);
  expect(documentIssuesSnapshot().issues).toEqual([]);
});

it('keeps an acknowledged issue hidden until it goes away and returns', () => {
  updateDocumentIssues('p1', [save], null, false);
  acknowledgeDocumentIssues();
  expect(documentIssuesSnapshot().issues).toEqual([]);
  updateDocumentIssues('p1', [save], null, false);
  expect(documentIssuesSnapshot().issues).toEqual([]);
  removeDocumentIssues('p1');
  updateDocumentIssues('p1', [save], null, false);
  expect(documentIssuesSnapshot().issues).toEqual([save]);
});

it('keeps the earlier connection issue for undefined and clears it for null', () => {
  updateDocumentIssues('p1', [], conn, false);
  updateDocumentIssues('p1', [], undefined, false);
  expect(documentIssuesSnapshot().issues).toEqual([conn]);
  updateDocumentIssues('p1', [], null, false);
  expect(documentIssuesSnapshot().issues).toEqual([]);
});

it('calls subscribers on update and stops after unsubscribe', () => {
  const listener = vi.fn();
  const off = subscribeDocumentIssues(listener);
  updateDocumentIssues('p1', [save], null, false);
  expect(listener).toHaveBeenCalledTimes(1);
  off();
  updateDocumentIssues('p1', [], null, false);
  expect(listener).toHaveBeenCalledTimes(1);
});
