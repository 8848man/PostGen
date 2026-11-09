import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from '../skill/postgen/scripts/profile.mjs';

const imageRoot = () => path.join(process.env.POSTGEN_NEXT_DIR || path.join(dataDir(), 'next'), 'images');
const allowed = new Map([['.png','image/png'],['.jpg','image/jpeg'],['.jpeg','image/jpeg'],['.webp','image/webp']]);

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

export async function generateImage({ description, asset, model = 'gpt-image-2.5-sunburst' }) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for image fallback');
  if (typeof description !== 'string' || !description.trim()) throw new Error('Image description required');
  let endpoint = 'https://api.openai.com/v1/images/generations';
  let payload = { model, prompt: `Create an original image for a Korean blog post. ${description}. Do not reproduce an unlicensed character or a third-party composition.`, n: 1, output_format: 'png' };
  if (asset) {
    const bytes = await fs.readFile(asset.storedPath);
    const mime = allowed.get(path.extname(asset.storedPath).toLowerCase());
    if (!mime) throw new Error('Unsupported reference asset');
    endpoint = 'https://api.openai.com/v1/images/edits';
    payload = { ...payload, images: [{ image_url: `data:${mime};base64,${bytes.toString('base64')}` }], prompt: `Create a new scene for a Korean blog post: ${description}. Preserve the identity, colors, shape, and distinctive features of the user-authorized reference ${asset.kind}: ${asset.features}. Change the pose and surroundings as needed.` };
  }
  const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(180_000) });
  const data = await response.json();
  if (!response.ok) throw new Error(`Image API failed (${response.status}): ${JSON.stringify(data.error || {}).slice(0,200)}`);
  const encoded = data.data?.[0]?.b64_json;
  if (!encoded) throw new Error('Image API returned no image');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > 15_000_000) throw new Error('Generated image size invalid');
  const dest = path.join(imageRoot(), `${crypto.randomUUID()}.png`);
  await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
  await fs.writeFile(dest, bytes, { flag: 'wx', mode: 0o600 });
  return { path: dest, usage: data.usage || null };
}

export async function checkImage({ imagePath, description, asset }) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for automatic image checks');
  const bytes = await fs.readFile(imagePath);
  const content = [{ type: 'input_text', text: `Assess this generated blog image against the intended scene: ${description}. Check subject identity, obvious artifacts, legibility, and whether the composition is usable. If a second image is provided, it is the account-owned style reference; assess consistency without demanding an exact copy. Return passed=false for substantial defects. Give one concise Korean reason.` }, { type: 'input_image', image_url: `data:image/png;base64,${bytes.toString('base64')}` }];
  if (asset) {
    const mime = allowed.get(path.extname(asset.storedPath).toLowerCase());
    if (!mime) throw new Error('Unsupported reference asset');
    content.push({ type: 'input_image', image_url: `data:${mime};base64,${(await fs.readFile(asset.storedPath)).toString('base64')}` });
  }
  const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: process.env.POSTGEN_IMAGE_CHECK_MODEL || 'gpt-5.4-mini', input: [{ role: 'user', content }], text: { format: { type: 'json_schema', name: 'postgen_image_check', strict: true, schema: { type: 'object', additionalProperties: false, required: ['passed','reason'], properties: { passed: { type: 'boolean' }, reason: { type: 'string' } } } } } }), signal: AbortSignal.timeout(180_000) });
  const data = await response.json();
  if (!response.ok) throw new Error(`Image check failed (${response.status}): ${JSON.stringify(data.error || {}).slice(0,200)}`);
  const raw = data.output?.flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('');
  const result = JSON.parse(raw);
  if (typeof result.passed !== 'boolean' || typeof result.reason !== 'string') throw new Error('Invalid image check result');
  return { passed: result.passed, reason: result.reason.slice(0, 500), usage: data.usage || null };
}
