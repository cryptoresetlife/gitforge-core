// Git plumbing for the forge: objects, trees, commits, packfiles (read + write, deltas),
// pkt-line framing, and the smart-HTTP services (upload-pack v0/v2, receive-pack v0).
// Everything lives in memory; nothing here shells out to a git binary.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync, gunzipSync } from 'node:zlib';

export const ZERO = '0000000000000000000000000000000000000000';
export const T_COMMIT = 1;
export const T_TREE = 2;
export const T_BLOB = 3;
export const T_TAG = 4;
const TYPE_NAME = ['', 'commit', 'tree', 'blob', 'tag'];
const AGENT = 'agent=gitforge/1.0';
const EMPTY = Buffer.alloc(0);
const FLUSH = Buffer.from('0000', 'latin1');
const DELIM = Buffer.from('0001', 'latin1');
const SIDEBAND_CHUNK = 65515;
const OID_RE = /^[0-9a-f]{40}$/;

export class GitError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function typeName(code) {
  return TYPE_NAME[code] || 'blob';
}

export function hashObject(type, data) {
  const h = createHash('sha1');
  h.update(`${TYPE_NAME[type]} ${data.length}\0`, 'latin1');
  h.update(data);
  return h.digest('hex');
}

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

const HEX = '0123456789abcdef';

export function pkt(payload) {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const n = data.length + 4;
  const out = Buffer.allocUnsafe(n);
  out[0] = HEX.charCodeAt((n >> 12) & 15);
  out[1] = HEX.charCodeAt((n >> 8) & 15);
  out[2] = HEX.charCodeAt((n >> 4) & 15);
  out[3] = HEX.charCodeAt(n & 15);
  data.copy(out, 4);
  return out;
}

function hexVal(c) {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}

// Reads one pkt-line at `pos`. Returns [kind, start, end, next] where kind is 0 data, 1 flush,
// 2 delim, 3 response-end. Throws GitError on a malformed length.
function readPkt(buf, pos, out) {
  if (pos + 4 > buf.length) throw new GitError('truncated pkt-line header');
  const a = hexVal(buf[pos]);
  const b = hexVal(buf[pos + 1]);
  const c = hexVal(buf[pos + 2]);
  const d = hexVal(buf[pos + 3]);
  if (a < 0 || b < 0 || c < 0 || d < 0) throw new GitError('malformed pkt-line length');
  const len = (a << 12) | (b << 8) | (c << 4) | d;
  if (len === 0) {
    out.kind = 1;
    out.next = pos + 4;
    return;
  }
  if (len === 1) {
    out.kind = 2;
    out.next = pos + 4;
    return;
  }
  if (len === 2) {
    out.kind = 3;
    out.next = pos + 4;
    return;
  }
  if (len < 4 || pos + len > buf.length) throw new GitError('truncated pkt-line');
  out.kind = 0;
  out.start = pos + 4;
  out.end = pos + len;
  out.next = pos + len;
}

function lineOf(buf, start, end) {
  let e = end;
  if (e > start && buf[e - 1] === 10) e -= 1;
  return buf.toString('utf8', start, e);
}

function sideband(band, data) {
  const parts = [];
  for (let off = 0; off < data.length || off === 0; off += SIDEBAND_CHUNK) {
    const slice = data.subarray(off, Math.min(data.length, off + SIDEBAND_CHUNK));
    const n = slice.length + 5;
    const head = Buffer.allocUnsafe(5);
    head[0] = HEX.charCodeAt((n >> 12) & 15);
    head[1] = HEX.charCodeAt((n >> 8) & 15);
    head[2] = HEX.charCodeAt((n >> 4) & 15);
    head[3] = HEX.charCodeAt(n & 15);
    head[4] = band;
    parts.push(head, slice);
    if (data.length === 0) break;
  }
  return parts;
}

// ---------------------------------------------------------------------------------------------
// object parsing / building
// ---------------------------------------------------------------------------------------------

export function parseTree(data) {
  const entries = [];
  let pos = 0;
  const n = data.length;
  while (pos < n) {
    let sp = pos;
    while (sp < n && data[sp] !== 32) sp += 1;
    let nul = sp + 1;
    while (nul < n && data[nul] !== 0) nul += 1;
    if (nul + 21 > n) throw new GitError('corrupt tree object');
    entries.push({
      mode: data.toString('latin1', pos, sp),
      name: data.toString('utf8', sp + 1, nul),
      oid: data.toString('hex', nul + 1, nul + 21),
    });
    pos = nul + 21;
  }
  return entries;
}

