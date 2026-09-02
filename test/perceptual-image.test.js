import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import {
  PERCEPTUAL_METRIC_VERSION,
  perceptualChangeScore,
  perceptualSignature,
} from '../src/perceptual-image.js';

const INVALID = 'Invalid perceptual PNG input';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  body.copy(output, 4);
  output.writeUInt32BE(crc32(body), output.length - 4);
  return output;
}

function pngFromRaw({
  width, height, colorType, raw, level = 6, idatSize = Infinity,
  bitDepth = 8, interlace = 0, compressed, beforeIdat = [],
}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = interlace;
  const packed = compressed ?? deflateSync(raw, { level });
  const pieces = [];
  const size = Math.max(1, idatSize);
  for (let offset = 0; offset < packed.length; offset += size) {
    pieces.push(packed.subarray(offset, offset + size));
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    ...beforeIdat,
    ...pieces.map((piece) => chunk('IDAT', piece)),
    chunk('IEND'),
  ]);
}

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

function encodePng(width, height, colorType, pixel, options = {}) {
  const channels = CHANNELS[colorType];
  const rows = [];
  let previous = Buffer.alloc(width * channels);
  for (let y = 0; y < height; y += 1) {
    const current = Buffer.alloc(width * channels);
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue, alpha = 255] = pixel(x, y);
      const values = colorType === 0 ? [red] : colorType === 2 ? [red, green, blue] :
        colorType === 4 ? [red, alpha] : [red, green, blue, alpha];
      values.forEach((value, index) => { current[x * channels + index] = value; });
    }
    const filter = Array.isArray(options.filters) ? options.filters[y] : options.filters ?? 0;
    const filtered = Buffer.alloc(current.length + 1);
    filtered[0] = filter;
    for (let byte = 0; byte < current.length; byte += 1) {
      const left = byte >= channels ? current[byte - channels] : 0;
      const up = previous[byte];
      const upperLeft = byte >= channels ? previous[byte - channels] : 0;
      let prediction = 0;
      if (filter === 1) prediction = left;
      else if (filter === 2) prediction = up;
      else if (filter === 3) prediction = Math.floor((left + up) / 2);
      else if (filter === 4) prediction = paeth(left, up, upperLeft);
      filtered[byte + 1] = (current[byte] - prediction) & 255;
    }
    rows.push(filtered);
    previous = current;
  }
  return pngFromRaw({ width, height, colorType, raw: Buffer.concat(rows), ...options });
}

function asBase64(buffer) {
  return buffer.toString('base64');
}

function assertInvalid(fn) {
  assert.throws(fn, (error) => {
    assert.equal(Object.getPrototypeOf(error), TypeError.prototype);
    assert.equal(error.message, INVALID);
    return true;
  });
}

function scene(x, y) {
  return [(x * 5 + y * 3) & 255, (x * 2 + y * 7) & 255,
    (x * 11 + y) & 255, 255];
}

test('exports a bounded frozen plain perceptual-grid-v1 signature', () => {
  const image = encodePng(20, 18, 6, (x, y) => {
    const value = (x * 31 + y * 47) & 255;
    return [value, value, value, 255];
  });
  const signature = perceptualSignature(asBase64(image));
  assert.equal(PERCEPTUAL_METRIC_VERSION, 'perceptual-grid-v1');
  assert.equal(Object.getPrototypeOf(signature), Object.prototype);
  assert.ok(Object.isFrozen(signature));
  assert.ok(Object.isFrozen(signature.samples));
  assert.deepEqual([signature.gridWidth, signature.gridHeight], [16, 16]);
  assert.ok(signature.samples.length <= 768);
  assert.equal(signature.samples.length, signature.gridWidth * signature.gridHeight * 3);
});

test('pixel identity ignores compression level and IDAT boundaries', () => {
  const pixel = (x, y) => {
    const value = (x * 17 + y * 29) & 255;
    return [value, 255 - value, (value * 3) & 255, 255];
  };
  const first = asBase64(encodePng(24, 19, 6, pixel, { level: 0 }));
  const second = asBase64(encodePng(24, 19, 6, pixel, { level: 9, idatSize: 3 }));
  assert.deepEqual(perceptualSignature(first), perceptualSignature(second));
  assert.equal(perceptualChangeScore(first, second), 0);
});

test('filters 0 through 4 and supported color types preserve intended pixels', () => {
  const pixel = (x, y) => {
    const value = (x * 23 + y * 41) & 255;
    return [value, value, value, 255];
  };
  const expected = perceptualSignature(asBase64(encodePng(9, 7, 6, pixel)));
  for (const colorType of [0, 2, 4, 6]) {
    for (const filter of [0, 1, 2, 3, 4]) {
      const actual = perceptualSignature(asBase64(
        encodePng(9, 7, colorType, pixel, { filters: filter }),
      ));
      assert.deepEqual(actual, expected);
    }
  }
});

test('tiny distributed noise stays below the perceptual threshold', () => {
  const base = asBase64(encodePng(32, 32, 2, scene));
  const noisy = asBase64(encodePng(32, 32, 2, (x, y) => {
    const color = scene(x, y);
    const delta = (x + y) % 2 ? 3 : -3;
    return color.map((value) => Math.max(0, Math.min(255, value + delta)));
  }));
  assert.ok(perceptualChangeScore(base, noisy) < 0.015);
});

