import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from '../skill/postgen/scripts/profile.mjs';

const imageRoot = () => path.join(process.env.POSTGEN_NEXT_DIR || path.join(dataDir(), 'next'), 'images');
const allowed = new Map([['.png','image/png'],['.jpg','image/jpeg'],['.jpeg','image/jpeg'],['.webp','image/webp']]);

export async function importGeneratedImage(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Generated image requires an absolute file path');
  const canonical = await fs.realpath(file);
  const ext = path.extname(canonical).toLowerCase();
  if (!allowed.has(ext)) throw new Error('Generated image must be PNG, JPEG, or WebP');
  const bytes = await fs.readFile(canonical);
  if (!bytes.length || bytes.length > 15_000_000) throw new Error('Generated image must be under 15 MB');
  const png = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const jpeg = bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
  const webp = bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  if (!(ext === '.png' && png || ['.jpg', '.jpeg'].includes(ext) && jpeg || ext === '.webp' && webp)) throw new Error('Generated image content does not match its extension');
  const dest = path.join(imageRoot(), `${crypto.randomUUID()}${ext}`);
  await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
  await fs.writeFile(dest, bytes, { flag: 'wx', mode: 0o600 });
  return dest;
}
export async function importAsset(file) {
  const canonical = await fs.realpath(path.resolve(file));
  const mime = allowed.get(path.extname(canonical).toLowerCase());
  if (!mime) throw new Error('Asset must be PNG, JPEG, or WebP');
  const bytes = await fs.readFile(canonical);
  if (!bytes.length || bytes.length > 5_000_000) throw new Error('Asset must be under 5 MB');
  const dest = path.join(imageRoot(), `${crypto.randomUUID()}${path.extname(canonical).toLowerCase()}`);
  await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
  await fs.writeFile(dest, bytes, { flag: 'wx', mode: 0o600 });
  return dest;
}