function treeSortKey(entry) {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

function compareBytes(a, b) {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return Buffer.compare(x, y);
}

export function buildTree(entries) {
  const sorted = entries.slice().sort((p, q) => compareBytes(treeSortKey(p), treeSortKey(q)));
  const parts = [];
  for (const entry of sorted) {
    const mode = entry.mode === '040000' ? '40000' : entry.mode;
    parts.push(Buffer.from(`${mode} ${entry.name}\0`, 'utf8'), Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data) {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5, 45);
    else if (line.startsWith('parent ')) parents.push(line.slice(7, 47));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

// "Name <email> 1700000000 +0000" -> { name, email, ts, tz }
export function parseIdent(text) {
  const lt = text.indexOf('<');
  const gt = text.indexOf('>', lt + 1);
  if (lt < 0 || gt < 0) return { name: text.trim(), email: '', ts: 0, tz: '+0000' };
  const rest = text.slice(gt + 1).trim().split(' ');
  return {
    name: text.slice(0, lt).trim(),
    email: text.slice(lt + 1, gt),
    ts: Number(rest[0]) || 0,
    tz: rest[1] || '+0000',
  };
}

export function parseTag(data) {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7, 47);
    else if (line.startsWith('type ')) type = line.slice(5);
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message: split < 0 ? '' : text.slice(split + 2) };
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

function applyDelta(base, delta) {
  let pos = 0;
  let srcSize = 0;
  let shift = 0;
  let byte;
  do {
    byte = delta[pos++];
    srcSize += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80 && pos < delta.length);
  let dstSize = 0;
  shift = 0;
  do {
    byte = delta[pos++];
    dstSize += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80 && pos < delta.length);
  if (srcSize !== base.length) throw new GitError('delta base size mismatch');
  const out = Buffer.allocUnsafe(dstSize);
  let w = 0;
  const n = delta.length;
  while (pos < n) {
    const op = delta[pos++];
    if (op & 0x80) {
      let off = 0;
      let len = 0;
      if (op & 0x01) off = delta[pos++];
      if (op & 0x02) off |= delta[pos++] << 8;
      if (op & 0x04) off |= delta[pos++] << 16;
      if (op & 0x08) off += delta[pos++] * 0x1000000;
      if (op & 0x10) len = delta[pos++];
      if (op & 0x20) len |= delta[pos++] << 8;
      if (op & 0x40) len |= delta[pos++] << 16;
      if (len === 0) len = 0x10000;
      if (off + len > base.length || w + len > dstSize) throw new GitError('delta copy out of range');
      base.copy(out, w, off, off + len);
      w += len;
    } else if (op !== 0) {
      if (pos + op > n || w + op > dstSize) throw new GitError('delta insert out of range');
      delta.copy(out, w, pos, pos + op);
      pos += op;
      w += op;
    } else {
      throw new GitError('delta opcode 0');
    }
  }
  if (w !== dstSize) throw new GitError('delta result size mismatch');
  return out;
}

function inflateAt(buf, pos) {
  let result;
  try {
    result = inflateSync(buf.subarray(pos), { info: true });
  } catch (err) {
    throw new GitError(`pack zlib stream is corrupt: ${err.message}`);
  }
  const used = result.engine.bytesWritten;
  if (!(used > 0)) throw new GitError('pack zlib stream consumed nothing');
  return { data: result.buffer, next: pos + used };
}

// Parses a packfile. `lookup(oid)` resolves ref-delta bases that are not in the pack (thin packs).
// Returns [{ oid, t, d, z }] with z the original zlib bytes for undeltified entries (reused when
// the object is served again).
export function readPack(buf, lookup) {
  if (buf.length < 32 || buf[0] !== 0x50 || buf[1] !== 0x41 || buf[2] !== 0x43 || buf[3] !== 0x4b) {
    throw new GitError('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new GitError(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const body = buf.length - 20;
  const sum = createHash('sha1').update(buf.subarray(0, body)).digest();
  if (sum.compare(buf, body, body + 20) !== 0) throw new GitError('pack checksum mismatch');
  const out = [];
  const byOffset = new Map();
  const byOid = new Map();
  const pending = [];
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    const start = pos;
    if (pos >= body) throw new GitError('pack is truncated');
    let byte = buf[pos++];
    const type = (byte >> 4) & 7;
    let size = byte & 15;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[pos++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (type >= 1 && type <= 4) {
      const inflated = inflateAt(buf, pos);
      if (inflated.data.length !== size) throw new GitError('pack entry size mismatch');
      const entry = { oid: hashObject(type, inflated.data), t: type, d: inflated.data, z: buf.subarray(pos, inflated.next) };
      pos = inflated.next;
      byOffset.set(start, entry);
      byOid.set(entry.oid, entry);
      out.push(entry);
    } else if (type === 6) {
      byte = buf[pos++];
      let rel = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[pos++];
        rel = (rel + 1) * 128 + (byte & 0x7f);
      }
      const inflated = inflateAt(buf, pos);
      pos = inflated.next;
      const base = byOffset.get(start - rel);
      if (base === undefined) throw new GitError('ofs-delta base is not in the pack');
      const data = applyDelta(base.d, inflated.data);
      const entry = { oid: hashObject(base.t, data), t: base.t, d: data, z: null };
      byOffset.set(start, entry);
      byOid.set(entry.oid, entry);
      out.push(entry);
    } else if (type === 7) {
      const baseOid = buf.toString('hex', pos, pos + 20);
      pos += 20;
      const inflated = inflateAt(buf, pos);
      pos = inflated.next;
      const base = byOid.get(baseOid) || (lookup ? lookup(baseOid) : undefined);
      if (base === undefined) {
        pending.push({ start, baseOid, delta: inflated.data });
      } else {
        const data = applyDelta(base.d, inflated.data);
        const entry = { oid: hashObject(base.t, data), t: base.t, d: data, z: null };
        byOffset.set(start, entry);
        byOid.set(entry.oid, entry);
        out.push(entry);
      }
    } else {
      throw new GitError(`unknown pack entry type ${type}`);
    }
  }
  // ref-deltas whose base came later in the pack
  let progress = true;
  while (pending.length > 0 && progress) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const item = pending[i];
      const base = byOid.get(item.baseOid);
      if (base === undefined) continue;
      const data = applyDelta(base.d, item.delta);
      const entry = { oid: hashObject(base.t, data), t: base.t, d: data, z: null };
      byOid.set(entry.oid, entry);
      out.push(entry);
      pending.splice(i, 1);
      progress = true;
    }
  }
  if (pending.length > 0) throw new GitError('ref-delta base is missing');
  return out;
}

function packEntryHeader(type, size) {
  const bytes = [];
  let rest = Math.floor(size / 16);
  let cur = (type << 4) | (size & 15);
  while (rest > 0) {
    bytes.push(cur | 0x80);
    cur = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(cur);
  return Buffer.from(bytes);
}

// Builds a version-2 pack of whole (undeltified) objects.
export function writePack(objects) {
  const head = Buffer.allocUnsafe(12);
  head.write('PACK', 0, 'latin1');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  const parts = [head];
  const hash = createHash('sha1');
  hash.update(head);
  for (const obj of objects) {
    if (obj.z === null || obj.z === undefined) obj.z = deflateSync(obj.d, { level: 1 });
    const eh = packEntryHeader(obj.t, obj.d.length);
    hash.update(eh);
    hash.update(obj.z);
    parts.push(eh, obj.z);
  }
  parts.push(hash.digest());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// repository
// ---------------------------------------------------------------------------------------------

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export class GitRepo {
  constructor(defaultBranch = 'main') {
    this.objects = new Map();
    this.refs = new Map();
    this.head = `refs/heads/${defaultBranch}`;
    this.commitCache = new Map();
    this.sortedRefs = null;
  }

  has(oid) {
    return this.objects.has(oid);
  }

  get(oid) {
    return this.objects.get(oid);
  }

  put(type, data, z = null) {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { t: type, d: data, z });
    return oid;
  }

  commit(oid) {
    let info = this.commitCache.get(oid);
    if (info !== undefined) return info;
    const obj = this.objects.get(oid);
    if (obj === undefined || obj.t !== T_COMMIT) return null;
    info = parseCommit(obj.d);
    this.commitCache.set(oid, info);
    return info;
  }

  tree(oid) {
    const obj = this.objects.get(oid);
    if (obj === undefined || obj.t !== T_TREE) return null;
    return parseTree(obj.d);
  }

  // Follows annotated tags down to the object they name.
  peel(oid) {
    let cur = oid;
    for (let i = 0; i < 16; i += 1) {
      const obj = this.objects.get(cur);
      if (obj === undefined) return null;
      if (obj.t !== T_TAG) return cur;
      cur = parseTag(obj.d).object;
    }
    return null;
  }

  setRef(name, oid) {
    this.refs.set(name, oid);
    this.sortedRefs = null;
  }

  deleteRef(name) {
    const had = this.refs.delete(name);
    this.sortedRefs = null;
    return had;
  }

  refList() {
    if (this.sortedRefs === null) {
      this.sortedRefs = [...this.refs].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    }
    return this.sortedRefs;
  }

  headOid() {
    return this.refs.get(this.head);
  }

  branch(name) {
    return this.refs.get(`refs/heads/${name}`);
  }

  branches() {
    const out = [];
    for (const [name, oid] of this.refList()) if (name.startsWith('refs/heads/')) out.push([name.slice(11), oid]);
    return out;
  }

  // Resolves a branch name, tag name, full ref or commit sha to a commit oid (or null).
  resolve(rev) {
    if (rev === undefined || rev === null || rev === '') {
      const oid = this.headOid();
      return oid === undefined ? null : oid;
    }
    let oid = this.refs.get(`refs/heads/${rev}`);
    if (oid === undefined) oid = this.refs.get(`refs/tags/${rev}`);
    if (oid === undefined) oid = this.refs.get(rev);
    if (oid === undefined && rev.startsWith('heads/')) oid = this.refs.get(`refs/${rev}`);
    if (oid === undefined && rev.startsWith('tags/')) oid = this.refs.get(`refs/${rev}`);
    if (oid === undefined && OID_RE.test(rev) && this.objects.has(rev)) oid = rev;
    if (oid === undefined && /^[0-9a-f]{7,39}$/.test(rev)) {
      for (const key of this.objects.keys()) {
        if (key.startsWith(rev)) {
          oid = key;
          break;
        }
      }
    }
    if (oid === undefined) return null;
    const peeled = this.peel(oid);
    if (peeled === null) return null;
    const obj = this.objects.get(peeled);
    return obj !== undefined && obj.t === T_COMMIT ? peeled : null;
  }

  // ---- trees ----

  lookupPath(treeOid, segments) {
    let cur = treeOid;
    let mode = '40000';
    for (let i = 0; i < segments.length; i += 1) {
      if (mode !== '40000') return null;
      const entries = this.tree(cur);
      if (entries === null) return null;
      let found = null;
      for (const entry of entries) {
        if (entry.name === segments[i]) {
          found = entry;
          break;
        }
      }
      if (found === null) return null;
      cur = found.oid;
      mode = found.mode;
    }
    return { oid: cur, mode };
  }

  // Returns the new tree oid after writing (blobOid) or removing (null) the file at `segments`.
  // undefined means "nothing to remove at that path"; null means the tree became empty.
  editTree(treeOid, segments, index, blobOid) {
    const entries = treeOid ? this.tree(treeOid) || [] : [];
    const name = segments[index];
    let at = -1;
    for (let i = 0; i < entries.length; i += 1) {
      if (entries[i].name === name) {
        at = i;
        break;
      }
    }
    if (index === segments.length - 1) {
      if (blobOid === null) {
        if (at < 0) return undefined;
        entries.splice(at, 1);
      } else if (at >= 0) {
        const keep = entries[at].mode === '40000' ? '100644' : entries[at].mode;
        entries[at] = { mode: keep, name, oid: blobOid };
      } else {
        entries.push({ mode: '100644', name, oid: blobOid });
      }
    } else {
      const child = at >= 0 && entries[at].mode === '40000' ? entries[at].oid : null;
      if (blobOid === null && child === null) return undefined;
      const sub = this.editTree(child, segments, index + 1, blobOid);
      if (sub === undefined) return undefined;
      if (sub === null) {
        if (at >= 0) entries.splice(at, 1);
      } else if (at >= 0) {
        entries[at] = { mode: '40000', name, oid: sub };
      } else {
        entries.push({ mode: '40000', name, oid: sub });
      }
    }
    if (entries.length === 0) return null;
    return this.put(T_TREE, buildTree(entries));
  }

  flatten(treeOid, prefix = '', out = new Map()) {
    const entries = this.tree(treeOid);
    if (entries === null) return out;
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flatten(entry.oid, path, out);
      else out.set(path, entry);
    }
    return out;
  }

  // Builds nested tree objects from a flat Map(path -> { mode, oid }).
  treeFromFlat(flat) {
    const root = { files: [], dirs: new Map() };
    for (const [path, entry] of flat) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        let next = node.dirs.get(segments[i]);
        if (next === undefined) {
          next = { files: [], dirs: new Map() };
          node.dirs.set(segments[i], next);
        }
        node = next;
      }
      node.files.push({ mode: entry.mode, name: segments[segments.length - 1], oid: entry.oid });
    }
    const write = (node) => {
      const entries = node.files.slice();
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: write(child) });
      return this.put(T_TREE, buildTree(entries));
    };
    return write(root);
  }

  emptyTree() {
    return this.put(T_TREE, EMPTY);
  }

  writeCommit({ tree, parents, message, author, committer }) {
    let text = `tree ${tree}\n`;
    for (const parent of parents) text += `parent ${parent}\n`;
    text += `author ${author}\ncommitter ${committer || author}\n\n${message}`;
    return this.put(T_COMMIT, Buffer.from(text, 'utf8'));
  }

  // ---- history ----

  isAncestor(ancestor, descendant) {
    if (ancestor === descendant) return true;
    const seen = new Set([descendant]);
    const stack = [descendant];
    while (stack.length > 0) {
      const info = this.commit(stack.pop());
      if (info === null) continue;
      for (const parent of info.parents) {
        if (parent === ancestor) return true;
        if (!seen.has(parent)) {
          seen.add(parent);
          stack.push(parent);
        }
      }
    }
    return false;
  }

  ancestors(tip) {
    const seen = new Set();
    if (!tip) return seen;
    const stack = [tip];
    seen.add(tip);
    while (stack.length > 0) {
      const info = this.commit(stack.pop());
      if (info === null) continue;
      for (const parent of info.parents) {
        if (!seen.has(parent)) {
          seen.add(parent);
          stack.push(parent);
        }
      }
    }
    return seen;
  }

  mergeBase(a, b) {
    if (!a || !b) return null;
    if (a === b) return a;
    const mine = this.ancestors(a);
    if (mine.has(b)) return b;
    const seen = new Set([b]);
    let frontier = [b];
    while (frontier.length > 0) {
      const next = [];
      for (const oid of frontier) {
        if (mine.has(oid)) return oid;
        const info = this.commit(oid);
        if (info === null) continue;
        for (const parent of info.parents) {
          if (!seen.has(parent)) {
            seen.add(parent);
            next.push(parent);
          }
        }
      }
      frontier = next;
    }
    return null;
  }

  // Commits reachable from `tip`, newest first (parents after children), up to `limit`.
  log(tip, limit = Infinity) {
    const out = [];
    const seen = new Set();
    const stack = [tip];
    while (stack.length > 0 && out.length < limit) {
      const oid = stack.pop();
      if (seen.has(oid)) continue;
      seen.add(oid);
      const info = this.commit(oid);
      if (info === null) continue;
      out.push(oid);
      for (let i = info.parents.length - 1; i >= 0; i -= 1) if (!seen.has(info.parents[i])) stack.push(info.parents[i]);
    }
    return out;
  }

  // ---- pack negotiation ----

  // Adds every tree/blob under `treeOid` to `into`, skipping anything in `skip`.
  walkTree(treeOid, into, skip) {
    if (into.has(treeOid) || (skip !== null && skip.has(treeOid))) return;
    const entries = this.tree(treeOid);
    if (entries === null) return;
    into.add(treeOid);
    for (const entry of entries) {
      if (entry.mode === '40000') this.walkTree(entry.oid, into, skip);
      else if (entry.mode !== '160000' && !into.has(entry.oid) && (skip === null || !skip.has(entry.oid)) && this.objects.has(entry.oid)) {
        into.add(entry.oid);
      }
    }
  }

  // Everything the client already holds: objects reachable from `haves`, where the parents of a
  // commit in `clientShallow` are not followed (the client does not have them).
  haveClosure(haves, clientShallow) {
    const have = new Set();
    const stack = [];
    for (const oid of haves) {
      const peeled = this.peel(oid);
      if (peeled === null) continue;
      if (peeled !== oid) have.add(oid);
      stack.push(peeled);
    }
    while (stack.length > 0) {
      const oid = stack.pop();
      if (have.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (obj === undefined) continue;
      if (obj.t === T_COMMIT) {
        have.add(oid);
        const info = this.commit(oid);
        this.walkTree(info.tree, have, null);
        if (!clientShallow.has(oid)) for (const parent of info.parents) stack.push(parent);
      } else if (obj.t === T_TREE) {
        this.walkTree(oid, have, null);
      } else {
        have.add(oid);
      }
    }
    return have;
  }

  // Chooses the objects to send for a fetch. Returns { objects, shallow, unshallow }.
  selectObjects(wants, haves, clientShallow, depth) {
    const have = haves.length > 0 ? this.haveClosure(haves, clientShallow) : new Set();
    const send = new Set();
    const order = [];
    const shallow = [];
    const unshallow = [];
    let frontier = [];
    const depthOf = new Map();
    for (const want of wants) {
      let cur = want;
      // annotated tags on the way down are sent too
      for (let i = 0; i < 16; i += 1) {
        const obj = this.objects.get(cur);
        if (obj === undefined) throw new GitError(`upload-pack: not our ref ${want}`);
        if (obj.t !== T_TAG) break;
        if (!have.has(cur) && !send.has(cur)) {
          send.add(cur);
          order.push(cur);
        }
        cur = parseTag(obj.d).object;
      }
      const obj = this.objects.get(cur);
      if (obj === undefined) throw new GitError(`upload-pack: not our ref ${want}`);
      if (obj.t === T_COMMIT) {
        if (!depthOf.has(cur)) {
          depthOf.set(cur, 1);
          frontier.push(cur);
        }
      } else if (obj.t === T_TREE) {
        this.walkTree(cur, send, have);
      } else if (!have.has(cur)) {
        send.add(cur);
      }
    }
    const commits = [];
    const limited = depth > 0;
    while (frontier.length > 0) {
      const next = [];
      for (const oid of frontier) {
        const info = this.commit(oid);
        if (info === null) continue;
        const d = depthOf.get(oid);
        const known = have.has(oid);
        if (!known) commits.push(oid);
        if (limited) {
          if (d >= depth) {
            if (info.parents.length > 0 && !clientShallow.has(oid)) shallow.push(oid);
            continue;
          }
          if (clientShallow.has(oid)) unshallow.push(oid);
        } else if (known) {
          // without a depth limit the client's own history covers everything below a have
          continue;
        }
        for (const parent of info.parents) {
          if (!depthOf.has(parent)) {
            depthOf.set(parent, d + 1);
            next.push(parent);
          }
        }
      }
      frontier = next;
    }
    const trees = new Set();
    for (const oid of commits) {
      send.add(oid);
      order.push(oid);
      this.walkTree(this.commit(oid).tree, trees, have);
    }
    const ordered = new Set(order);
    for (const oid of send) {
      if (!ordered.has(oid)) {
        ordered.add(oid);
        order.push(oid);
      }
    }
    for (const oid of trees) {
      if (!send.has(oid)) {
        send.add(oid);
        order.push(oid);
      }
    }
    const objects = [];
    for (const oid of order) {
      const obj = this.objects.get(oid);
      if (obj !== undefined) objects.push(obj);
    }
    return { objects, shallow, unshallow };
  }
}

