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
  DEFAULT_PARAMS_FILE,
  paramsInitCommand,
  paramsListCommand,
} from './commands/params.js';
import {
  registryAddCommand,
  registryListCommand,
  registryOpenCommand,
  registryRemoveCommand,
} from './commands/registry.js';
import { refsCheckCommand, refsFixCommand } from './commands/refs.js';
import { statusCommand } from './commands/status.js';
import { targetsCommand } from './commands/targets.js';
import { uninstallCommand } from './commands/uninstall.js';
import { updateCommand } from './commands/update.js';
import { validateCommand } from './commands/validate.js';
import type { ConflictPolicy } from './core/conflicts.js';
import { ConflictError, HcmError } from './core/errors.js';
import { ALL_FLAVORS } from './core/flavors.js';
import { ALL_TARGETS } from './core/harnesses.js';
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
  })
  /**
   * `--target` is variadic, so `hcm install --target pi 1 2` hands `1` and `2`
   * to the option and leaves the command with no bundle at all. Commander then
   * says "missing required argument", which is true and no help whatsoever --
   * so when the command line has a `-t` in it, say what actually happened.
   *
   * Set before any subcommand is defined, since each one copies the output
   * configuration from its parent as it is created.
   */
  .configureOutput({
    writeErr(str: string) {
      process.stderr.write(str);
      if (!/missing required argument/.test(str)) return;

      // `--flavor` is variadic for the same reason and swallows names the same
      // way, so the hint names whichever of the two is on the command line.
      const variadic = [
        { flags: ['-t', '--target'], name: '--target', takes: '<harness...>' },
        { flags: ['-f', '--flavor'], name: '--flavor', takes: '<flavor...>' },
      ].find((option) => process.argv.slice(2).some((arg) => option.flags.includes(arg)));
      if (!variadic) return;

      process.stderr.write(
        `${variadic.name} takes every value after it, so bundle names must come first: ` +
          `hcm <command> <bundle...> ${variadic.name} ${variadic.takes}\n`,
      );
    },
  });

const scopeOption = () =>
  new Option('-s, --scope <scope>', 'install scope').choices(['project', 'user']).default('project');

/**
 * Which harnesses a command acts on -- one, several, or `all`.
 *
 * Variadic, so `-t claude pi` is two harnesses in one flag, and each value is
 * an id, an alias or any unambiguous prefix of one. Deliberately not
 * `.choices()`: that would reject the shorthands, and it reports a bad value
 * without the hint about `--target` swallowing bundle names that follow it.
 * `core/harnesses.ts` validates instead.
 */
const targetOption = () =>
  new Option(
    '-t, --target <target...>',
    `target harness(es): ${TARGET_IDS.join(', ')}, or "${ALL_TARGETS}"`,
  );

/**
 * Which parts of a bundle to install -- see `core/flavors.ts`.
 *
 * Variadic like `--target`, so `--flavor python csharp` is two of them, and
 * deliberately not `.choices()`: the valid values are the bundle's, not the
 * CLI's, and `core/flavors.ts` refuses an unknown one against the bundle
 * actually being installed. `all` is reserved for "the whole bundle", which is
 * how a narrowed installation is widened again on `hcm update`.
 */
const flavorOption = () =>
  new Option(
    '-f, --flavor <flavor...>',
    `install the bundle's common part plus these flavor(s), or "${ALL_FLAVORS}" for all of it`,
  );

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

/**
 * Repeatable rather than variadic, unlike `--target` and `--flavor`.
 *
 * A variadic `--param` would swallow the bundle names after it exactly the way
 * those two do -- and here it would be worse, because `NAME=value` pairs are
 * the kind of thing people write several of, so the trap would be sprung most
 * of the time rather than occasionally.
 */
const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

/**
 * The values a bundle is customised with. See `core/parameters.ts`; the names
 * are the bundle's, so there is nothing for the CLI to validate here.
 */
const paramOption = () =>
  new Option(
    '--param <name=value>',
    'set a bundle parameter; repeatable, and scopable as bundle:NAME=value or bundle@harness:NAME=value',
  ).argParser(collect);

const paramsFileOption = () =>
  new Option(
    '--params-file <file>',
    'read parameter values from a YAML or JSON file; repeatable, later files winning',
  ).argParser(collect);

const noPromptOption = () =>
  new Option(
    '--no-prompt',
    'never ask for a parameter value: use what is supplied, then the defaults',
  );

