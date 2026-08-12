import { Buffer } from "node:buffer";
import { deflateSync } from "node:zlib";

const DIGITS = {
  0: ["111", "101", "101", "101", "111"],
  1: ["010", "110", "010", "010", "111"],
  2: ["111", "001", "111", "100", "111"],
  3: ["111", "001", "111", "001", "111"],
  4: ["101", "101", "111", "001", "001"],
  5: ["111", "100", "111", "001", "111"],
  6: ["111", "100", "111", "101", "111"],
  7: ["111", "001", "010", "010", "010"],
  8: ["111", "101", "111", "101", "111"],
  9: ["111", "101", "111", "001", "111"],
  "+": ["000", "010", "111", "010", "000"],
};

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

/** Generate a tiny self-contained PNG, avoiding Chromium's inconsistent SVG
 * data-URL rasterization on Windows taskbar overlays. */
export function windowsAttentionPng(count) {
  const size = 32;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const radius = Math.hypot(x - 15.5, y - 15.5);
      if (radius > 15.5) continue;
      const border = radius > 13.5;
      rgba.set(border ? [255, 255, 255, 255] : [37, 99, 235, 255], offset);
    }
  }
  const label = count > 99 ? "99+" : String(Math.max(1, count));
  const scale = label.length > 2 ? 2 : 3;
  const glyphWidth = 3 * scale;
  const gap = scale;
  const totalWidth = label.length * glyphWidth + (label.length - 1) * gap;
  const startX = Math.floor((size - totalWidth) / 2);
  const startY = Math.floor((size - 5 * scale) / 2);
  [...label].forEach((character, index) => {
    const glyph = DIGITS[character];
    glyph?.forEach((row, y) => {
      [...row].forEach((pixel, x) => {
        if (pixel !== "1") return;
        for (let sy = 0; sy < scale; sy += 1) {
          for (let sx = 0; sx < scale; sx += 1) {
            const px = startX + index * (glyphWidth + gap) + x * scale + sx;
            const py = startY + y * scale + sy;
            rgba.set([255, 255, 255, 255], (py * size + px) * 4);
          }
        }
      });
    });
  });

  const scanlines = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    scanlines[row] = 0;
    rgba.copy(scanlines, row + 1, y * size * 4, (y + 1) * size * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function windowsAttentionDescription(count) {
  return count === 1 ? "1 session needs attention" : `${count} sessions need attention`;
}

export function createWindowsAttentionOverlay(nativeImage, count) {
  return nativeImage.createFromBuffer(windowsAttentionPng(count));
}
