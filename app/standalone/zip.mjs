// 零依赖 ZIP 读写:导出/导入歌单包 <库名>-qsyy.zip 用。写侧流式落盘(m4a store,
// JSON deflate),读侧整包解析(method 0/8)。不支持 ZIP64(>4GB 报错)。
import fs from 'node:fs';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
export function dosDateTime(date) {
  const d = date || new Date();
  const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1F);
  const day = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
  return { time, day };
}
// entries: [{ name, data: Buffer, deflate?: boolean }] → 流式写 zip 到 outPath
export async function zipBuildStream(entries, outPath) {
  const fd = fs.openSync(outPath, 'w');
  const central = [];
  let offset = 0;
  try {
    for (const entry of entries) {
      const nameBuf = Buffer.from(entry.name, 'utf8');
      if (nameBuf.length > 0xFFFF) throw new Error('zip entry name too long');
      const raw = entry.data;
      if (raw.length > 0xFFFFFFFF) throw new Error('单文件超过 4GB,不支持(ZIP64)');
      const useDeflate = Boolean(entry.deflate) && raw.length > 0;
      const data = useDeflate ? zlib.deflateRawSync(raw, { level: 6 }) : raw;
      if (data.length > 0xFFFFFFFF) throw new Error('压缩后超过 4GB,不支持(ZIP64)');
      const { time, day } = dosDateTime();
      const crc = crc32(raw);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034B50, 0);        // local file header signature
      local.writeUInt16LE(20, 4);                  // version needed
      local.writeUInt16LE(0x0800, 6);             // flags: UTF-8 names
      local.writeUInt16LE(useDeflate ? 8 : 0, 8); // method
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(day, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);        // compressed size
      local.writeUInt32LE(raw.length, 22);        // uncompressed size
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);                  // extra length
      fs.writeSync(fd, local);
      fs.writeSync(fd, nameBuf);
      fs.writeSync(fd, data);
      central.push({ nameBuf, crc, csize: data.length, usize: raw.length, method: useDeflate ? 8 : 0, time, day, offset });
      offset += 30 + nameBuf.length + data.length;
    }
    const cdStart = offset;
    for (const c of central) {
      const head = Buffer.alloc(46);
      head.writeUInt32LE(0x02014B50, 0);          // central directory signature
      head.writeUInt16LE(20, 4);                   // version made by
      head.writeUInt16LE(20, 6);                   // version needed
      head.writeUInt16LE(0x0800, 8);              // flags: UTF-8
      head.writeUInt16LE(c.method, 10);
      head.writeUInt16LE(c.time, 12);
      head.writeUInt16LE(c.day, 14);
      head.writeUInt32LE(c.crc, 16);
      head.writeUInt32LE(c.csize, 20);
      head.writeUInt32LE(c.usize, 24);
      head.writeUInt16LE(c.nameBuf.length, 28);
      head.writeUInt16LE(0, 30);                   // extra
      head.writeUInt16LE(0, 32);                   // comment
      head.writeUInt16LE(0, 34);                   // disk number
      head.writeUInt16LE(0, 36);                   // internal attrs
      head.writeUInt32LE(0, 38);                   // external attrs
      head.writeUInt32LE(c.offset, 42);
      fs.writeSync(fd, head);
      fs.writeSync(fd, c.nameBuf);
      offset += 46 + c.nameBuf.length;
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054B50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(offset - cdStart, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    fs.writeSync(fd, eocd);
  } finally {
    fs.closeSync(fd);
  }
}
// 整包读 zip → [{ name, data: Buffer }](store/deflate)
export function zipParse(buf) {
  const entries = [];
  // 从尾部找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xFFFF); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054B50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件(缺少 EOCD)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014B50) throw new Error('ZIP 中央目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    // local header: 30 + nameLen + extraLen → data
    if (buf.readUInt32LE(localOff) !== 0x04034B50) throw new Error('ZIP 本地头损坏');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + csize);
    let data;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else throw new Error(`不支持的 ZIP 压缩方法 ${method}`);
    if (data.length !== usize) throw new Error(`ZIP 条目 ${name} 尺寸不符`);
    entries.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
