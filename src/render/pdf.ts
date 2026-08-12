// Minutes as a PDF, rendered by whatever headless browser is on the machine.
//
// No pandoc, no LaTeX, no headless-chrome npm package pulling a second browser
// down. Chromium is already installed on any machine that runs a meeting bot,
// and `--print-to-pdf` is a stable interface.
//
// The trap, and it cost an afternoon: Chrome writes the PDF and then sometimes
// does not exit. Awaiting the process hangs forever with a finished file sitting
// on disk. Wait for the FILE to stop growing, then kill the process.

import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEADLINE_MS = 60_000;

/** Where Chromium might be, in the order worth trying. */
const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
];

export async function findBrowser(explicit?: string): Promise<string | null> {
  if (explicit) return (await Bun.file(explicit).exists()) ? explicit : null;
  for (const path of CANDIDATES) {
    if (await Bun.file(path).exists()) return path;
  }
  return null;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Converts the small Markdown subset the minutes use. A full parser would be
 *  dead weight: the input comes from a format this project specifies itself. */
export function markdownToHtml(md: string): string {
  const blocks: string[] = [];
  let list: string[] = [];
  let paragraph: string[] = [];

  const flushList = () => {
    if (!list.length) return;
    blocks.push(`<ul>${list.map((i) => `<li>${i}</li>`).join('')}</ul>`);
    list = [];
  };

  // Consecutive lines are one paragraph, as Markdown means them to be. Emitting
  // a <p> per source line puts a blank line inside every wrapped sentence, which
  // only shows up once the PDF is rendered and looks like broken typesetting.
  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p>${paragraph.join(' ')}</p>`);
    paragraph = [];
  };

  const flush = () => {
    flushParagraph();
    flushList();
  };

  const inline = (t: string) =>
    escapeHtml(t)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flush();
      blocks.push(`<h${heading[1]?.length}>${inline(heading[2] ?? '')}</h${heading[1]?.length}>`);
      continue;
    }

    const item = line.match(/^[-*•]\s+(.*)$/);
    if (item) {
      flushParagraph();
      list.push(inline(item[1] ?? ''));
      continue;
    }

    flushList();
    paragraph.push(inline(line));
  }
  flush();
  return blocks.join('\n');
}

export interface PdfDocument {
  title: string;
  /** Shown under the title: date, participant count, whatever is worth knowing. */
  meta: string[];
  /** The minutes, in Markdown. */
  body: string;
  /** Full transcript, appended on its own page. Omit to print minutes alone. */
  transcript?: string;
  /** Accent colour. Defaults to a slate that prints well in black and white. */
  accent?: string;
  footer?: string;
}

export function buildHtml(doc: PdfDocument): string {
  const accent = doc.accent || '#0f766e';
  const transcript = doc.transcript
    ? `<div class="break"></div>\n<h2>Transcript</h2>\n<div class="transcript">${markdownToHtml(doc.transcript)}</div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(doc.title)}</title>
<style>
  @page { size: A4; margin: 20mm 18mm; }
  body { font-family: -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif; color: #1a1a1a; font-size: 10.5pt; line-height: 1.55; }
  header { border-bottom: 2px solid ${accent}; padding-bottom: 12px; margin-bottom: 22px; }
  h1 { font-size: 19pt; margin: 0 0 6px; color: ${accent}; }
  .meta { font-size: 9pt; color: #555; }
  .meta span:not(:last-child)::after { content: "·"; margin: 0 8px; color: #bbb; }
  h2 { font-size: 12.5pt; margin: 22px 0 8px; color: ${accent}; }
  h3 { font-size: 11pt; margin: 16px 0 6px; }
  /* A heading must never end a page alone, or a decision loses its label. */
  h1, h2, h3 { break-after: avoid; page-break-after: avoid; }
  p { margin: 0 0 8px; }
  ul { margin: 0 0 10px; padding-left: 18px; }
  li { margin-bottom: 4px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9.5pt; background: #f4f4f5; padding: 1px 4px; border-radius: 3px; }
  .transcript { font-size: 9.5pt; color: #333; }
  .transcript strong { color: ${accent}; }
  .break { page-break-before: always; }
  footer { margin-top: 26px; border-top: 1px solid #ddd; padding-top: 8px; font-size: 8pt; color: #888; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(doc.title)}</h1>
  <div class="meta">${doc.meta.map((m) => `<span>${escapeHtml(m)}</span>`).join('')}</div>
</header>

${markdownToHtml(doc.body)}

${transcript}

${doc.footer ? `<footer>${escapeHtml(doc.footer)}</footer>` : ''}
</body>
</html>`;
}

/** A dedicated profile directory, outside the output folder: the browser on a
 *  shared machine may be driving someone else's session, and reusing the default
 *  profile closes their windows. */
function printToPdf(browser: string, htmlPath: string, destination: string) {
  return Bun.spawn(
    [
      browser,
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${join(tmpdir(), 'meeting-agent-chrome')}`,
      '--no-pdf-header-footer',
      `--print-to-pdf=${destination}`,
      `file://${htmlPath}`,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
}

/** Ready = the file exists and has stopped growing. Reading it the moment it
 *  appears yields a truncated PDF. */
async function waitForFile(path: string, deadlineMs: number): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  let previous = -1;
  while (Date.now() < until) {
    await Bun.sleep(400);
    const size = Bun.file(path).size;
    if (size > 0 && size === previous) return true;
    previous = size;
  }
  return false;
}

export interface RenderOptions {
  /** Explicit browser path. Auto-detected when absent. */
  browser?: string;
  deadlineMs?: number;
  log?: (line: string) => void;
}

/** Renders to `destination`. Returns false rather than throwing: a missing PDF
 *  is a degraded delivery, never a reason to lose the meeting record. */
export async function renderPdf(doc: PdfDocument, destination: string, opts: RenderOptions = {}): Promise<boolean> {
  const log = opts.log ?? (() => {});
  const browser = await findBrowser(opts.browser);
  if (!browser) {
    log('no Chromium-based browser found; skipping PDF');
    return false;
  }

  const html = join(tmpdir(), `minutes-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`);
  try {
    await Bun.write(html, buildHtml(doc));

    const proc = printToPdf(browser, html, destination);

    const ready = await waitForFile(destination, opts.deadlineMs ?? DEADLINE_MS);
    proc.kill('SIGKILL');

    if (!ready) {
      log(`PDF never finished: ${(await new Response(proc.stderr).text()).slice(0, 200)}`);
      return false;
    }
    log(`PDF written (${Math.round(Bun.file(destination).size / 1024)} KB): ${destination}`);
    return true;
  } catch (err) {
    log(`PDF failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    await unlink(html).catch(() => {});
  }
}