// ---------------------------------------------------------------------------------------------
// smart HTTP: advertisements
// ---------------------------------------------------------------------------------------------

const UPLOAD_CAPS_V0 = `multi_ack_detailed multi_ack side-band-64k side-band thin-pack ofs-delta shallow no-progress include-tag allow-tip-sha1-in-want allow-reachable-sha1-in-want object-format=sha1 ${AGENT}`;
const RECEIVE_CAPS = `report-status delete-refs side-band-64k ofs-delta object-format=sha1 ${AGENT}`;
const V2_ADVERT = Buffer.concat([
  pkt('version 2\n'),
  pkt(`${AGENT}\n`),
  pkt('ls-refs=unborn\n'),
  pkt('fetch=shallow\n'),
  pkt('object-format=sha1\n'),
  FLUSH,
]);

export function advertiseUploadV2() {
  return V2_ADVERT;
}

function refAdvertLines(repo, caps, withHead, withPeeled) {
  const parts = [];
  let first = true;
  const push = (oid, name) => {
    if (first) {
      parts.push(pkt(`${oid} ${name}\0${caps}\n`));
      first = false;
    } else {
      parts.push(pkt(`${oid} ${name}\n`));
    }
  };
  if (withHead) {
    const headOid = repo.headOid();
    if (headOid !== undefined) push(headOid, 'HEAD');
  }
  for (const [name, oid] of repo.refList()) {
    push(oid, name);
    if (withPeeled) {
      const obj = repo.get(oid);
      if (obj !== undefined && obj.t === T_TAG) {
        const peeled = repo.peel(oid);
        if (peeled !== null) push(peeled, `${name}^{}`);
      }
    }
  }
  if (first) parts.push(pkt(`${ZERO} capabilities^{}\0${caps}\n`));
  parts.push(FLUSH);
  return parts;
}

