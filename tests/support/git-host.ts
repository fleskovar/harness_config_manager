/**
 * A git host in memory, for the tests of `core/git-http.ts`.
 *
 * It speaks the two requests of the smart HTTP protocol the way a real server
 * does -- the ref advertisement, then a pack -- so the tests need no network
 * and no `git` on the machine. `host.fetch` replaces the global `fetch`.
 *
 * The pack is built here by hand, which is what lets a test choose the hard
 * encodings on purpose: objects stored as deltas against an earlier object
 * (`ofs`), or against an object that comes later in the pack (`ref`).
 */

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

interface GitObject {
  type: ObjectType;
  data: Buffer;
  id: string;
}

export interface HostOptions {
  /** Refuse every request that does not carry this token as the Basic password. */
  token?: string;
  /** Send the pack in side-band packets, as every modern server does. Default true. */
  sideBand?: boolean;
  /** How blobs after the first are stored. Default `none`: every object whole. */
  deltas?: 'none' | 'ofs' | 'ref';
}

export interface SeenRequest {
  method: string;
  url: string;
  authorization?: string;
}

const PACK_TYPE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function makeObject(type: ObjectType, data: Buffer): GitObject {
  const id = createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
  return { type, data, id };
}

function pkt(text: string | Buffer): Buffer {
  const payload = typeof text === 'string' ? Buffer.from(text) : text;
  return Buffer.concat([Buffer.from((payload.length + 4).toString(16).padStart(4, '0')), payload]);
}

const FLUSH = Buffer.from('0000');

/** A size as git writes it: seven bits to a byte, low bits first. */
function varint(value: number): number[] {
  const bytes: number[] = [];
  do {
    const byte = value & 0x7f;
    value = Math.floor(value / 128);
    bytes.push(value > 0 ? byte | 0x80 : byte);
  } while (value > 0);
  return bytes;
}

/** The header of one pack entry: the type, then the size of the inflated data. */
function entryHeader(type: number, size: number): Buffer {
  const bytes = [(type << 4) | (size & 15)];
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes[bytes.length - 1]! |= 0x80;
    bytes.push(size & 0x7f);
    size = Math.floor(size / 128);
  }
  return Buffer.from(bytes);
}

/** The distance back to the base of an `OFS_DELTA`, in git's own encoding. */
function ofsDistance(distance: number): Buffer {
  const bytes = [distance & 0x7f];
  distance = Math.floor(distance / 128);
  while (distance > 0) {
    distance -= 1;
    bytes.unshift(0x80 | (distance & 0x7f));
    distance = Math.floor(distance / 128);
  }
  return Buffer.from(bytes);
}

/**
 * A delta that turns `base` into `target`: copy the prefix they share, then
 * insert the rest. Both kinds of instruction are in it whenever the two have
 * a first byte in common.
 */
export function makeDelta(base: Buffer, target: Buffer): Buffer {
  let shared = 0;
  const limit = Math.min(base.length, target.length, 0xffff);
  while (shared < limit && base[shared] === target[shared]) shared += 1;

  const bytes = [...varint(base.length), ...varint(target.length)];
  if (shared > 0) {
    // Copy from offset 0, so no offset bytes; the length takes one or two.
    const low = shared & 0xff;
    const high = shared >> 8;
    bytes.push(0x80 | (low ? 0x10 : 0) | (high ? 0x20 : 0));
    if (low) bytes.push(low);
    if (high) bytes.push(high);
  }
  for (let from = shared; from < target.length; from += 127) {
    const chunk = target.subarray(from, from + 127);
    bytes.push(chunk.length, ...chunk);
  }
  return Buffer.from(bytes);
}

