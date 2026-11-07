/** Minimal store-only ZIP writer (no compression) plus the shared CRC-32. */
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
const encoder = new TextEncoder();

/** CRC-32 (ISO-HDLC) of one or more byte arrays, as used by ZIP and PNG. */
export function crc32(...parts) {
  let crc = 0xffffffff;
  for (const bytes of parts) for (let i = 0; i < bytes.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

/** Text or bytes as a Uint8Array. */
export const toBytes = (data) => typeof data === 'string' ? encoder.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);

function dosTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Build a ZIP archive from [{name, data}] where data is a string or bytes. Names are stored as UTF-8. */
export function createZip(entries, date = new Date()) {
  const { time, date: day } = dosTime(date);
  const names = new Set();
  const files = entries.map(({ name, data }) => {
    if (!name || name.length > 255 || names.has(name)) throw new Error(`ZIP entry names must be unique: ${name}`);
    names.add(name);
    const bytes = toBytes(data);
    return { name: encoder.encode(name), bytes, crc: crc32(bytes) };
  });
  const size = files.reduce((n, f) => n + 30 + f.name.length + f.bytes.length + 46 + f.name.length, 22);
  if (size > 0xffffffff) throw new Error('This export is too large for a ZIP file.');
  const out = new Uint8Array(size), view = new DataView(out.buffer);
  let offset = 0;
  const header = (signature, file, central, localOffset) => {
    view.setUint32(offset, signature, true); offset += 4;
    if (central) { view.setUint16(offset, 20, true); offset += 2; }
    for (const value of [20, 0x0800, 0, time, day]) { view.setUint16(offset, value, true); offset += 2; }
    for (const value of [file.crc, file.bytes.length, file.bytes.length]) { view.setUint32(offset, value, true); offset += 4; }
    view.setUint16(offset, file.name.length, true); view.setUint16(offset + 2, 0, true); offset += 4;
    if (central) {
      for (const value of [0, 0, 0]) { view.setUint16(offset, value, true); offset += 2; }
      view.setUint32(offset, 0, true); view.setUint32(offset + 4, localOffset, true); offset += 8;
    }
    out.set(file.name, offset); offset += file.name.length;
  };
  for (const file of files) {
    file.offset = offset;
    header(0x04034b50, file, false);
    out.set(file.bytes, offset); offset += file.bytes.length;
  }
  const directory = offset;
  for (const file of files) header(0x02014b50, file, true, file.offset);
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 8, files.length, true); view.setUint16(offset + 10, files.length, true);
  view.setUint32(offset + 12, offset - directory, true); view.setUint32(offset + 16, directory, true);
  return out;
}

/** Read the entries of a store-only ZIP (used by tests and export verification). */
export function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('No ZIP end record.');
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  return Array.from({ length: count }, () => {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('Bad ZIP directory.');
    const method = view.getUint16(offset + 10, true), crc = view.getUint32(offset + 16, true), length = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true), extra = view.getUint16(offset + 30, true), comment = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extra + comment;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    return { name, method, crc, data: bytes.subarray(start, start + length) };
  });
}
