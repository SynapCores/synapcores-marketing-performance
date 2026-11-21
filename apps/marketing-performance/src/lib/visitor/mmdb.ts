/**
 * Minimal, dependency-free MaxMind DB (.mmdb) reader that reads the file
 * ON DEMAND with positional reads + a small page cache, instead of loading the
 * whole database into memory. The DB-IP City Lite database is ~130 MB; the
 * production box has ~2 GB of RAM shared with the engine, so a full in-memory
 * reader (mmdb-lib / maxmind) would be the single biggest allocation in the
 * app. A lookup touches ~32 tree nodes + one data record — a handful of 4 KB
 * pages, served from the OS page cache after warm-up.
 *
 * Implements the MaxMind DB format v2 spec:
 * https://maxmind.github.io/MaxMind-DB/ (search tree + data section decoder).
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { ipToBytes } from './ip';

const METADATA_MARKER = Buffer.from([0xab, 0xcd, 0xef, ...Buffer.from('MaxMind.com')]);
const PAGE = 4096;

export interface MmdbMetadata {
  node_count: number;
  record_size: number;
  ip_version: number;
  database_type: string;
  build_epoch: number;
  [k: string]: unknown;
}

/** Positional reader with an LRU page cache. Swappable with a Buffer for tests. */
interface ByteSource {
  size: number;
  read(offset: number, length: number): Buffer;
  close(): void;
}

class FileSource implements ByteSource {
  readonly size: number;
  private readonly fd: number;
  private readonly cache = new Map<number, Buffer>();
  constructor(path: string, private readonly maxPages = 1024) {
    this.fd = openSync(path, 'r');
    this.size = fstatSync(this.fd).size;
  }
  private page(n: number): Buffer {
    const hit = this.cache.get(n);
    if (hit) {
      this.cache.delete(n);
      this.cache.set(n, hit);
      return hit;
    }
    const start = n * PAGE;
    const len = Math.min(PAGE, this.size - start);
    const buf = Buffer.alloc(Math.max(0, len));
    if (len > 0) readSync(this.fd, buf, 0, len, start);
    this.cache.set(n, buf);
    if (this.cache.size > this.maxPages) this.cache.delete(this.cache.keys().next().value as number);
    return buf;
  }
  read(offset: number, length: number): Buffer {
    if (offset < 0 || offset + length > this.size) throw new RangeError('mmdb read out of bounds');
    const first = Math.floor(offset / PAGE);
    const last = Math.floor((offset + length - 1) / PAGE);
    if (first === last) {
      const p = this.page(first);
      const o = offset - first * PAGE;
      return p.subarray(o, o + length);
    }
    const out = Buffer.alloc(length);
    let w = 0;
    for (let n = first; n <= last; n++) {
      const p = this.page(n);
      const from = n === first ? offset - n * PAGE : 0;
      const to = n === last ? offset + length - n * PAGE : p.length;
      p.copy(out, w, from, to);
      w += to - from;
    }
    return out;
  }
  close() {
    closeSync(this.fd);
    this.cache.clear();
  }
}

class BufferSource implements ByteSource {
  constructor(private readonly buf: Buffer) {}
  get size() { return this.buf.length; }
  read(offset: number, length: number) {
    if (offset < 0 || offset + length > this.buf.length) throw new RangeError('mmdb read out of bounds');
    return this.buf.subarray(offset, offset + length);
  }
  close() { /* nothing */ }
}

export class MmdbReader {
  readonly metadata: MmdbMetadata;
  private readonly treeSize: number;
  private readonly dataStart: number;
  private readonly nodeBytes: number;
  private ipv4Start = -1;

  private constructor(private readonly src: ByteSource) {
    const metaStart = findMetadata(src);
    this.metadata = new Decoder(src, metaStart).decode(metaStart).value as MmdbMetadata;
    const { node_count: nc, record_size: rs } = this.metadata;
    if (![24, 28, 32].includes(rs)) throw new Error(`unsupported mmdb record size ${rs}`);
    this.nodeBytes = (rs * 2) / 8;
    this.treeSize = this.nodeBytes * nc;
    this.dataStart = this.treeSize + 16;
  }

  static open(path: string, cachePages?: number) { return new MmdbReader(new FileSource(path, cachePages)); }
  static fromBuffer(buf: Buffer) { return new MmdbReader(new BufferSource(buf)); }

  close() { this.src.close(); }

  private record(node: number, bit: 0 | 1): number {
    const b = this.src.read(node * this.nodeBytes, this.nodeBytes);
    switch (this.metadata.record_size) {
      case 24:
        return bit === 0 ? b.readUIntBE(0, 3) : b.readUIntBE(3, 3);
      case 28:
        return bit === 0
          ? ((b[3]! & 0xf0) << 20) | b.readUIntBE(0, 3)
          : ((b[3]! & 0x0f) << 24) | b.readUIntBE(4, 3);
      default:
        return bit === 0 ? b.readUInt32BE(0) : b.readUInt32BE(4);
    }
  }

