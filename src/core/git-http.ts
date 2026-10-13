/**
 * A read-only git client for the "smart" HTTP protocol.
 *
 * It downloads the files of one commit from any git host that serves HTTPS
 * clone URLs: GitHub, Azure DevOps, Bitbucket, GitLab, Gitea, a self-hosted
 * server. It does not start a `git` process, so hcm works on a machine that
 * has no git, and no credential helper opens a prompt.
 *
 * The exchange is two requests:
 *
 *   GET  <url>/info/refs?service=git-upload-pack   the refs and capabilities
 *   POST <url>/git-upload-pack                     one `want`, answered by a pack
 *
 * The request asks for a depth of 1 when the server permits it, so the pack
 * holds one commit and its files, not the history. This is protocol version 0,
 * which every smart HTTP server speaks; version 2 is not universal.
 *
 * Everything the server sends is untrusted: the pack is checked as it is read,
 * and a file name that could leave the target directory is refused.
 */

import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { HcmError } from './errors.js';

/** Some hosts serve the git protocol only to a client that says it is git. */
const USER_AGENT = 'git/2.0 (harness-config-manager)';

/** Capabilities this client can use. Only those the server offers are sent. */
const WANTED_CAPABILITIES = ['multi_ack_detailed', 'side-band-64k', 'ofs-delta', 'no-progress'];

const TOKEN_HINT =
  'For a private repository, set HCM_GIT_TOKEN to an access token that can read it. ' +
  'HCM_GIT_TOKEN_<HOST> sets a token for one host, for example HCM_GIT_TOKEN_DEV_AZURE_COM.';

/** One file of the downloaded commit. */
export interface GitFile {
  /** Path from the root of the repository, POSIX separators. */
  path: string;
  data: Buffer;
  executable: boolean;
}

export interface GitDownload {
  /** The object id that the ref resolved to. */
  commit: string;
  files: GitFile[];
}

type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

interface GitObject {
  type: ObjectType;
  data: Buffer;
}

