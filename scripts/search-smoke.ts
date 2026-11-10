/**
 * Provider smoke test. Run this first when a search key is new:
 *
 *   npm run search:smoke -- "neon launch plan price"
 *
 * It exercises the real webSearch pipeline (fan-out → rank → fetch → passages)
 * and prints exactly what the model would see, so a broken adapter is obvious
 * before you blame the prompt.
 */

import path from 'node:path';
import { SourceRegistry, webSearch } from '../src/server/search';
import { getTimeContext } from '../src/server/time/clock';
import { activeSearchProviders, getConfig, resetConfigCache } from '../src/server/config';
import { closeDb } from '../src/server/db/client';

async function main() {
  const query = process.argv.slice(2).join(' ').trim() || 'neon launch plan price';
  // Never touch the dev server's data directory: PGlite is single-process.
  process.env.PGLITE_DIR ||= path.join(process.cwd(), '.data', 'smoke');
  resetConfigCache();
  const config = getConfig();

  console.log(`Query: ${query}`);
  console.log(`Providers: ${config.mock ? 'mock (offline fixtures)' : activeSearchProviders(config).join(', ') || 'none configured'}`);

  const started = Date.now();
  const result = await webSearch(
    { queries: [query], freshness: 'any' },
    { registry: new SourceRegistry(), time: getTimeContext() },
  );

  console.log(`\n${result.sources.length} sources in ${Date.now() - started} ms`);
  console.log(`providers used: ${result.meta.providers.join(', ') || '—'}`);
  if (result.meta.errors.length) console.log(`errors:\n  ${result.meta.errors.join('\n  ')}`);

  for (const source of result.sources) {
    console.log(`\n[${source.id}] ${source.title}`);
    console.log(`     ${source.url}  (${source.site}${source.publishedAt ? `, ${source.publishedAt}` : ''})`);
    console.log(`     ${source.snippetOnly ? 'snippet only' : 'full page'} · hash ${source.contentHash ?? '—'}`);
    for (const passage of source.passages) {
      console.log(`     > ${passage.replace(/\s+/g, ' ').slice(0, 220)}`);
    }
  }
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
