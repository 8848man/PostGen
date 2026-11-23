const projectLabels = { postgen: 'PostGen', 'assets-manager': 'Assets Manager', 'obsidian-setup': 'AI 사서', ucompany: 'uCompany', u_company: 'uCompany' };

export function projectNameForSources(sources = []) {
  const names = new Set(sources.map(source => {
    const match = String(source.ref || '').replaceAll('\\', '/').match(/(?:^|\/)posts\/([^/]+)\//i);
    return match && projectLabels[match[1].toLowerCase()] || null;
  }).filter(Boolean));
  return names.size === 1 ? [...names][0] : null;
}

export function projectTitle(title, projectName) {
  const clean = String(title || '').trim();
  const name = String(projectName || '').trim();
  if (!name) return clean;
  const unprefixed = clean.replace(/^\[[^\]]+\]\s*/, '').replace(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`, 'i'), '').trim();
  return `[${name}] ${unprefixed}`;
}

export function cleanTags(tags) {
  if (!Array.isArray(tags) || tags.length > 5) throw new Error('Recommend up to five tags');
  if (tags.some(tag => typeof tag !== 'string')) throw new Error('Tags must be text');
  const result = tags.map(tag => tag.trim().replace(/^#+/, '')).filter(Boolean);
  if (result.some(tag => tag.length > 30 || /[\r\n]/.test(tag)) || new Set(result.map(tag => tag.toLocaleLowerCase('ko-KR'))).size !== result.length) throw new Error('Tags must be unique short phrases');
  return result;
}

export function naverTagLine(tags) {
  if (tags.some(tag => !/^[\p{L}\p{N}_]+$/u.test(tag))) throw new Error('Naver body tags must be single words without spaces or punctuation');
  return tags.map(tag => `#${tag}`).join(' ');
}

export function withNaverTagLine(body, tags, previousTags = []) {
  const line = naverTagLine(tags);
  const oldLine = naverTagLine(previousTags);
  const normalized = body.replace(/\r\n/g, '\n');
  const [first, ...rest] = normalized.split('\n');
  const hadLine = Boolean(first && (first === line || first === oldLine));
  const content = hadLine ? rest.join('\n') : normalized;
  if (!content.trim()) throw new Error('Naver draft body needs content after the tag line');
  return { body: line ? `${line}\n${content}` : content, paragraphShift: Number(Boolean(line)) - Number(hadLine) };
}
