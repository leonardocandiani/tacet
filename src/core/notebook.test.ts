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

describe('notes that look alike', () => {
  test('a correction is kept alongside what it corrects, in the order said', () => {
    let book = newNotebook();
    book = merge(book, { decisions: [{ what: 'we will ship the new pricing page on Monday', at: 10 }] }, 10);
    book = merge(book, { decisions: [{ what: 'we will ship the new pricing page on Friday', at: 400 }] }, 400);

    // Choosing which one wins would mean guessing, and a wrong guess deletes a
    // real decision. Both are in the minutes, timestamped, last one last.
    expect(book.decisions).toHaveLength(2);
    expect(book.decisions[1]?.what).toContain('Friday');
  });

  test('two decisions sharing an opening are both kept', () => {
    let book = newNotebook();
    book = merge(book, { decisions: [{ what: 'we will hire two engineers in Q3 for the platform team', at: 10 }] }, 10);
    book = merge(book, { decisions: [{ what: 'we will hire two engineers in Q3 for the data team', at: 900 }] }, 900);

    expect(book.decisions).toHaveLength(2);
  });

  test('a sentence still being transcribed collapses into its finished form', () => {
    let book = newNotebook();
    book = merge(book, { decisions: [{ what: 'we will ship the new', at: 10 }] }, 10);
    book = merge(book, { decisions: [{ what: 'we will ship the new pricing page on Monday', at: 12 }] }, 12);

    expect(book.decisions).toHaveLength(1);
    expect(book.decisions[0]?.what).toBe('we will ship the new pricing page on Monday');
  });

  test('a later pass never rewrites the notebook it grew from', () => {
    const first = merge(newNotebook(), { actions: [{ what: 'send the contract', at: 1 }] }, 1);
    const before = JSON.parse(JSON.stringify(first));
    merge(first, { actions: [{ what: 'send the contract', owner: 'Ana', at: 2 }] }, 2);

    expect(first.actions).toEqual(before.actions);
  });

  test('the identical sentence arriving twice is still one decision', () => {
    let book = newNotebook();
    book = merge(book, { decisions: [{ what: 'budget stays at fifteen thousand', at: 10 }] }, 10);
    book = merge(book, { decisions: [{ what: 'Budget stays at fifteen thousand.', at: 90 }] }, 90);

    expect(book.decisions).toHaveLength(1);
    expect(book.decisions[0]?.at).toBe(10);
  });
});

describe('the spoken status when everything is answered', () => {
  test('says so instead of speaking a bare full stop', () => {
    let book = newNotebook();
    book = merge(book, { questions: [{ what: 'who signs the contract', at: 5 }] }, 5);
    book = merge(book, { answered: [{ question: 'who signs the contract', answer: 'Ana' }] }, 6);

    const said = speakableStatus(book);
    expect(said).not.toBe('.');
    expect(said).toContain('Nothing open');
  });
});
