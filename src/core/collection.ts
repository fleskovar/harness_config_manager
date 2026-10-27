/**
 * The collection manifest: an optional `hcm_manifest.yml` in a folder that
 * holds several bundles.
 *
 *   agent-kits/
 *     hcm_manifest.yml
 *     review-kit/hcm.yaml
 *     bundles/db-kit/hcm.yaml
 *
 *   # hcm_manifest.yml
 *   collection: agent-kits    # the collection name, recorded on each registered bundle
 *   bundles:                  # optional; the default is each direct subfolder with a bundle
 *     - review-kit
 *     - bundles/db-kit
 *
 * The collection name groups the bundles in the registry, so that
 * `hcm registry remove --collection agent-kits` removes all of them in one step.
 *
 * This module only reads and checks the file. `discoverBundles` in `bundle.ts`
 * makes sure that each listed folder holds a bundle.
 */

import path from 'node:path';
import YAML from 'yaml';
import { HcmError } from './errors.js';
import { fs, pathExists, toPosix } from './fsx.js';

export const COLLECTION_MANIFEST_NAMES = [
  'hcm_manifest.yml',
  'hcm_manifest.yaml',
  'hcm_manifest.json',
];

export interface CollectionManifest {
  /** The absolute path of the file, for error messages. */
  path: string;
  /** The collection name that each bundle of the collection gets in the registry. */
  collection?: string;
  /** The bundle folders, as POSIX paths relative to the collection root. */
  bundles?: string[];
}

const COLLECTION_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/** True when a collection name is usable. */
export function isUsableCollectionName(name: string): boolean {
  return COLLECTION_NAME_PATTERN.test(name);
}

/** Fail when a collection name is not usable. `where` names the origin of the value. */
export function checkCollectionName(name: string, where: string): string {
  const trimmed = name.trim();
  if (!isUsableCollectionName(trimmed)) {
    throw new HcmError(
      `"${name}" is not a usable collection name (in ${where})`,
      'Use letters, digits, dots, dashes and underscores. Start with a letter or a digit.',
    );
  }
  return trimmed;
}

export async function findCollectionManifest(root: string): Promise<string | undefined> {
  for (const name of COLLECTION_MANIFEST_NAMES) {
    const candidate = path.join(root, name);
    if (await pathExists(candidate)) return candidate;
  }
  return undefined;
}

/** Read and check the collection manifest of `root`. Undefined when there is none. */
export async function loadCollectionManifest(
  root: string,
): Promise<CollectionManifest | undefined> {
  const manifestPath = await findCollectionManifest(root);
  if (!manifestPath) return undefined;

  const text = await fs.readFile(manifestPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = manifestPath.endsWith('.json') ? JSON.parse(text) : YAML.parse(text);
  } catch (error) {
    throw new HcmError(
      `Collection manifest ${manifestPath} is malformed`,
      (error as Error).message,
    );
  }

  // An empty file is a valid manifest: the folder is a collection with no name.
  if (parsed === null || parsed === undefined) return { path: manifestPath };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HcmError(
      `Collection manifest ${manifestPath} must be a mapping`,
      'Write "collection: <name>" and, as an option, a "bundles:" list.',
    );
  }

  const raw = parsed as { collection?: unknown; bundles?: unknown };
  const manifest: CollectionManifest = { path: manifestPath };

  if (raw.collection !== undefined) {
    if (typeof raw.collection !== 'string') {
      throw new HcmError(`"collection" in ${manifestPath} must be a string`);
    }
    manifest.collection = checkCollectionName(raw.collection, manifestPath);
  }

  if (raw.bundles !== undefined) manifest.bundles = bundlePaths(raw.bundles, manifestPath);

  return manifest;
}

/**
 * Check the `bundles` list. Each item is a folder inside the collection root.
 * A path that goes out of the root is refused: a remote source records each
 * bundle as a subfolder of the download, and `..` cannot be one.
 */
function bundlePaths(declared: unknown, manifestPath: string): string[] {
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new HcmError(
      `"bundles" in ${manifestPath} must be a list with at least one folder`,
      'Write one relative folder path per line, for example "- review-kit".',
    );
  }

  const seen = new Set<string>();
  const paths: string[] = [];

  for (const item of declared) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new HcmError(`Malformed item in "bundles" of ${manifestPath}: ${JSON.stringify(item)}`);
    }

    const normalized = toPosix(path.normalize(item.trim())).replace(/\/+$/, '');
    if (
      path.isAbsolute(item.trim()) ||
      normalized === '.' ||
      normalized === '..' ||
      normalized.startsWith('../')
    ) {
      throw new HcmError(
        `"${item}" in ${manifestPath} is not a folder inside the collection`,
        'Give each bundle as a path relative to the folder that holds hcm_manifest.yml.',
      );
    }

    if (seen.has(normalized)) {
      throw new HcmError(`"${item}" is listed twice in "bundles" of ${manifestPath}`);
    }
    seen.add(normalized);
    paths.push(normalized);
  }

  return paths;
}
