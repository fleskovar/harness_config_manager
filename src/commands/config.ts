import {
  assertConfigKey,
  CONFIG_KEYS,
  configFile,
  describeSetting,
  expandPath,
  type HcmConfig,
  readConfig,
  writeConfig,
} from '../core/config.js';
import { color, log } from '../core/logger.js';

/** Show every setting, its effective value, and where that value came from. */
export async function configListCommand(options: { json?: boolean }): Promise<void> {
  const keys = Object.keys(CONFIG_KEYS) as (keyof HcmConfig)[];
  const resolved = await Promise.all(
    keys.map(async (key) => ({ key, ...(await describeSetting(key)) })),
  );

  if (options.json) {
    log.plain(JSON.stringify({ configFile: configFile(), settings: resolved }, null, 2));
    return;
  }

  log.plain(color.dim(`config file: ${configFile()}`));
  for (const setting of resolved) {
    log.plain(`${color.bold(setting.key)} ${color.dim(`(${setting.origin})`)}`);
    log.plain(`  ${setting.value}`);
    log.plain(color.dim(`  ${CONFIG_KEYS[setting.key]}`));
  }
}

export async function configGetCommand(key: string): Promise<void> {
  assertConfigKey(key);
  const setting = await describeSetting(key);
  log.plain(setting.value);
}

export async function configSetCommand(key: string, value: string): Promise<void> {
  assertConfigKey(key);
  const config = await readConfig();
  config[key] = value;
  await writeConfig(config);

  log.success(`Set ${key} = ${expandPath(value)}`);
  if (key === 'cacheDir') {
    log.info(
      color.dim('Existing downloads stay where they were; they will be re-fetched as needed.'),
    );
  }
}

export async function configUnsetCommand(key: string): Promise<void> {
  assertConfigKey(key);
  const config = await readConfig();
  delete config[key];
  await writeConfig(config);

  const setting = await describeSetting(key);
  log.success(`Unset ${key}, now using ${setting.origin}: ${setting.value}`);
}
