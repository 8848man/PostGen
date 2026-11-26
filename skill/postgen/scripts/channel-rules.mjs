// Social channels (X, LinkedIn, Instagram, Reddit): PostGen fills the platform's composer in the posting Chrome and
// checks it; the user presses the platform's own post button. Their platform terms restrict automated posting, so
// PostGen never presses it. These rules describe what one post may hold on each channel.

export const SOCIAL_CHANNELS = ['x', 'linkedin', 'instagram', 'reddit'];
export const isSocialChannel = channel => SOCIAL_CHANNELS.includes(channel);

export const CHANNEL_LABELS = { naver: '네이버 블로그', tistory: '티스토리', x: 'X', linkedin: '링크드인', instagram: '인스타그램', reddit: '레딧', threads: 'Threads' };

// Composer hosts PostGen may open for each channel.
export const SOCIAL_HOSTS = {
  x: ['x.com', 'twitter.com'],
  linkedin: ['www.linkedin.com'],
  instagram: ['www.instagram.com'],
  reddit: ['www.reddit.com']
};

export const SOCIAL_LIMITS = {
  x: { text: 280, weighted: true, maxImages: 4, minImages: 0, hashtags: true },
  linkedin: { text: 3000, maxImages: 20, minImages: 0, hashtags: true },
  instagram: { text: 2200, maxImages: 10, minImages: 1, hashtags: true, maxHashtags: 30 },
  reddit: { title: 300, text: 40000, maxImages: 0, minImages: 0, hashtags: false }
};

// X counts most CJK characters and emoji as 2 and every link as 23 (twitter-text weighting).
export function xWeightedLength(text) {
  const withoutUrls = String(text).replace(/https?:\/\/\S+/g, '');
  const urls = (String(text).match(/https?:\/\/\S+/g) || []).length;
  let length = urls * 23;
  for (const char of withoutUrls) {
    const code = char.codePointAt(0);
    const light = code <= 4351 || (code >= 8192 && code <= 8205) || (code >= 8208 && code <= 8223) || (code >= 8242 && code <= 8247);
    length += light ? 1 : 2;
  }
  return length;
}

export const hashtagFor = tag => `#${String(tag).trim().replace(/^#+/, '').replace(/\s+/g, '')}`;

// The exact text PostGen types into the composer: the body, then the approved tags as hashtags (Reddit has none).
export function socialPostText(channel, body, tags = []) {
  const text = String(body || '').replace(/\r\n/g, '\n').trim();
  if (!SOCIAL_LIMITS[channel]?.hashtags || !tags.length) return text;
  return `${text}\n\n${tags.map(hashtagFor).join(' ')}`;
}

export function socialTextLength(channel, text) {
  return SOCIAL_LIMITS[channel]?.weighted ? xWeightedLength(text) : [...String(text)].length;
}

// What keeps a draft from being one post on this channel; empty when it fits.
export function socialDraftProblems(channel, draft) {
  const limits = SOCIAL_LIMITS[channel];
  if (!limits || !draft) return [];
  const problems = [];
  const text = socialPostText(channel, draft.body, draft.tags || []);
  const length = socialTextLength(channel, text);
  if (length > limits.text) problems.push(`${CHANNEL_LABELS[channel]} post is ${length} characters${limits.weighted ? ' (X counts Korean as 2)' : ''}; the limit is ${limits.text}`);
  if (limits.title && [...String(draft.title || '')].length > limits.title) problems.push(`${CHANNEL_LABELS[channel]} title is longer than ${limits.title} characters`);
  const images = (draft.images || []).length;
  if (images > limits.maxImages) problems.push(limits.maxImages === 0 ? `${CHANNEL_LABELS[channel]} posts are text only; remove the image suggestions` : `${CHANNEL_LABELS[channel]} takes at most ${limits.maxImages} images (draft has ${images})`);
  if (images < limits.minImages) problems.push(`${CHANNEL_LABELS[channel]} posts need at least ${limits.minImages} image`);
  if (limits.maxHashtags && (draft.tags || []).length > limits.maxHashtags) problems.push(`${CHANNEL_LABELS[channel]} takes at most ${limits.maxHashtags} hashtags`);
  return problems;
}

// Instructions for the draft writer, per channel.
export const SOCIAL_BODY_RULES = {
  x: ' This is one X post: "body" is the whole post text with no headings or lists, at most 280 characters where Korean characters count as 2 (so about 120 Korean characters including spaces, leaving room for hashtags), with "headings" empty. Use 0 to 1 image. The "title" is an internal label and is not posted. "tags" become hashtags appended after the body; recommend at most 2.',
  linkedin: ' This is one LinkedIn post: "body" is plain text of short paragraphs separated by blank lines, at most 2,500 characters, no markdown, with "headings" empty. Use 0 to 1 image. The "title" is an internal label and is not posted. "tags" become hashtags appended after the body; recommend 3 to 5.',
  instagram: ' This is one Instagram post: "body" is the caption, plain text of short paragraphs, at most 2,000 characters including the hashtags appended later, with "headings" empty. Use 1 to 3 images; the first image is the cover. The "title" is an internal label and is not posted. "tags" become hashtags appended after the caption; recommend up to 5.',
  reddit: ' This is one Reddit text post: "title" is the post title (at most 300 characters, plain and specific, no clickbait) and "body" is the post text in short paragraphs, with "headings" empty. Reddit posts here are text only: "images" must be an empty list. Do not write hashtags; "tags" are kept only as internal labels.'
};