test('a local HUD change scores below a full scene and color change', () => {
  const base = asBase64(encodePng(64, 48, 2, scene));
  const hud = asBase64(encodePng(64, 48, 2, (x, y) => {
    if (x < 12 && y < 6) return [255, 255, 255, 255];
    return scene(x, y);
  }));
  const full = asBase64(encodePng(64, 48, 2, (x, y) => {
    const color = scene(63 - x, 47 - y);
    return color.map((value, index) => index === 3 ? value : 255 - value);
  }));
  const hudScore = perceptualChangeScore(base, hud);
  const fullScore = perceptualChangeScore(base, full);
  assert.ok(hudScore < fullScore);
  assert.ok(fullScore > 0.15);
  assert.ok(fullScore > hudScore * 4);
});

test('scores repeat deterministically and remain in the unit interval', () => {
  const first = asBase64(encodePng(27, 21, 6, scene));
  const second = asBase64(encodePng(27, 21, 6, (x, y) => scene(y + 7, x + 3)));
  const scores = Array.from({ length: 5 }, () => perceptualChangeScore(first, second));
  assert.deepEqual(scores, Array(5).fill(scores[0]));
  for (const score of scores) {
    assert.ok(score >= 0 && score <= 1);
  }
  assert.equal(perceptualChangeScore(first, first), 0);
});

test('alpha composites deterministically onto the metric background', () => {
  const translucent = (x, y) => [
    (x * 31 + y * 7) & 255,
    (x * 13 + y * 19) & 255,
    (x * 3 + y * 43) & 255,
    (x * 17 + y * 23) & 255,
  ];
  const flattened = (x, y) => {
    const color = translucent(x, y);
    const alpha = color[3];
    const mix = (value) => Math.floor((value * alpha + 128 * (255 - alpha) + 127) / 255);
    return [mix(color[0]), mix(color[1]), mix(color[2]), 255];
  };
  const alphaPng = asBase64(encodePng(17, 13, 6, translucent));
  const rgbPng = asBase64(encodePng(17, 13, 2, flattened));
  assert.deepEqual(perceptualSignature(alphaPng), perceptualSignature(rgbPng));
  const scores = Array.from(
    { length: 4 }, () => perceptualChangeScore(alphaPng, rgbPng),
  );
  assert.deepEqual(scores, [0, 0, 0, 0]);
});

test('malformed PNG forms reject with the exact public TypeError', () => {
  const good = encodePng(1, 1, 6, () => [10, 20, 30, 255]);
  const decoded = Buffer.from(good);
  const badSignature = Buffer.from(decoded);
  badSignature[0] ^= 1;
  const badCrc = Buffer.from(decoded);
  badCrc[badCrc.length - 1] ^= 1;
  const raw = Buffer.from([0, 10, 20, 30, 255]);
  const compressed = deflateSync(raw);
  const malformed = [
    7,
    '$not-base64$',
    asBase64(badSignature),
    asBase64(badCrc),
    asBase64(decoded.subarray(0, decoded.length - 1)),
    asBase64(pngFromRaw({
      width: 1, height: 1, colorType: 6, raw: Buffer.from([5, 10, 20, 30, 255]),
    })),
    asBase64(pngFromRaw({
      width: 1, height: 1, colorType: 6, raw, interlace: 1,
    })),
    asBase64(pngFromRaw({
      width: 1, height: 1, colorType: 3, raw: Buffer.from([0, 0]),
    })),
    asBase64(pngFromRaw({
      width: 1, height: 1, colorType: 6, raw, bitDepth: 16,
    })),
    asBase64(pngFromRaw({
      width: 1, height: 1, colorType: 6, raw,
      beforeIdat: [chunk('ABCD')],
    })),
    asBase64(pngFromRaw({
      width: 1, height: 1, colorType: 6, raw,
      compressed: compressed.subarray(0, compressed.length - 1),
    })),
    asBase64(pngFromRaw({
      width: 1, height: 1, colorType: 6, raw,
      compressed: Buffer.concat([compressed, Buffer.from([0])]),
    })),
  ];
  for (const input of malformed) {
    assertInvalid(() => perceptualSignature(input));
  }
});

test('dimension, pixel, compressed, inflated, and limit-object bounds reject', () => {
  const valid = asBase64(encodePng(2, 2, 6, scene));
  const bytes = Buffer.from(valid, 'base64').length;
  const overDimension = asBase64(pngFromRaw({
    width: 16385, height: 1, colorType: 0, raw: Buffer.from([0, 0]),
  }));
  const overPixels = asBase64(pngFromRaw({
    width: 10000, height: 4001, colorType: 0, raw: Buffer.from([0, 0]),
  }));
  assertInvalid(() => perceptualSignature(overDimension));
  assertInvalid(() => perceptualSignature(overPixels));
  assertInvalid(() => {
    perceptualSignature(valid, { maxCompressedBytes: bytes - 1 });
  });
  assertInvalid(() => {
    perceptualSignature(valid, { maxInflatedBytes: 17 });
  });
  const invalidLimits = [
    null, [], new Date(), { unexpected: 1 },
    { maxWidth: 0 }, { gridWidth: 17 }, { maxPixels: 1.5 },
  ];
  for (const limits of invalidLimits) {
    assertInvalid(() => perceptualSignature(valid, limits));
  }
});
