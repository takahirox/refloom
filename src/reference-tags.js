export const MAX_REFERENCE_TAGS = 20;
export const MAX_REFERENCE_TAG_LENGTH = 64;
export const BUILT_IN_REFERENCE_TAGS = Object.freeze([
  'branding',
  'editorial',
  'illustration',
  'motion',
  'photography',
  'typography',
  'web-3d',
  'web-design'
]);

const codePointLength = value => [...value].length;

export function normalizeReferenceTag(value) {
  if (typeof value !== 'string') throw new TypeError('Reference tags must be strings');
  const normalized = value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s\p{Dash_Punctuation}_]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  if (normalized === '') throw new TypeError('Reference tags must not be empty');
  if (codePointLength(normalized) > MAX_REFERENCE_TAG_LENGTH) {
    throw new TypeError(`Reference tags must be at most ${MAX_REFERENCE_TAG_LENGTH} characters`);
  }
  return normalized;
}

export function normalizeReferenceTags(tags) {
  if (tags === undefined) return [];
  if (!Array.isArray(tags)) throw new TypeError('Reference tags must be an array');
  if (tags.length > MAX_REFERENCE_TAGS) throw new TypeError(`References may have at most ${MAX_REFERENCE_TAGS} tags`);
  const normalized = [];
  const seen = new Set();
  for (const value of tags) {
    const tag = normalizeReferenceTag(value);
    if (seen.has(tag)) continue;
    seen.add(tag);
    normalized.push(tag);
  }
  return normalized;
}

export function isCanonicalReferenceTags(tags) {
  if (!Array.isArray(tags)) return false;
  try {
    const normalized = normalizeReferenceTags(tags);
    return normalized.length === tags.length
      && normalized.every((tag, index) => tag === tags[index]);
  } catch {
    return false;
  }
}
