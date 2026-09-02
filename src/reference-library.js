import {
  BUILT_IN_REFERENCE_TAGS, MAX_REFERENCE_TAGS, normalizeReferenceTag, normalizeReferenceTags
} from './reference-tags.js';

export function addReferenceTags(current, input) {
  const tags = normalizeReferenceTags(current);
  for (const value of input.split(',')) {
    if (!value.trim()) continue;
    const tag = normalizeReferenceTag(value);
    if (tags.includes(tag)) continue;
    if (tags.length >= MAX_REFERENCE_TAGS) {
      throw new TypeError(`References may have at most ${MAX_REFERENCE_TAGS} tags`);
    }
    tags.push(tag);
  }
  return tags;
}

export function listReferenceTags(references) {
  return [...new Set(references.flatMap(reference => reference.tags))]
    .sort((left, right) => left.localeCompare(right));
}

export function listReferenceTagSuggestions(references) {
  const counts = new Map(BUILT_IN_REFERENCE_TAGS.map(tag => [tag, 0]));
  for (const reference of references) {
    for (const tag of reference.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts]
    .map(([tag, referenceCount]) => ({ tag, referenceCount }))
    .sort((left, right) => right.referenceCount - left.referenceCount
      || (left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0));
}

export function filterLibraryReferences(references, { query = '', tag = '' } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  const exactTag = tag ? normalizeReferenceTag(tag) : '';
  return references.filter(reference => {
    if (exactTag && !reference.tags.includes(exactTag)) return false;
    if (!needle) return true;
    return [reference.title, reference.sourceUrl, reference.creator, reference.notes, ...reference.tags]
      .filter(Boolean).join(' ').toLocaleLowerCase().includes(needle);
  });
}