  /** Node where IPv4 addresses live inside an IPv6 tree (::/96). */
  private v4Root(): number {
    if (this.ipv4Start >= 0) return this.ipv4Start;
    let node = 0;
    if (this.metadata.ip_version === 6) {
      for (let i = 0; i < 96 && node < this.metadata.node_count; i++) node = this.record(node, 0);
    }
    this.ipv4Start = node;
    return node;
  }

  /** Look up an IP; returns the decoded record (e.g. GeoIP2-City shaped) or null. */
  get<T = Record<string, unknown>>(ip: string): T | null {
    const bytes = ipToBytes(ip);
    if (!bytes) return null;
    if (bytes.length === 16 && this.metadata.ip_version === 4) return null;
    const nc = this.metadata.node_count;
    let node = bytes.length === 4 ? this.v4Root() : 0;
    const bits = bytes.length * 8;
    for (let i = 0; i < bits && node < nc; i++) {
      const bit = ((bytes[i >> 3]! >> (7 - (i & 7))) & 1) as 0 | 1;
      node = this.record(node, bit);
    }
    if (node === nc) return null; // empty
    if (node < nc) return null; // ran out of bits (malformed)
    const offset = this.treeSize + (node - nc); // = dataStart + (node - nc - 16)
    if (offset >= this.src.size) throw new Error('mmdb pointer out of range');
    return new Decoder(this.src, this.dataStart).decode(offset).value as T;
  }
}

function findMetadata(src: ByteSource): number {
  const tailLen = Math.min(src.size, 128 * 1024);
  const tail = src.read(src.size - tailLen, tailLen);
  const at = tail.lastIndexOf(METADATA_MARKER);
  if (at < 0) throw new Error('not a MaxMind DB (metadata marker missing)');
  return src.size - tailLen + at + METADATA_MARKER.length;
}

/** Data-section decoder. `base` is the absolute offset pointers are relative to. */
class Decoder {
  constructor(private readonly src: ByteSource, private readonly base: number) {}

  private u(off: number, len: number): number {
    if (len === 0) return 0;
    const b = this.src.read(off, len);
    let n = 0;
    for (const x of b) n = n * 256 + x;
    return n;
  }

  decode(off: number): { value: unknown; next: number } {
    const ctrl = this.u(off, 1);
    off += 1;
    let type = ctrl >> 5;
    if (type === 1) {
      // pointer
      const ss = (ctrl >> 3) & 3;
      const vvv = ctrl & 7;
      let p: number;
      if (ss === 0) { p = (vvv << 8) | this.u(off, 1); off += 1; }
      else if (ss === 1) { p = ((vvv << 16) | this.u(off, 2)) + 2048; off += 2; }
      else if (ss === 2) { p = vvv * 2 ** 24 + this.u(off, 3) + 526336; off += 3; }
      else { p = this.u(off, 4); off += 4; }
      return { value: this.decode(this.base + p).value, next: off };
    }
    if (type === 0) { type = 7 + this.u(off, 1); off += 1; }
    let size = ctrl & 0x1f;
    if (size === 29) { size = 29 + this.u(off, 1); off += 1; }
    else if (size === 30) { size = 285 + this.u(off, 2); off += 2; }
    else if (size === 31) { size = 65821 + this.u(off, 3); off += 3; }

    switch (type) {
      case 2: return { value: this.src.read(off, size).toString('utf8'), next: off + size };
      case 3: return { value: this.src.read(off, 8).readDoubleBE(0), next: off + 8 };
      case 4: return { value: Buffer.from(this.src.read(off, size)), next: off + size };
      case 5: case 6: case 9: case 10:
        return { value: size <= 6 ? this.u(off, size) : Number(BigInt('0x' + (this.src.read(off, size).toString('hex') || '0'))), next: off + size };
      case 8: {
        const v = this.u(off, size);
        return { value: size === 4 ? v | 0 : v, next: off + size };
      }
      case 7: {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < size; i++) {
          const k = this.decode(off);
          const v = this.decode(k.next);
          obj[String(k.value)] = v.value;
          off = v.next;
        }
        return { value: obj, next: off };
      }
      case 11: {
        const arr: unknown[] = [];
        for (let i = 0; i < size; i++) {
          const v = this.decode(off);
          arr.push(v.value);
          off = v.next;
        }
        return { value: arr, next: off };
      }
      case 14: return { value: size !== 0, next: off };
      case 15: return { value: this.src.read(off, 4).readFloatBE(0), next: off + 4 };
      default: throw new Error(`mmdb: unsupported data type ${type}`);
    }
  }
}
