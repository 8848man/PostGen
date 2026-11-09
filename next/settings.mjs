import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from '../skill/postgen/scripts/profile.mjs';

const file = () => path.join(process.env.POSTGEN_NEXT_DIR || path.join(dataDir(), 'next'), 'settings.json');
export const defaultSettings = () => ({ schemaVersion: 'next-settings/v1', revision: 0, retentionMonths: 3, backgroundNotifications: false, autoImageCheck: false, maxImageGenerations: 3 });
export function validateSettings(value) {
  if (value?.schemaVersion !== 'next-settings/v1' || !Number.isInteger(value.revision) || !Number.isInteger(value.retentionMonths) || value.retentionMonths < 1 || value.retentionMonths > 3 || typeof value.backgroundNotifications !== 'boolean' || typeof value.autoImageCheck !== 'boolean' || !Number.isInteger(value.maxImageGenerations) || value.maxImageGenerations < 1 || value.maxImageGenerations > 3) throw new Error('Invalid next settings');
  return value;
}
export function loadSettings() { return fs.existsSync(file()) ? validateSettings(JSON.parse(fs.readFileSync(file(), 'utf8'))) : defaultSettings(); }
export function updateSettings(input) {
  const current = loadSettings();
  const next = validateSettings({ ...current, ...input, schemaVersion: 'next-settings/v1', revision: current.revision + 1 });
  const dir = path.dirname(file()); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.settings-${crypto.randomUUID()}.tmp`);
  try { fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file()); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return next;
}
