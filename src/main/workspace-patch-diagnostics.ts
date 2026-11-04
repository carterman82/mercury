/** Explain unique near-matches without choosing or applying a replacement.
 * Inputs are logical LF text; exact matching and write preconditions stay in Workspace. */
export function diagnosePatchMismatch(logical: string, search: string): Record<string, unknown> {
  let diagnostic: Record<string, unknown> = {};
  const typography = (value: string) => value.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  for (const [reason, source, candidate] of [
    ['TYPOGRAPHIC_QUOTES', typography(logical), typography(search)],
    ['OVER_ESCAPED_BACKSLASHES', logical, search.replaceAll('\\\\', '\\')],
  ]) {
    const equivalent = source.indexOf(candidate);
    if (candidate && equivalent >= 0 && source.indexOf(candidate, equivalent + 1) < 0) {
      diagnostic = { reason, sourceLine: logical.slice(0, equivalent).split('\n').length, sourceExcerpt: logical.slice(equivalent, equivalent + Math.min(search.length, 2000)) };
      break;
    }
  }
  if (!Object.keys(diagnostic).length) {
    const normalizeIndent = (value: string) => value.replace(/^[ \t]+/gm, '');
    const source = normalizeIndent(logical), candidate = normalizeIndent(search);
    const equivalent = source.indexOf(candidate);
    if (candidate && equivalent >= 0 && source.indexOf(candidate, equivalent + 1) < 0) {
      const sourceLine = source.slice(0, equivalent).split('\n').length;
      const lines = logical.split('\n');
      diagnostic = { reason: 'LINE_INDENTATION', sourceLine,
        sourceExcerpt: lines.slice(sourceLine - 1, sourceLine - 1 + search.split('\n').length).join('\n').slice(0, 2000),
        sourceLeadingWhitespace: lines[sourceLine - 1].match(/^[ \t]*/)?.[0].length,
        searchLeadingWhitespace: search.match(/^[ \t]*/)?.[0].length };
    }
  }
  return diagnostic;
}
