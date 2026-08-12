#!/usr/bin/env node
import { Command, Option } from 'commander';
import {
  configGetCommand,
  configListCommand,
  configSetCommand,
  configUnsetCommand,
} from './commands/config.js';
import {
  contextAppendCommand,
  contextListCommand,
  contextOverrideCommand,
  contextRemoveCommand,
  type ContextOptions,
} from './commands/context.js';
import { exportCommand } from './commands/export.js';
import { importCommand } from './commands/import.js';
import { infoCommand } from './commands/info.js';
import { initCommand } from './commands/init.js';
import { installCommand } from './commands/install.js';
import { listCommand } from './commands/list.js';
import {
  registryAddCommand,
  registryListCommand,
  registryOpenCommand,
  registryRemoveCommand,
} from './commands/registry.js';
import { statusCommand } from './commands/status.js';
import { targetsCommand } from './commands/targets.js';
import { uninstallCommand } from './commands/uninstall.js';
import { updateCommand } from './commands/update.js';
import { validateCommand } from './commands/validate.js';
import type { ConflictPolicy } from './core/conflicts.js';
import { ConflictError, HcmError } from './core/errors.js';
import { color, configureLogger, log } from './core/logger.js';
import { closePrompt } from './core/prompt.js';
import type { Scope, TargetOptions } from './core/types.js';
import { TARGET_IDS } from './targets/index.js';

const program = new Command();
const cwd = process.cwd();

program
  .name('hcm')
  .description(
    'Define agents, skills, commands, rules and MCP servers once; install them into ' +
      'Claude Code, GitHub Copilot, Reasonix, OpenCode and Pi with exact, item-level rollback.',
  )
  .version('0.1.0')
  .option('-q, --quiet', 'suppress non-essential output')
  .option('-v, --verbose', 'show skipped resources and other details')
  .hook('preAction', (thisCommand) => {
    const options = thisCommand.opts<{ quiet?: boolean; verbose?: boolean }>();
    configureLogger({ quiet: options.quiet ?? false, verbose: options.verbose ?? false });
  });

const scopeOption = () =>
  new Option('-s, --scope <scope>', 'install scope').choices(['project', 'user']).default('project');

const targetOption = () =>
  new Option('-t, --target <target...>', 'target harness(es)').choices(TARGET_IDS);

/**
 * Without this, a conflict asks -- when there is a terminal to ask at, and
 * otherwise errors out, which is what scripts and CI want by default.
 */
const conflictOption = () =>
  new Option(
    '--on-conflict <policy>',
    'what to do when an item is already there: ask, keep the existing one, replace it, or stop',
  ).choices(['prompt', 'skip', 'overwrite', 'abort']);

/**
 * Extensions the machine has, which change where a target files things. Stated
 * once per install and remembered with it, so `hcm update` does not need it
 * again -- see `TargetOptions`.
 */
const piSubagentsOption = () =>
  new Option(
    '--pi-subagents',
    'Pi has the pi-subagents extension: file subagents in .pi/agents/ rather than as skills',
  );

const targetOptionsFrom = (options: { piSubagents?: boolean }): TargetOptions =>
  options.piSubagents ? { piSubagents: true } : {};

program
  .command('install')
  .argument('<bundle>', 'registered name, local path, GitHub URL, or owner/repo[/subdir][#ref]')
  .description('install a bundle into one or more harnesses')
  .addOption(targetOption())
  .addOption(scopeOption())
  .addOption(conflictOption())
  .option('--dry-run', 'show what would change without writing')
  .option('--force', 'overwrite conflicting items (same as --on-conflict overwrite)')
  .option('--refresh', 're-download a GitHub bundle instead of using the cache')
  .option('--no-deps', 'install only this bundle, not the ones it requires')
  .addOption(piSubagentsOption())
  .action(async (bundle, options) => {
    await installCommand(bundle, {
      targets: options.target,
      scope: options.scope as Scope,
      dryRun: options.dryRun,
      force: options.force,
      onConflict: options.onConflict as ConflictPolicy | undefined,
      refresh: options.refresh,
      // commander gives --no-deps as deps: false
      noDeps: options.deps === false,
      targetOptions: targetOptionsFrom(options),
      cwd,
    });
  });

program
  .command('uninstall')
  .alias('remove')
  .argument('<bundle>', 'installed bundle name')
  .description('remove exactly the items a bundle installed')
  .addOption(targetOption())
  .addOption(scopeOption())
  .option('--dry-run', 'show what would be removed without writing')
  .option('--force', 'remove items even if they were edited since install')
  .option('--cascade', 'also remove the bundles that depend on this one')
  .option('--ignore-dependents', 'remove it even though other bundles still require it')
  .option('--keep-orphans', 'keep bundles that were installed only as dependencies')
  .action(async (bundle, options) => {
    await uninstallCommand(bundle, {
      targets: options.target,
      scope: options.scope as Scope,
      dryRun: options.dryRun,
      force: options.force,
      cascade: options.cascade,
      ignoreDependents: options.ignoreDependents,
      keepOrphans: options.keepOrphans,
      cwd,
    });
  });

