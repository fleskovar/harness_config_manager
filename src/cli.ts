#!/usr/bin/env node
import { Command, Option } from 'commander';
import {
  configGetCommand,
  configListCommand,
  configSetCommand,
  configUnsetCommand,
} from './commands/config.js';
import { exportCommand } from './commands/export.js';
import { importCommand } from './commands/import.js';
import { infoCommand } from './commands/info.js';
import { initCommand } from './commands/init.js';
import { installCommand } from './commands/install.js';
import { listCommand } from './commands/list.js';
import {
  registryAddCommand,
  registryListCommand,
  registryRemoveCommand,
} from './commands/registry.js';
import { statusCommand } from './commands/status.js';
import { targetsCommand } from './commands/targets.js';
import { uninstallCommand } from './commands/uninstall.js';
import { validateCommand } from './commands/validate.js';
import { ConflictError, HcmError } from './core/errors.js';
import { color, configureLogger, log } from './core/logger.js';
import type { Scope } from './core/types.js';
import { TARGET_IDS } from './targets/index.js';

const program = new Command();
const cwd = process.cwd();

program
  .name('hcm')
  .description(
    'Define agents, skills, commands, rules and MCP servers once; install them into ' +
      'Claude Code, GitHub Copilot and Reasonix with exact, item-level rollback.',
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

program
  .command('install')
  .argument('<bundle>', 'registered name, local path, GitHub URL, or owner/repo[/subdir][#ref]')
  .description('install a bundle into one or more harnesses')
  .addOption(targetOption())
  .addOption(scopeOption())
  .option('--dry-run', 'show what would change without writing')
  .option('--force', 'overwrite conflicting items')
  .option('--refresh', 're-download a GitHub bundle instead of using the cache')
  .action(async (bundle, options) => {
    await installCommand(bundle, {
      targets: options.target,
      scope: options.scope as Scope,
      dryRun: options.dryRun,
      force: options.force,
      refresh: options.refresh,
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
  .action(async (bundle, options) => {
    await uninstallCommand(bundle, {
      targets: options.target,
      scope: options.scope as Scope,
      dryRun: options.dryRun,
      force: options.force,
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
  .action(async (bundle, options) => {
    await infoCommand(bundle, { scope: options.scope as Scope, cwd });
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
  .option('--dry-run', 'with --install, show what would change without writing')
  .option('--force', 'with --install, overwrite conflicting items')
  .action(async (file, options) => {
    await importCommand(file, {
      install: options.install,
      targets: options.target,
      scope: options.scope as Scope,
      force: options.force,
      dryRun: options.dryRun,
      cwd,
    });
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
  .description('register a bundle so it can be installed by name')
  .action(async (source, options) => {
    await registryAddCommand(source, { name: options.name, cwd });
  });

registry
  .command('remove')
  .argument('<name>', 'registered bundle name')
  .description('forget a bundle (does not uninstall it)')
  .action(async (name) => {
    await registryRemoveCommand(name);
  });

registry
  .command('list')
  .option('--json', 'machine-readable output')
  .description('list registered bundles')
  .action(async (options) => {
    await registryListCommand({ json: options.json });
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
  }
}

void main();
