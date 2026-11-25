// Draft bodies stay plain text (one paragraph per non-empty line). This module reads the structure
// the writing standards ask for out of that text: the table of contents, subheadings, list items
// and emphasis lines. Channel adapters turn it into editor formatting (Tistory HTML input).

const TOC_TITLE = /^목차\s*:?$/;
const BULLET = /^[-•·]\s+/;
const SMALL_HEADING = /^([①-⑳]|\d+-\d+[.)])/;
const CHECK_LINE = /^✔/;
const FAQ_QUESTION = /^Q\d+[.)]/;
export const TISTORY_EMPHASIS_COLOR = '#006dd7';

export function stripBullet(line) { return line.replace(BULLET, ''); }

// Line indexes (into the given lines) that are table-of-contents entries: the lines right after a
// '목차' line that each repeat a subheading appearing again later, until any other line.
export function tocLineIndexes(lines, headings) {
  const known = new Set(headings), toc = new Set();
  const trimmed = lines.map(line => line.trim());
  for (let index = 0; index < trimmed.length; index++) {
    if (!TOC_TITLE.test(trimmed[index])) continue;
    const seen = new Set();
    for (let next = index + 1; next < trimmed.length; next++) {
      const text = trimmed[next];
      if (!text) continue;
      const entry = stripBullet(text);
      if (!known.has(entry) || seen.has(entry) || !trimmed.slice(next + 1).includes(entry)) break;
      seen.add(entry);
      toc.add(next);
    }
  }
  return toc;
}

// For each heading, the line index of its one occurrence outside the table of contents, or -1 when
// it has none or more than one. Table-of-contents entries repeat headings on purpose (ISSUE-098).
export function headingLineIndexes(lines, headings) {
  const trimmed = lines.map(line => line.trim());
  const toc = tocLineIndexes(trimmed, headings);
  return headings.map(heading => {
    const matches = trimmed.flatMap((line, index) => line === heading && !toc.has(index) ? [index] : []);
    return matches.length === 1 ? matches[0] : -1;
  });
}

export function unmatchedHeadings(body, headings = []) {
  const indexes = headingLineIndexes(String(body).replace(/\r\n/g, '\n').split('\n'), headings);
  return headings.filter((_, index) => indexes[index] < 0);
}

// Which occurrence (0-based) of the heading's exact text is the real heading, among non-empty body lines.
export function headingOccurrence(body, headings, heading) {
  const lines = String(body).replace(/\r\n/g, '\n').split('\n').map(line => line.trim()).filter(Boolean);
  const target = headingLineIndexes(lines, headings)[headings.indexOf(heading)];
  if (target === undefined || target < 0) return null;
  return { index: lines.slice(0, target).filter(line => line === heading).length, total: lines.filter(line => line === heading).length };
}

// One block per non-empty body line, so block N is the paragraph an image's afterParagraph N refers to.
// Each block: { tag: p|h2|h3|li, list: null|'toc'|'bullet', text, bold, colored, parts }.
export function bodyBlocks(body, headings = []) {
  const lines = String(body).replace(/\r\n/g, '\n').split('\n').map(line => line.trim()).filter(Boolean);
  const toc = tocLineIndexes(lines, headings);
  const headingAt = new Set(headingLineIndexes(lines, headings).filter(index => index >= 0));
  return lines.map((line, index) => {
    if (headingAt.has(index)) return block(SMALL_HEADING.test(line) ? 'h3' : 'h2', null, [{ text: line }]);
    if (toc.has(index)) return block('li', 'toc', [{ text: stripBullet(line) }]);
    if (TOC_TITLE.test(line) && toc.has(index + 1)) return block('p', null, [{ text: line, bold: true }]);
    if (BULLET.test(line)) {
      const text = stripBullet(line);
      const label = text.match(/^([^:.!?。]{1,30}:)\s*(.*)$/);
      return block('li', 'bullet', label ? [{ text: label[1], bold: true }, ...(label[2] ? [{ text: ` ${label[2]}` }] : [])] : [{ text }]);
    }
    if (CHECK_LINE.test(line)) {
      const prefix = line.match(/^(✔[^:=]*[:=])\s*(.*)$/);
      return block('p', null, prefix ? [{ text: prefix[1], bold: true, colored: true }, ...(prefix[2] ? [{ text: ` ${prefix[2]}` }] : [])] : [{ text: line, bold: true, colored: true }]);
    }
    if (FAQ_QUESTION.test(line)) return block('p', null, [{ text: line, bold: true }]);
    return block('p', null, [{ text: line }]);
  });
}
function block(tag, list, parts) {
  return { tag, list, text: parts.map(part => part.text).join(''), bold: parts.filter(part => part.bold).map(part => part.text).join(''), colored: parts.some(part => part.colored), parts };
}

function escapeHtml(text) { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function inlineHtml(parts) {
  return parts.map(part => {
    let html = escapeHtml(part.text);
    if (part.colored) html = `<span style="color: ${TISTORY_EMPHASIS_COLOR};">${html}</span>`;
    return part.bold ? `<b>${html}</b>` : html;
  }).join('');
}

// HTML for the Tistory editor. Consecutive list blocks of the same kind share one <ul>.
export function tistoryHtml(body, headings = []) {
  const blocks = bodyBlocks(body, headings), out = [];
  for (let index = 0; index < blocks.length; index++) {
    const current = blocks[index];
    if (current.tag === 'li') {
      const items = [];
      while (index < blocks.length && blocks[index].tag === 'li' && blocks[index].list === current.list) items.push(`<li>${inlineHtml(blocks[index++].parts)}</li>`);
      index--;
      out.push(`<ul style="list-style-type: disc;" data-ke-list-type="disc">${items.join('')}</ul>`);
    } else if (current.tag === 'h2') out.push(`<h2 data-ke-size="size26">${inlineHtml(current.parts)}</h2>`);
    else if (current.tag === 'h3') out.push(`<h3 data-ke-size="size23">${inlineHtml(current.parts)}</h3>`);
    else out.push(`<p data-ke-size="size16">${inlineHtml(current.parts)}</p>`);
  }
  return out.join('');
}

// Compare blocks read back from the editor ({ tag, text, bold, colored }) with the expected ones.
// Returns null when they match, otherwise the first difference by block number only: automation
// errors must not quote body sentences (docs/sdd/next/04-contracts.md).
export function blockDifference(actual, expected) {
  for (let index = 0; index < Math.max(actual.length, expected.length); index++) {
    const a = actual[index], e = expected[index];
    if (!a || !e) return `block count differs (editor ${actual.length}, approved ${expected.length})`;
    if (a.tag !== e.tag) return `block ${index + 1} differs (editor ${a.tag}, approved ${e.tag})`;
    if (a.text !== e.text) return `block ${index + 1} text differs`;
    if (a.bold !== e.bold || a.colored !== e.colored) return `block ${index + 1} emphasis differs (bold ${a.bold ? 'yes' : 'no'}/${e.bold ? 'yes' : 'no'}, color ${a.colored ? 'yes' : 'no'}/${e.colored ? 'yes' : 'no'})`;
  }
  return null;
}