program
  .command('update')
  .argument('<bundle>', 'registered name or id, or "all"')
  .description('re-read a registered bundle and reinstall it wherever it is installed')
  .addOption(targetOption())
  .addOption(
    new Option('-s, --scope <scope>', 'scopes to update').choices(['project', 'user', 'all']),
  )
  .addOption(conflictOption())
  .option('--dry-run', 'show what would change without writing')
  .option('--force', 'replace items that were edited since install')
  // Omitted, each installation keeps what it recorded; passing it switches
  // every installation this run touches over.
  .addOption(piSubagentsOption())
  .action(async (bundle, options) => {
    await updateCommand(bundle, {
      targets: options.target,
      scope: options.scope as Scope | 'all' | undefined,
      dryRun: options.dryRun,
      force: options.force,
      onConflict: options.onConflict as ConflictPolicy | undefined,
      ...(options.piSubagents ? { targetOptions: { piSubagents: true } } : {}),
      cwd,
    });
  });

program
  .command('list')
  .description('list available bundles, or installed ones with --installed')
  .option('-i, --installed', 'list installed bundles instead of registered ones')
  .addOption(
    new Option('-s, --scope <scope>', 'scope to inspect with --installed').choices([
      'project',
      'user',
      'all',
    ]),
  )
  .option('--json', 'machine-readable output')
  .action(async (options) => {
    await listCommand({
      installed: options.installed,
      scope: options.scope as Scope | 'all' | undefined,
      json: options.json,
      cwd,
    });
  });

program
  .command('info')
  .argument('<bundle>', 'registered name, local path, GitHub URL, or owner/repo')
  .description('show a bundle’s contents and where each item would land')
  .addOption(scopeOption())
  .addOption(piSubagentsOption())
  .action(async (bundle, options) => {
    await infoCommand(bundle, {
      scope: options.scope as Scope,
      targetOptions: targetOptionsFrom(options),
      cwd,
    });
  });

program
  .command('status')
  .description('check that installed items are still present and unmodified')
  .addOption(
    new Option('-s, --scope <scope>', 'scope to inspect').choices(['project', 'user', 'all']),
  )
  .action(async (options) => {
    await statusCommand({ scope: options.scope as Scope | 'all' | undefined, cwd });
  });

program
  .command('validate')
  .argument('[bundle]', 'bundle to validate', '.')
  .description('check a bundle for common mistakes')
  .action(async (bundle) => {
    const ok = await validateCommand(bundle, { cwd });
    if (!ok) process.exitCode = 1;
  });

program
  .command('init')
  .argument('[directory]', 'where to create the bundle', '.')
  .option('-n, --name <name>', 'bundle name (defaults to the directory name)')
  .description('scaffold a new bundle')
  .action(async (directory, options) => {
    await initCommand(directory, { name: options.name, cwd });
  });

program
  .command('targets')
  .description('list supported harnesses and their install locations')
  .action(() => targetsCommand({ cwd }));

program
  .command('export')
  .argument('[file]', 'output file', 'bundles.txt')
  .description('write installed (or registered) bundles to a shareable list')
  .option('-r, --registry', 'export the local registry instead of what is installed here')
  .addOption(
    new Option('-s, --scope <scope>', 'scope to export').choices(['project', 'user', 'all']),
  )
  .option('--stdout', 'print the list instead of writing a file')
  .action(async (file, options) => {
    await exportCommand(file, {
      registry: options.registry,
      scope: options.scope as Scope | 'all' | undefined,
      stdout: options.stdout,
      cwd,
    });
  });

program
  .command('import')
  .argument('[file]', 'bundles file to read', 'bundles.txt')
  .description('register every bundle listed in a bundles file')
  .option('-i, --install', 'also install each bundle after registering it')
  .addOption(targetOption())
  .addOption(scopeOption())
  .addOption(conflictOption())
  .option('--dry-run', 'with --install, show what would change without writing')
  .option('--force', 'with --install, overwrite conflicting items')
  .option('--no-deps', 'with --install, do not pull in the bundles each one requires')
  .addOption(piSubagentsOption())
  .action(async (file, options) => {
    await importCommand(file, {
      install: options.install,
      targets: options.target,
      scope: options.scope as Scope,
      force: options.force,
      onConflict: options.onConflict as ConflictPolicy | undefined,
      dryRun: options.dryRun,
      noDeps: options.deps === false,
      targetOptions: targetOptionsFrom(options),
      cwd,
    });
  });

