import { describe, expect, test } from 'bun:test';
import { isEmpty, merge, newNotebook, pending, speakableStatus } from './notebook';

describe('live notebook', () => {
  test('starts empty', () => {
    expect(isEmpty(newNotebook())).toBe(true);
    expect(speakableStatus(newNotebook())).toBe('Nothing settled yet.');
  });

  test('folds a pass in', () => {
    const book = merge(
      newNotebook(),
      {
        decisions: [{ what: 'Ship the beta on the 20th', by: 'Alex', at: 120 }],
        actions: [{ what: 'Draft the release notes', owner: 'Sam', at: 130 }],
        questions: [{ what: 'Who signs off on pricing?', at: 140 }],
      },
      200,
    );
    expect(book.decisions).toHaveLength(1);
    expect(book.actions[0].owner).toBe('Sam');
    expect(book.consumedUntil).toBe(200);
  });

  test('the same decision restated does not duplicate', () => {
    let book = merge(newNotebook(), { decisions: [{ what: 'Ship the beta on the 20th', at: 10 }] }, 50);
    book = merge(book, { decisions: [{ what: 'ship the beta on the 20th!', at: 90 }] }, 100);
    expect(book.decisions).toHaveLength(1);
  });

  test('a later pass fills in an owner the first pass missed', () => {
    let book = merge(newNotebook(), { actions: [{ what: 'Draft the release notes', at: 10 }] }, 50);
    expect(book.actions[0].owner).toBeUndefined();

    book = merge(book, { actions: [{ what: 'Draft the release notes', owner: 'Sam', due: 'Friday', at: 90 }] }, 100);
    expect(book.actions).toHaveLength(1);
    expect(book.actions[0]).toMatchObject({ owner: 'Sam', due: 'Friday' });
  });

  test('a later pass never erases a known owner', () => {
    let book = merge(newNotebook(), { actions: [{ what: 'Draft the release notes', owner: 'Sam', at: 10 }] }, 50);
    book = merge(book, { actions: [{ what: 'Draft the release notes', at: 90 }] }, 100);
    expect(book.actions[0].owner).toBe('Sam');
  });

  test('answering closes an open question', () => {
    let book = merge(newNotebook(), { questions: [{ what: 'Who signs off on pricing?', at: 10 }] }, 50);
    expect(pending(book)).toHaveLength(1);

    book = merge(book, { answered: [{ question: 'who signs off on pricing', answer: 'Finance does' }] }, 100);
    expect(pending(book)).toHaveLength(0);
    expect(book.questions[0].answered).toBe('Finance does');
  });

  test('blank notes are dropped rather than stored', () => {
    const book = merge(newNotebook(), { decisions: [{ what: '   ', at: 1 }], actions: [{ what: '', at: 1 }] }, 10);
    expect(isEmpty(book)).toBe(true);
  });

  test('consumedUntil never goes backwards', () => {
    let book = merge(newNotebook(), {}, 500);
    book = merge(book, {}, 100);
    expect(book.consumedUntil).toBe(500);
  });

  test('the spoken status counts what matters and quotes the last decision', () => {
    const book = merge(
      newNotebook(),
      {
        decisions: [{ what: 'Budget stays at fifteen thousand', at: 10 }],
        actions: [{ what: 'Review the leads', owner: 'Sam', at: 20 }, { what: 'Update the deck', at: 30 }],
        questions: [{ what: 'Who owns the integration?', at: 40 }],
      },
      100,
    );
    const said = speakableStatus(book);
    expect(said).toContain('1 decision');
    expect(said).toContain('2 action items');
    expect(said).toContain('1 with an owner');
    expect(said).toContain('1 still open');
    expect(said).toContain('Budget stays at fifteen thousand');
  });

  test('merging returns a new notebook rather than mutating the old one', () => {
    const before = newNotebook();
    const after = merge(before, { decisions: [{ what: 'Something', at: 1 }] }, 10);
    expect(before.decisions).toHaveLength(0);
    expect(after.decisions).toHaveLength(1);
  });
});