program
  .command('install')
  .argument(
    '<bundle...>',
    'one or more: registered name or id, local path, GitHub URL, or owner/repo[/subdir][#ref]',
  )
  .description('install one or more bundles into one or more harnesses')
  .addOption(targetOption())
  .addOption(flavorOption())
  .addOption(scopeOption())
  .addOption(conflictOption())
  .addOption(paramOption())
  .addOption(paramsFileOption())
  .addOption(noPromptOption())
  .option('--dry-run', 'show what would change without writing')
  .option('--force', 'overwrite conflicting items (same as --on-conflict overwrite)')
  .option('--refresh', 're-download a GitHub bundle instead of using the cache')
  .option('--no-deps', 'install only this bundle, not the ones it requires')
  .addOption(piSubagentsOption())
  .action(async (bundles, options) => {
    await installCommand(bundles, {
      targets: options.target,
      flavors: options.flavor,
      scope: options.scope as Scope,
      dryRun: options.dryRun,
      force: options.force,
      onConflict: options.onConflict as ConflictPolicy | undefined,
      refresh: options.refresh,
      // commander gives --no-deps as deps: false, and --no-prompt as prompt: false
      noDeps: options.deps === false,
      params: options.param as string[] | undefined,
      paramsFiles: options.paramsFile as string[] | undefined,
      prompt: options.prompt !== false,
      targetOptions: targetOptionsFrom(options),
      cwd,
    });
  });

