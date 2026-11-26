import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from '../skill/postgen/scripts/profile.mjs';

// Codex image generation and image checks pass this model with -m; '' leaves the Codex CLI default.
export const recommendedCodexImageModel = 'gpt-6-sol';
export const validCodexModel = value => value === '' || (typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value));
const file = () => path.join(process.env.POSTGEN_NEXT_DIR || path.join(dataDir(), 'next'), 'settings.json');
// Channels the user works with. An off channel gets no drafts for new sources, is left out of counts, bulk actions
// and login checks, and its existing posts are shown greyed out. Channels not listed here count as on.
export const TOGGLE_CHANNELS = ['naver', 'tistory', 'x', 'linkedin', 'instagram', 'reddit'];
const defaultChannels = () => Object.fromEntries(TOGGLE_CHANNELS.map(channel => [channel, true]));
export const channelEnabled = (settings, channel) => settings?.channels?.[channel] !== false;
export const defaultSettings = () => ({ schemaVersion: 'next-settings/v1', revision: 0, retentionMonths: 3, backgroundNotifications: false, autoImageCheck: false, maxImageGenerations: 3, codexImageModel: recommendedCodexImageModel, channels: defaultChannels() });
export function validateSettings(value) {
  if (value?.schemaVersion !== 'next-settings/v1' || !Number.isInteger(value.revision) || !Number.isInteger(value.retentionMonths) || value.retentionMonths < 1 || value.retentionMonths > 3 || typeof value.backgroundNotifications !== 'boolean' || typeof value.autoImageCheck !== 'boolean' || !Number.isInteger(value.maxImageGenerations) || value.maxImageGenerations < 1 || value.maxImageGenerations > 3 || !validCodexModel(value.codexImageModel) || !value.channels || typeof value.channels !== 'object' || Object.entries(value.channels).some(([channel, on]) => !TOGGLE_CHANNELS.includes(channel) || typeof on !== 'boolean')) throw new Error('Invalid next settings');
  return value;
}
// Settings saved before a field existed take that field's default.
export function loadSettings() {
  if (!fs.existsSync(file())) return defaultSettings();
  const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
  return validateSettings({ ...defaultSettings(), ...saved, channels: { ...defaultChannels(), ...(saved.channels || {}) } });
}
export function updateSettings(input) {
  const current = loadSettings();
  const next = validateSettings({ ...current, ...input, channels: { ...current.channels, ...(input.channels || {}) }, schemaVersion: 'next-settings/v1', revision: current.revision + 1 });
  const dir = path.dirname(file()); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.settings-${crypto.randomUUID()}.tmp`);
  try { fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file()); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return next;
}
