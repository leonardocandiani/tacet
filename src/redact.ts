// Redaction for anything that leaves the process as text a human will read.
//
// The agent shells out to executables the operator configured, and their stderr
// ends up in the operator's log. That is the right place for a failure message
// and the wrong place for the API key that caused it, so known credential shapes
// are masked on the way out. It is a net, not a guarantee: a secret with no
// recognisable shape passes through, which is why the log itself should be
// treated as sensitive.

// Only the last pattern captures, and it captures the label so "Authorization:
// Bearer x" keeps its label and loses its value. Everything else is
// non-capturing, because a captured prefix would be mistaken for that label and
// the secret would be printed back in full.
const PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g,
  /(\b(?:bearer|token|api[_-]?key|password|secret)\b["'\s:=]+)([^\s"',}]{8,})/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const p of PATTERNS) {
    out = out.replace(p, (match, label?: unknown) => (typeof label === 'string' ? `${label}[redacted]` : '[redacted]'));
  }
  return out;
}
