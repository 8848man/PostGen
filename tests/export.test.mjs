import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHtml } from '../skill/postgen/scripts/export.mjs';

test('HTML export renders basic Markdown and escapes active HTML', () => {
  const html=renderHtml('# Title\n\nHello **world** <script>alert(1)</script>\n\n- item');
  assert.match(html,/<h1>Title<\/h1>/);assert.match(html,/<strong>world<\/strong>/);
  assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);assert.match(html,/<li>item<\/li>/);
});