interface Advertisement {
  refs: Map<string, string>;
  capabilities: string[];
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** `dev.azure.com` -> `HCM_GIT_TOKEN_DEV_AZURE_COM`. */
export function hostTokenVariable(hostname: string): string {
  return `HCM_GIT_TOKEN_${hostname.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

/**
 * The `Authorization` header for a repository, or nothing when no token is set.
 *
 * The token comes from the environment and never from the URL, so it is not
 * written to the registry or to a bundles file. The variable for the host wins
 * over the general one. Every host that hcm knows accepts a token as the
 * password of HTTP Basic authentication. Most of them ignore the user name;
 * Bitbucket does not, so a user name in the URL or in `HCM_GIT_USERNAME` is
 * used when there is one.
 */
export function gitAuthorization(
  url: URL,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const token = env[hostTokenVariable(url.hostname)] || env.HCM_GIT_TOKEN;
  if (!token) return undefined;

  const username =
    decodeURIComponent(url.username) ||
    env.HCM_GIT_USERNAME ||
    (/(^|\.)bitbucket\.org$/i.test(url.hostname) ? 'x-token-auth' : 'git');

  return `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`;
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

const FLUSH = Buffer.from('0000');

/** Frame one line: four hex digits of length, counting themselves, then the text. */
export function pktLine(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  return Buffer.concat([
    Buffer.from((payload.length + 4).toString(16).padStart(4, '0')),
    payload,
  ]);
}

/** Read one packet. A flush packet has no payload. */
function readPacket(buffer: Buffer, offset: number): { payload?: Buffer; next: number } {
  const header = buffer.toString('latin1', offset, offset + 4);
  if (!/^[0-9a-f]{4}$/i.test(header)) throw malformed('a packet has no length');

  const length = Number.parseInt(header, 16);
  if (length < 4) return { next: offset + 4 };
  if (offset + length > buffer.length) throw malformed('a packet is cut short');

  return { payload: buffer.subarray(offset + 4, offset + length), next: offset + length };
}

function malformed(detail: string): HcmError {
  return new HcmError(`The git server sent a reply that hcm cannot read: ${detail}`);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    const cause = (error as { cause?: Error }).cause?.message ?? (error as Error).message;
    throw new HcmError(`Cannot connect to ${new URL(url).host}: ${cause}`);
  }
}

function httpFailure(response: Response, repository: string): HcmError {
  if (response.status === 401 || response.status === 403) {
    return new HcmError(
      `${repository} refused access (HTTP ${response.status})`,
      TOKEN_HINT,
    );
  }
  if (response.status === 404) {
    return new HcmError(
      `Repository not found: ${repository} (HTTP 404)`,
      `Make sure that the URL is the HTTPS clone URL. ${TOKEN_HINT}`,
    );
  }
  return new HcmError(`Failed to read ${repository} (HTTP ${response.status})`);
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

/** Read the reply to `info/refs`: every ref, and the capabilities on the first one. */
export function parseAdvertisement(body: Buffer): Advertisement {
  const refs = new Map<string, string>();
  let capabilities: string[] = [];
  let offset = 0;

  while (offset < body.length) {
    const packet = readPacket(body, offset);
    offset = packet.next;
    if (!packet.payload) continue;

    let line = packet.payload;
    const nul = line.indexOf(0);
    if (nul >= 0) {
      capabilities = line.toString('utf8', nul + 1).trim().split(' ').filter(Boolean);
      line = line.subarray(0, nul);
    }

    // Other lines are the service header and, for an empty repository, a
    // placeholder that has no ref name.
    const match = /^([0-9a-f]{40}) (\S.*)$/.exec(line.toString('utf8').trimEnd());
    if (match) refs.set(match[2] as string, match[1] as string);
  }

  if (capabilities.includes('object-format=sha256')) {
    throw new HcmError('The repository uses SHA-256 object ids, which hcm cannot read');
  }

  return { refs, capabilities };
}

/**
 * The object id for a ref as the user wrote it: `HEAD`, a branch, a tag, a
 * full ref name, or a full commit id.
 *
 * For an annotated tag the server lists the commit under `<name>^{}`, and that
 * is the one to ask for.
 */
export function resolveRef(advertisement: Advertisement, ref: string, repository: string): string {
  const { refs } = advertisement;
  const lookup = (name: string): string | undefined => refs.get(`${name}^{}`) ?? refs.get(name);

  if (ref === 'HEAD') {
    const head = refs.get('HEAD') ?? lookup('refs/heads/main') ?? lookup('refs/heads/master');
    if (head) return head;
    throw new HcmError(`${repository} has no commits`);
  }

  const names = ref.startsWith('refs/') ? [ref] : [`refs/heads/${ref}`, `refs/tags/${ref}`];
  for (const name of names) {
    const id = lookup(name);
    if (id) return id;
  }

  // A commit id is not in the list. The server decides if it sends that commit.
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref.toLowerCase();

  const branches = [...refs.keys()]
    .filter((name) => name.startsWith('refs/heads/'))
    .map((name) => name.slice('refs/heads/'.length));

  throw new HcmError(
    `"${ref}" is not a branch, a tag or a full commit id of ${repository}`,
    branches.length > 0
      ? `Branches: ${branches.slice(0, 10).join(', ')}${branches.length > 10 ? ', ...' : ''}`
      : undefined,
  );
}

// ---------------------------------------------------------------------------
// The pack
// ---------------------------------------------------------------------------

/**
 * Take the pack out of the reply to `git-upload-pack`.
 *
 * With `side-band-64k` the pack arrives in packets, each with a first byte that
 * names its band: 1 is pack data, 2 is progress text, 3 is an error. Text
 * packets (`NAK`, `shallow <id>`) come before them. Without the side band, the
 * raw pack follows the text packets.
 */
export function readPackResponse(body: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;

  while (offset < body.length) {
    if (body.toString('latin1', offset, offset + 4) === 'PACK') {
      chunks.push(body.subarray(offset));
      break;
    }

    const packet = readPacket(body, offset);
    offset = packet.next;
    if (!packet.payload || packet.payload.length === 0) continue;

    const band = packet.payload[0];
    if (band === 1) chunks.push(packet.payload.subarray(1));
    else if (band === 3) throw serverError(packet.payload.toString('utf8', 1));
    else if (band !== 2 && packet.payload.toString('latin1', 0, 4) === 'ERR ') {
      throw serverError(packet.payload.toString('utf8', 4));
    }
  }

  if (chunks.length === 0) throw malformed('it has no pack');
  return Buffer.concat(chunks);
}

function serverError(text: string): HcmError {
  return new HcmError(`The git server refused the request: ${text.trim()}`);
}

const PACK_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const OFS_DELTA = 6;
const REF_DELTA = 7;

function objectId(object: GitObject): string {
  return createHash('sha1')
    .update(`${object.type} ${object.data.length}\0`)
    .update(object.data)
    .digest('hex');
}

/**
 * Read every object of a pack, keyed by object id.
 *
 * An object is stored whole, or as a delta against another object of the pack.
 * The base of a delta is named by its distance back in the pack (`OFS_DELTA`),
 * or by its id (`REF_DELTA`). A base named by id can come later in the pack,
 * so those deltas wait until their base is known.
 */
export function parsePack(pack: Buffer): Map<string, GitObject> {
  try {
    return readPack(pack);
  } catch (error) {
    if (error instanceof HcmError) throw error;
    throw malformed(`the pack is damaged (${(error as Error).message})`);
  }
}

function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 12 || pack.toString('latin1', 0, 4) !== 'PACK') {
    throw malformed('the pack has no header');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw malformed(`pack version ${version} is not supported`);
  const count = pack.readUInt32BE(8);

  const byOffset = new Map<number, GitObject>();
  const byId = new Map<string, GitObject>();
  const waiting: { base: string; delta: Buffer }[] = [];

  let offset = 12;
  const next = (): number => {
    const byte = pack[offset];
    if (byte === undefined) throw malformed('the pack is cut short');
    offset += 1;
    return byte;
  };

  for (let index = 0; index < count; index += 1) {
    const start = offset;

    // The type is in bits 4-6 of the first byte. The size starts in its low
    // four bits, and continues seven bits at a time while the high bit is set.
    let byte = next();
    const type = (byte >> 4) & 7;
    let size = byte & 15;
    let scale = 16;
    while (byte & 0x80) {
      byte = next();
      size += (byte & 0x7f) * scale;
      scale *= 128;
    }

    let baseOffset: number | undefined;
    let baseId: string | undefined;
    if (type === OFS_DELTA) {
      byte = next();
      let distance = byte & 0x7f;
      while (byte & 0x80) {
        byte = next();
        distance = (distance + 1) * 128 + (byte & 0x7f);
      }
      baseOffset = start - distance;
    } else if (type === REF_DELTA) {
      baseId = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }

    // `info` makes zlib report how much input one object used, which is the
    // only way to find where the next object starts.
    const inflated = inflateSync(pack.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    offset += inflated.engine.bytesWritten;
    const data = inflated.buffer;
    if (data.length !== size) throw malformed('an object has the wrong size');

    let object: GitObject | undefined;
    if (baseOffset !== undefined) {
      const base = byOffset.get(baseOffset);
      if (!base) throw malformed('a delta has no base');
      object = { type: base.type, data: applyDelta(base.data, data) };
    } else if (baseId !== undefined) {
      const base = byId.get(baseId);
      if (base) object = { type: base.type, data: applyDelta(base.data, data) };
      else waiting.push({ base: baseId, delta: data });
    } else {
      const name = PACK_TYPES[type];
      if (!name) throw malformed(`object type ${type} is unknown`);
      object = { type: name, data };
    }

    if (object) {
      byOffset.set(start, object);
      byId.set(objectId(object), object);
    }
  }

  // Each pass resolves the deltas whose base is now known. A pass that resolves
  // none means that a base is not in the pack at all.
  let pending = waiting;
  while (pending.length > 0) {
    const unresolved: typeof waiting = [];
    for (const entry of pending) {
      const base = byId.get(entry.base);
      if (!base) {
        unresolved.push(entry);
        continue;
      }
      const object: GitObject = { type: base.type, data: applyDelta(base.data, entry.delta) };
      byId.set(objectId(object), object);
    }
    if (unresolved.length === pending.length) throw malformed('a delta has no base');
    pending = unresolved;
  }

  return byId;
}

/**
 * Build an object from its base and a delta.
 *
 * A delta starts with the size of the base and the size of the result. Then
 * each instruction either copies a range of the base, or inserts bytes that
 * the delta carries.
 */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let position = 0;
  const next = (): number => {
    const byte = delta[position];
    if (byte === undefined) throw malformed('a delta is cut short');
    position += 1;
    return byte;
  };
  const size = (): number => {
    let value = 0;
    let scale = 1;
    let byte: number;
    do {
      byte = next();
      value += (byte & 0x7f) * scale;
      scale *= 128;
    } while (byte & 0x80);
    return value;
  };

  if (size() !== base.length) throw malformed('a delta does not match its base');
  const result = Buffer.alloc(size());
  let written = 0;

  while (position < delta.length) {
    const command = next();

    if (command & 0x80) {
      // Copy. Bits 0-3 say which bytes of the offset follow, bits 4-6 which
      // bytes of the length. A byte that is not sent is zero.
      let from = 0;
      let length = 0;
      if (command & 0x01) from += next();
      if (command & 0x02) from += next() * 0x100;
      if (command & 0x04) from += next() * 0x10000;
      if (command & 0x08) from += next() * 0x1000000;
      if (command & 0x10) length += next();
      if (command & 0x20) length += next() * 0x100;
      if (command & 0x40) length += next() * 0x10000;
      if (length === 0) length = 0x10000;

      if (from + length > base.length || written + length > result.length) {
        throw malformed('a delta copies outside its base');
      }
      base.copy(result, written, from, from + length);
      written += length;
    } else if (command > 0) {
      // Insert: the command is the number of bytes that follow.
      if (position + command > delta.length || written + command > result.length) {
        throw malformed('a delta inserts too much');
      }
      delta.copy(result, written, position, position + command);
      position += command;
      written += command;
    } else {
      throw malformed('a delta has an unknown instruction');
    }
  }

  if (written !== result.length) throw malformed('a delta gives the wrong size');
  return result;
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

const MODE_DIRECTORY = '40000';
const MODE_SYMLINK = '120000';
const MODE_SUBMODULE = '160000';

/**
 * A tree entry name that is safe to join onto a directory. A name with a
 * separator, or `..`, could put a file outside the directory.
 */
function isSafeName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[\\/\0]/.test(name);
}

function requireObject(
  objects: Map<string, GitObject>,
  id: string,
  type: ObjectType,
): GitObject {
  const object = objects.get(id);
  if (!object || object.type !== type) throw malformed(`the pack has no ${type} ${id}`);
  return object;
}

/** The tree of a commit, after following an annotated tag to its commit. */
function treeOf(objects: Map<string, GitObject>, id: string): string {
  let object = objects.get(id);

  for (let depth = 0; object?.type === 'tag' && depth < 8; depth += 1) {
    const target = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('latin1'))?.[1];
    object = target ? objects.get(target) : undefined;
  }

  const tree =
    object?.type === 'commit'
      ? /^tree ([0-9a-f]{40})$/m.exec(object.data.toString('latin1'))?.[1]
      : undefined;
  if (!tree) throw malformed(`${id} is not a commit`);
  return tree;
}

/**
 * Every file of a commit.
 *
 * Symbolic links and submodules are left out. A link can point outside the
 * bundle, and Windows cannot always create one; a submodule is another
 * repository, which the pack does not contain.
 */
export function readFiles(objects: Map<string, GitObject>, commit: string): GitFile[] {
  const files: GitFile[] = [];

  const walk = (treeId: string, prefix: string): void => {
    const tree = requireObject(objects, treeId, 'tree').data;
    let position = 0;

    // Each entry is `<mode> <name>\0` and then the 20 bytes of the object id.
    while (position < tree.length) {
      const space = tree.indexOf(0x20, position);
      const nul = tree.indexOf(0, space);
      if (space < 0 || nul < 0 || nul + 21 > tree.length) throw malformed('a tree is damaged');

      const mode = tree.toString('latin1', position, space).replace(/^0+/, '');
      const name = tree.toString('utf8', space + 1, nul);
      const id = tree.toString('hex', nul + 1, nul + 21);
      position = nul + 21;

      if (!isSafeName(name)) {
        throw new HcmError(`The repository has a file name that hcm does not write: "${name}"`);
      }
      if (name.toLowerCase() === '.git') continue;
      if (mode === MODE_SYMLINK || mode === MODE_SUBMODULE) continue;

      const entryPath = prefix ? `${prefix}/${name}` : name;
      if (mode === MODE_DIRECTORY) {
        walk(id, entryPath);
        continue;
      }

      files.push({
        path: entryPath,
        data: requireObject(objects, id, 'blob').data,
        executable: mode === '100755',
      });
    }
  };

  walk(treeOf(objects, commit), '');
  return files;
}

// ---------------------------------------------------------------------------
// The download
// ---------------------------------------------------------------------------

/**
 * Download the files of one ref of a repository.
 *
 * `url` is the HTTPS clone URL. A user name in it is used for authentication
 * and is not sent as part of the address.
 */
export async function downloadGitTree(options: { url: string; ref: string }): Promise<GitDownload> {
  const address = new URL(options.url);
  const authorization = gitAuthorization(address);
  address.username = '';
  address.password = '';
  address.hash = '';
  address.search = '';

  const repository = address.href.replace(/\/+$/, '');
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    ...(authorization ? { Authorization: authorization } : {}),
  };

  const refsResponse = await request(`${repository}/info/refs?service=git-upload-pack`, {
    headers,
  });
  if (!refsResponse.ok) throw httpFailure(refsResponse, repository);

  // A sign-in page, or a server that only serves static files, answers 200 with
  // another content type. Neither can be read as the git protocol.
  const contentType = refsResponse.headers.get('content-type') ?? '';
  if (!contentType.includes('application/x-git-upload-pack-advertisement')) {
    throw new HcmError(
      `${repository} did not answer as a git repository`,
      `Make sure that the URL is the HTTPS clone URL. ${TOKEN_HINT}`,
    );
  }

  const advertisement = parseAdvertisement(Buffer.from(await refsResponse.arrayBuffer()));
  const commit = resolveRef(advertisement, options.ref, repository);

  const offered = new Set(advertisement.capabilities);
  const capabilities = WANTED_CAPABILITIES.filter((capability) => offered.has(capability));
  if (advertisement.capabilities.some((capability) => capability.startsWith('agent='))) {
    capabilities.push(`agent=${USER_AGENT.replace(/\s.*$/, '')}`);
  }

  const body = Buffer.concat([
    pktLine(`want ${commit} ${capabilities.join(' ')}\n`),
    // Without `shallow` the server sends the full history, which is larger but
    // gives the same files.
    ...(offered.has('shallow') ? [pktLine('deepen 1\n')] : []),
    FLUSH,
    pktLine('done\n'),
  ]);

  const packResponse = await request(`${repository}/git-upload-pack`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/x-git-upload-pack-request',
      Accept: 'application/x-git-upload-pack-result',
    },
    body,
  });
  if (!packResponse.ok) throw httpFailure(packResponse, repository);

  const pack = readPackResponse(Buffer.from(await packResponse.arrayBuffer()));
  return { commit, files: readFiles(parsePack(pack), commit) };
}