program
  .command('uninstall')
  .alias('remove')
  .argument('<bundle...>', 'installed bundle name(s) or id(s)')
  .description('remove exactly the items one or more bundles installed')
  .addOption(targetOption())
  .addOption(scopeOption())
  .option('--dry-run', 'show what would be removed without writing')
  .option('--force', 'remove items even if they were edited since install')
  .option('--cascade', 'also remove the bundles that depend on these')
  .option('--ignore-dependents', 'remove them even though other bundles still require them')
  .option('--keep-orphans', 'keep bundles that were installed only as dependencies')
  .action(async (bundles, options) => {
    await uninstallCommand(bundles, {
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
  .argument(
    '[bundle...]',
    'registered name(s) or id(s), or "all" for every registered bundle; omit for every bundle installed here',
  )
  .description('re-read bundles and reinstall them in place (default: everything installed here)')
  .addOption(targetOption())
  // Omitted, each installation keeps the flavors it recorded; passing it
  // re-narrows (or, with "all", widens) every installation this run touches.
  .addOption(flavorOption())
  .addOption(
    new Option('-s, --scope <scope>', 'scopes to update').choices(['project', 'user', 'all']),
  )
  .addOption(conflictOption())
  // Omitted, each installation is rendered again with the values it recorded;
  // passing either changes them for the installations this run touches.
  .addOption(paramOption())
  .addOption(paramsFileOption())
  .addOption(
    new Option('--reconfigure', 'ask for every parameter again, ignoring what was recorded'),
  )
  .addOption(noPromptOption())
  .option('--dry-run', 'show what would change without writing')
  .option('--force', 'replace items that were edited since install')
  // Omitted, each installation keeps what it recorded; passing it switches
  // every installation this run touches over.
  .addOption(piSubagentsOption())
  .action(async (bundles, options) => {
    await updateCommand(bundles, {
      targets: options.target,
      scope: options.scope as Scope | 'all' | undefined,
      dryRun: options.dryRun,
      force: options.force,
      onConflict: options.onConflict as ConflictPolicy | undefined,
      params: options.param as string[] | undefined,
      paramsFiles: options.paramsFile as string[] | undefined,
      reconfigure: options.reconfigure,
      prompt: options.prompt !== false,
      ...(options.piSubagents ? { targetOptions: { piSubagents: true } } : {}),
      // Passed through as given: "not asked for" and "asked for all of it" are
      // different instructions here, and `updateCommand` tells them apart.
      ...(options.flavor ? { flavors: options.flavor as string[] } : {}),
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
  .option('--descriptions', 'include each bundle\'s description')
  .action(async (options) => {
    await listCommand({
      installed: options.installed,
      scope: options.scope as Scope | 'all' | undefined,
      json: options.json,
      descriptions: options.descriptions,
      cwd,
    });
  });

program
  .command('info')
  .argument('<bundle...>', 'registered name(s), local path(s), GitHub URL(s), or owner/repo')
  .description('show what bundles contain and where each item would land')
  .addOption(scopeOption())
  .addOption(flavorOption())
  .addOption(paramOption())
  .addOption(paramsFileOption())
  .addOption(piSubagentsOption())
  .action(async (bundles, options) => {
    await infoCommand(bundles, {
      scope: options.scope as Scope,
      flavors: options.flavor,
      params: options.param as string[] | undefined,
      paramsFiles: options.paramsFile as string[] | undefined,
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
  .description('list supported harnesses, which are set up here, and the files they share')
  .action(async () => {
    await targetsCommand({ cwd });
  });

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
  .addOption(flavorOption())
  .addOption(scopeOption())
  .addOption(conflictOption())
  .addOption(paramOption())
  .addOption(paramsFileOption())
  .addOption(noPromptOption())
  .option('--dry-run', 'with --install, show what would change without writing')
  .option('--force', 'with --install, overwrite conflicting items')
  .option('--no-deps', 'with --install, do not pull in the bundles each one requires')
  .addOption(piSubagentsOption())
  .action(async (file, options) => {
    await importCommand(file, {
      install: options.install,
      targets: options.target,
      flavors: options.flavor,
      scope: options.scope as Scope,
      force: options.force,
      onConflict: options.onConflict as ConflictPolicy | undefined,
      dryRun: options.dryRun,
      noDeps: options.deps === false,
      params: options.param as string[] | undefined,
      paramsFiles: options.paramsFile as string[] | undefined,
      prompt: options.prompt !== false,
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

/**
 * `hcm refs` -- the file references a bundle's own text makes.
 *
 * `check` reports the ones that point at nothing; `fix` offers replacements and
 * applies the ones you pick. Both take a folder rather than a bundle name: a
 * reference is a fact about files on disk, and the folder may hold a whole
 * collection whose bundles point at each other.
 */
const refs = program
  .command('refs')
  .description('find and repair broken file references in bundles');

const refsPathOption = () =>
  new Option('-p, --path <path>', 'folder to scan (a bundle, or a collection of them)').default('.');

const strictOption = () =>
  new Option(
    '--strict',
    'also report bare filenames that look like references but match nothing',
  );

refs
  .command('check', { isDefault: true })
  .description('report every file reference that points at nothing')
  .addOption(refsPathOption())
  .addOption(strictOption())
  .option('--json', 'machine-readable output')
  .action(async (options) => {
    const ok = await refsCheckCommand({
      path: options.path,
      strict: options.strict,
      json: options.json,
      cwd,
    });
    if (!ok) process.exitCode = 1;
  });

refs
  .command('fix')
  .description('write the broken references to a JSON file, then apply what you leave in it')
  .addOption(refsPathOption())
  .addOption(strictOption())
  .option('--write [file]', `save the JSON in the working directory instead of opening an editor`)
  .option('--file <path>', 'apply an already-edited JSON file')
  .option('--dry-run', 'show what would change without writing')
  .action(async (options) => {
    const ok = await refsFixCommand({
      path: options.path,
      strict: options.strict,
      write: options.write,
      file: options.file,
      dryRun: options.dryRun,
      cwd,
    });
    if (!ok) process.exitCode = 1;
  });

/**
 * `hcm params` -- the values bundles are customised with.
 *
 * `list` is read-only: the way to change a value is to render the bundle again
 * with the new one, which is `hcm install --param` or `hcm update --param`.
 * `init` writes the file those installs can read the values out of.
 */
const params = program
  .command('params')
  .description('the values bundles are customised with at install time');

params
  .command('list', { isDefault: true })
  .argument('[bundle...]', 'installed bundle name(s); defaults to all of them')
  .description('show the parameter values each installation was rendered with')
  .addOption(targetOption())
  .addOption(
    new Option('-s, --scope <scope>', 'scope to inspect').choices(['project', 'user', 'all']),
  )
  .option('--json', 'machine-readable output')
  .action(async (bundles, options) => {
    await paramsListCommand(bundles, {
      targets: options.target,
      scope: options.scope as Scope | 'all' | undefined,
      json: options.json,
      cwd,
    });
  });

params
  .command('init')
  .argument(
    '[bundle...]',
    'bundles to write questions for; omit for everything installed here',
  )
  .description('write a parameters file to fill in and pass back with --params-file')
  .addOption(targetOption())
  .addOption(flavorOption())
  .addOption(scopeOption())
  .option('-o, --output <file>', `where to write it (default: ${DEFAULT_PARAMS_FILE})`)
  .option('--stdout', 'print it instead of writing a file')
  .option('--force', 'replace the file if it is already there')
  .action(async (bundles, options) => {
    await paramsInitCommand(bundles, {
      targets: options.target,
      flavors: options.flavor,
      scope: options.scope as Scope,
      output: options.output,
      stdout: options.stdout,
      force: options.force,
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
  .argument(
    '<source...>',
    'local path(s), GitHub URL(s) (web, clone or SSH), or owner/repo[/subdir][#ref]',
  )
  .option('-n, --name <name>', 'override the registered name (one source only)')
  .option('--dev', 'read a local bundle in place, so edits apply without re-registering')
  .description('register bundles so they can be installed by name or id')
  .action(async (sources, options) => {
    await registryAddCommand(sources, { name: options.name, dev: options.dev, cwd });
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
