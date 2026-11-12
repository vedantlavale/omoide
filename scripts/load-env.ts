/**
 * Minimal .env loader for the CLI scripts (eval, search smoke).
 *
 * The Next.js app loads .env itself, but `npm run eval` runs under tsx and
 * would otherwise silently miss OPENROUTER_API_KEY etc. Existing process env
 * always wins, so `EVAL_LIVE=1 npm run eval` still works as documented.
 * Node 20's built-in --env-file is not used because it errors when the file
 * is absent, and a missing .env must not be an error.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

let loaded = false;

export function loadDotEnv(file = '.env'): void {
  if (loaded) return;
  loaded = true;
  let text: string;
  try {
    text = readFileSync(path.resolve(process.cwd(), file), 'utf8');
  } catch {
    return; // no .env is fine; configurationProblems() reports what is missing
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    // Value may carry a trailing comment: "KEY=value  # note".
    let value = line.slice(eq + 1).split('#')[0].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!key) continue;
    if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
  }
}
