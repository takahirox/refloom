// Synthetic contract fixture, not an assertion about model quality.
export function profile(sha256) {
  return {
    schema_version: '0.3', sources: [{ id: 'reference-1', kind: 'screenshot', role: 'reference', locator: `file:sha256:${sha256}` }],
    measurements: [],
    observations: [{ id: 'o1', source_ids: ['reference-1'], category: 'layout', statement: 'The fixture has one visual region.' }],
    interpretations: [{ id: 'i1', observation_ids: ['o1'], category: 'design_tone', statement: 'The composition may feel simple.', confidence_id: 'c1' }],
    confidence: [{ id: 'c1', level: 0.5, uncertainty: 'Synthetic interpretation.', basis: 'Synthetic observation.' }],
    principles: [{ id: 'p1', observation_ids: ['o1'], interpretation_ids: ['i1'], statement: 'Consider a clear hierarchy.' }],
    recommendations: [{ id: 'r1', principle_ids: ['p1'], target_source_ids: [], action: 'Consider one focal region.', rationale: 'A clear hierarchy can help scanning.', transfer_mode: 'principle', avoid_copying: ['assets', 'branding', 'content', 'implementation'] }],
    provenance: { created_by: 'offline-contract-fixture', inputs: ['reference-1'] }
  };
}
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