/**
 * `hcm context` -- the standing-instruction files are the one place a harness's
 * own agent writes back, so the sections installed there need putting back
 * from time to time. Every subcommand takes the same bundle list and options.
 */
const context = program
  .command('context')
  .description('manage the context sections installed in CLAUDE.md / AGENTS.md and friends');

const contextScopeOption = () =>
  new Option('-s, --scope <scope>', 'scope to act on')
    .choices(['project', 'user', 'all'])
    .default('project');

const contextOptions = (options: Record<string, unknown>): ContextOptions => ({
  targets: options.target as string[] | undefined,
  scope: options.scope as Scope | 'all',
  dryRun: options.dryRun as boolean | undefined,
  force: options.force as boolean | undefined,
  json: options.json as boolean | undefined,
  cwd,
});

const contextSubcommand = (name: string, description: string, isDefault = false) =>
  context
    .command(name, { isDefault })
    .argument('[bundle...]', 'bundle name(s) or id(s); defaults to all of them')
    .description(description)
    .addOption(targetOption())
    .addOption(contextScopeOption());

// `hcm context` on its own is a status report, as `hcm config` is.
contextSubcommand('list', 'show each tracked section and whether it is still in place', true)
  .option('--json', 'machine-readable output')
  .action(async (bundles, options) => {
    await contextListCommand(bundles, contextOptions(options));
  });

contextSubcommand('append', 'add back the sections that are no longer in the file')
  .option('--dry-run', 'show what would change without writing')
  .option('--force', 'write every section from the cache, without checking first')
  .action(async (bundles, options) => {
    await contextAppendCommand(bundles, contextOptions(options));
  });

contextSubcommand('override', 'clear the file and rewrite it from the cached sections')
  .option('--dry-run', 'show what would change without writing')
  .option('--force', 'discard content hcm did not write without asking')
  .action(async (bundles, options) => {
    await contextOverrideCommand(bundles, contextOptions(options));
  });

contextSubcommand('remove', 'take the sections out, keeping the cached copies')
  .option('--dry-run', 'show what would change without writing')
  .action(async (bundles, options) => {
    await contextRemoveCommand(bundles, contextOptions(options));
  });

const config = program.command('config').description('view and change hcm settings');

config
  .command('list', { isDefault: true })
  .option('--json', 'machine-readable output')
  .description('show every setting and where its value comes from')
  .action(async (options) => {
    await configListCommand({ json: options.json });
  });

config
  .command('get')
  .argument('<key>', 'setting name')
  .description('print the effective value of a setting')
  .action(async (key) => {
    await configGetCommand(key);
  });

config
  .command('set')
  .argument('<key>', 'setting name')
  .argument('<value>', 'new value')
  .description('change a setting')
  .action(async (key, value) => {
    await configSetCommand(key, value);
  });

config
  .command('unset')
  .argument('<key>', 'setting name')
  .description('revert a setting to its default')
  .action(async (key) => {
    await configUnsetCommand(key);
  });

const registry = program.command('registry').description('manage the list of known bundles');

registry
  .command('add')
  .argument('<source>', 'local path, GitHub URL (web, clone or SSH), or owner/repo[/subdir][#ref]')
  .option('-n, --name <name>', 'override the registered name')
  .option('--dev', 'read a local bundle in place, so edits apply without re-registering')
  .description('register a bundle so it can be installed by name or id')
  .action(async (source, options) => {
    await registryAddCommand(source, { name: options.name, dev: options.dev, cwd });
  });

registry
  .command('remove')
  .argument('<bundle...>', 'registered bundle name(s) or id(s)')
  .description('unregister a bundle and delete its stored copy')
  .action(async (bundles) => {
    await registryRemoveCommand(bundles, { cwd });
  });

registry
  .command('list')
  .option('--json', 'machine-readable output')
  .description('list registered bundles')
  .action(async (options) => {
    await registryListCommand({ json: options.json });
  });

registry
  .command('open')
  .argument('[bundle]', 'open one bundle’s folder instead of the whole store')
  .option('--no-open', 'print the path without launching a file manager')
  .description('show where registered bundles are stored, and open it')
  .action(async (bundle, options) => {
    await registryOpenCommand(bundle, { open: options.open });
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof ConflictError) {
      log.error(error.message);
      if (error.hint) log.info(color.dim(error.hint));
      process.exitCode = 1;
      return;
    }
    if (error instanceof HcmError) {
      log.error(error.message);
      if (error.hint) log.info(color.dim(error.hint));
      process.exitCode = 1;
      return;
    }
    log.error((error as Error).message);
    if (process.env.HCM_DEBUG) console.error(error);
    process.exitCode = 1;
  } finally {
    closePrompt();
  }
}

void main();