/** Write objects as a version 2 pack. */
export function makePack(objects: GitObject[], deltas: HostOptions['deltas'] = 'none'): Buffer {
  const parts: Buffer[] = [];
  let length = 12;
  const push = (...buffers: Buffer[]): void => {
    for (const buffer of buffers) {
      parts.push(buffer);
      length += buffer.length;
    }
  };
  const whole = (object: GitObject): number => {
    const start = length;
    push(entryHeader(PACK_TYPE[object.type], object.data.length), deflateSync(object.data));
    return start;
  };

  const blobs = objects.filter((object) => object.type === 'blob');
  const base = deltas === 'none' ? undefined : blobs[0];
  const asDelta = base ? blobs.slice(1) : [];
  const others = objects.filter((object) => object !== base && !asDelta.includes(object));

  if (base && deltas === 'ofs') {
    const baseStart = whole(base);
    for (const object of asDelta) {
      const delta = makeDelta(base.data, object.data);
      const start = length;
      push(entryHeader(6, delta.length), ofsDistance(start - baseStart), deflateSync(delta));
    }
  } else if (base && deltas === 'ref') {
    // The deltas come first, so the reader meets them before their base.
    for (const object of asDelta) {
      const delta = makeDelta(base.data, object.data);
      push(entryHeader(7, delta.length), Buffer.from(base.id, 'hex'), deflateSync(delta));
    }
    whole(base);
  }
  for (const object of others) whole(object);

  const header = Buffer.alloc(12);
  header.write('PACK');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);

  const body = Buffer.concat([header, ...parts]);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

interface Repository {
  refs: Map<string, string>;
  /** The objects that each advertised id needs, by that id. */
  packs: Map<string, GitObject[]>;
}

/** Build the tree of a flat `path -> content` map, returning every object in it. */
function buildTree(files: Record<string, string>): { root: GitObject; objects: GitObject[] } {
  const objects: GitObject[] = [];

  const build = (entries: [string, string][]): GitObject => {
    const here = new Map<string, { mode: string; id: string }>();
    const folders = new Map<string, [string, string][]>();

    for (const [filePath, content] of entries) {
      const slash = filePath.indexOf('/');
      if (slash < 0) {
        const blob = makeObject('blob', Buffer.from(content));
        objects.push(blob);
        here.set(filePath, { mode: '100644', id: blob.id });
        continue;
      }
      const folder = filePath.slice(0, slash);
      folders.set(folder, [...(folders.get(folder) ?? []), [filePath.slice(slash + 1), content]]);
    }
    for (const [folder, inner] of folders) {
      here.set(folder, { mode: '40000', id: build(inner).id });
    }

    const data = Buffer.concat(
      [...here.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, entry]) =>
          Buffer.concat([Buffer.from(`${entry.mode} ${name}\0`), Buffer.from(entry.id, 'hex')]),
        ),
    );
    const tree = makeObject('tree', data);
    objects.push(tree);
    return tree;
  };

  return { root: build(Object.entries(files)), objects };
}

export class FakeGitHost {
  /** Every request received, in order. */
  readonly requests: SeenRequest[] = [];
  private readonly repositories = new Map<string, Repository>();
  private serial = 0;

  constructor(private readonly options: HostOptions = {}) {}

  /** Requests that asked for a pack -- one for each download. */
  get downloads(): number {
    return this.requests.filter((seen) => seen.method === 'POST').length;
  }

  private repository(url: string): Repository {
    let repository = this.repositories.get(url);
    if (!repository) {
      repository = { refs: new Map(), packs: new Map() };
      this.repositories.set(url, repository);
    }
    return repository;
  }

  /**
   * Put a commit with exactly these files on a branch, replacing what the
   * branch had. `HEAD` follows `main`. Returns the commit id.
   */
  commit(url: string, files: Record<string, string>, branch = 'main'): string {
    const repository = this.repository(url);
    const { root, objects } = buildTree(files);
    this.serial += 1;
    const commit = makeObject(
      'commit',
      Buffer.from(
        `tree ${root.id}\nauthor T <t@example.com> ${this.serial} +0000\n` +
          `committer T <t@example.com> ${this.serial} +0000\n\ncommit ${this.serial}\n`,
      ),
    );

    repository.packs.set(commit.id, [commit, ...objects]);
    repository.refs.set(`refs/heads/${branch}`, commit.id);
    if (branch === 'main') repository.refs.set('HEAD', commit.id);
    return commit.id;
  }

