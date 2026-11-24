// Minimal Markdown -> HTML for the turtle-skill analysis reports.
// Handles: # / ## headings, paragraphs, **bold**, [text](url),
// tables, unordered/ordered lists, horizontal rules. No code fences.
export function mdToHtml(src: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(
        /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener">$1</a>',
      );
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const isSepRow = (l: string) =>
    /^\s*\|[\s:|-]+\|\s*$/.test(l) && l.includes('-');
  const cells = (r: string) =>
    r
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => inline(c.trim()));
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t) {
      i++;
      continue;
    }
    if (/^#{1,2}\s/.test(t)) {
      const lvl = t.startsWith('## ') ? 3 : 2;
      out.push(`<h${lvl}>${inline(t.replace(/^#+\s*/, ''))}</h${lvl}>`);
      i++;
      continue;
    }
    if (/^---+$/.test(t)) {
      out.push('<hr />');
      i++;
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isSepRow(lines[i + 1])) {
      const head = cells(line);
      out.push(
        '<div class="tbl-wrap"><table><thead><tr>' +
          head.map((c) => `<th>${c}</th>`).join('') +
          '</tr></thead><tbody>',
      );
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        out.push(
          '<tr>' +
            cells(lines[i])
              .map((c) => `<td>${c}</td>`)
              .join('') +
            '</tr>',
        );
        i++;
      }
      out.push('</tbody></table></div>');
      continue;
    }
    if (/^[-*]\s/.test(t)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i].trim())) {
        items.push(
          `<li>${inline(lines[i].trim().replace(/^[-*]\s/, ''))}</li>`,
        );
        i++;
      }
      out.push('<ul>' + items.join('') + '</ul>');
      continue;
    }
    if (/^\d+[.)]\s/.test(t)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s/.test(lines[i].trim())) {
        items.push(
          `<li>${inline(lines[i].trim().replace(/^\d+[.)]\s/, ''))}</li>`,
        );
        i++;
      }
      out.push('<ol>' + items.join('') + '</ol>');
      continue;
    }
    const buf: string[] = [t];
    i++;
    while (i < lines.length) {
      const nt = lines[i].trim();
      if (!nt) break;
      if (
        /^#{1,2}\s/.test(nt) ||
        /^---+$/.test(nt) ||
        isTableRow(lines[i]) ||
        /^[-*]\s/.test(nt) ||
        /^\d+[.)]\s/.test(nt)
      )
        break;
      buf.push(nt);
      i++;
    }
    out.push(`<p>${buf.map(inline).join(' ')}</p>`);
  }
  return out.join('\n');
}
