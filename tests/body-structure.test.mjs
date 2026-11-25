import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyBlocks, blockDifference, headingOccurrence, tistoryHtml, tocLineIndexes, unmatchedHeadings } from '../skill/postgen/scripts/body-structure.mjs';

const headings = ['1. 첫째 방법', '① 작은 항목', '2. 둘째 방법'];
const body = [
  '도입 문단입니다.',
  '',
  '목차',
  '1. 첫째 방법',
  '2. 둘째 방법',
  '',
  '1. 첫째 방법',
  '① 작은 항목',
  '설명 문단입니다.',
  '- 횟수: 하루 한 번',
  '- 시간 확인',
  '✔ 정리 방법: 오늘 한 번 해 보세요.',
  '2. 둘째 방법',
  '✔ Point = 기준을 먼저 정합니다.',
  'Q1. 매일 해야 하나요?',
  '<b>태그</b> 같은 글자도 그대로 둡니다.'
].join('\n');

test('table of contents entries do not make headings ambiguous (ISSUE-098)', () => {
  assert.deepEqual(unmatchedHeadings(body, headings), []);
  assert.deepEqual([...tocLineIndexes(body.split('\n'), headings)], [3, 4]);
  assert.deepEqual(headingOccurrence(body, headings, '1. 첫째 방법'), { index: 1, total: 2 });
  assert.deepEqual(headingOccurrence(body, headings, '① 작은 항목'), { index: 0, total: 1 });
});

test('a heading repeated outside the table of contents is still rejected', () => {
  assert.deepEqual(unmatchedHeadings('1. 첫째 방법\n본문\n1. 첫째 방법', ['1. 첫째 방법']), ['1. 첫째 방법']);
  assert.deepEqual(unmatchedHeadings('본문', ['없는 소제목']), ['없는 소제목']);
});

test('a table of contents stops before a heading it does not list', () => {
  const partial = '목차\n1. 첫째 방법\n2. 둘째 방법\n1. 첫째 방법\n본문';
  assert.deepEqual(unmatchedHeadings(partial, ['1. 첫째 방법', '2. 둘째 방법']), []);
  assert.deepEqual(bodyBlocks(partial, ['1. 첫째 방법', '2. 둘째 방법']).map(block => block.tag), ['p', 'li', 'h2', 'h2', 'p']);
});

test('body blocks follow non-empty lines and carry heading levels, lists and emphasis', () => {
  const blocks = bodyBlocks(body, headings);
  assert.equal(blocks.length, body.split('\n').filter(line => line.trim()).length);
  assert.deepEqual(blocks.map(block => block.tag), ['p', 'p', 'li', 'li', 'h2', 'h3', 'p', 'li', 'li', 'p', 'h2', 'p', 'p', 'p']);
  assert.deepEqual(blocks[1], { tag: 'p', list: null, text: '목차', bold: '목차', colored: false, parts: [{ text: '목차', bold: true }] });
  assert.equal(blocks[2].list, 'toc');
  assert.equal(blocks[7].text, '횟수: 하루 한 번');
  assert.equal(blocks[7].bold, '횟수:');
  assert.equal(blocks[8].bold, '');
  assert.equal(blocks[9].bold, '✔ 정리 방법:');
  assert.equal(blocks[9].colored, true);
  assert.equal(blocks[11].bold, '✔ Point =');
  assert.equal(blocks[12].bold, 'Q1. 매일 해야 하나요?');
});

test('Tistory HTML groups lists, escapes text and keeps the block order', () => {
  const html = tistoryHtml(body, headings);
  assert.match(html, /<h2 data-ke-size="size26">1\. 첫째 방법<\/h2><h3 data-ke-size="size23">① 작은 항목<\/h3>/);
  assert.match(html, /<ul[^>]*><li>1\. 첫째 방법<\/li><li>2\. 둘째 방법<\/li><\/ul>/);
  assert.match(html, /<ul[^>]*><li><b>횟수:<\/b> 하루 한 번<\/li><li>시간 확인<\/li><\/ul>/);
  assert.match(html, /<p data-ke-size="size16"><b><span style="color: #006dd7;">✔ 정리 방법:<\/span><\/b> 오늘 한 번 해 보세요\.<\/p>/);
  assert.match(html, /&lt;b&gt;태그&lt;\/b&gt;/);
  assert.equal((html.match(/<ul/g) || []).length, 2);
});

test('block difference reports text, tag and emphasis changes', () => {
  const expected = bodyBlocks(body, headings).map(({ tag, text, bold, colored }) => ({ tag, text, bold, colored }));
  assert.equal(blockDifference(structuredClone(expected), expected), null);
  const lostHeading = structuredClone(expected); lostHeading[4].tag = 'p';
  assert.match(blockDifference(lostHeading, expected), /block 5 differs/);
  const lostBold = structuredClone(expected); lostBold[7].bold = '';
  assert.match(blockDifference(lostBold, expected), /emphasis differs/);
  assert.match(blockDifference(expected.slice(1), expected), /differs/);
});
