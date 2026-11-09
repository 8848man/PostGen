import fs from 'node:fs';
import { loadRegistry, saveRegistry, addAccount, addSample, approveSample, setDefaultSample, resolveAccount } from './account-registry.mjs';

const [command, ...args] = process.argv.slice(2);
const usage = 'Usage: node account-cli.mjs list | resolve <channel> <handle> | add-account <channel> <handle> <default-goal> | add-sample <account-id> <text|file|url|screenshot> <source-ref> <owned|licensed|public_style> | approve-sample <sample-id> <rules-json-file> | set-default <account-id> <sample-id>';

try {
  const current = loadRegistry();
  if (command === 'list' && args.length === 0) { process.stdout.write(JSON.stringify(current, null, 2) + '\n'); process.exit(0); }
  if (command === 'resolve' && args.length === 2) { process.stdout.write(JSON.stringify(resolveAccount(current, args[0], args[1]), null, 2) + '\n'); process.exit(0); }
  let next;
  if (command === 'add-account' && args.length === 3) next = addAccount(current, { channel: args[0], handle: args[1], defaultGoal: args[2] });
  else if (command === 'add-sample' && args.length === 4) next = addSample(current, { accountId: args[0], sourceType: args[1], sourceRef: args[2], rights: args[3] });
  else if (command === 'approve-sample' && args.length === 2) next = approveSample(current, args[0], JSON.parse(fs.readFileSync(args[1], 'utf8')));
  else if (command === 'set-default' && args.length === 2) next = setDefaultSample(current, args[0], args[1]);
  else throw new Error(usage);
  saveRegistry(next, current.revision);
  process.stdout.write(JSON.stringify(next, null, 2) + '\n');
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
