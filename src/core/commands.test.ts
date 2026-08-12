import { describe, expect, test } from 'bun:test';
import { isRecordingControl, readCommand } from './commands';

const opts = { wake: /\btacet\b/i };

describe('spoken commands', () => {
  test('ordinary conversation is not a command', () => {
    expect(readCommand('so we should note that down later', opts)).toBeNull();
    expect(readCommand('lets go off the record for a second', opts)).toBeNull();
  });

  test('the wake word is required — this is the whole guard', () => {
    expect(readCommand('note that down: ship on the 20th', opts)).toBeNull();
    expect(readCommand('tacet, note that down: ship on the 20th', opts)).toMatchObject({
      kind: 'capture-note',
      payload: 'ship on the 20th',
    });
  });

  test('captures a decision with its content', () => {
    expect(readCommand("tacet, that's a decision: budget stays at fifteen thousand", opts)).toMatchObject({
      kind: 'capture-decision',
      payload: 'budget stays at fifteen thousand',
    });
  });

  test('captures an action item', () => {
    expect(readCommand('tacet, action item: Sam reviews the leads by friday', opts)).toMatchObject({
      kind: 'capture-action',
      payload: 'Sam reviews the leads by friday',
    });
  });

  test('a decision phrasing is not swallowed by the note pattern', () => {
    expect(readCommand('tacet, record this decision: we ship on the 20th', opts)?.kind).toBe('capture-decision');
  });

  test('capture with no content still fires, meaning "what we just discussed"', () => {
    expect(readCommand('tacet, make a note', opts)).toMatchObject({ kind: 'capture-note', payload: '' });
  });

  test('asks for a mid-meeting status', () => {
    expect(readCommand('tacet, where are we?', opts)?.kind).toBe('status');
    expect(readCommand('tacet, catch me up', opts)?.kind).toBe('status');
  });

  test('recording controls are recognised in both directions', () => {
    expect(readCommand('tacet, off the record', opts)?.kind).toBe('off-the-record');
    expect(readCommand('tacet, back on the record please', opts)?.kind).toBe('on-the-record');
  });

  test('recording controls are marked so they can bypass the floor', () => {
    expect(isRecordingControl('off-the-record')).toBe(true);
    expect(isRecordingControl('on-the-record')).toBe(true);
    expect(isRecordingControl('capture-note')).toBe(false);
    expect(isRecordingControl('status')).toBe(false);
  });

  test('the wake word is stripped out of the captured text', () => {
    const c = readCommand('tacet, note that down: tacet should stay quiet here', opts);
    expect(c?.payload).toBe('should stay quiet here');
  });
});

describe('the status command does not swallow ordinary questions', () => {
  const opts = { wake: /\bnova\b/i };

  test('a question that merely contains the word "status" is not a command', () => {
    expect(readCommand('nova, what is the status of the API work?', opts)).toBeNull();
  });

  test('asking for the status is still a command', () => {
    expect(readCommand('nova, status?', opts)?.kind).toBe('status');
    expect(readCommand("nova, what's the status?", opts)?.kind).toBe('status');
    expect(readCommand('nova, where are we?', opts)?.kind).toBe('status');
    expect(readCommand('nova, catch me up', opts)?.kind).toBe('status');
  });
});