  /** An annotated tag on a commit that `commit` returned. */
  tag(url: string, name: string, commitId: string): void {
    const repository = this.repository(url);
    const tag = makeObject(
      'tag',
      Buffer.from(`object ${commitId}\ntype commit\ntag ${name}\ntagger T <t@example.com> 0 +0000\n\n${name}\n`),
    );
    repository.refs.set(`refs/tags/${name}`, tag.id);
    repository.refs.set(`refs/tags/${name}^{}`, commitId);
  }

  /** Put any objects behind an id, for the tests of malformed repositories. */
  raw(url: string, ref: string, id: string, objects: GitObject[]): void {
    const repository = this.repository(url);
    repository.packs.set(id, objects);
    repository.refs.set(ref, id);
    repository.refs.set('HEAD', id);
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const headers = new Headers(init?.headers);
    const authorization = headers.get('authorization') ?? undefined;
    const method = init?.method ?? 'GET';
    this.requests.push({ method, url: url.href, ...(authorization ? { authorization } : {}) });

    if (this.options.token) {
      const password = Buffer.from((authorization ?? '').replace(/^Basic /, ''), 'base64')
        .toString()
        .split(':')[1];
      if (password !== this.options.token) return new Response('sign in', { status: 401 });
    }

    const service = /^(.*)\/(info\/refs|git-upload-pack)$/.exec(url.origin + url.pathname);
    const repository = service ? this.repositories.get(service[1] as string) : undefined;
    if (!service || !repository) return new Response('not found', { status: 404 });

    if (service[2] === 'info/refs') {
      return new Response(this.advertise(repository), {
        headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
      });
    }

    const body = Buffer.from(init?.body as Uint8Array).toString('latin1');
    const want = /want ([0-9a-f]{40})/.exec(body)?.[1] ?? '';
    const objects = repository.packs.get(want);
    if (!objects) {
      return new Response(pkt(`ERR upload-pack: not our ref ${want}`), {
        headers: { 'content-type': 'application/x-git-upload-pack-result' },
      });
    }

    const pack = makePack(objects, this.options.deltas);
    const parts: Buffer[] = [];
    if (body.includes('deepen 1')) parts.push(pkt(`shallow ${want}\n`), FLUSH);
    parts.push(pkt('NAK\n'));

    if (this.options.sideBand === false) parts.push(pack);
    else {
      parts.push(pkt(Buffer.concat([Buffer.from([2]), Buffer.from('Counting objects\n')])));
      // Small packets, so a pack always spans several of them.
      for (let from = 0; from < pack.length; from += 1000) {
        parts.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(from, from + 1000)])));
      }
      parts.push(FLUSH);
    }

    return new Response(Buffer.concat(parts), {
      headers: { 'content-type': 'application/x-git-upload-pack-result' },
    });
  };

  private advertise(repository: Repository): Buffer {
    const capabilities = [
      'multi_ack_detailed',
      'ofs-delta',
      'shallow',
      'no-progress',
      ...(this.options.sideBand === false ? [] : ['side-band-64k']),
      'symref=HEAD:refs/heads/main',
      'agent=git/fake',
    ].join(' ');

    const lines = [...repository.refs.entries()].sort(([a], [b]) =>
      a === 'HEAD' ? -1 : b === 'HEAD' ? 1 : a < b ? -1 : 1,
    );
    const packets = lines.map(([name, id], index) =>
      pkt(index === 0 ? `${id} ${name}\0${capabilities}\n` : `${id} ${name}\n`),
    );

    return Buffer.concat([pkt('# service=git-upload-pack\n'), FLUSH, ...packets, FLUSH]);
  }
}

/** A blob, tree or commit made by hand, for `FakeGitHost.raw`. */
export { makeObject };
