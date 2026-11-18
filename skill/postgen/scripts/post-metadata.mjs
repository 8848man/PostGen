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