export function advertiseUploadV0(repo) {
  const caps = repo.headOid() !== undefined ? `${UPLOAD_CAPS_V0} symref=HEAD:${repo.head}` : UPLOAD_CAPS_V0;
  return Buffer.concat([pkt('# service=git-upload-pack\n'), FLUSH, ...refAdvertLines(repo, caps, true, true)]);
}

export function advertiseReceive(repo) {
  return Buffer.concat([pkt('# service=git-receive-pack\n'), FLUSH, ...refAdvertLines(repo, RECEIVE_CAPS, false, false)]);
}

// ---------------------------------------------------------------------------------------------
// smart HTTP: upload-pack
// ---------------------------------------------------------------------------------------------

function packSection(objects, parts) {
  const pack = writePack(objects);
  const framed = sideband(1, pack);
  for (const part of framed) parts.push(part);
}

function lsRefs(repo, args) {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice(11));
  }
  const keep = (name) => {
    if (prefixes.length === 0) return true;
    for (const prefix of prefixes) if (name.startsWith(prefix)) return true;
    return false;
  };
  const parts = [];
  if (keep('HEAD')) {
    const headOid = repo.headOid();
    if (headOid !== undefined) parts.push(pkt(`${headOid} HEAD${symrefs ? ` symref-target:${repo.head}` : ''}\n`));
    else if (unborn) parts.push(pkt(`unborn HEAD${symrefs ? ` symref-target:${repo.head}` : ''}\n`));
  }
  for (const [name, oid] of repo.refList()) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const obj = repo.get(oid);
      if (obj !== undefined && obj.t === T_TAG) {
        const peeled = repo.peel(oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    parts.push(pkt(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function fetchV2(repo, args) {
  const wants = [];
  const haves = [];
  const clientShallow = new Set();
  let depth = 0;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5, 45));
    else if (arg.startsWith('have ')) haves.push(arg.slice(5, 45));
    else if (arg.startsWith('shallow ')) clientShallow.add(arg.slice(8, 48));
    else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7)) || 0;
    else if (arg === 'done') done = true;
    else if (arg.startsWith('want-ref ')) {
      const oid = repo.refs.get(arg.slice(9));
      if (oid === undefined) throw new GitError(`unknown ref ${arg.slice(9)}`);
      wants.push(oid);
    }
  }
  const parts = [];
  if (wants.length === 0) {
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  const known = haves.filter((oid) => repo.has(oid));
  if (!done) {
    parts.push(pkt('acknowledgments\n'));
    if (known.length === 0) parts.push(pkt('NAK\n'));
    else for (const oid of known) parts.push(pkt(`ACK ${oid}\n`));
    parts.push(pkt('ready\n'), DELIM);
  }
  const selected = repo.selectObjects(wants, known, clientShallow, depth);
  if (selected.shallow.length > 0 || selected.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of selected.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of selected.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  parts.push(pkt('packfile\n'));
  packSection(selected.objects, parts);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function uploadPackV2(repo, body) {
  const cur = { kind: 0, start: 0, end: 0, next: 0 };
  let pos = 0;
  let command = '';
  const args = [];
  let inArgs = false;
  let sawAny = false;
  while (pos < body.length) {
    readPkt(body, pos, cur);
    pos = cur.next;
    sawAny = true;
    if (cur.kind === 1) break;
    if (cur.kind === 2) {
      inArgs = true;
      continue;
    }
    if (cur.kind !== 0) continue;
    const line = lineOf(body, cur.start, cur.end);
    if (inArgs) args.push(line);
    else if (line.startsWith('command=')) command = line.slice(8);
  }
  if (!sawAny) throw new GitError('empty upload-pack request');
  if (command === 'ls-refs') return lsRefs(repo, args);
  if (command === 'fetch') return fetchV2(repo, args);
  throw new GitError(`unknown upload-pack command ${JSON.stringify(command)}`);
}

function uploadPackV0(repo, body) {
  const cur = { kind: 0, start: 0, end: 0, next: 0 };
  let pos = 0;
  const wants = [];
  const haves = [];
  const clientShallow = new Set();
  let depth = 0;
  let done = false;
  let caps = '';
  let sawAny = false;
  while (pos < body.length) {
    readPkt(body, pos, cur);
    pos = cur.next;
    sawAny = true;
    if (cur.kind !== 0) continue;
    const line = lineOf(body, cur.start, cur.end);
    if (line.startsWith('want ')) {
      wants.push(line.slice(5, 45));
      if (wants.length === 1) caps = line.slice(45);
    } else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) clientShallow.add(line.slice(8, 48));
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7)) || 0;
    else if (line === 'done') done = true;
  }
  if (!sawAny) throw new GitError('empty upload-pack request');
  const parts = [];
  if (wants.length === 0) {
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  const known = haves.filter((oid) => repo.has(oid));
  const selected = repo.selectObjects(wants, known, clientShallow, depth);
  if (depth > 0 || clientShallow.size > 0) {
    for (const oid of selected.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of selected.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  const detailed = caps.includes('multi_ack_detailed');
  if (!done) {
    if (known.length === 0) parts.push(pkt('NAK\n'));
    else if (detailed) {
      for (const oid of known) parts.push(pkt(`ACK ${oid} common\n`));
      parts.push(pkt(`ACK ${known[known.length - 1]} ready\n`), pkt('NAK\n'));
    } else parts.push(pkt(`ACK ${known[known.length - 1]}\n`));
    return Buffer.concat(parts);
  }
  if (known.length > 0) parts.push(pkt(`ACK ${known[known.length - 1]}\n`));
  else parts.push(pkt('NAK\n'));
  if (caps.includes('side-band')) {
    packSection(selected.objects, parts);
    parts.push(FLUSH);
  } else {
    parts.push(writePack(selected.objects));
  }
  return Buffer.concat(parts);
}

export function uploadPack(repo, body, v2) {
  return v2 ? uploadPackV2(repo, body) : uploadPackV0(repo, body);
}

// ---------------------------------------------------------------------------------------------
// smart HTTP: receive-pack
// ---------------------------------------------------------------------------------------------

// Applies a push. Returns { response, changed } where changed lists the refs that moved.
export function receivePack(repo, body) {
  const cur = { kind: 0, start: 0, end: 0, next: 0 };
  let pos = 0;
  const commands = [];
  let caps = '';
  let sawFlush = false;
  while (pos < body.length) {
    readPkt(body, pos, cur);
    pos = cur.next;
    if (cur.kind === 1) {
      sawFlush = true;
      break;
    }
    if (cur.kind !== 0) continue;
    let end = cur.end;
    const nul = body.indexOf(0, cur.start);
    if (nul >= 0 && nul < cur.end) {
      caps = lineOf(body, nul + 1, cur.end);
      end = nul;
    }
    const line = lineOf(body, cur.start, end);
    if (line.startsWith('shallow ')) continue;
    const oldOid = line.slice(0, 40);
    const newOid = line.slice(41, 81);
    const ref = line.slice(82);
    if (!OID_RE.test(oldOid) || !OID_RE.test(newOid) || !ref.startsWith('refs/')) throw new GitError('malformed receive-pack command');
    commands.push({ oldOid, newOid, ref });
  }
  if (!sawFlush || commands.length === 0) throw new GitError('receive-pack request has no commands');

  let unpack = 'ok';
  if (pos < body.length) {
    try {
      const entries = readPack(body.subarray(pos), (oid) => repo.get(oid));
      for (const entry of entries) {
        if (!repo.objects.has(entry.oid)) repo.objects.set(entry.oid, { t: entry.t, d: entry.d, z: entry.z });
      }
    } catch (err) {
      unpack = err instanceof GitError ? err.message : 'unpacker error';
    }
  }

  const lines = [pkt(`unpack ${unpack}\n`)];
  const changed = [];
  for (const command of commands) {
    const { ref, oldOid, newOid } = command;
    const current = repo.refs.get(ref);
    if (unpack !== 'ok') {
      lines.push(pkt(`ng ${ref} unpacker error\n`));
      continue;
    }
    if (newOid === ZERO) {
      if (current === undefined) {
        lines.push(pkt(`ng ${ref} no such ref\n`));
        continue;
      }
      repo.deleteRef(ref);
      changed.push({ ref, oldOid: current, newOid: ZERO });
      lines.push(pkt(`ok ${ref}\n`));
      continue;
    }
    if (!repo.has(newOid)) {
      lines.push(pkt(`ng ${ref} missing necessary objects\n`));
      continue;
    }
    if (current !== undefined) {
      if (current === newOid) {
        lines.push(pkt(`ok ${ref}\n`));
        continue;
      }
      const from = repo.peel(current);
      const to = repo.peel(newOid);
      const fastForward = ref.startsWith('refs/tags/')
        ? oldOid === current && from !== null && to !== null && repo.isAncestor(from, to)
        : from !== null && to !== null && repo.isAncestor(from, to);
      if (!fastForward) {
        lines.push(pkt(`ng ${ref} non-fast-forward\n`));
        continue;
      }
    }
    repo.setRef(ref, newOid);
    changed.push({ ref, oldOid: current === undefined ? ZERO : current, newOid });
    lines.push(pkt(`ok ${ref}\n`));
  }
  lines.push(FLUSH);
  const report = Buffer.concat(lines);
  let response;
  if (caps.includes('side-band-64k') || caps.includes('side-band')) {
    response = Buffer.concat([...sideband(1, report), FLUSH]);
  } else {
    response = report;
  }
  return { response, changed };
}

export function maybeGunzip(body, encoding) {
  if (encoding === 'gzip' || encoding === 'x-gzip') return gunzipSync(body);
  return body;
}
