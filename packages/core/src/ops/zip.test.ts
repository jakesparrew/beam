import { describe, expect, it } from "vitest";
import { collectBytes } from "./csv";
import { crc32, zipStore, type ZipEntry } from "./zip";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Bitwise CRC-32 (no table), independent of the implementation under test. */
function referenceCrc(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

type Read = { name: string; data: Uint8Array; flags: number; method: number };

/**
 * A reference reader with `unzip -t` semantics: finds the end record, walks the central
 * directory, checks every local header against it, recomputes each entry's CRC over its data,
 * and checks the data descriptor (signature, CRC and both sizes) that follows the data.
 */
function readZip(zip: Uint8Array): Read[] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  expect(v.getUint32(eocd, true)).toBe(0x06054b50);
  const count = v.getUint16(eocd + 10, true);
  expect(v.getUint16(eocd + 8, true)).toBe(count);
  const cdSize = v.getUint32(eocd + 12, true);
  const cdOffset = v.getUint32(eocd + 16, true);
  expect(cdOffset + cdSize).toBe(eocd);
  const out: Read[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50);
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true);
    const usize = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const localOffset = v.getUint32(p + 42, true);
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    expect(v.getUint32(localOffset, true)).toBe(0x04034b50);
    expect(v.getUint16(localOffset + 6, true)).toBe(flags);
    expect(v.getUint16(localOffset + 8, true)).toBe(method);
    const lNameLen = v.getUint16(localOffset + 26, true);
    const lExtraLen = v.getUint16(localOffset + 28, true);
    expect(dec.decode(zip.subarray(localOffset + 30, localOffset + 30 + lNameLen))).toBe(name);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    expect(csize).toBe(usize);
    const data = zip.subarray(dataStart, dataStart + csize);
    expect(referenceCrc(data), `crc of ${name}`).toBe(crc);
    if (flags & 0x08) {
      const d = dataStart + csize;
      expect(v.getUint32(d, true)).toBe(0x08074b50);
      expect(v.getUint32(d + 4, true)).toBe(crc);
      expect(v.getUint32(d + 8, true)).toBe(csize);
      expect(v.getUint32(d + 12, true)).toBe(usize);
    }
    out.push({ name, data: data.slice(), flags, method });
  }
  expect(p).toBe(eocd);
  return out;
}

async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  await Promise.resolve();
  for (const s of parts) yield enc.encode(s);
}

async function* entries(list: ZipEntry[]): AsyncIterable<ZipEntry> {
  await Promise.resolve();
  for (const e of list) yield e;
}

describe("crc32", () => {
  it("matches the standard check value and the reference over chunks", () => {
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
    const data = enc.encode("The quick brown fox jumps over the lazy dog");
    expect(crc32(data.subarray(10), crc32(data.subarray(0, 10)))).toBe(referenceCrc(data));
  });
});

describe("zipStore", () => {
  it("writes a store-only zip with data descriptors that a reference reader verifies", async () => {
    const zip = await collectBytes(
      zipStore(
        entries([
          { name: "README.txt", data: chunks("Uw gegevens\n", "Vos données\n") },
          { name: "crm/persons.csv", data: chunks("id,locale\r\n", "1,nl-BE\r\n") },
          { name: "empty.json", data: chunks() },
          { name: "données-é.json", data: chunks('{"ok":true}') },
        ]),
      ),
    );
    const read = readZip(zip);
    expect(read.map((r) => r.name)).toEqual(["README.txt", "crm/persons.csv", "empty.json", "données-é.json"]);
    expect(dec.decode(read[0]!.data)).toBe("Uw gegevens\nVos données\n");
    expect(dec.decode(read[1]!.data)).toBe("id,locale\r\n1,nl-BE\r\n");
    expect(read[2]!.data.length).toBe(0);
    for (const r of read) {
      expect(r.method).toBe(0);
      expect(r.flags & 0x08).toBe(0x08);
      expect(r.flags & 0x800).toBe(0x800);
    }
  });

  it("streams a large binary entry in many chunks", async () => {
    const big = new Uint8Array(300_000).map((_, i) => (i * 31) % 256);
    async function* pieces(): AsyncIterable<Uint8Array> {
      await Promise.resolve();
      for (let i = 0; i < big.length; i += 4096) yield big.subarray(i, i + 4096);
    }
    const zip = await collectBytes(zipStore([{ name: "part-1.bin", data: pieces() }]));
    const [only] = readZip(zip);
    expect(only!.data).toEqual(big);
  });

  it("gives the same bytes for the same input", async () => {
    const make = () => collectBytes(zipStore([{ name: "a.txt", data: chunks("x") }]));
    expect(await make()).toEqual(await make());
  });

  it("refuses unsafe and duplicate names", async () => {
    await expect(collectBytes(zipStore([{ name: "../etc/passwd", data: chunks("x") }]))).rejects.toThrow(RangeError);
    await expect(collectBytes(zipStore([{ name: "/abs", data: chunks("x") }]))).rejects.toThrow(RangeError);
    await expect(
      collectBytes(
        zipStore([
          { name: "a", data: chunks("x") },
          { name: "a", data: chunks("y") },
        ]),
      ),
    ).rejects.toThrow(/duplicate/);
  });

  it("writes an empty archive as a lone end record", async () => {
    const zip = await collectBytes(zipStore([]));
    expect(zip.length).toBe(22);
    expect(readZip(zip)).toEqual([]);
  });
});
