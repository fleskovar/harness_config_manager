import { validateBundle } from '../core/bundle.js';
import { color, log } from '../core/logger.js';
import { resolveBundles } from '../core/registry.js';

export async function validateCommand(reference: string, options: { cwd: string }): Promise<boolean> {
  const bundles = await resolveBundles(reference, options.cwd);
  let ok = true;

  for (const bundle of bundles) {
    const problems = validateBundle(bundle);

    log.plain(`${color.bold(bundle.manifest.name)} ${color.dim(`v${bundle.manifest.version}`)}`);
    log.plain(color.dim(`  ${bundle.resources.length} resource(s)`));

    if (problems.length === 0) {
      log.success('  No problems found.');
      continue;
    }

    ok = false;
    for (const problem of problems) log.warn(`  ${problem}`);
  }

  return ok;
}
