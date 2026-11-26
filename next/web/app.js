const hashParams = new URLSearchParams(location.hash.slice(1));
const token = hashParams.get('token');
const message = document.querySelector('#message');
let cache;
let selectedCampaignId = null;
let selectedJobId = hashParams.get('job');
const scheduleInputs = new Map();
const conflictChecks = new Set();
const checkedChannels = new Set();
const ARCHIVE_AFTER_DAYS = 14;
const VISIBLE_SOURCES = 5;
let averageImageMs = 90_000;
const missingImages = job => (job.draft?.images || []).filter(image => !image.generatedPath && !image.pendingPath).length;
function defaultPublishTime() { const value = new Date(Date.now() + 24 * 60 * 60 * 1000); value.setSeconds(0, 0); value.setMinutes(Math.ceil(value.getMinutes() / 10) * 10); return localDateTime(value); }
// Make every missing image of the given channels in one server request, so the activity button can show n/m progress.
async function generateImagesFor(jobIds) {
  say(`이미지를 생성합니다. 진행 상황은 오른쪽 아래 작업 버튼에서 볼 수 있습니다.`, 300_000);
  const { results, total } = await api('/api/images/generate-batch', { jobIds });
  await refresh();
  const made = results.reduce((sum, entry) => sum + entry.generated, 0);
  const failed = results.filter(entry => entry.error);
  say(failed.length ? `이미지 ${made}/${total}장을 만들었습니다. 실패: ${failed.map(entry => `${channelName(entry.jobId)} (${entry.error})`).join(', ')}` : `이미지 ${made}장이 준비됐습니다. 확인한 뒤 발행하세요.`, 60_000);
}
// Non-empty body lines an image cannot follow: table of contents entries and list items (mirrors
// settleImagePosition in body-structure.mjs; the server enforces it).
function imageBlockedLines(lines, headings) {
  const blocked = new Set(), known = new Set(headings), trimmed = lines.map(line => line.trim());
  for (let index = 0; index < trimmed.length; index++) {
    if (/^[-•·]\s+/.test(trimmed[index])) blocked.add(index);
    if (!/^목차\s*:?$/.test(trimmed[index])) continue;
    for (let next = index + 1; next < trimmed.length; next++) {
      const entry = trimmed[next].replace(/^[-•·]\s+/, '');
      if (!known.has(entry) || !trimmed.slice(next + 1).includes(entry)) break;
      blocked.add(next);
    }
  }
  return blocked;
}
function channelName(jobId) {
  const job = cache.state.jobs.find(item => item.id === jobId);
  const account = cache.registry.accounts.find(item => item.id === job?.accountId);
  return `${channelLabels[account?.channel] || account?.channel || '채널'} ${account?.handle || job?.accountHandle || ''}`.trim();
}
// Approve the draft with its images, reserve it at the given time and start entering it into the editor.
async function publishJob(job, timeValue) {
  const social = isSocialJob(job);
  const parsed = new Date(timeValue); if (!social && (!timeValue || Number.isNaN(parsed.getTime()))) throw new Error('공개 시각을 지정하세요.');
  if (!social && parsed.getTime() % (10 * 60_000) !== 0) throw new Error('공개 시각은 10분 단위로 지정하세요.');
  const at = social ? null : parsed.toISOString();
  const standardUnverifiedAcknowledged = job.status === 'draft' && !hasDraftStandard(job) ? await confirmUnverifiedStandard() : false;
  if (job.status === 'draft' && !hasDraftStandard(job) && !standardUnverifiedAcknowledged) return false;
  await api(job.status === 'draft' ? '/api/publish-reservation' : '/api/schedule', { jobId: job.id, at, conflictAcknowledged: conflictChecks.has(job.id), standardUnverifiedAcknowledged });
  await api('/api/start', { jobId: job.id });
  await preparedBrowser(job.id, await api('/api/prepare-browser', { jobId: job.id }));
  return true;
}
// Checked channels one after another: each uses the publish time set on its own card (default: tomorrow).
async function publishChecked(jobs) {
  const ready = [], skipped = [];
  for (const job of jobs) {
    if (!job.draft || !['draft','approved'].includes(job.status)) skipped.push(`${channelName(job.id)}: 발행할 초안이 아닙니다`);
    else if (missingImages(job)) skipped.push(`${channelName(job.id)}: 이미지 ${missingImages(job)}장 미생성`);
    else if (job.diagnostics?.some(item => item.code === 'source_conflict') && !conflictChecks.has(job.id)) skipped.push(`${channelName(job.id)}: 출처 충돌 확인 필요`);
    else ready.push(job);
  }
  if (!ready.length) throw new Error(`발행할 수 있는 채널이 없습니다.\n${skipped.join('\n')}`);
  const plan = ready.map(job => `${channelName(job.id)} · ${isSocialJob(job) ? '작성 창만 채움 (게시는 직접)' : (scheduleInputs.get(job.id) || defaultPublishTime()).replace('T', ' ')}`);
  if (!confirm(`다음 채널을 차례로 발행(예약 등록)합니다.\n${plan.join('\n')}${skipped.length ? `\n\n제외:\n${skipped.join('\n')}` : ''}`)) return;
  const failures = [];
  for (const job of ready) {
    try { await publishJob(job, scheduleInputs.get(job.id) || defaultPublishTime()); }
    catch (error) { failures.push(`${channelName(job.id)}: ${error.message}`); }
  }
  await refresh();
  say(failures.length ? `일부 채널 발행에 실패했습니다.\n${failures.join('\n')}` : `${ready.length}개 채널 발행을 시작했습니다.`, 60_000);
}
function rememberSelection() { const params = new URLSearchParams({ token }); if (selectedJobId) params.set('job', selectedJobId); history.replaceState(null, '', `#${params}`); }
const statusLabels = { selected: '원본 등록', draft: '초안 검토', approved: '승인됨', awaiting_registration: '예약 준비', preparing: '편집기 준비', review_required: '변경 재검토', ready_to_register: '등록 대기', submitting: '예약 등록 중', registered: '예약 등록됨', verification_due: '공개 확인 필요', published: '발행 확인됨', unknown: '등록 결과 불명확', expired: '예약 만료', cancelled: '취소됨', failed: '실패' };
const hasDraftStandard = job => !!(job.draft?.standard?.set && /^[0-9a-f]{64}$/.test(job.draft.standard.sha256 || ''));
const displayStatus = job => job.status === 'published' && job.publication?.source === 'manual' ? '수동 발행 완료' : job.status === 'published' && job.publication?.source === 'implicit' ? '발행 완료 (예약 시각 경과)' :job.status === 'draft' && !hasDraftStandard(job) ? '지침 적용 확인 필요' : statusLabels[job.status] || job.status;
function usageText(entries) {
  const unique = [...new Map(entries.map(entry => [entry.id, entry])).values()];
  if (!unique.length) return '호스트 호출 기록 없음';
  const known = unique.filter(entry => entry.usage?.known);
  const input = known.reduce((sum, entry) => sum + entry.usage.inputTokens, 0);
  const output = known.reduce((sum, entry) => sum + entry.usage.outputTokens, 0);
  const subscription = unique.filter(entry => entry.usage?.subscription).at(-1)?.usage.subscription;
  const limit = subscription ? ` · 구독 한도 5시간 ${subscription.fiveHour?.usedPercent ?? '확인 불가'}% / 7일 ${subscription.sevenDay?.usedPercent ?? '확인 불가'}%` : ' · 구독 한도 확인 불가';
  return `호출 ${unique.length}회 · 확인된 입력 ${input.toLocaleString('ko-KR')} / 출력 ${output.toLocaleString('ko-KR')} 토큰${known.length < unique.length ? ' · 일부 사용량 확인 불가' : ''}${limit}`;
}
const channelLabels = { naver: '네이버 블로그', tistory: '티스토리', x: 'X', linkedin: '링크드인', instagram: '인스타그램', reddit: '레딧', threads: 'Threads' };
// X, LinkedIn, Instagram, Reddit: PostGen fills the composer; the user presses the platform's post button.
const SOCIAL_CHANNELS = ['x', 'linkedin', 'instagram', 'reddit'];
const channelOf = job => cache.registry.accounts.find(item => item.id === job.accountId)?.channel;
const isSocialJob = job => SOCIAL_CHANNELS.includes(channelOf(job));
// 채널 설정: an off channel's posts stay visible but greyed, and are left out of counts and bulk actions.
const TOGGLE_CHANNELS = ['naver', 'tistory', 'x', 'linkedin', 'instagram', 'reddit'];
const channelOn = channel => cache?.settings?.channels?.[channel] !== false;
const jobOn = job => channelOn(channelOf(job));
function excerpt(value, max = 140) { const text = String(value || '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max)}…` : text; }
function localDateTime(date) { const pad = value => String(value).padStart(2, '0'); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; }
async function api(path, data) {
  const pending = fetch(path, { method: data ? 'POST' : 'GET', headers: { 'x-postgen-token': token, ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
  // A POST may have started long work in the server; show it in the activity list right away.
  if (data) setTimeout(() => refreshActivity(), 400);
  const response = await pending;
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '요청에 실패했습니다');
  return result;
}
function say(text, durationMs = 7000) { message.textContent = text; setTimeout(() => { if (message.textContent === text) message.textContent = ''; }, durationMs); }
function button(label, action, blockedReason = null) {
  const element = document.createElement('button'); element.textContent = label; element.type = 'button';
  let running = false;
  element.onclick = async () => {
    if (running) return say(`${label} 작업이 진행 중입니다. 완료될 때까지 기다려 주세요.`);
    const reason = typeof blockedReason === 'function' ? blockedReason() : blockedReason;
    if (reason) return say(reason);
    running = true;
    try { await action(); await refresh(); }
    catch (error) { say(error.message, 60_000); }
    finally { running = false; }
  };
  return element;
}
function imageRevisionDialog() {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog'); dialog.className = 'image-revision-dialog'; dialog.setAttribute('aria-label', '이 이미지 재생성');
    const form = document.createElement('form'); form.method = 'dialog';
    const title = document.createElement('h3'); title.textContent = '이 이미지 재생성';
    const note = document.createElement('p'); note.textContent = '현재 이미지를 스타일 원본과 별도로 첨부합니다. 바꿀 부분을 적으세요. 새 후보를 확인하기 전까지 이전 이미지는 유지됩니다.';
    const label = document.createElement('label'); label.textContent = '추가 지침';
    const input = document.createElement('textarea'); input.required = true; input.maxLength = 2000; input.rows = 5; input.placeholder = '예: 인물의 자세를 바꾸고 배경의 글자는 제거해 주세요.'; label.append(input);
    const actions = document.createElement('div'); actions.className = 'image-revision-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '취소'; cancel.onclick = () => dialog.close();
    const submit = document.createElement('button'); submit.type = 'submit'; submit.value = 'regenerate'; submit.textContent = '재생성';
    actions.append(cancel, submit); form.append(title, note, label, actions); dialog.append(form); document.body.append(dialog);
    dialog.addEventListener('close', () => { const value = dialog.returnValue === 'regenerate' ? input.value.trim() : null; dialog.remove(); resolve(value); }, { once: true });
    dialog.showModal(); input.focus();
  });
}
function confirmUnverifiedStandard() {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog'); dialog.className = 'image-revision-dialog'; dialog.setAttribute('aria-label', '표준 확인');
    const form = document.createElement('form'); form.method = 'dialog';
    const message = document.createElement('p'); message.textContent = '표준 확인이 안된 글입니다. 발행하시겠습니까?';
    const actions = document.createElement('div'); actions.className = 'image-revision-actions';
    const cancel = document.createElement('button'); cancel.type = 'submit'; cancel.value = 'cancel'; cancel.textContent = '취소';
    const publish = document.createElement('button'); publish.type = 'submit'; publish.value = 'publish'; publish.textContent = '발행';
    actions.append(cancel, publish); form.append(message, actions); dialog.append(form); document.body.append(dialog);
    dialog.addEventListener('close', () => { const confirmed = dialog.returnValue === 'publish'; dialog.remove(); resolve(confirmed); }, { once: true });
    dialog.showModal();
  });
}
// Mirrors republishable in next-core.mjs; the server enforces the rule.
// 플랫폼 예약 등록이 확인됐지만 아직 발행 확인 전인 상태
const scheduledStatuses = ['registered','verification_due'];
const republishable = ['awaiting_registration','preparing','review_required','ready_to_register','expired','cancelled','failed','unknown','registered','verification_due'];
// Next ten-minute mark at least an hour ahead (Naver reservations use ten-minute steps); keep the old time if it is still valid.
function republishDefaultTime(job) {
  const previous = Date.parse(job.schedule?.at || '');
  if (previous > Date.now() + 60 * 60 * 1000 && new Date(previous).getMinutes() % 10 === 0) return localDateTime(new Date(previous));
  const next = new Date(Date.now() + 60 * 60 * 1000); next.setSeconds(0, 0); next.setMinutes(Math.ceil(next.getMinutes() / 10) * 10);
  return localDateTime(next);
}
async function registerBrowser(jobId, sessionId) {
  const output = await api('/api/registration/browser', { jobId, sessionId });
  say(output.result.verified ? '플랫폼 예약 등록을 확인했습니다.' : output.result.notSubmitted ? `태그나 발행 설정을 확인하지 못해 발행 버튼을 누르지 않았습니다: ${output.result.reason}` : `예약 결과를 확인할 수 없습니다. 플랫폼에서 중복 등록 여부를 확인하세요: ${output.result.reason}`);
}
async function preparedBrowser(jobId, output) {
  sessionStorage.setItem(`editor:${jobId}`, output.sessionId);
  if (output.loginRequired) return say(output.message?.includes('connected browser') ? '연결된 브라우저(포스팅용 크롬) 탭에서 직접 로그인한 뒤 이 화면의 “로그인 후 재개”를 누르세요.' : 'PostGen 전용 Edge 창에서 직접 로그인한 뒤 이 화면의 “로그인 후 재개”를 누르세요.');
  const job = output.state.jobs.find(item => item.id === jobId);
  if (job?.status === 'ready_to_register' && isSocialJob(job)) return say(`${channelName(jobId)} 작성 창에 글${job.draft.images.length ? '과 이미지' : ''}를 채웠습니다. 포스팅용 크롬에서 내용을 확인하고 게시 버튼을 직접 누른 뒤, 이 화면에서 '게시 완료 표시'를 눌러 주세요.${job.editor?.accountVerified === false ? ' 이 채널은 로그인한 계정을 자동으로 확인하지 못했으니 계정도 확인해 주세요.' : ''}`, 120_000);
  if (job?.status === 'ready_to_register') return registerBrowser(jobId, output.sessionId);
  say('편집기 내용이 승인본과 달라 재검토가 필요합니다.');
}
function writtenAt(job) {
  for (const source of job.sources || []) {
    const match = String(source.ref || '').replaceAll('\\', '/').split('/').pop().match(/^(\d{4})-(\d{2})-(\d{2})(?!\d)/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}T00:00:00+09:00`;
  }
  return job.createdAt;
}
function campaignCard(key, allJobs) {
  const group = allJobs.filter(jobOn);
  const published = group.filter(job => job.status === 'published').length;
  const scheduled = group.filter(job => scheduledStatuses.includes(job.status)).length;
  const stage = !group.length ? '' : published === group.length ? 'complete' : published + scheduled === group.length ? 'scheduled' : published || scheduled ? 'in-progress' : '';
  const stageLabel = !group.length ? '○ 켜진 채널 글 없음' : { complete: '✓ 모든 채널 발행 완료', scheduled: published ? '⏱ 남은 채널 예약 발행 등록됨' : '⏱ 예약 발행 등록됨', 'in-progress': published ? '◐ 일부 채널 발행 완료' : '◔ 일부 채널 예약 등록됨', '': '○ 발행 완료 전' }[stage];
  const item = document.createElement('button'); item.type = 'button'; item.className = `pick-card campaign-card ${stage} ${key === selectedCampaignId ? 'selected' : ''}`;
  const source = allJobs[0].sources[0];
  const off = allJobs.length - group.length;
  const title = document.createElement('strong'); title.textContent = excerpt(source?.text || allJobs[0].draft?.title || '원본 사본 만료', 55);
  const meta = document.createElement('small'); meta.textContent = `${group.length}개 채널 글${off ? ` (꺼진 채널 ${off}개 제외)` : ''} · 원문 ${new Date(writtenAt(allJobs[0])).toLocaleDateString('ko-KR')} · ${allJobs[0].sources.length}개 출처`;
  const progress = document.createElement('span'); progress.className = 'campaign-progress'; progress.textContent = `${stageLabel}${scheduled ? ` · 예약 ${scheduled}` : ''} · 발행 ${published}/${group.length}`;
  item.append(title, meta, progress); item.onclick = () => { selectedCampaignId = key; selectedJobId = null; refresh().catch(error => say(error.message)); };
  return item;
}
// Show the first `count` cards and scroll for the rest.
function limitVisibleCards(list, count) {
  list.classList.remove('scroll-limited'); list.style.maxHeight = '';
  const cards = [...list.querySelectorAll(':scope > .pick-card')];
  if (cards.length <= count) return;
  requestAnimationFrame(() => {
    const height = cards[count - 1].getBoundingClientRect().bottom - list.getBoundingClientRect().top;
    if (height > 0) { list.style.maxHeight = `${Math.ceil(height) + 2}px`; list.classList.add('scroll-limited'); }
  });
}
function channelBulkBar(allJobs) {
  const group = allJobs.filter(jobOn);
  const bar = document.createElement('div'); bar.className = 'channel-bulk';
  const checked = () => group.filter(job => checkedChannels.has(job.id));
  const all = document.createElement('label'); const allBox = document.createElement('input'); allBox.type = 'checkbox';
  allBox.disabled = !group.length;
  allBox.checked = group.length > 0 && group.every(job => checkedChannels.has(job.id)); allBox.indeterminate = !allBox.checked && group.some(job => checkedChannels.has(job.id));
  allBox.onchange = () => { for (const job of group) allBox.checked ? checkedChannels.add(job.id) : checkedChannels.delete(job.id); refresh().catch(error => say(error.message)); };
  all.append(allBox, ` 전체 선택 (${checked().length}/${group.length})`);
  const images = button('선택 채널 이미지 생성', async () => {
    const targets = checked().filter(job => job.status === 'draft' && missingImages(job));
    if (!targets.length) throw new Error('이미지를 만들 채널이 없습니다. 이미지가 남은 초안 채널을 선택하세요.');
    await generateImagesFor(targets.map(job => job.id));
  }, () => checked().length ? null : '채널을 선택하세요.');
  const publish = button('선택 채널 발행', async () => { await publishChecked(checked()); }, () => checked().length ? null : '채널을 선택하세요.');
  bar.append(all, images, publish);
  return bar;
}
function channelPick(job) {
  const on = jobOn(job);
  const wrap = document.createElement('div'); wrap.className = `channel-pick${on ? '' : ' channel-off'}`;
  const box = document.createElement('input'); box.type = 'checkbox'; box.checked = on && checkedChannels.has(job.id); box.disabled = !on; box.setAttribute('aria-label', `${channelName(job.id)} 선택`);
  if (!on) box.title = '채널 설정에서 꺼진 채널입니다';
  box.onchange = () => { box.checked ? checkedChannels.add(job.id) : checkedChannels.delete(job.id); refresh().catch(error => say(error.message)); };
  const card = channelCard(job);
  if (!on) { const badge = document.createElement('span'); badge.className = 'channel-off-badge'; badge.textContent = '꺼진 채널'; card.prepend(badge); }
  wrap.append(box, card);
  return wrap;
}
function channelCard(job) {
  const account = cache.registry.accounts.find(item => item.id === job.accountId);
  const item = document.createElement('button');
  item.type = 'button';
  item.className = `pick-card channel-card ${job.id === selectedJobId ? 'selected' : ''}`;
  const channel = document.createElement('small');
  channel.textContent = `${channelLabels[account?.channel] || account?.channel || '채널 미상'} · ${account?.handle || job.accountHandle}`;
  const title = document.createElement('strong');
  title.textContent = job.draft?.title || '초안 생성 전';
  const summary = document.createElement('span');
  summary.textContent = excerpt(job.draft?.body || '등록된 원본으로 글을 생성할 수 있습니다.', 180);
  const status = document.createElement('em');
  status.textContent = job.status === 'draft' && !hasDraftStandard(job) ? displayStatus(job) : job.review ? (job.review.decision === 'rejected' ? '반려됨' : '개선 요청') : displayStatus(job);
  item.append(channel, title, summary, status);
  item.onclick = () => { selectedJobId = job.id; refresh().catch(error => say(error.message)); };
  return item;
}
async function importManualImage(job, image) {
  const asset = (cache.registry.assets || []).find(item => item.id === image.assetId);
  const { request } = await api('/api/images/request', { jobId: job.id, imageId: image.id });
  const guide = request
    ? `Assets Manager 표준(${job.draft.standard.set})의 ImageGen 요청서입니다. ChatGPT에 아래 참조 이미지를 첨부하고 요청서를 붙여 넣어 만드세요.\n\n참조 이미지 파일:\n${request.referencePaths.join('\n')}\n\n${request.text}${asset ? `\n\n승인된 참고 자산(함께 첨부): ${asset.storedPath}` : ''}`
    : `호스트의 내장 이미지 기능으로 다음 장면을 만드세요: ${image.description}${asset ? `\n승인된 참고 자산: ${asset.storedPath}\n유지할 특징: ${asset.features}` : ''}`;
  if (request) {
    try { await navigator.clipboard.writeText(request.text); say('요청서를 클립보드에 복사했습니다.'); } catch {}
  }
  const filePath = prompt(`${guide}\n\n생성한 PNG/JPEG/WebP 파일의 절대 경로를 입력하세요.`);
  if (!filePath) return;
  if (!confirm('이미지를 직접 열어 내용과 시각 품질을 확인했습니까?')) return;
  const result = await api('/api/images/import', { jobId: job.id, imageId: image.id, path: filePath, reviewed: true });
  say(`이미지를 연결했습니다. 사용량: ${result.usage.known ? '확인됨' : '확인 불가'}`);
}
async function submitJob(event) {
  event.preventDefault();
  try {
    const form = Object.fromEntries(new FormData(event.target));
    const accountIds = [...document.querySelector('#accounts').selectedOptions].map(option => option.value);
    const sources = [];
    if (form.sourceText.trim()) sources.push({ type: 'text', text: form.sourceText });
    if (form.sourcePath.trim()) sources.push({ type: 'file', path: form.sourcePath });
    if (form.sourceUrl.trim()) sources.push({ type: 'url', url: form.sourceUrl });
    for (const selected of document.querySelectorAll('.record-source:checked')) sources.push({ type: 'ai-record', sourceId: selected.value });
    if (form.connectorId) {
      if (!form.sourceToolName.trim()) return say('연결 문서 도구 이름을 입력하세요.');
      sources.push({ type: 'connected', connectorId: form.connectorId, toolName: form.sourceToolName, args: JSON.parse(form.sourceToolArgs), ref: `${form.connectorId}:${form.sourceToolName}` });
    }
    await api('/api/job', { accountIds, audience: form.audience, model: form.model, projectName: form.projectName, sources });
    event.target.reset();
    await refresh();
  } catch (error) { say(error.message); }
}
let loginStatuses = {}, loginCheckedAt = 0;
const loginLabels = { logged_in: '로그인됨', logged_out: '로그인 필요', unknown: '확인 불가', checking: '확인 중' };
function postingAccountRow(entry, account) {
  const row = document.createElement('div');
  row.className = 'posting-account';
  const name = document.createElement('strong');
  name.textContent = `${channelLabels[account.channel] || account.channel} · ${account.handle}`;
  const status = loginStatuses[account.id];
  const state = status?.state || 'checking';
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = `login-badge ${state}`;
  badge.textContent = loginLabels[state];
  badge.title = state === 'logged_in' ? '포스팅용 크롬에서 포스팅 페이지 열기' : `포스팅용 크롬에서 로그인 페이지 열기${status?.reason ? ` (${status.reason})` : ''}`;
  badge.onclick = () => openPostingLogin(account.id, state === 'logged_in').catch(error => say(error.message));
  const form = document.createElement('form');
  const input = document.createElement('input');
  input.name = 'postingUrl';
  input.value = entry.custom ? entry.postingUrl : '';
  input.placeholder = entry.postingUrl || entry.error || '';
  input.setAttribute('aria-label', `${account.handle} 포스팅 주소`);
  const save = document.createElement('button');
  save.textContent = '주소 저장';
  form.append(input, save);
  form.onsubmit = async event => {
    event.preventDefault();
    try {
      await api('/api/account/posting-url', { accountId: account.id, postingUrl: input.value });
      say(input.value.trim() ? '포스팅 주소를 저장했습니다.' : '기본 포스팅 주소로 되돌렸습니다.');
      await refresh();
      await checkPostingLogins();
    } catch (error) { say(error.message); }
  };
  row.append(name, badge, form);
  return row;
}
function renderPostingAccounts() {
  const list = document.querySelector('#posting-accounts');
  // The list is rebuilt on every refresh; keep an address the user is typing.
  if (list.contains(document.activeElement)) return;
  list.replaceChildren();
  for (const entry of cache?.postingAccounts || []) {
    const account = cache.registry.accounts.find(item => item.id === entry.accountId);
    if (!account) continue;
    const row = postingAccountRow(entry, account);
    if (!channelOn(account.channel)) { row.classList.add('channel-off'); row.title = '채널 설정에서 꺼진 채널입니다. 로그인 확인을 하지 않습니다.'; }
    list.append(row);
  }
  if (!list.children.length) list.textContent = '네이버·티스토리 계정을 추가하면 여기에 표시됩니다.';
}
const postingAccountOn = entry => channelOn(cache?.registry?.accounts.find(item => item.id === entry.accountId)?.channel);
async function checkPostingLogins() {
  loginCheckedAt = Date.now();
  for (const entry of (cache?.postingAccounts || []).filter(postingAccountOn)) loginStatuses[entry.accountId] = { state: 'checking' };
  renderPostingAccounts();
  try {
    const { statuses } = await api('/api/login-status', {});
    loginStatuses = Object.fromEntries(statuses.map(status => [status.accountId, status]));
  } catch (error) {
    for (const entry of (cache?.postingAccounts || []).filter(postingAccountOn)) loginStatuses[entry.accountId] = { state: 'unknown', reason: error.message };
  }
  renderPostingAccounts();
}
async function openPostingLogin(accountId, loggedIn) {
  const result = await api('/api/login-open', { accountId, loggedIn });
  if (result.opened) return say(loggedIn ? '포스팅용 크롬에 포스팅 페이지를 열었습니다.' : '포스팅용 크롬에 로그인 페이지를 열었습니다. 로그인한 뒤 이 화면으로 돌아오면 다시 확인합니다.', 12_000);
  window.open(result.url, '_blank', 'noopener');
  say(`포스팅용 크롬에 연결하지 못해 이 브라우저에서 열었습니다. ${result.reason || ''}`, 12_000);
}
async function refresh() {
  cache = await api('/api/state');
  renderPostingAccounts();
  const settingsForm = document.querySelector('#settings');
  for (const name of ['retentionMonths', 'maxImageGenerations']) settingsForm.elements[name].value = String(cache.settings[name]);
  for (const name of ['backgroundNotifications', 'autoImageCheck']) settingsForm.elements[name].checked = cache.settings[name];
  settingsForm.elements.codexImageModel.replaceChildren(...(cache.codexModels || []).map(model => { const option = document.createElement('option'); option.value = model.id; option.textContent = model.recommended ? `${model.label} (권장)` : model.label; return option; }));
  settingsForm.elements.codexImageModel.value = cache.settings.codexImageModel;
  const accountSelect = document.querySelector('#accounts'); const selectedAccounts = new Set([...accountSelect.selectedOptions].map(option => option.value)); accountSelect.replaceChildren();
  const sampleAccountSelect = document.querySelector('#sample-accounts'); sampleAccountSelect.replaceChildren();
  const assetAccountSelect = document.querySelector('#asset-accounts'); assetAccountSelect.replaceChildren();
  for (const account of cache.registry.accounts) { const option = document.createElement('option'); option.value = account.id; option.disabled = !channelOn(account.channel); option.textContent = `${account.channel} / ${account.handle}${option.disabled ? ' (꺼진 채널)' : ''}`; option.selected = !option.disabled && selectedAccounts.has(account.id); accountSelect.append(option); }
  renderChannelToggles();
  for (const account of cache.registry.accounts) { const option = document.createElement('option'); option.value = account.id; option.textContent = `${account.channel} / ${account.handle}`; sampleAccountSelect.append(option); }
  for (const account of cache.registry.accounts) { const option = document.createElement('option'); option.value = account.id; option.textContent = `${account.channel} / ${account.handle}`; assetAccountSelect.append(option); }
  const samples = document.querySelector('#samples'); samples.replaceChildren();
  for (const sample of cache.registry.samples) { const row = document.createElement('p'); const account = cache.registry.accounts.find(item => item.id === sample.accountId); row.append(`${account?.handle || '?'} · ${sample.sourceType} · ${sample.status} `); if (sample.status === 'proposed') row.append(button('규칙 검토·승인', async () => { const raw = prompt('규칙 JSON 배열을 검토하고 수정하세요', JSON.stringify(sample.rules, null, 2)); if (raw) await api('/api/sample/approve', { sampleId: sample.id, rules: JSON.parse(raw) }); })); if (sample.status === 'approved' && account?.defaultSampleId !== sample.id) row.append(button('대표 샘플로 지정', async () => api('/api/sample/default', { accountId: sample.accountId, sampleId: sample.id }))); samples.append(row); }
  const connectors = document.querySelector('#connectors'); connectors.replaceChildren();
  const sourceConnectors = document.querySelector('#source-connectors'); sourceConnectors.replaceChildren(); const none = document.createElement('option'); none.value = ''; none.textContent = '선택 안 함'; sourceConnectors.append(none);
  for (const server of cache.connectors.servers) { const row = document.createElement('p'); row.append(`${server.name} · ${server.approvedFingerprint ? '허용됨' : '미승인'} `); row.append(button('도구 확인·허용', async () => { const result = await api('/api/connector/inspect', { id: server.id }); const list = result.tools.map(tool => `${tool.name}: ${tool.description || ''}`).join('\n'); if (confirm(`${server.name}의 도구를 서버 단위로 허용할까요?\n${list}`)) await api('/api/connector/approve', { id: server.id, fingerprint: result.fingerprint }); })); connectors.append(row); }
  for (const server of cache.connectors.servers.filter(item => item.approvedFingerprint)) { const option = document.createElement('option'); option.value = server.id; option.textContent = server.name; sourceConnectors.append(option); }
  const campaigns = new Map();
  for (const job of cache.state.jobs) { const key = job.campaignId || job.id; if (!campaigns.has(key)) campaigns.set(key, []); campaigns.get(key).push(job); }
  const sortedCampaigns = [...campaigns.entries()].sort((a, b) => Date.parse(b[1][0].createdAt) - Date.parse(a[1][0].createdAt));
  // 창고: campaigns whose original was written more than 14 days ago (moved by the server) or moved by hand.
  const archived = ([, group]) => group.some(job => job.archivedAt);
  const activeCampaigns = sortedCampaigns.filter(entry => !archived(entry)), archivedCampaigns = sortedCampaigns.filter(archived);
  const rememberedJob = cache.state.jobs.find(job => job.id === selectedJobId);
  if (rememberedJob) selectedCampaignId = rememberedJob.campaignId || rememberedJob.id;
  if (!campaigns.has(selectedCampaignId)) selectedCampaignId = activeCampaigns.find(([, group]) => group.some(job => job.status === 'draft' && job.draft?.images?.length))?.[0] || activeCampaigns.find(([, group]) => group.some(job => job.status === 'draft'))?.[0] || activeCampaigns[0]?.[0] || sortedCampaigns[0]?.[0] || null;
  const campaignList = document.querySelector('#campaigns'); campaignList.replaceChildren(...activeCampaigns.map(([key, group]) => campaignCard(key, group)));
  if (!activeCampaigns.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = archivedCampaigns.length ? '진행 중인 원본이 없습니다. 지난 원본은 아래 창고에 있습니다.' : '등록된 원본이 없습니다.'; campaignList.append(empty); }
  limitVisibleCards(campaignList, VISIBLE_SOURCES);
  const archive = document.querySelector('#archive');
  archive.hidden = archivedCampaigns.length === 0;
  document.querySelector('#archive-count').textContent = String(archivedCampaigns.length);
  document.querySelector('#archive-list').replaceChildren(...archivedCampaigns.map(([key, group]) => campaignCard(key, group)));
  if (archivedCampaigns.some(([key]) => key === selectedCampaignId)) archive.open = true;
  const group = campaigns.get(selectedCampaignId) || [];
  const sourceDetail = document.querySelector('#sources'); sourceDetail.replaceChildren();
  if (group.length) {
    const isArchived = group.some(job => job.archivedAt);
    const row = document.createElement('div'); row.className = 'archive-row';
    const written = new Date(writtenAt(group[0])).toLocaleDateString('ko-KR');
    const note = document.createElement('small'); note.textContent = isArchived ? `창고에 있는 원본입니다 · 원문 작성 ${written}` : `원문 작성 ${written} · 작성 ${ARCHIVE_AFTER_DAYS}일이 지나면 창고로 옮겨집니다`;
    row.append(note, button(isArchived ? '창고에서 꺼내기' : '창고로 보내기', async () => {
      await api('/api/archive', { jobId: group[0].id, archived: !isArchived });
      if (!isArchived) { selectedCampaignId = null; selectedJobId = null; }
    }));
    sourceDetail.append(row);
  }
  for (const source of group[0]?.sources || []) { const block = document.createElement('div'); block.className = 'source-item'; const meta = document.createElement('small'); meta.textContent = `${source.type} · ${source.ref} · ${source.capturedAt ? new Date(source.capturedAt).toLocaleString('ko-KR') : '수집 시각 없음'}`; const pre = document.createElement('pre'); pre.textContent = source.expired ? '보관 기간이 지나 원본 사본이 정리됐습니다.' : source.text; block.append(meta, pre); sourceDetail.append(block); }
  if (!group.some(job => job.id === selectedJobId)) selectedJobId = group.find(job => jobOn(job) && job.status === 'draft' && job.draft?.images?.length)?.id || group.find(jobOn)?.id || group[0]?.id || null;
  rememberSelection();
  const channelJobs = document.querySelector('#channel-jobs'); channelJobs.replaceChildren();
  for (const id of [...checkedChannels]) if (!group.some(job => job.id === id && jobOn(job))) checkedChannels.delete(id);
  if (group.length) channelJobs.append(channelBulkBar(group));
  for (const job of group) channelJobs.append(channelPick(job));
  const jobs = document.querySelector('#jobs'); jobs.replaceChildren();
  if (!selectedJobId) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '왼쪽에서 원본을 선택하세요.'; jobs.append(empty); }
  for (const job of cache.state.jobs.filter(item => item.id === selectedJobId)) {
    const article = document.createElement('article'); article.className = 'job';
    const account = cache.registry.accounts.find(item => item.id === job.accountId);
    const title = document.createElement('h3'); title.textContent = job.draft?.title || '새 글 작업'; article.append(title);
    const meta = document.createElement('small'); meta.textContent = `${account?.channel || '?'} / ${account?.handle || '?'} · ${job.status} · 글 ${job.model} / 이미지 ${job.imageProvider || 'manual'} · ${job.audience}`; article.append(meta);
    const usage = document.createElement('p'); usage.textContent = `이 글: ${usageText(job.modelUsage || [])} · 묶음: ${usageText(group.flatMap(item => item.modelUsage || []))}`; article.append(usage);
    const outcome = document.createElement('div'); outcome.className = 'outcome';
    const outcomeTitle = document.createElement('strong'); outcomeTitle.textContent = '예상 결과와 현재 상태'; outcome.append(outcomeTitle);
    const outcomeText = document.createElement('p'); outcomeText.textContent = job.status === 'published' && job.publication?.source === 'manual' ? `${channelLabels[account?.channel] || account?.channel || '채널'} / ${job.accountHandle}에 “${job.draft?.title || '제목 미정'}” 글을 사용자가 직접 올린 것으로 표시했습니다. 플랫폼 자동 확인은 하지 않았습니다.` : `${channelLabels[account?.channel] || account?.channel || '채널'} / ${job.accountHandle}에 “${job.draft?.title || '제목 미정'}” 글을 ${job.schedule?.at ? new Date(job.schedule.at).toLocaleString('ko-KR') : '승인 후 지정할 시각'}에 예약합니다. 현재: ${displayStatus(job)}.`; outcome.append(outcomeText);
    if (job.status === 'draft' && !hasDraftStandard(job)) { const notice = document.createElement('p'); notice.textContent = '지침 적용 기록이 없습니다. 발행 시 별도 확인을 요청합니다.'; outcome.append(notice); }
    if (job.status === 'published' && job.publication?.source === 'implicit') { const implicit = document.createElement('p'); implicit.textContent = `예약 시각(${new Date(job.schedule.at).toLocaleString('ko-KR')})이 지나 발행 완료로 처리했습니다. 실제로 올라가지 않았다면 “발행 안 됨으로 되돌리기”를 누르세요.`; outcome.append(implicit); }
    if (job.automationError && !['published','registered'].includes(job.status)) { const failure = document.createElement('p'); failure.className = 'automation-error'; failure.textContent = `마지막 자동 입력 중단 (${new Date(job.automationError.at).toLocaleString('ko-KR')}${job.automationError.stage ? ` · 단계: ${job.automationError.stage}` : ''}): ${job.automationError.message}`; outcome.append(failure); }
    if (job.registration) { const registration = document.createElement('p'); registration.textContent = `플랫폼 예약: ${job.registration.verified ? '확인됨' : '확인 불가'} · ${job.registration.remoteId || job.registration.reservationUrl || '영수증 없음'}`; outcome.append(registration); }
    if (job.publication?.postUrl) { const link = document.createElement('a'); link.href = job.publication.postUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = `공개 글 확인: ${job.publication.postUrl}`; outcome.append(link); }
    if (job.review) { const note = document.createElement('p'); note.className = 'review-note'; note.textContent = `${job.review.decision === 'rejected' ? '반려' : '개선 요청'}: ${job.review.note}`; outcome.append(note); }
    article.append(outcome);
    if (job.draft) { const tags = document.createElement('p'); tags.className = 'draft-tags'; tags.textContent = `추천 태그 (${(job.draft.tags || []).length}/5): ${(job.draft.tags || []).map(tag => `#${tag}`).join('  ') || '없음'}`; article.append(tags); }
    if (job.draft && (['draft','approved','awaiting_registration','preparing','review_required','ready_to_register','cancelled','expired','failed'].includes(job.status) || job.status === 'published' && job.publication?.source === 'manual')) {
      const manual = document.createElement('div'); manual.className = 'manual-publication';
      const label = document.createElement('label'); const check = document.createElement('input'); check.type = 'checkbox'; check.checked = job.status === 'published'; label.append(check, ' 수동으로 발행함');
      const hint = document.createElement('small'); hint.textContent = '플랫폼에 직접 올렸다면 체크하세요. URL 없이 이 채널을 발행 완료로 표시합니다.';
      check.onchange = async () => { try { await api(check.checked ? '/api/publication/manual' : '/api/publication/manual/undo', { jobId: job.id }); await refresh(); say(check.checked ? '수동 발행 완료로 표시했습니다.' : '수동 발행 표시를 해제했습니다.'); } catch (error) { check.checked = !check.checked; say(error.message); } };
      manual.append(label, hint); article.append(manual);
    }
    if (job.status === 'draft') {
      const tagRow = document.createElement('div'); tagRow.className = 'tag-edit-row';
      const tagInput = document.createElement('input'); tagInput.setAttribute('aria-label', '발행 태그'); tagInput.placeholder = '태그를 쉼표로 구분해 입력 (최대 5개)'; tagInput.value = (job.draft.tags || []).join(', ');
      tagRow.append(tagInput, button('태그 저장', async () => {
        const tags = tagInput.value.split(',').map(tag => tag.trim()).filter(Boolean);
        const { lock } = await api('/api/draft/lock', { jobId: job.id });
        try { await api('/api/draft', { jobId: job.id, draft: { ...job.draft, tags }, lockToken: lock.token, expectedDraftRevision: lock.draftRevision }); }
        finally { await api('/api/draft/unlock', { jobId: job.id, token: lock.token }); }
        await refresh();
        say('태그를 저장했습니다. 네이버 글은 본문 첫 줄에 태그가 표시됩니다.');
      })); article.append(tagRow);
    }
    const canRepublish = job.draft && job.approval && republishable.includes(job.status);
    if (canRepublish || ['cancelled','failed','ready_to_register','unknown'].includes(job.status)) {
      const recovery = document.createElement('section'); recovery.className = 'publish-panel';
      const heading = document.createElement('h4'); heading.textContent = '다시 시도'; recovery.append(heading);
      if (canRepublish) {
        const reason = job.submission?.reason || job.republishHistory?.at(-1)?.reason;
        const note = document.createElement('p'); note.textContent = `승인된 글과 이미지를 그대로 쓰고 새 시각으로 예약 등록을 처음부터 다시 진행합니다.${reason ? ` 지난 오류: ${reason}` : ''}${job.republishHistory?.length ? ` (재발행 ${job.republishHistory.length}회)` : ''}`; recovery.append(note);
        const row = document.createElement('div'); row.className = 'publish-row';
        const time = document.createElement('input'); time.type = 'datetime-local'; time.step = '600'; time.setAttribute('aria-label', '재발행 공개 시각'); time.value = scheduleInputs.get(`republish:${job.id}`) || republishDefaultTime(job); time.oninput = () => scheduleInputs.set(`republish:${job.id}`, time.value);
        row.append(time, button('재발행', async () => {
          const parsed = new Date(time.value); if (!time.value || Number.isNaN(parsed.getTime())) throw new Error('공개 시각을 지정하세요.');
          const platformChecked = Boolean(job.submission?.startedAt || job.registration);
          if (platformChecked && !confirm('이 글은 이미 플랫폼에 등록됐을 수 있습니다. 플랫폼의 예약 목록과 발행 글에 이 글이 없는 것을 확인했습니까? 확인하지 않고 재발행하면 중복 게시될 수 있습니다.')) return say('재발행을 취소했습니다.');
          if (!platformChecked && !confirm(`승인된 글을 ${parsed.toLocaleString()}에 다시 예약 등록합니다. 진행할까요?`)) return say('재발행을 취소했습니다.');
          await api('/api/publication/republish', { jobId: job.id, at: parsed.toISOString(), platformChecked });
          scheduleInputs.delete(`republish:${job.id}`);
          say('재발행 예약을 저장했습니다. 편집기를 준비합니다.', 60_000);
          await refresh();
          await api('/api/start', { jobId: job.id });
          await refresh();
          await preparedBrowser(job.id, await api('/api/prepare-browser', { jobId: job.id }));
        }));
        recovery.append(row);
      }
      if (['cancelled','failed'].includes(job.status) && job.draft) recovery.append(button('초안으로 되돌려 다시 시도', async () => { if (!confirm('초안을 다시 검토하고 이 계정의 발행을 새로 승인하시겠습니까?')) return; await api('/api/publication/retry', { jobId: job.id }); say('초안 검토로 되돌렸습니다. 태그와 내용을 확인한 뒤 새 예약을 진행하세요.'); }));
      if (job.status === 'ready_to_register') recovery.append(button('발행 설정 확인 후 다시 시도', async () => { const sessionId = sessionStorage.getItem(`editor:${job.id}`); if (!sessionId) throw new Error('편집기 세션이 없습니다. 이 발행을 취소하고 초안에서 다시 시도하세요.'); await registerBrowser(job.id, sessionId); }));
      if (job.status === 'unknown' && account?.channel === 'naver') recovery.append(button('네이버 예약 목록 다시 확인', async () => { const output = await api('/api/registration/recheck', { jobId: job.id }); say(output.result.verified ? '예약 등록을 확인했습니다.' : `등록 여부를 확인하지 못했습니다: ${output.result.reason}`); }));
      article.append(recovery);
    }
    if (['selected','draft','approved','awaiting_registration','preparing','review_required','ready_to_register','expired'].includes(job.status)) article.append(button('이 발행 취소', async () => { if (confirm('이 계정의 발행 작업을 취소합니까?')) await api('/api/cancel', { jobId: job.id }); }));
    if (job.draft) {
      const imageReview = document.createElement('section'); imageReview.className = 'image-review';
      const heading = document.createElement('h4'); heading.textContent = `이미지 ${job.draft.images.length}건`; imageReview.append(heading);
      if (!job.draft.images.length) { const empty = document.createElement('p'); empty.textContent = '이 글에는 이미지 제안이 없습니다.'; imageReview.append(empty); }
      const paragraphs = job.draft.body.replace(/\r\n/g, '\n').split('\n').map(line => line.trim()).filter(Boolean);
      for (const image of job.draft.images) {
        const block = document.createElement('div'); block.className = 'image-review-item';
        const label = document.createElement('p'); label.textContent = `본문 ${image.afterParagraph}번째 문단 뒤 · ${image.pendingPath ? '후보 검수 필요' : image.generatedPath ? '연결됨' : '생성 전'} · ${image.description}`; block.append(label);
        if (job.status === 'draft') {
          const placement = document.createElement('div'); placement.className = 'image-placement';
          const select = document.createElement('select'); select.setAttribute('aria-label', `${image.description} 배치 위치`);
          const listLines = imageBlockedLines(paragraphs, job.draft.headings || []);
          for (const [index, paragraph] of paragraphs.entries()) { const option = document.createElement('option'); option.value = String(index + 1); option.disabled = listLines.has(index) && index + 1 !== image.afterParagraph; option.textContent = `${index + 1}번째 문단 뒤 · ${excerpt(paragraph, 70)}${listLines.has(index) ? ' (목차·목록 안 · 선택 불가)' : ''}`; option.selected = index + 1 === image.afterParagraph; select.append(option); }
          select.onchange = async () => { try { await api('/api/images/position', { jobId: job.id, imageId: image.id, afterParagraph: Number(select.value) }); await refresh(); say('이미지 위치를 저장했습니다.'); } catch (error) { say(error.message); } };
          placement.append(select);
          block.append(placement);
        }
        const visibleCheck = image.pendingPath ? image.pendingCheck : image.check;
        if (visibleCheck?.passed === false) { const check = document.createElement('p'); check.textContent = `자동 점검 실패: ${visibleCheck.reason}${visibleCheck.manualAccepted ? ' · 수동 승인됨' : ''}`; block.append(check); }
        if (image.generatedPath || image.pendingPath) {
          try {
            const preview = await api('/api/images/preview', { jobId: job.id, imageId: image.id });
            const picture = document.createElement('img'); picture.className = 'image-preview'; picture.alt = image.description; picture.src = preview.dataUrl; block.prepend(picture);
          }
          catch { const error = document.createElement('p'); error.textContent = '이미지를 불러오지 못했습니다. 파일을 확인하세요.'; block.append(error); }
        }
        if (job.status === 'draft' && (image.pendingPath || image.generatedPath)) {
          const regenerate = button('이 이미지 재생성', async () => {
            const instructions = await imageRevisionDialog(); if (!instructions) return;
            if (job.imageProvider !== 'codex') await api('/api/images/provider', { jobId: job.id, provider: 'codex' });
            if (!job.draft.imagePlanApproved) await api('/api/images/approve-plan', { jobId: job.id });
            say('이전 이미지를 첨부해 재생성 중입니다. 호스트 응답을 기다려 주세요.', 300_000);
            const result = await api('/api/images/regenerate', { jobId: job.id, imageId: image.id, previousPath: image.pendingPath || image.generatedPath, instructions });
            say(`새 이미지 후보가 준비됐습니다. ${result.attempts}회 생성 · 미리 본 뒤 발행하거나 후보를 버리세요.`, 60_000);
          }, () => (image.generationAttempts || 0) >= cache.settings.maxImageGenerations ? `이 이미지는 생성 시도 한도 ${cache.settings.maxImageGenerations}회에 도달했습니다. 설정에서 한도를 늘린 뒤 다시 시도하세요.` : null);
          block.append(regenerate);
        }
        if (job.status === 'draft' && !image.generatedPath) {
          const options = document.createElement('details'); options.className = 'image-options';
          const summary = document.createElement('summary'); summary.textContent = '이미지 옵션'; options.append(summary);
          if (image.pendingPath) options.append(button('후보 버리기', async () => { await api('/api/images/discard', { jobId: job.id, imageId: image.id, candidatePath: image.pendingPath }); say('후보를 버렸습니다.'); }));
          else options.append(button('이 제안 제외', async () => api('/api/images/remove', { jobId: job.id, imageId: image.id })));
          block.append(options);
        }
        if (job.status === 'draft' && image.pendingPath && image.generatedPath) {
          const options = document.createElement('details'); options.className = 'image-options';
          const summary = document.createElement('summary'); summary.textContent = '이미지 옵션'; options.append(summary);
          options.append(button('새 후보 버리고 이전 이미지 유지', async () => api('/api/images/discard', { jobId: job.id, imageId: image.id, candidatePath: image.pendingPath })));
          block.append(options);
        }
        imageReview.append(block);
      }
      article.append(imageReview);
    }
    if (job.draft) { const body = document.createElement('pre'); body.textContent = job.draft.body; article.append(body); }
    if (job.draft?.evaluation) { const scores = document.createElement('pre'); scores.textContent = JSON.stringify(job.draft.evaluation, null, 2); article.append(scores); }
    if (job.draft && ['draft','approved'].includes(job.status)) {
      const panel = document.createElement('section'); panel.className = 'publish-panel';
      const title = document.createElement('h4'); title.textContent = '발행'; panel.append(title);
      const social = SOCIAL_CHANNELS.includes(account?.channel);
      const note = document.createElement('p'); note.textContent = social ? `${account?.handle || job.accountHandle} · 이미지 ${job.draft.images.length}장 · 누르면 글을 승인하고 포스팅용 크롬에서 ${channelLabels[account.channel]} 작성 창을 채웁니다. 게시 버튼은 직접 누릅니다(플랫폼 약관상 자동 게시를 하지 않습니다).` : `${account?.handle || job.accountHandle} · 이미지 ${job.draft.images.length}장 · 발행을 누르면 표시된 글과 이미지를 함께 승인하고 지정 시각 예약 등록을 시작합니다.`; panel.append(note);
      const row = document.createElement('div'); row.className = 'publish-row';
      if (!scheduleInputs.has(job.id)) scheduleInputs.set(job.id, defaultPublishTime());
      const time = document.createElement('input'); time.type = 'datetime-local'; time.step = '600'; time.setAttribute('aria-label', '공개 시각'); time.value = scheduleInputs.get(job.id); time.oninput = () => scheduleInputs.set(job.id, time.value);
      const missing = missingImages(job);
      const publish = button(social ? '작성 창 채우기' : '발행', async () => { await publishJob(job, time.value); }, () => missing > 0 ? `이미지 ${missing}장을 아직 만들지 않아 발행할 수 없습니다. 이미지를 만들거나 제안을 제외하세요.` : null);
      if (!social) row.append(time);
      if (job.status === 'draft' && missing) row.append(button('이미지 만들기', async () => { await generateImagesFor([job.id]); }));
      row.append(publish); panel.append(row);
      const hint = document.createElement('p'); hint.textContent = missing ? `이미지 ${missing}장을 먼저 만드세요.` : !hasDraftStandard(job) ? '지침 적용 기록이 없어 발행 시 확인 다이얼로그가 열립니다.' : '이미지마다 승인할 필요 없이 발행 한 번으로 진행합니다.'; panel.append(hint);
      if (job.diagnostics?.some(item => item.code === 'source_conflict')) { const label = document.createElement('label'); const conflict = document.createElement('input'); conflict.type = 'checkbox'; conflict.checked = conflictChecks.has(job.id); conflict.onchange = () => conflict.checked ? conflictChecks.add(job.id) : conflictChecks.delete(job.id); label.append(conflict, ' 출처 충돌을 확인했습니다'); panel.append(label); }
      article.append(panel);
    }
    if (SOCIAL_CHANNELS.includes(account?.channel) && job.status === 'ready_to_register') {
      const panel = document.createElement('section'); panel.className = 'publish-panel';
      const title = document.createElement('h4'); title.textContent = '직접 게시'; panel.append(title);
      const note = document.createElement('p'); note.textContent = `포스팅용 크롬의 ${channelLabels[account.channel]} 작성 창에 승인된 글${job.draft.images.length ? '과 이미지' : ''}를 채웠습니다. 내용${job.editor?.accountVerified === false ? '과 로그인한 계정' : ''}을 확인하고 게시 버튼을 직접 누른 뒤 아래 버튼을 눌러 주세요.`; panel.append(note);
      const row = document.createElement('div'); row.className = 'publish-row';
      row.append(button('게시 완료 표시', async () => { await api('/api/publication/manual', { jobId: job.id }); say(`${channelName(job.id)} 게시 완료로 표시했습니다.`); }));
      row.append(button('작성 창 다시 채우기', async () => { await api('/api/publication/republish', { jobId: job.id, platformChecked: false }); await api('/api/start', { jobId: job.id }); await preparedBrowser(job.id, await api('/api/prepare-browser', { jobId: job.id })); }));
      panel.append(row); article.append(panel);
    }
    const advanced = document.createElement('details'); advanced.className = 'advanced-actions';
    const advancedLabel = document.createElement('summary'); advancedLabel.textContent = '글·이미지 편집 옵션'; advanced.append(advancedLabel);
    const actions = document.createElement('div'); actions.className = 'actions'; advanced.append(actions); article.append(advanced);
    if (['draft','approved'].includes(job.status) && hasDraftStandard(job)) for (const [decision, label] of [['improvement_requested','개선'], ['rejected','반려']]) actions.append(button(label, async () => { const note = prompt(`${label} 사유를 입력하세요. 작업에 기록됩니다.`); if (!note?.trim()) return; await api('/api/draft/review', { jobId: job.id, decision, note: note.trim() }); }));
    if (cache.state.retentionTrash?.some(entry => entry.jobId === job.id && Date.parse(entry.purgeAt) > Date.now())) actions.append(button('원본·기획 복원 (14일)', async () => api('/api/retention/restore', { jobId: job.id })));
    if (['selected','draft'].includes(job.status)) { const sharedPlan = group.length > 1 && !job.plan; const calls = sharedPlan ? 2 : 1; actions.append(button(sharedPlan ? '초안 생성 (공통 기획+작성 2회)' : '초안 생성 (기획·작성 1회)', async () => { say(`생성 중입니다. 호스트 ${calls}회 응답을 기다려 주세요.`); const generated = await api('/api/generate', { jobId: job.id, provider: job.model }); if (generated.usage?.text) say(`초안 생성 완료 · ${generated.usage.text.replace(/\n/g, ' · ')}`, 60_000); })); }
    if (job.status === 'draft' && hasDraftStandard(job)) actions.append(button('별도 모델 평가 (호스트 1회)', async () => { say('평가 중입니다. 호스트 응답을 기다려 주세요.'); const evaluated = await api('/api/evaluate', { jobId: job.id, provider: job.model }); if (evaluated.usage?.text) say(`평가 완료 · ${evaluated.usage.text.replace(/\n/g, ' · ')}`, 60_000); }));
    if (job.status === 'draft') actions.append(button('초안 수정', async () => { const { lock } = await api('/api/draft/lock', { jobId: job.id }); try { const title = prompt('제목', job.draft.title); if (title === null) return; const tagsText = prompt('추천 태그 (쉼표로 구분, 최대 5개)', (job.draft.tags || []).join(', ')); if (tagsText === null) return; const tags = tagsText.split(',').map(tag => tag.trim()).filter(Boolean); const body = prompt('본문', job.draft.body); if (body === null) return; if (title && body) await api('/api/draft', { jobId: job.id, draft: { ...job.draft, title, tags, body }, lockToken: lock.token, expectedDraftRevision: lock.draftRevision }); } finally { await api('/api/draft/unlock', { jobId: job.id, token: lock.token }); } }));
    if (job.status === 'draft' && job.draft.images.length && job.imageProvider !== 'codex') actions.append(button('Codex 이미지 생성 사용', async () => api('/api/images/provider', { jobId: job.id, provider: 'codex' })));
    if (job.status === 'draft' && job.draft.images.length && !job.draft.imagePlanApproved) actions.append(button('이미지 제안 승인', async () => { const assets = (cache.registry.assets || []).filter(asset => asset.accountId === job.accountId); const choices = assets.map(asset => `${asset.id}: ${asset.kind} / ${asset.features}`).join('\n'); const assetId = prompt(`사용할 자산 ID를 입력하세요. 비우면 자산 없이 생성합니다.\n${choices}`, '') || null; await api('/api/images/approve-plan', { jobId: job.id, assetId }); }));
    if (job.status === 'draft' && job.draft.imagePlanApproved && job.imageProvider === 'codex' && job.draft.images.some(image => !image.generatedPath && !image.pendingPath)) actions.append(button('남은 이미지 후보 모두 생성', async () => { const remaining = job.draft.images.filter(image => !image.generatedPath && !image.pendingPath); if (!confirm(`${remaining.length}개 이미지 후보를 순서대로 생성합니까? 생성된 후보는 이 화면에서 확인한 뒤 연결합니다.`)) return; let completed = 0; for (const image of remaining) { say(`이미지 생성 중 ${completed + 1}/${remaining.length}: ${image.description.slice(0, 35)}`, 300_000); try { await api('/api/images/generate', { jobId: job.id, imageId: image.id }); completed++; await refresh(); } catch (error) { say(`${completed}개 생성 후 중단: ${error.message}`, 60_000); return; } } say(`${completed}개 이미지 후보를 생성했습니다. 미리 본 뒤 각각 확인·연결하세요.`, 60_000); }));
    if (job.status === 'draft' && job.draft.imagePlanApproved) for (const image of job.draft.images) {
      if (image.generationHistory?.length) { const tokens = image.generationHistory.reduce((sum, entry) => sum + [entry.usage, entry.checkUsage].filter(usage => usage?.known).reduce((callSum, usage) => callSum + (usage.totalTokens ?? usage.inputTokens + usage.outputTokens), 0), 0); actions.append(document.createTextNode(`이미지 생성 ${image.generationHistory.length}회 · 확인된 텍스트 토큰 ${tokens} · 이미지 자체 사용량 확인 불가 `)); }
      if (!image.generatedPath && job.imageProvider === 'codex' && !image.pendingPath) actions.append(button(`Codex 이미지 생성: ${image.description.slice(0,20)}`, async () => { say('이미지 생성 중입니다. 호스트 응답을 기다려 주세요.', 300_000); const result = await api('/api/images/generate', { jobId: job.id, imageId: image.id }); const tokenText = result.usage?.known ? `토큰 입력 ${result.usage.inputTokens} · 출력 ${result.usage.outputTokens}` : '토큰 확인 불가'; say(`이미지 후보가 준비됐습니다. ${result.attempts}회 생성 · 자동 점검 ${result.check ? result.check.passed ? '통과' : `실패: ${result.check.reason}` : '꺼짐'} · 직접 미리 보고 확인하세요. ${tokenText} · 이미지 사용량 확인 불가`, 60_000); }));
      if (!image.generatedPath && !image.pendingPath) actions.append(button(`직접 만든 이미지 연결: ${image.description.slice(0,20)}`, () => importManualImage(job, image)));
    }
    if (['awaiting_registration','due'].includes(job.status)) actions.append(button('플랫폼 예약 등록 재개', async () => { await api('/api/start', { jobId: job.id }); await preparedBrowser(job.id, await api('/api/prepare-browser', { jobId: job.id })); }));
    if (job.status === 'preparing' && !(account?.channel === 'naver' && job.draft.tags?.length)) actions.append(button('MCP 초안 입력', async () => { const available = cache.connectors.servers.filter(item => item.approvedFingerprint); const connectorId = prompt(`허용된 서버 ID를 선택하세요:\n${available.map(item => `${item.id}: ${item.name}`).join('\n')}`); const toolName = connectorId && prompt('초안 입력 도구 이름'); if (connectorId && toolName) { const result = await api('/api/prepare-mcp', { jobId: job.id, connectorId, toolName }); say(JSON.stringify(result.result).slice(0,300)); } }));
    if (job.status === 'preparing') actions.append(button('로그인 후 재개', async () => { const sessionId = sessionStorage.getItem(`editor:${job.id}`); if (!sessionId) return say('편집기 세션이 없어 다시 열어야 합니다.'); await preparedBrowser(job.id, await api('/api/prepare-browser/resume', { jobId: job.id, sessionId })); }));
    if (job.status === 'preparing') actions.append(button('편집기 다시 열기', async () => {
      sessionStorage.removeItem(`editor:${job.id}`);
      await preparedBrowser(job.id, await api('/api/prepare-browser', { jobId: job.id }));
    }));
    if (job.status === 'preparing') actions.append(button('수동 편집기 검수 기록', async () => { const editorUrl = prompt('실제 편집기 URL'), visibleAccount = prompt('화면에 보이는 계정명', job.accountHandle), title = prompt('실제 편집기 제목'), body = prompt('실제 편집기 본문'); const uploadedImages = job.draft.images.length ? prompt('화면에서 업로드와 위치를 확인한 이미지 ID를 쉼표로 구분해 입력', '')?.split(',').map(s => s.trim()) || [] : []; if (editorUrl && visibleAccount && title && body) await api('/api/review', { jobId: job.id, editor: { editorUrl, visibleAccount, title, body, uploadedImages } }); }));
    if (job.status === 'expired') actions.append(button('재검토 후 재예약', async () => { const at = prompt('새 예약 시각 (ISO 8601)'); if (at && confirm('사실·링크를 다시 확인하고 이 계정의 글을 재승인합니까?')) await api('/api/reschedule', { jobId: job.id, at, factsAndLinksReviewed: true }); }));
    if (job.status === 'review_required') actions.append(button('편집기 변경 재검토·승인', async () => { if (!confirm('편집기에서 달라진 제목·본문의 사실 주장과 링크를 다시 확인하고, 이 계정의 수정본을 승인합니까?')) return; await api('/api/review-changes', { jobId: job.id, factsAndLinksReviewed: true }); const sessionId = sessionStorage.getItem(`editor:${job.id}`); if (sessionId) await registerBrowser(job.id, sessionId); }));
    if (job.status === 'ready_to_register') actions.append(button('승인된 예약 등록 실행', async () => { const sessionId = sessionStorage.getItem(`editor:${job.id}`); if (!sessionId) return say('편집기 세션이 없습니다. 서버를 재시작했다면 예약 등록을 수동으로 확인해야 합니다.'); await registerBrowser(job.id, sessionId); }));
    if (job.status === 'ready_to_register' && !(account?.channel === 'naver' && job.draft.tags?.length) && cache.connectors.servers.some(item => item.approvedFingerprint)) actions.append(button('승인된 MCP 예약 도구로 등록', async () => { const available = cache.connectors.servers.filter(item => item.approvedFingerprint); const connectorId = prompt(`예약 도구가 있는 서버 ID:\n${available.map(item => `${item.id}: ${item.name}`).join('\n')}`); const toolName = connectorId && prompt('예약 등록 도구 이름 (schedule/reserve)'); if (!connectorId || !toolName) return; const output = await api('/api/registration/mcp', { jobId: job.id, connectorId, toolName }); say(output.result.verified ? 'MCP 예약 등록 확인' : `예약 결과 불명확: ${output.result.reason}`); }));
    if (job.status === 'published' && job.publication?.source === 'implicit') actions.append(button('발행 안 됨으로 되돌리기', async () => { if (!confirm('플랫폼에서 이 글이 실제로 발행되지 않았습니까? 공개 확인 필요 상태로 되돌립니다.')) return; await api('/api/publication/implicit/undo', { jobId: job.id }); }));
    if (job.status === 'verification_due' || job.status === 'published' && job.publication?.source === 'implicit') actions.append(button('공개 URL 확인·기록', async () => { const postUrl = prompt('플랫폼에서 공개된 글의 URL'); if (!postUrl) return; const finalTitle = prompt('공개된 제목', job.editor?.title || job.draft.title), finalBody = prompt('공개된 본문', job.editor?.body || job.draft.body); if (finalTitle && finalBody) await api('/api/publication', { jobId: job.id, publication: { postUrl, finalTitle, finalBody, source: 'user', finalTextSource: 'user', changedClaimsReviewed: finalBody === job.editor?.body || confirm('변경된 사실 주장을 검토했습니까?') } }); }));
    if (job.status === 'unknown' && ['naver', 'tistory'].includes(account?.channel)) actions.append(button(`${account.channel === 'naver' ? '네이버 예약 목록' : '티스토리 글 관리 목록'}에서 다시 확인`, async () => { const output = await api('/api/registration/recheck', { jobId: job.id }); say(output.result.verified ? '예약 목록에서 확인해 등록됨으로 기록했습니다.' : `등록으로 확인하지 못했습니다: ${output.result.reason}`); }));
    if (['submitting','unknown'].includes(job.status)) article.append(document.createTextNode(' 예약 등록 결과가 불명확합니다. 플랫폼의 예약 목록에서 중복 등록 여부를 먼저 확인하세요. 자동 재시도하지 않습니다.'));
    jobs.append(article);
  }
}
document.querySelector('#account').onsubmit = async event => { event.preventDefault(); try { await api('/api/account', Object.fromEntries(new FormData(event.target))); event.target.reset(); await refresh(); } catch (error) { say(error.message); } };
document.querySelector('#settings').onsubmit = async event => { event.preventDefault(); const form = event.target; try { await api('/api/settings', { retentionMonths: Number(form.elements.retentionMonths.value), backgroundNotifications: form.elements.backgroundNotifications.checked, autoImageCheck: form.elements.autoImageCheck.checked, maxImageGenerations: Number(form.elements.maxImageGenerations.value), codexImageModel: form.elements.codexImageModel.value }); await refresh(); say('운영 설정을 저장했습니다.'); } catch (error) { say(error.message); } };
document.querySelector('#sample').onsubmit = async event => { event.preventDefault(); const input = Object.fromEntries(new FormData(event.target)); try { const result = await api('/api/sample/analyze', input); document.querySelector('#analysis').textContent = JSON.stringify(result.analysis, null, 2); const registry = await api('/api/sample', { ...input, rules: result.analysis.rules }); say('제안 규칙을 확인한 뒤 아래에서 승인하세요.'); await refresh(); } catch (error) { say(error.message); } };
document.querySelector('#asset').onsubmit = async event => { event.preventDefault(); try { await api('/api/asset', Object.fromEntries(new FormData(event.target))); event.target.reset(); await refresh(); } catch (error) { say(error.message); } };
document.querySelector('#connector').onsubmit = async event => { event.preventDefault(); const input = Object.fromEntries(new FormData(event.target)); try { input.args = JSON.parse(input.args); await api('/api/connector', input); event.target.reset(); await refresh(); } catch (error) { say(error.message); } };
document.querySelector('#discover').onclick = async () => { try { const catalog = await api('/api/discover'); const list = document.querySelector('#record-list'); list.replaceChildren(); for (const source of catalog.sources) { const row = document.createElement('label'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'record-source'; checkbox.value = source.sourceId; row.append(checkbox, ` ${source.provider}: ${source.preview}`); list.append(row); } } catch (error) { say(error.message); } };
document.querySelector('#job').onsubmit = submitJob;
const projectField = document.createElement('label'); projectField.textContent = '프로젝트 표시명 (원본 경로에서 알 수 있으면 자동 적용)'; const projectInput = document.createElement('input'); projectInput.name = 'projectName'; projectInput.maxLength = 80; projectInput.placeholder = '예: PostGen'; projectField.append(projectInput); document.querySelector('#job').querySelector('[name="audience"]').closest('label').before(projectField);
// 채널 설정 dialog: one switch per channel with how many accounts are registered on it.
function renderChannelToggles() {
  const dialog = document.querySelector('#channel-settings');
  if (dialog.open) return;
  const list = document.querySelector('#channel-toggles'); list.replaceChildren();
  for (const channel of TOGGLE_CHANNELS) {
    const label = document.createElement('label'); label.className = 'channel-toggle';
    const text = document.createElement('span'); const name = document.createElement('strong'); name.textContent = channelLabels[channel];
    const count = (cache?.registry?.accounts || []).filter(account => account.channel === channel).length;
    const note = document.createElement('small'); note.textContent = count ? ` 계정 ${count}개` : ' 등록된 계정 없음';
    text.append(name, note);
    const box = document.createElement('input'); box.type = 'checkbox'; box.name = channel; box.checked = channelOn(channel); box.setAttribute('role', 'switch'); box.setAttribute('aria-label', `${channelLabels[channel]} 켜기`);
    label.append(text, box); list.append(label);
  }
}
document.querySelector('#channel-settings-open').onclick = () => { renderChannelToggles(); document.querySelector('#channel-settings').showModal(); };
document.querySelector('#channel-settings-cancel').onclick = () => document.querySelector('#channel-settings').close('cancel');
document.querySelector('#channel-settings-form').onsubmit = async event => {
  event.preventDefault();
  const channels = Object.fromEntries([...document.querySelectorAll('#channel-toggles input')].map(input => [input.name, input.checked]));
  try {
    await api('/api/settings', { channels });
    document.querySelector('#channel-settings').close('save');
    await refresh();
    const off = TOGGLE_CHANNELS.filter(channel => !channels[channel]).map(channel => channelLabels[channel]);
    say(off.length ? `채널 설정을 저장했습니다. 꺼진 채널: ${off.join(', ')}` : '채널 설정을 저장했습니다. 모든 채널이 켜져 있습니다.');
  } catch (error) { say(error.message, 60_000); }
};
// Floating activity button: long work runs in the server, so the list comes from /api/activity, not this page.
const activityStatusLabels = { running: '진행 중', done: '완료', failed: '실패' };
let activityOpen = false, activityTimer = null, lastRunningIds = new Set();
function elapsedText(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}초` : `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
}
const IMAGE_ROUTES = ['/api/images/generate', '/api/images/regenerate', '/api/images/generate-batch'];
// Image work: finished images out of the total, plus the current image estimated from the average image time
// (capped below 100% until the server reports it done).
function activityPercent(entry) {
  if (!IMAGE_ROUTES.includes(entry.route)) return null;
  if (entry.status !== 'running') return entry.status === 'done' ? 100 : null;
  const done = entry.progress?.done ?? 0, total = entry.progress?.total ?? 1;
  const current = Math.min(0.95, (entry.progress ? entry.progress.itemElapsedMs : entry.elapsedMs) / Math.max(1, averageImageMs));
  return Math.min(99, Math.floor(((done + (done < total ? current : 0)) / total) * 100));
}
function activityItem(entry) {
  const item = document.createElement('li');
  item.className = `activity-item ${entry.status}`;
  const head = document.createElement('div');
  const label = document.createElement('strong');
  label.textContent = entry.label;
  const status = document.createElement('span');
  status.className = 'activity-status';
  status.textContent = entry.status === 'running' ? `${activityStatusLabels.running} · ${elapsedText(entry.elapsedMs)}` : `${activityStatusLabels[entry.status]} · ${elapsedText(entry.elapsedMs)} 걸림`;
  head.append(label, status);
  item.append(head);
  const percent = activityPercent(entry);
  if (percent !== null) {
    const bar = document.createElement('div'); bar.className = 'activity-bar'; bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100'); bar.setAttribute('aria-valuenow', String(percent));
    const fill = document.createElement('span'); fill.style.width = `${percent}%`; bar.append(fill);
    const caption = document.createElement('small'); caption.className = 'activity-bar-caption';
    caption.textContent = entry.progress ? `이미지 ${entry.progress.done}/${entry.progress.total}장 · ${percent}%${entry.status === 'running' ? ` · 한 장 평균 ${elapsedText(averageImageMs)}` : ''}` : `${percent}% · 한 장 평균 ${elapsedText(averageImageMs)} 기준`;
    item.append(bar, caption);
  }
  for (const text of [entry.title, entry.detail, entry.error && `사유: ${entry.error}`]) {
    if (!text) continue;
    const line = document.createElement('small');
    line.textContent = text;
    item.append(line);
  }
  return item;
}
async function refreshActivity() {
  clearTimeout(activityTimer);
  let activities = [];
  try { const result = await api('/api/activity'); activities = result.activities; if (Number.isFinite(result.averageImageMs)) averageImageMs = result.averageImageMs; } catch { /* the next poll retries */ }
  const running = activities.filter(entry => entry.status === 'running');
  const count = document.querySelector('#activity-count');
  count.hidden = running.length === 0;
  count.textContent = String(running.length);
  document.querySelector('#activity-fab').classList.toggle('busy', running.length > 0);
  const list = document.querySelector('#activity-list');
  list.replaceChildren(...activities.map(activityItem));
  if (!activities.length) { const empty = document.createElement('li'); empty.className = 'activity-empty'; empty.textContent = '진행 중이거나 최근 10분 안에 끝난 작업이 없습니다.'; list.append(empty); }
  // When something finishes, reload the screen data so its result shows without a manual refresh.
  const runningIds = new Set(running.map(entry => entry.id));
  if ([...lastRunningIds].some(id => !runningIds.has(id))) refresh().catch(error => say(error.message));
  lastRunningIds = runningIds;
  activityTimer = setTimeout(refreshActivity, running.length || activityOpen ? 2000 : 10_000);
}
document.querySelector('#activity-fab').onclick = () => {
  activityOpen = !activityOpen;
  document.querySelector('#activity-panel').hidden = !activityOpen;
  document.querySelector('#activity-fab').setAttribute('aria-expanded', String(activityOpen));
  refreshActivity();
};
refresh().then(checkPostingLogins).catch(error => say(error.message));
refreshActivity();
document.querySelector('#login-recheck').onclick = () => checkPostingLogins();
// After logging in from a badge the user comes back to this tab; re-check then, at most every 15 seconds.
window.addEventListener('focus', () => { if (Date.now() - loginCheckedAt > 15_000) checkPostingLogins(); });
setInterval(() => refresh().catch(error => say(error.message)), 60_000);
