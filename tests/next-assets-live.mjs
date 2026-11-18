import assert from 'node:assert/strict';
import { loadAssetsStandard, assetsStandardConfig, standardRecord, imageRequest } from '../next/assets-standard.mjs';

const standard = await loadAssetsStandard({ channel: 'naver', task: '네이버 블로그 포스트' }, assetsStandardConfig());
assert.ok(standard, 'POSTGEN_ASSETS_CLI must point to the Assets Manager CLI');
const record = standardRecord(standard);
const chart = imageRequest(record, { position: '본문 2번째 문단 뒤', scene: '월별 완료 건수를 비교하는 막대 차트.', kind: 'chart' });
const diagram = imageRequest(record, { position: '본문 3번째 문단 뒤', scene: '세 단계가 이어진 흐름도.', kind: 'diagram' });
const illustration = imageRequest(record, { position: '본문 1번째 문단 뒤', scene: '두 사람이 메모를 정리한다.', kind: 'illustration' });
assert.deepEqual(chart.referencePaths.map(file => file.split(/[\\/]/).at(-1)), [record.chartReference.name]);
assert.deepEqual(diagram.referencePaths.map(file => file.split(/[\\/]/).at(-1)), [record.chartReference.name]);
assert.ok(!illustration.referencePaths.some(file => file.split(/[\\/]/).at(-1) === record.chartReference.name));
assert.match(chart.text, /월별 완료 건수/);
assert.match(illustration.text, /두 사람이 메모/);
console.log(JSON.stringify({ set: standard.set, chartReferences: chart.referencePaths, illustrationReferences: illustration.referencePaths }));
