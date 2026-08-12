import { describe, expect, test } from 'bun:test';
import { buildHtml, markdownToHtml } from './pdf';

describe('markdown to html', () => {
  test('consecutive lines are one paragraph', () => {
    const html = markdownToHtml('The team reviewed the rollout\nand settled the date.');
    expect(html).toBe('<p>The team reviewed the rollout and settled the date.</p>');
  });

  test('a blank line starts a new paragraph', () => {
    const html = markdownToHtml('First thought.\n\nSecond thought.');
    expect(html).toBe('<p>First thought.</p>\n<p>Second thought.</p>');
  });

  test('headings become headings at the right level', () => {
    expect(markdownToHtml('## Decisions')).toBe('<h2>Decisions</h2>');
    expect(markdownToHtml('# Title')).toBe('<h1>Title</h1>');
  });

  test('bullets group into one list', () => {
    expect(markdownToHtml('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
  });

  test('a list closes when prose resumes', () => {
    expect(markdownToHtml('- one\nthen prose')).toBe('<ul><li>one</li></ul>\n<p>then prose</p>');
  });

  test('a paragraph closes when a list starts', () => {
    expect(markdownToHtml('intro line\n- one')).toBe('<p>intro line</p>\n<ul><li>one</li></ul>');
  });

  test('inline emphasis survives', () => {
    expect(markdownToHtml('**Sam:** said it')).toContain('<strong>Sam:</strong>');
    expect(markdownToHtml('a *quiet* word')).toContain('<em>quiet</em>');
  });

  test('html in the transcript is escaped, not executed', () => {
    const html = markdownToHtml('Alex: use <script>alert(1)</script> carefully');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});

describe('document assembly', () => {
  const doc = {
    title: 'Q3 Rollout',
    meta: ['12/08/2026', '6 utterances'],
    body: '## Summary\n\nIt went fine.',
    transcript: '**Alex:** hello',
  };

  test('carries the title into the tab and the page', () => {
    const html = buildHtml(doc);
    expect(html).toContain('<title>Q3 Rollout</title>');
    expect(html).toContain('<h1>Q3 Rollout</h1>');
  });

  test('puts the transcript on its own page', () => {
    expect(buildHtml(doc)).toContain('class="break"');
  });

  test('omits the transcript section when there is none', () => {
    const html = buildHtml({ ...doc, transcript: undefined });
    expect(html).not.toContain('<h2>Transcript</h2>');
  });

  test('escapes the title rather than letting it break the document', () => {
    expect(buildHtml({ ...doc, title: 'Q3 <b>Rollout</b>' })).toContain('Q3 &lt;b&gt;Rollout&lt;/b&gt;');
  });

  test('keeps headings from being orphaned at a page break', () => {
    expect(buildHtml(doc)).toContain('page-break-after: avoid');
  });
});
