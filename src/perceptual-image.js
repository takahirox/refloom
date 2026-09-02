import { inflateSync } from 'node:zlib';
export const PERCEPTUAL_METRIC_VERSION = 'perceptual-grid-v1';
const ERROR = 'Invalid perceptual PNG input';
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const DEFAULTS = Object.freeze({
  maxCompressedBytes: 25 * 1024 * 1024, maxWidth: 16384, maxHeight: 16384,
  maxPixels: 40_000_000, maxInflatedBytes: 160 * 1024 * 1024,
  gridWidth: 16, gridHeight: 16,
});
const MAXIMUMS = DEFAULTS;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let crc = n;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  CRC_TABLE[n] = crc >>> 0;
}
function invalid() {
  throw new TypeError(ERROR);
}
function resolveLimits(value) {
  if (value === undefined) return DEFAULTS;
  if (value === null || typeof value !== 'object') invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Object.keys(DEFAULTS);
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid();
  const result = {};
  for (const key of keys) {
    const number = value[key] === undefined ? DEFAULTS[key] : value[key];
    if (!Number.isSafeInteger(number) || number < 1 || number > MAXIMUMS[key]) invalid();
    result[key] = number;
  }
  return result;
}
function readBase64(value, limits) {
  if (typeof value !== 'string' ||
      value.length > 4 * Math.ceil(limits.maxCompressedBytes / 3) ||
      !BASE64.test(value)) invalid();
  const png = Buffer.from(value, 'base64');
  if (png.length > limits.maxCompressedBytes || png.toString('base64') !== value ||
      png.length < 8 || !png.subarray(0, 8).equals(SIGNATURE)) invalid();
  return png;
}
function crc32(buffer, start, end) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 255] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function validChunkName(buffer, start) {
  for (let index = start; index < start + 4; index += 1) {
    const byte = buffer[index];
    if (!((byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122))) return false;
  }
  return (buffer[start + 2] & 32) === 0;
}
function parse(base64, limits) {
  const png = readBase64(base64, limits);
  const idats = [];
  let offset = 8, chunkCount = 0, idatBytes = 0;
  let width, height, colorType, bytesPerPixel;
  let header = false, data = false, dataEnded = false, end = false, palette = false;
  while (offset < png.length) {
    if (++chunkCount > 65536 || png.length - offset < 12) invalid();
    const length = png.readUInt32BE(offset);
    if (length > png.length - offset - 12) invalid();
    const typeStart = offset + 4, dataStart = offset + 8;
    const dataEnd = dataStart + length, next = dataEnd + 4;
    if (!validChunkName(png, typeStart) ||
        crc32(png, typeStart, dataEnd) !== png.readUInt32BE(dataEnd)) invalid();
    const type = png.toString('ascii', typeStart, dataStart);
    if (chunkCount === 1 && type !== 'IHDR') invalid();
    if (type === 'IHDR') {
      if (header || chunkCount !== 1 || length !== 13) invalid();
      width = png.readUInt32BE(dataStart);
      height = png.readUInt32BE(dataStart + 4);
      colorType = png[dataStart + 9];
      bytesPerPixel = colorType === 0 ? 1 : colorType === 2 ? 3 :
        colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
      if (!width || !height || width > limits.maxWidth || height > limits.maxHeight ||
          width * height > limits.maxPixels || png[dataStart + 8] !== 8 ||
          !bytesPerPixel || png[dataStart + 10] !== 0 ||
          png[dataStart + 11] !== 0 || png[dataStart + 12] !== 0) invalid();
      header = true;
    } else if (type === 'PLTE') {
      if (!header || data || palette || (colorType !== 2 && colorType !== 6) ||
          length < 3 || length > 768 || length % 3) invalid();
      palette = true;
    } else if (type === 'IDAT') {
      if (!header || dataEnded) invalid();
      idatBytes += length;
      if (idatBytes > limits.maxCompressedBytes) invalid();
      idats.push(png.subarray(dataStart, dataEnd));
      data = true;
    } else if (type === 'IEND') {
      if (!data || end || length || next !== png.length) invalid();
      end = true;
    } else {
      if ((png[typeStart] & 32) === 0) invalid();
      if (data) dataEnded = true;
    }
    offset = next;
    if (end) break;
  }
  if (!header || !data || !end || offset !== png.length) invalid();
  const stride = width * bytesPerPixel;
  const outputBytes = height * (stride + 1);
  if (!Number.isSafeInteger(outputBytes) || outputBytes > limits.maxInflatedBytes) invalid();
  let inflated;
  try {
    inflated = inflateSync(Buffer.concat(idats, idatBytes), {
      info: true, maxOutputLength: outputBytes,
    });
  } catch {
    invalid();
  }
  if (!inflated || !Buffer.isBuffer(inflated.buffer) ||
      inflated.buffer.length !== outputBytes ||
      inflated.engine.bytesWritten !== idatBytes) invalid();
  return { pixels: inflated.buffer, width, height, colorType, bytesPerPixel, stride };
}
function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
}
function quantize(value, step) {
  return Math.min(255, Math.round(value / step) * step);
}
function buildSignature(base64, limits) {
  const image = parse(base64, limits);
  const { pixels, width, height, colorType, bytesPerPixel, stride } = image;
  const gridWidth = Math.min(width, limits.gridWidth);
  const gridHeight = Math.min(height, limits.gridHeight);
  const cells = gridWidth * gridHeight;
  const sums = [new Float64Array(cells), new Float64Array(cells),
    new Float64Array(cells)];
  const counts = new Uint32Array(cells);
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1), start = row + 1;
    const previous = start - stride - 1, filter = pixels[row];
    if (filter > 4) invalid();
    for (let x = 0; x < stride; x += 1) {
      const index = start + x;
      const left = x >= bytesPerPixel ? pixels[index - bytesPerPixel] : 0;
      const up = y ? pixels[previous + x] : 0;
      const upperLeft = y && x >= bytesPerPixel ?
        pixels[previous + x - bytesPerPixel] : 0;
      let prediction = 0;
      if (filter === 1) prediction = left;
      else if (filter === 2) prediction = up;
      else if (filter === 3) prediction = Math.floor((left + up) / 2);
      else if (filter === 4) prediction = paeth(left, up, upperLeft);
      pixels[index] = (pixels[index] + prediction) & 255;
    }
    const gridY = Math.floor(y * gridHeight / height);
    for (let x = 0; x < width; x += 1) {
      const index = start + x * bytesPerPixel;
      let red = pixels[index];
      let green = colorType === 0 || colorType === 4 ? red : pixels[index + 1];
      let blue = colorType === 0 || colorType === 4 ? red : pixels[index + 2];
      const alpha = colorType === 4 ? pixels[index + 1] :
        colorType === 6 ? pixels[index + 3] : 255;
      if (alpha !== 255) {
        red = Math.floor((red * alpha + 128 * (255 - alpha) + 127) / 255);
        green = Math.floor((green * alpha + 128 * (255 - alpha) + 127) / 255);
        blue = Math.floor((blue * alpha + 128 * (255 - alpha) + 127) / 255);
      }
      const cell = gridY * gridWidth + Math.floor(x * gridWidth / width);
      sums[0][cell] += red; sums[1][cell] += green; sums[2][cell] += blue;
      counts[cell] += 1;
    }
  }
  const samples = [];
  for (let cell = 0; cell < cells; cell += 1) {
    const count = counts[cell];
    const red = Math.floor((sums[0][cell] + count / 2) / count);
    const green = Math.floor((sums[1][cell] + count / 2) / count);
    const blue = Math.floor((sums[2][cell] + count / 2) / count);
    const luminance = Math.floor((77 * red + 150 * green + 29 * blue + 128) / 256);
    const blueChroma = Math.max(0, Math.min(255,
      Math.round(128 + (-43 * red - 85 * green + 128 * blue) / 256)));
    const redChroma = Math.max(0, Math.min(255,
      Math.round(128 + (128 * red - 107 * green - 21 * blue) / 256)));
    samples.push(quantize(luminance, 8), quantize(blueChroma, 12),
      quantize(redChroma, 12));
  }
  Object.freeze(samples);
  return Object.freeze({
    version: PERCEPTUAL_METRIC_VERSION, width, height, gridWidth, gridHeight, samples,
  });
}
export function perceptualSignature(base64, limits) {
  try {
    return buildSignature(base64, resolveLimits(limits));
  } catch {
    invalid();
  }
}
function sampleOffset(signature, x, y, width, height) {
  const sourceX = Math.min(signature.gridWidth - 1,
    Math.floor((x + 0.5) * signature.gridWidth / width));
  const sourceY = Math.min(signature.gridHeight - 1,
    Math.floor((y + 0.5) * signature.gridHeight / height));
  return (sourceY * signature.gridWidth + sourceX) * 3;
}
export function perceptualChangeScore(leftBase64, rightBase64, limits) {
  try {
    const bounded = resolveLimits(limits);
    const left = buildSignature(leftBase64, bounded);
    const right = buildSignature(rightBase64, bounded);
    const width = Math.min(left.gridWidth, right.gridWidth);
    const height = Math.min(left.gridHeight, right.gridHeight);
    let difference = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const a = sampleOffset(left, x, y, width, height);
        const b = sampleOffset(right, x, y, width, height);
        const luminance = Math.max(0, Math.abs(left.samples[a] - right.samples[b]) - 8);
        const blueChroma = Math.max(0,
          Math.abs(left.samples[a + 1] - right.samples[b + 1]) - 12);
        const redChroma = Math.max(0,
          Math.abs(left.samples[a + 2] - right.samples[b + 2]) - 12);
        difference += 4 * luminance + blueChroma + redChroma;
      }
    }
    const score = difference / (width * height * 6 * 255);
    return Math.round(Math.min(1, score) * 1_000_000) / 1_000_000;
  } catch {
    invalid();
  }
}
