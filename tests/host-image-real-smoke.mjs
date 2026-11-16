// Opt-in smoke: set POSTGEN_IMAGE_TEST_REFERENCE to an Assets Manager original, then run this script.
// Uses the Codex subscription image tool and stores the verified copy under output/codex-cli-image-test.
import fs from 'node:fs';
import path from 'node:path';
import { generateHostImage } from '../next/host-image.mjs';
import { importGeneratedImage } from '../next/images.mjs';

const root = path.resolve('output/codex-cli-image-test');
process.env.POSTGEN_NEXT_DIR = path.join(root, 'managed');
const reference = process.env.POSTGEN_IMAGE_TEST_REFERENCE;
if (!reference || !fs.existsSync(reference)) throw new Error('Set POSTGEN_IMAGE_TEST_REFERENCE to an existing image original');
const result = await generateHostImage({
  scene: 'A white doodle character points at a single green block on a table.',
  request: { text: 'Create one new image with a white doodle character pointing at a single green block on a table. Use the attached reference for the visual style.' },
  referencePaths: [reference]
});
const stored = await importGeneratedImage(result.path);
if (!fs.existsSync(stored)) throw new Error('Managed image was not saved');
process.stdout.write(JSON.stringify({ stored, bytes: fs.statSync(stored).size, textTokensKnown: result.usage.known, imageUsageKnown: result.imageUsage.known }) + '\n');
