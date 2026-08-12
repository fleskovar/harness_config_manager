import { validateBundle } from '../core/bundle.js';
import { resolveDependencyGraph } from '../core/deps.js';
import { color, log } from '../core/logger.js';
import { resolveBundles } from '../core/registry.js';
import type { LoadedBundle } from '../core/types.js';

export async function validateCommand(reference: string, options: { cwd: string }): Promise<boolean> {
  const bundles = await resolveBundles(reference, options.cwd);
  let ok = true;

  for (const bundle of bundles) {
    const problems = [...validateBundle(bundle), ...(await dependencyProblems(bundle, options.cwd))];

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

/**
 * Can everything this bundle requires actually be found from here? Authors hit
 * this the moment they publish: the dependency resolves on their machine
 * because it is registered there, and nowhere else.
 */
async function dependencyProblems(bundle: LoadedBundle, cwd: string): Promise<string[]> {
  if (bundle.dependencies.length === 0) return [];
  try {
    await resolveDependencyGraph([bundle], cwd);
    return [];
  } catch (error) {
    return [(error as Error).message];
  }
}
