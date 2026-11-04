/**
 * A streaming, store-only zip writer (ops rules 55 and 60): each entry's data is streamed once,
 * its CRC-32 and size follow in a data descriptor (general purpose flag bit 3), names are UTF-8
 * (bit 11), and the central directory closes the archive. No compression (CSV parts and the
 * encrypted export are streamed straight through), no ZIP64: an archive must stay below 4 GiB
 * and 65,535 entries, far above the 9 MB export parts.
 */

const LOCAL_SIG = 0x04034b50;
const DESCRIPTOR_SIG = 0x08074b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const VERSION = 20;
const FLAGS = 0x0808;
const MAX_U32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

let crcTable: Uint32Array | undefined;

function table(): Uint32Array {
  if (crcTable) return crcTable;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  crcTable = t;
  return t;
}

/** Continues a CRC-32 (IEEE 802.3) over `data`; start with 0. */
export function crc32(data: Uint8Array, crc = 0): number {
  const t = table();
  let c = (crc ^ MAX_U32) >>> 0;
  for (let i = 0; i < data.length; i++) c = t[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ MAX_U32) >>> 0;
}

/** MS-DOS time and date of a local wall clock (the zip format has no zone). */
function dosDateTime(at: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, at.getUTCFullYear()));
  const date = ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate();
  const time = (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2);
  return { time, date };
}

type Central = { name: Uint8Array; crc: number; size: number; offset: number; time: number; date: number };

export type ZipEntry = {
  name: string;
  data: AsyncIterable<Uint8Array>;
  /** Defaults to 1980-01-01 00:00, so the same input gives the same bytes. */
  modifiedAt?: Date;
};

const DEFAULT_TIME = new Date(Date.UTC(1980, 0, 1));

function header(size: number): { bytes: Uint8Array; view: DataView } {
  const bytes = new Uint8Array(size);
  return { bytes, view: new DataView(bytes.buffer) };
}

/** Streams a store-only zip of the entries, in order. */
export async function* zipStore(entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  const central: Central[] = [];
  let offset = 0;
  const names = new Set<string>();

  for await (const entry of entries) {
    if (!entry.name || entry.name.startsWith("/") || entry.name.split("/").includes("..")) throw new RangeError(`unsafe zip entry name: ${entry.name}`);
    if (names.has(entry.name)) throw new RangeError(`duplicate zip entry name: ${entry.name}`);
    names.add(entry.name);
    if (central.length >= MAX_ENTRIES) throw new RangeError("too many zip entries (no ZIP64)");
    const name = encoder.encode(entry.name);
    const { time, date } = dosDateTime(entry.modifiedAt ?? DEFAULT_TIME);
    const local = header(30 + name.length);
    local.view.setUint32(0, LOCAL_SIG, true);
    local.view.setUint16(4, VERSION, true);
    local.view.setUint16(6, FLAGS, true);
    local.view.setUint16(8, 0, true);
    local.view.setUint16(10, time, true);
    local.view.setUint16(12, date, true);
    // crc, sizes 0: they follow in the data descriptor.
    local.view.setUint16(26, name.length, true);
    local.view.setUint16(28, 0, true);
    local.bytes.set(name, 30);
    const entryOffset = offset;
    yield local.bytes;
    offset += local.bytes.length;

    let crc = 0;
    let size = 0;
    for await (const chunk of entry.data) {
      if (!chunk.length) continue;
      crc = crc32(chunk, crc);
      size += chunk.length;
      if (size > MAX_U32) throw new RangeError("zip entry larger than 4 GiB (no ZIP64)");
      yield chunk;
    }
    offset += size;

    const desc = header(16);
    desc.view.setUint32(0, DESCRIPTOR_SIG, true);
    desc.view.setUint32(4, crc, true);
    desc.view.setUint32(8, size, true);
    desc.view.setUint32(12, size, true);
    yield desc.bytes;
    offset += 16;
    if (offset > MAX_U32) throw new RangeError("zip archive larger than 4 GiB (no ZIP64)");
    central.push({ name, crc, size, offset: entryOffset, time, date });
  }

  const cdStart = offset;
  for (const c of central) {
    const h = header(46 + c.name.length);
    h.view.setUint32(0, CENTRAL_SIG, true);
    h.view.setUint16(4, VERSION, true);
    h.view.setUint16(6, VERSION, true);
    h.view.setUint16(8, FLAGS, true);
    h.view.setUint16(10, 0, true);
    h.view.setUint16(12, c.time, true);
    h.view.setUint16(14, c.date, true);
    h.view.setUint32(16, c.crc, true);
    h.view.setUint32(20, c.size, true);
    h.view.setUint32(24, c.size, true);
    h.view.setUint16(28, c.name.length, true);
    // extra, comment, disk, internal and external attributes: 0.
    h.view.setUint32(42, c.offset, true);
    h.bytes.set(c.name, 46);
    yield h.bytes;
    offset += h.bytes.length;
  }
  const end = header(22);
  end.view.setUint32(0, END_SIG, true);
  end.view.setUint16(8, central.length, true);
  end.view.setUint16(10, central.length, true);
  end.view.setUint32(12, offset - cdStart, true);
  end.view.setUint32(16, cdStart, true);
  yield end.bytes;
}
