import { describe, expect, it } from 'vitest';
import { SendTeamMessageRequest } from '../api/dto';
import type { Actor } from './event';
import { canDeleteMessageAttachment, MAX_MESSAGE_ATTACHMENTS } from './message-attachment';
import type { TaskViewer } from './task';

const human = (handle: string): Actor => ({ kind: 'human', handle });
const uploadedBy = human('robin');
const viewer = (access: TaskViewer['access'], handle: string): TaskViewer => ({ access, handle });

describe('who may delete the file of a message', () => {
  it('lets the uploader, an owner and an admin', () => {
    expect(canDeleteMessageAttachment(viewer('developer', 'robin'), { uploadedBy })).toBe(true);
    expect(canDeleteMessageAttachment(viewer('owner', 'owner'), { uploadedBy })).toBe(true);
    expect(canDeleteMessageAttachment(viewer('admin', 'ada'), { uploadedBy })).toBe(true);
  });

  it('refuses any other member, and an AI member with the handle of a person', () => {
    expect(canDeleteMessageAttachment(viewer('developer', 'olga'), { uploadedBy })).toBe(false);
    expect(canDeleteMessageAttachment(viewer('client', 'cleo'), { uploadedBy })).toBe(false);
    expect(canDeleteMessageAttachment(viewer('ai', 'robin'), { uploadedBy })).toBe(false);
  });

  it('lets an AI uploader delete its own file, and no other AI', () => {
    const ai: Actor = { kind: 'ai', handle: 'dev-1' };
    expect(canDeleteMessageAttachment(viewer('ai', 'dev-1'), { uploadedBy: ai })).toBe(true);
    expect(canDeleteMessageAttachment(viewer('ai', 'dev-2'), { uploadedBy: ai })).toBe(false);
    expect(canDeleteMessageAttachment(viewer('developer', 'dev-1'), { uploadedBy: ai })).toBe(false);
  });
});

describe('the request to send a team message with files', () => {
  const id = (n: number) => `msa_${String(n).padStart(10, 'a')}`;
  const ok = (input: object) => SendTeamMessageRequest.safeParse({ to: ['dev-1'], ...input }).success;

  it('needs text or a file', () => {
    expect(ok({ text: 'Hello' })).toBe(true);
    expect(ok({ text: '', attachmentIds: [id(1)] })).toBe(true);
    expect(ok({ text: '   ', attachmentIds: [id(1)] })).toBe(true);
    expect(ok({ text: '' })).toBe(false);
    expect(ok({ text: '   ', attachmentIds: [] })).toBe(false);
  });

  it('trims the text and takes at most 20000 characters of it', () => {
    expect(SendTeamMessageRequest.parse({ to: ['dev-1'], text: '  hi  ' }).text).toBe('hi');
    expect(ok({ text: 'x'.repeat(20000) })).toBe(true);
    expect(ok({ text: 'x'.repeat(20001) })).toBe(false);
  });

  it('takes unique ids of the shape of a message file, at most the limit', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => id(i));
    expect(ok({ text: '', attachmentIds: many(MAX_MESSAGE_ATTACHMENTS) })).toBe(true);
    expect(ok({ text: '', attachmentIds: many(MAX_MESSAGE_ATTACHMENTS + 1) })).toBe(false);
    expect(ok({ text: 'x', attachmentIds: [id(1), id(1)] })).toBe(false);
    expect(ok({ text: 'x', attachmentIds: ['att_1234567890'] })).toBe(false);
    expect(ok({ text: 'x', attachmentIds: ['msa_Short'] })).toBe(false);
  });
});
