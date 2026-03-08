import { describe, it, expect } from 'vitest';
import {
  EvidencePackage,
  computeDepth,
  derivePoAScores,
  validateEvidenceGraph,
  verifyWorkEvidence,
  extractAgencySignals,
  composeScoreVector,
  composeScoreVectorWithDefaults,
  rangeFit,
  EngineeringStudioPolicy,
  WorkMandate,
  AgencySignals,
} from '../src/evidence';

function makeNode(
  id: string,
  parentIds: string[] = [],
): EvidencePackage {
  return {
    arweave_tx_id: id,
    author: '0x0000000000000000000000000000000000000001',
    timestamp: Date.now(),
    parent_ids: parentIds,
    payload_hash: '0x' + id.padStart(64, '0'),
    artifact_ids: [],
    signature: '0x' + '00'.repeat(65),
  };
}

// =============================================================================
// computeDepth
// =============================================================================

describe('computeDepth', () => {
  it('returns 0 for empty graph', () => {
    expect(computeDepth([])).toBe(0);
  });

  it('returns 1 for a single-node graph', () => {
    expect(computeDepth([makeNode('a')])).toBe(1);
  });

  it('returns 3 for a linear 3-node chain', () => {
    const evidence = [
      makeNode('a'),
      makeNode('b', ['a']),
      makeNode('c', ['b']),
    ];
    expect(computeDepth(evidence)).toBe(3);
  });

  it('returns correct depth for a fan-in DAG', () => {
    const evidence = [
      makeNode('a'),
      makeNode('b'),
      makeNode('c', ['a', 'b']),
    ];
    expect(computeDepth(evidence)).toBe(2);
  });
});

// =============================================================================
// derivePoAScores
// =============================================================================

describe('derivePoAScores', () => {
  it('returns signal-derived scores for 3 root nodes, no edges', () => {
    const evidence = [makeNode('a'), makeNode('b'), makeNode('c')];
    const scores = derivePoAScores(evidence);
    expect(scores[0]).toBe(90); // initiative: rootRatio=1.0 → soft-capped at 0.9
    expect(scores[1]).toBe(0);  // collaboration: no edges
    expect(scores[2]).toBe(33); // reasoning: depthRatio=1/3=0.333 < 0.9
    expect(scores[3]).toBe(0);
    expect(scores[4]).toBe(0);
  });

  it('options override compliance and efficiency (0..100 range)', () => {
    const evidence = [makeNode('a'), makeNode('b'), makeNode('c')];
    const scores = derivePoAScores(evidence, { compliance: 90, efficiency: 95 });
    expect(scores[3]).toBe(90);
    expect(scores[4]).toBe(95);
  });

  it('options override compliance and efficiency (0..1 range)', () => {
    const evidence = [makeNode('a'), makeNode('b'), makeNode('c')];
    const scores = derivePoAScores(evidence, { compliance: 0.85, efficiency: 0.72 });
    expect(scores[3]).toBe(85);
    expect(scores[4]).toBe(72);
  });

  it('clamps all scores to 0-100', () => {
    const evidence = [makeNode('a')];
    const scores = derivePoAScores(evidence, { compliance: 150, efficiency: -10 });
    expect(scores[3]).toBe(100);
    expect(scores[4]).toBe(0);
  });

  it('returns zeros for empty evidence with no overrides', () => {
    const scores = derivePoAScores([]);
    expect(scores).toEqual([0, 0, 0, 0, 0]);
  });

  it('returns overrides for empty evidence when provided', () => {
    const scores = derivePoAScores([], { compliance: 75, efficiency: 80 });
    expect(scores).toEqual([0, 0, 0, 75, 80]);
  });

  it('handles a linear chain correctly (soft-capped)', () => {
    const evidence = [
      makeNode('a'),
      makeNode('b', ['a']),
      makeNode('c', ['b']),
    ];
    const [initiative, collaboration, reasoning] = derivePoAScores(evidence);
    expect(initiative).toBe(33);
    expect(collaboration).toBe(90);
    expect(reasoning).toBe(90);
  });

  it('no hardcoded 75/80 placeholders anywhere', () => {
    const evidence = [makeNode('a'), makeNode('b')];
    const scores = derivePoAScores(evidence);
    // Without policy context, compliance and efficiency are 0 (not 75/80)
    expect(scores[3]).toBe(0);
    expect(scores[4]).toBe(0);
  });
});

// =============================================================================
// validateEvidenceGraph
// =============================================================================

describe('validateEvidenceGraph', () => {
  it('returns true for a valid DAG', () => {
    const evidence = [
      makeNode('a'),
      makeNode('b', ['a']),
      makeNode('c', ['a', 'b']),
    ];
    expect(validateEvidenceGraph(evidence)).toBe(true);
  });

  it('returns true for a single root node', () => {
    expect(validateEvidenceGraph([makeNode('a')])).toBe(true);
  });

  it('returns true for empty graph', () => {
    expect(validateEvidenceGraph([])).toBe(true);
  });

  it('returns false when parent_ids reference non-existent nodes', () => {
    const evidence = [makeNode('a', ['missing'])];
    expect(validateEvidenceGraph(evidence)).toBe(false);
  });

  it('returns false for cycles', () => {
    const a: EvidencePackage = { ...makeNode('a', ['c']) };
    const b: EvidencePackage = { ...makeNode('b', ['a']) };
    const c: EvidencePackage = { ...makeNode('c', ['b']) };
    expect(validateEvidenceGraph([a, b, c])).toBe(false);
  });
});

// =============================================================================
// verifyWorkEvidence
// =============================================================================

describe('verifyWorkEvidence', () => {
  it('returns valid=true and signals for valid DAG', () => {
    const evidence = [makeNode('a'), makeNode('b', ['a'])];
    const result = verifyWorkEvidence(evidence);
    expect(result.valid).toBe(true);
    expect(result.signals).toBeDefined();
    expect(result.signals!.initiativeSignal).toBeCloseTo(0.5);
    expect(result.signals!.collaborationSignal).toBeCloseTo(0.9); // soft-capped
    expect(result.signals!.reasoningSignal).toBeCloseTo(0.9);     // soft-capped
  });

  it('returns valid=false and no signals for invalid DAG', () => {
    const evidence = [makeNode('a', ['missing'])];
    const result = verifyWorkEvidence(evidence);
    expect(result.valid).toBe(false);
    expect(result.signals).toBeUndefined();
  });

  it('accepts policy context for signal extraction', () => {
    const evidence = [
      makeNode('a', [], ['src/retry.ts']),
      makeNode('b', ['a'], ['src/circuit.ts']),
      makeNode('c', ['b'], ['tests/resilience.test.ts']),
    ];
    const result = verifyWorkEvidence(evidence, { studioPolicy: DEFAULT_POLICY });
    expect(result.valid).toBe(true);
    expect(result.signals).toBeDefined();
    expect(result.signals!.complianceSignal).toBeDefined();
    expect(result.signals!.complianceSignal!).toBeGreaterThan(0);
  });

  it('verifyWorkEvidence + composeScoreVector produces full pipeline', () => {
    const evidence = [makeNode('a'), makeNode('b', ['a']), makeNode('c', ['b'])];
    const result = verifyWorkEvidence(evidence);
    expect(result.valid).toBe(true);

    const vector = composeScoreVector(result.signals!, {
      complianceScore: 85,
      efficiencyScore: 78,
    });
    expect(vector).toHaveLength(5);
    expect(vector.every(v => Number.isInteger(v) && v >= 0 && v <= 100)).toBe(true);
    expect(vector[3]).toBe(85);
    expect(vector[4]).toBe(78);
  });
});

// =============================================================================
// rangeFit
// =============================================================================

describe('rangeFit', () => {
  it('returns 1 when value equals target', () => {
    expect(rangeFit(5, 0, 5, 10)).toBe(1);
  });

  it('returns 0 when value equals min', () => {
    expect(rangeFit(0, 0, 5, 10)).toBe(0);
  });

  it('returns 0 when value equals max', () => {
    expect(rangeFit(10, 0, 5, 10)).toBe(0);
  });

  it('returns 0 when value is below min', () => {
    expect(rangeFit(-1, 0, 5, 10)).toBe(0);
  });

  it('returns 0 when value is above max', () => {
    expect(rangeFit(11, 0, 5, 10)).toBe(0);
  });

  it('returns 0.5 when value is midway between min and target', () => {
    expect(rangeFit(2.5, 0, 5, 10)).toBeCloseTo(0.5, 5);
  });

  it('returns 0.5 when value is midway between target and max', () => {
    expect(rangeFit(7.5, 0, 5, 10)).toBeCloseTo(0.5, 5);
  });

  it('clamps output to [0, 1]', () => {
    const r = rangeFit(3, 0, 5, 10);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(1);
  });
});

// =============================================================================
// extractAgencySignals
// =============================================================================

describe('extractAgencySignals', () => {
  it('returns zero signals for empty graph', () => {
    const signals = extractAgencySignals([]);
    expect(signals.initiativeSignal).toBe(0);
    expect(signals.collaborationSignal).toBe(0);
    expect(signals.reasoningSignal).toBe(0);
    expect(signals.observed.totalNodes).toBe(0);
  });

  it('returns deterministic results for identical DAGs', () => {
    const evidence = [
      makeNode('a'),
      makeNode('b', ['a']),
      makeNode('c', ['b']),
    ];
    const s1 = extractAgencySignals(evidence);
    const s2 = extractAgencySignals(evidence);
    expect(s1).toEqual(s2);
  });

  it('all signals fall in [0, 1]', () => {
    const evidence = [
      makeNode('a'),
      makeNode('b'),
      makeNode('c', ['a', 'b']),
      makeNode('d', ['c']),
    ];
    const signals = extractAgencySignals(evidence);
    expect(signals.initiativeSignal).toBeGreaterThanOrEqual(0);
    expect(signals.initiativeSignal).toBeLessThanOrEqual(1);
    expect(signals.collaborationSignal).toBeGreaterThanOrEqual(0);
    expect(signals.collaborationSignal).toBeLessThanOrEqual(1);
    expect(signals.reasoningSignal).toBeGreaterThanOrEqual(0);
    expect(signals.reasoningSignal).toBeLessThanOrEqual(1);
  });

  it('multiple roots increases initiativeSignal', () => {
    const oneRoot = [
      makeNode('a'),
      makeNode('b', ['a']),
      makeNode('c', ['b']),
    ];
    const threeRoots = [
      makeNode('a'),
      makeNode('b'),
      makeNode('c'),
    ];
    expect(extractAgencySignals(threeRoots).initiativeSignal)
      .toBeGreaterThan(extractAgencySignals(oneRoot).initiativeSignal);
  });

  it('deeper chains increase reasoningSignal', () => {
    const shallow = [
      makeNode('a'),
      makeNode('b'),
      makeNode('c'),
      makeNode('d'),
    ];
    const deep = [
      makeNode('a'),
      makeNode('b', ['a']),
      makeNode('c', ['b']),
      makeNode('d', ['c']),
    ];
    expect(extractAgencySignals(deep).reasoningSignal)
      .toBeGreaterThan(extractAgencySignals(shallow).reasoningSignal);
  });

  it('more edges increases collaborationSignal', () => {
    const fewEdges = [
      makeNode('a'),
      makeNode('b'),
      makeNode('c'),
    ];
    const manyEdges = [
      makeNode('a'),
      makeNode('b', ['a']),
      makeNode('c', ['a', 'b']),
    ];
    expect(extractAgencySignals(manyEdges).collaborationSignal)
      .toBeGreaterThan(extractAgencySignals(fewEdges).collaborationSignal);
  });

  it('correctly counts observed features for a fan-in DAG', () => {
    const evidence = [
      makeNode('a'),
      makeNode('b'),
      makeNode('c', ['a', 'b']),
    ];
    const { observed } = extractAgencySignals(evidence);
    expect(observed.totalNodes).toBe(3);
    expect(observed.rootCount).toBe(2);
    expect(observed.edgeCount).toBe(2);
    expect(observed.maxDepth).toBe(2);
    expect(observed.terminalCount).toBe(1);
    expect(observed.integrationNodeCount).toBe(1);
  });

  it('correctly counts terminal nodes in a diamond DAG', () => {
    // Diamond: a→b, a→c, d→[b,c]. Only root is 'a'.
    // d merges b and c but both trace to the same root — NOT cross-root integration.
    const evidence = [
      makeNode('a'),
      makeNode('b', ['a']),
      makeNode('c', ['a']),
      makeNode('d', ['b', 'c']),
    ];
    const { observed } = extractAgencySignals(evidence);
    expect(observed.terminalCount).toBe(1);
    expect(observed.rootCount).toBe(1);
    expect(observed.integrationNodeCount).toBe(0);
    expect(observed.edgeCount).toBe(4);
  });

  it('counts unique authors', () => {
    const evidence = [
      { ...makeNode('a'), author: '0xAAA' },
      { ...makeNode('b', ['a']), author: '0xBBB' },
      { ...makeNode('c', ['b']), author: '0xAAA' },
    ];
    const { observed } = extractAgencySignals(evidence);
    expect(observed.uniqueAuthors).toBe(2);
  });

  it('counts artifact nodes', () => {
    const withArtifacts = { ...makeNode('a'), artifact_ids: ['file1.ts', 'file2.ts'] };
    const withoutArtifacts = makeNode('b', ['a']);
    const { observed } = extractAgencySignals([withArtifacts, withoutArtifacts]);
    expect(observed.artifactCount).toBe(1);
  });

  it('computes durationMs from timestamps', () => {
    const evidence = [
      { ...makeNode('a'), timestamp: 1000 },
      { ...makeNode('b', ['a']), timestamp: 5000 },
    ];
    const { observed } = extractAgencySignals(evidence);
    expect(observed.durationMs).toBe(4000);
  });

  it('leaves compliance and efficiency undefined', () => {
    const signals = extractAgencySignals([makeNode('a')]);
    expect(signals.complianceSignal).toBeUndefined();
    expect(signals.efficiencySignal).toBeUndefined();
  });

  it('single node: initiative=0.9 (soft-capped), collaboration=0, reasoning=0.9', () => {
    const signals = extractAgencySignals([makeNode('a')]);
    expect(signals.initiativeSignal).toBeCloseTo(0.9);
    expect(signals.collaborationSignal).toBe(0);
    expect(signals.reasoningSignal).toBeCloseTo(0.9);
  });

  it('5-node linear chain: structural signals capped below 1.0', () => {
    const evidence = [
      makeNode('a'),
      makeNode('b', ['a']),
      makeNode('c', ['b']),
      makeNode('d', ['c']),
      makeNode('e', ['d']),
    ];
    const signals = extractAgencySignals(evidence);
    // Without policy, raw edgeDensity=1.0 and depthRatio=1.0 are capped at 0.9
    expect(signals.collaborationSignal).toBeLessThanOrEqual(0.9);
    expect(signals.collaborationSignal).toBeGreaterThan(0);
    expect(signals.reasoningSignal).toBeLessThanOrEqual(0.9);
    expect(signals.reasoningSignal).toBeGreaterThan(0);
    // The key: they do NOT reach 1.0
    expect(signals.collaborationSignal).toBeLessThan(1.0);
    expect(signals.reasoningSignal).toBeLessThan(1.0);
  });

  it('no-policy fallback never produces exactly 1.0 on any structural signal', () => {
    const graphs = [
      [makeNode('a')],
      [makeNode('a'), makeNode('b', ['a'])],
      [makeNode('a'), makeNode('b', ['a']), makeNode('c', ['b'])],
      [makeNode('a'), makeNode('b'), makeNode('c', ['a', 'b'])],
    ];
    for (const evidence of graphs) {
      const signals = extractAgencySignals(evidence);
      expect(signals.initiativeSignal).toBeLessThanOrEqual(0.9);
      expect(signals.collaborationSignal).toBeLessThanOrEqual(0.9);
      expect(signals.reasoningSignal).toBeLessThanOrEqual(0.9);
    }
  });

  it('fan-in DAG with policy targets produces meaningful non-zero signals', () => {
    // 5-node fan-in: 2 roots, 1 integration node, depth 3
    // rootRatio=0.4, edgeDensity=4/4=1.0, integrationRatio=1/5=0.2, depthRatio=3/5=0.6
    const evidence = [
      makeNode('a'),
      makeNode('b'),
      makeNode('c', ['a', 'b']),
      makeNode('d', ['c']),
      makeNode('e', ['d']),
    ];
    // Policy ranges chosen so observed values land near the targets
    const policy: EngineeringStudioPolicy = {
      version: '1.0',
      studioName: 'Test',
      scoring: {
        initiative: { rootRatio: { min: 0.1, target: 0.4, max: 0.8 } },
        collaboration: {
          edgeDensity: { min: 0.3, target: 0.9, max: 1.5 },
          integrationRatio: { min: 0.0, target: 0.2, max: 0.5 },
          weights: { edgeDensity: 0.6, integrationRatio: 0.4 },
        },
        reasoning: { depthRatio: { min: 0.2, target: 0.6, max: 1.0 } },
        compliance: {
          requiredChecks: [], forbiddenPatterns: [], requiredArtifacts: [],
          weights: { testsPresent: 0, requiredArtifactsPresent: 0, noPolicyViolations: 0 },
        },
        efficiency: { weights: {} },
      },
      verifierInstructions: { initiative: '', collaboration: '', reasoning: '', compliance: '', efficiency: '' },
    };
    const signals = extractAgencySignals(evidence, { studioPolicy: policy });
    // All signals should be meaningfully positive (not saturated, not zero)
    expect(signals.initiativeSignal).toBeGreaterThanOrEqual(0.5);
    expect(signals.initiativeSignal).toBeLessThanOrEqual(1.0);
    expect(signals.collaborationSignal).toBeGreaterThanOrEqual(0.5);
    expect(signals.collaborationSignal).toBeLessThanOrEqual(1.0);
    expect(signals.reasoningSignal).toBeGreaterThanOrEqual(0.49);
    expect(signals.reasoningSignal).toBeLessThanOrEqual(1.0);
  });

  it('fan-in DAG with policy scores higher than linear chain with same policy', () => {
    const linear = [
      makeNode('a'),
      makeNode('b', ['a']),
      makeNode('c', ['b']),
      makeNode('d', ['c']),
      makeNode('e', ['d']),
    ];
    const fanIn = [
      makeNode('a'),
      makeNode('b'),
      makeNode('c', ['a', 'b']),
      makeNode('d', ['c']),
      makeNode('e', ['d']),
    ];
    const policy: EngineeringStudioPolicy = {
      version: '1.0',
      studioName: 'Test',
      scoring: {
        initiative: { rootRatio: { min: 0.1, target: 0.4, max: 0.8 } },
        collaboration: {
          edgeDensity: { min: 0.2, target: 0.8, max: 1.0 },
          integrationRatio: { min: 0.0, target: 0.3, max: 0.7 },
          weights: { edgeDensity: 0.6, integrationRatio: 0.4 },
        },
        reasoning: { depthRatio: { min: 0.2, target: 0.6, max: 1.0 } },
        compliance: {
          requiredChecks: [], forbiddenPatterns: [], requiredArtifacts: [],
          weights: { testsPresent: 0, requiredArtifactsPresent: 0, noPolicyViolations: 0 },
        },
        efficiency: { weights: {} },
      },
      verifierInstructions: { initiative: '', collaboration: '', reasoning: '', compliance: '', efficiency: '' },
    };
    const linearSignals = extractAgencySignals(linear, { studioPolicy: policy });
    const fanInSignals = extractAgencySignals(fanIn, { studioPolicy: policy });

    // Fan-in has more initiative (2 roots vs 1)
    expect(fanInSignals.initiativeSignal).toBeGreaterThan(linearSignals.initiativeSignal);
    // Fan-in has integration nodes → higher collaboration
    expect(fanInSignals.collaborationSignal).toBeGreaterThan(linearSignals.collaborationSignal);
  });
});

// =============================================================================
// Policy-Aware Signal Extraction (Phase 2)
// =============================================================================

const DEFAULT_POLICY: EngineeringStudioPolicy = {
  version: '1.0',
  studioName: 'Test Studio',
  scoring: {
    initiative: {
      rootRatio: { min: 0.1, target: 0.5, max: 1.0 },
    },
    collaboration: {
      edgeDensity: { min: 0.2, target: 0.7, max: 1.0 },
      integrationRatio: { min: 0.0, target: 0.25, max: 0.7 },
      weights: { edgeDensity: 0.6, integrationRatio: 0.4 },
    },
    reasoning: {
      depthRatio: { min: 0.1, target: 0.5, max: 1.0 },
    },
    compliance: {
      requiredChecks: ['tests'],
      forbiddenPatterns: ['secret-commit'],
      requiredArtifacts: ['test'],
      weights: { testsPresent: 0.4, requiredArtifactsPresent: 0.3, noPolicyViolations: 0.3 },
    },
    efficiency: {
      durationRatio: { min: 0.05, target: 0.5, max: 2.0 },
      artifactCountRatio: { min: 0.3, target: 0.8, max: 1.0 },
      weights: { durationRatio: 0.5, artifactCountRatio: 0.5 },
    },
  },
  verifierInstructions: {
    initiative: '',
    collaboration: '',
    reasoning: '',
    compliance: '',
    efficiency: '',
  },
};

function makeNodeWithArtifacts(
  id: string,
  parentIds: string[] = [],
  artifacts: string[] = [],
  timestamp = Date.now(),
): EvidencePackage {
  return {
    arweave_tx_id: id,
    author: '0x0000000000000000000000000000000000000001',
    timestamp,
    parent_ids: parentIds,
    payload_hash: '0x' + id.padStart(64, '0'),
    artifact_ids: artifacts,
    signature: '0x' + '00'.repeat(65),
  };
}

describe('extractAgencySignals with policy', () => {
  it('returns policy-conditioned signals when policy is provided', () => {
    const evidence = [
      makeNode('a'),
      makeNode('b', ['a']),
      makeNode('c', ['b']),
    ];
    const withPolicy = extractAgencySignals(evidence, { studioPolicy: DEFAULT_POLICY });
    const withoutPolicy = extractAgencySignals(evidence);

    // With policy, signals go through rangeFit — different values
    expect(withPolicy.initiativeSignal).not.toBe(withoutPolicy.initiativeSignal);
  });

  it('signals change when policy ranges change', () => {
    const evidence = [
      makeNode('a'),
      makeNode('b'),
      makeNode('c', ['a', 'b']),
    ];

    const narrowPolicy = {
      ...DEFAULT_POLICY,
      scoring: {
        ...DEFAULT_POLICY.scoring,
        initiative: { rootRatio: { min: 0.5, target: 0.6, max: 0.7 } },
      },
    };

    const widePolicy = {
      ...DEFAULT_POLICY,
      scoring: {
        ...DEFAULT_POLICY.scoring,
        initiative: { rootRatio: { min: 0.0, target: 0.67, max: 1.0 } },
      },
    };

    const narrow = extractAgencySignals(evidence, { studioPolicy: narrowPolicy });
    const wide = extractAgencySignals(evidence, { studioPolicy: widePolicy });

    // rootRatio = 2/3 ≈ 0.667
    // narrow: 0.667 is near edge of max (0.7), so signal is low
    // wide: 0.667 is near target (0.67), so signal is high
    expect(wide.initiativeSignal).toBeGreaterThan(narrow.initiativeSignal);
  });

  it('computes compliance signal from policy', () => {
    const evidence = [
      makeNodeWithArtifacts('a', [], ['src/auth.ts', 'tests/auth.test.ts']),
      makeNodeWithArtifacts('b', ['a'], ['src/handler.ts']),
    ];

    const signals = extractAgencySignals(evidence, { studioPolicy: DEFAULT_POLICY });
    expect(signals.complianceSignal).toBeDefined();
    expect(signals.complianceSignal).toBeGreaterThan(0);
    expect(signals.complianceSignal).toBeLessThanOrEqual(1);
    expect(signals.observed.testsPresent).toBe(true);
  });

  it('compliance signal drops when tests are missing', () => {
    const withTests = [
      makeNodeWithArtifacts('a', [], ['src/main.ts', 'tests/main.test.ts']),
    ];
    const noTests = [
      makeNodeWithArtifacts('a', [], ['src/main.ts']),
    ];

    const sigWith = extractAgencySignals(withTests, { studioPolicy: DEFAULT_POLICY });
    const sigWithout = extractAgencySignals(noTests, { studioPolicy: DEFAULT_POLICY });

    expect(sigWith.complianceSignal!).toBeGreaterThan(sigWithout.complianceSignal!);
  });

  it('compliance detects forbidden patterns', () => {
    const evidence = [
      makeNodeWithArtifacts('a', [], ['src/main.ts', 'secret-commit.json']),
    ];

    const signals = extractAgencySignals(evidence, { studioPolicy: DEFAULT_POLICY });
    expect(signals.observed.policyViolations).toBeDefined();
    expect(signals.observed.policyViolations!.length).toBeGreaterThan(0);
    expect(signals.observed.policyViolations![0]).toContain('forbidden pattern');
  });

  it('compliance tracks required and missing artifacts', () => {
    const evidence = [
      makeNodeWithArtifacts('a', [], ['src/main.ts']),
    ];

    const signals = extractAgencySignals(evidence, { studioPolicy: DEFAULT_POLICY });
    expect(signals.observed.missingArtifacts).toContain('test');
  });

  it('compliance is 1.0 when all checks pass', () => {
    const evidence = [
      makeNodeWithArtifacts('a', [], ['src/main.ts', 'tests/main.test.ts']),
    ];

    const signals = extractAgencySignals(evidence, { studioPolicy: DEFAULT_POLICY });
    expect(signals.complianceSignal).toBe(1);
    expect(signals.observed.policyViolations).toEqual([]);
    expect(signals.observed.missingArtifacts).toEqual([]);
  });

  it('efficiency signal computed when latencyBudget and duration available', () => {
    const base = 1000;
    const evidence = [
      makeNodeWithArtifacts('a', [], ['src/main.ts'], base),
      makeNodeWithArtifacts('b', ['a'], ['src/handler.ts', 'test.ts'], base + 90_000),
    ];

    const mandate: WorkMandate = {
      taskId: 'task-1',
      title: 'Test',
      objective: 'Test efficiency',
      taskType: 'feature',
      constraints: { latencyBudgetMs: 180_000 },
    };

    const signals = extractAgencySignals(evidence, {
      studioPolicy: DEFAULT_POLICY,
      workMandate: mandate,
    });

    expect(signals.efficiencySignal).toBeDefined();
    expect(signals.efficiencySignal!).toBeGreaterThan(0);
    expect(signals.efficiencySignal!).toBeLessThanOrEqual(1);
  });

  it('efficiency signal is undefined when no latency budget', () => {
    const evidence = [makeNode('a'), makeNode('b', ['a'])];

    const signals = extractAgencySignals(evidence, { studioPolicy: DEFAULT_POLICY });
    // artifactCountRatio will compute (both nodes have empty artifacts → 0/2 = 0)
    // but durationRatio requires latencyBudgetMs from mandate
    // So at least the artifactCount part runs
    expect(signals.efficiencySignal).toBeDefined();
  });
});

describe('extractAgencySignals with work mandate', () => {
  const BUGFIX_MANDATE: WorkMandate = {
    taskId: 'bug-001',
    title: 'Fix auth crash',
    objective: 'Fix broken auth middleware',
    taskType: 'bugfix',
    constraints: {
      mustPassTests: true,
      requiredArtifacts: ['test'],
      latencyBudgetMs: 300_000,
    },
    overrides: {
      initiative: { rootRatio: { min: 0.2, target: 0.4, max: 0.7 } },
      reasoning: { depthRatio: { min: 0.2, target: 0.5, max: 0.8 } },
    },
  };

  const FEATURE_MANDATE: WorkMandate = {
    taskId: 'feat-001',
    title: 'Add caching layer',
    objective: 'Implement query caching',
    taskType: 'feature',
    constraints: {
      mustPassTests: true,
      requiredArtifacts: ['test'],
      latencyBudgetMs: 600_000,
    },
    overrides: {
      initiative: { rootRatio: { min: 0.3, target: 0.7, max: 1.0 } },
      reasoning: { depthRatio: { min: 0.3, target: 0.7, max: 1.0 } },
    },
  };

  it('bugfix mandate produces different signals than feature mandate', () => {
    // 5-node graph: 2 roots, depth 3 → rootRatio=0.4, depthRatio=0.6
    const evidence = [
      makeNodeWithArtifacts('a', [], ['src/fix.ts', 'tests/fix.test.ts']),
      makeNodeWithArtifacts('b', [], ['src/handler.ts']),
      makeNodeWithArtifacts('c', ['a'], ['src/middleware.ts']),
      makeNodeWithArtifacts('d', ['c', 'b'], ['src/router.ts']),
      makeNodeWithArtifacts('e', ['d'], ['tests/integration.test.ts']),
    ];

    const bugfix = extractAgencySignals(evidence, {
      studioPolicy: DEFAULT_POLICY,
      workMandate: BUGFIX_MANDATE,
    });

    const feature = extractAgencySignals(evidence, {
      studioPolicy: DEFAULT_POLICY,
      workMandate: FEATURE_MANDATE,
    });

    // Same evidence, different mandates → different initiative signals
    // rootRatio=0.4 → bugfix target=0.4 (perfect), feature target=0.7 (below target)
    expect(bugfix.initiativeSignal).not.toBe(feature.initiativeSignal);
  });

  it('mandate overrides take precedence over studio policy', () => {
    const evidence = [
      makeNode('a'),
      makeNode('b'),
      makeNode('c', ['a', 'b']),
    ];

    // rootRatio = 2/3 ≈ 0.667
    // Default policy target: 0.5, mandate override target: 0.4 (bugfix)
    const withMandate = extractAgencySignals(evidence, {
      studioPolicy: DEFAULT_POLICY,
      workMandate: BUGFIX_MANDATE,
    });

    const withoutMandate = extractAgencySignals(evidence, {
      studioPolicy: DEFAULT_POLICY,
    });

    expect(withMandate.initiativeSignal).not.toBe(withoutMandate.initiativeSignal);
  });

  it('mandate mustPassTests violation appears in policy violations', () => {
    const evidence = [
      makeNodeWithArtifacts('a', [], ['src/fix.ts']),
    ];

    const mandate: WorkMandate = {
      taskId: 'strict-1',
      title: 'Strict task',
      objective: 'Must have tests',
      taskType: 'bugfix',
      constraints: { mustPassTests: true },
    };

    const signals = extractAgencySignals(evidence, {
      studioPolicy: DEFAULT_POLICY,
      workMandate: mandate,
    });

    expect(signals.observed.policyViolations).toBeDefined();
    expect(signals.observed.policyViolations!.some(v => v.includes('mandate requires tests'))).toBe(true);
  });

  it('deterministic: same evidence + same context = same signals', () => {
    const evidence = [
      makeNodeWithArtifacts('a', [], ['src/main.ts', 'tests/main.test.ts'], 1000),
      makeNodeWithArtifacts('b', ['a'], ['src/handler.ts'], 5000),
    ];

    const ctx = { studioPolicy: DEFAULT_POLICY, workMandate: BUGFIX_MANDATE };

    const s1 = extractAgencySignals(evidence, ctx);
    const s2 = extractAgencySignals(evidence, ctx);
    expect(s1).toEqual(s2);
  });
});

// =============================================================================
// Safety guards: clamping, weight normalization, NaN prevention
// =============================================================================

describe('signal safety guards', () => {
  it('collaboration signal stays ≤ 1 even with unnormalized weights', () => {
    const badWeightsPolicy: EngineeringStudioPolicy = {
      ...DEFAULT_POLICY,
      scoring: {
        ...DEFAULT_POLICY.scoring,
        collaboration: {
          edgeDensity: { min: 0.0, target: 0.5, max: 1.0 },
          integrationRatio: { min: 0.0, target: 0.5, max: 1.0 },
          weights: { edgeDensity: 0.8, integrationRatio: 0.8 },
        },
      },
    };

    const evidence = [
      makeNode('a'),
      makeNode('b', ['a']),
      makeNode('c', ['a', 'b']),
    ];

    const signals = extractAgencySignals(evidence, { studioPolicy: badWeightsPolicy });
    expect(signals.collaborationSignal).toBeLessThanOrEqual(1);
    expect(signals.collaborationSignal).toBeGreaterThanOrEqual(0);
  });

  it('compliance signal stays ≤ 1 even with large weights', () => {
    const bigWeightsPolicy: EngineeringStudioPolicy = {
      ...DEFAULT_POLICY,
      scoring: {
        ...DEFAULT_POLICY.scoring,
        compliance: {
          requiredChecks: [],
          forbiddenPatterns: [],
          requiredArtifacts: [],
          weights: { testsPresent: 5.0, requiredArtifactsPresent: 5.0, noPolicyViolations: 5.0 },
        },
      },
    };

    const evidence = [
      makeNodeWithArtifacts('a', [], ['src/main.ts', 'tests/main.test.ts']),
    ];

    const signals = extractAgencySignals(evidence, { studioPolicy: bigWeightsPolicy });
    expect(signals.complianceSignal).toBeLessThanOrEqual(1);
    expect(signals.complianceSignal).toBeGreaterThanOrEqual(0);
  });

  it('compliance signal stays ≤ 1 with all checks passing and unequal weights', () => {
    const unequalPolicy: EngineeringStudioPolicy = {
      ...DEFAULT_POLICY,
      scoring: {
        ...DEFAULT_POLICY.scoring,
        compliance: {
          requiredChecks: [],
          forbiddenPatterns: [],
          requiredArtifacts: ['test'],
          weights: { testsPresent: 0.6, requiredArtifactsPresent: 0.6, noPolicyViolations: 0.6 },
        },
      },
    };

    const evidence = [
      makeNodeWithArtifacts('a', [], ['tests/main.test.ts']),
    ];

    const signals = extractAgencySignals(evidence, { studioPolicy: unequalPolicy });
    expect(signals.complianceSignal).toBeLessThanOrEqual(1);
    expect(signals.complianceSignal).toBeGreaterThanOrEqual(0);
  });

  it('efficiency signal is not NaN when latencyBudgetMs is 0', () => {
    const evidence = [
      makeNodeWithArtifacts('a', [], ['src/main.ts'], 1000),
      makeNodeWithArtifacts('b', ['a'], ['src/handler.ts'], 5000),
    ];

    const mandate: WorkMandate = {
      taskId: 't1',
      title: 'Test',
      objective: 'Test',
      taskType: 'bugfix',
      constraints: { latencyBudgetMs: 0 },
    };

    const signals = extractAgencySignals(evidence, {
      studioPolicy: DEFAULT_POLICY,
      workMandate: mandate,
    });

    if (signals.efficiencySignal !== undefined) {
      expect(Number.isNaN(signals.efficiencySignal)).toBe(false);
      expect(signals.efficiencySignal).toBeGreaterThanOrEqual(0);
      expect(signals.efficiencySignal).toBeLessThanOrEqual(1);
    }
  });

  it('efficiency signal is not NaN when latencyBudgetMs is missing', () => {
    const evidence = [makeNode('a')];

    const mandate: WorkMandate = {
      taskId: 't1',
      title: 'Test',
      objective: 'Test',
      taskType: 'bugfix',
    };

    const signals = extractAgencySignals(evidence, {
      studioPolicy: DEFAULT_POLICY,
      workMandate: mandate,
    });

    if (signals.efficiencySignal !== undefined) {
      expect(Number.isNaN(signals.efficiencySignal)).toBe(false);
    }
  });

  it('all signals are [0, 1] with policy and mandate combined', () => {
    const evidence = [
      makeNodeWithArtifacts('a', [], ['src/main.ts', 'tests/main.test.ts'], 1000),
      makeNodeWithArtifacts('b', ['a'], ['src/handler.ts'], 50000),
      makeNodeWithArtifacts('c', ['b'], ['src/router.ts', 'tests/router.test.ts'], 100000),
    ];

    const mandate: WorkMandate = {
      taskId: 't1',
      title: 'Test',
      objective: 'Full safety test',
      taskType: 'feature',
      constraints: { latencyBudgetMs: 200_000, mustPassTests: true, requiredArtifacts: ['test'] },
    };

    const signals = extractAgencySignals(evidence, {
      studioPolicy: DEFAULT_POLICY,
      workMandate: mandate,
    });

    for (const key of ['initiativeSignal', 'collaborationSignal', 'reasoningSignal'] as const) {
      expect(signals[key]).toBeGreaterThanOrEqual(0);
      expect(signals[key]).toBeLessThanOrEqual(1);
      expect(Number.isNaN(signals[key])).toBe(false);
    }

    if (signals.complianceSignal !== undefined) {
      expect(signals.complianceSignal).toBeGreaterThanOrEqual(0);
      expect(signals.complianceSignal).toBeLessThanOrEqual(1);
      expect(Number.isNaN(signals.complianceSignal)).toBe(false);
    }

    if (signals.efficiencySignal !== undefined) {
      expect(signals.efficiencySignal).toBeGreaterThanOrEqual(0);
      expect(signals.efficiencySignal).toBeLessThanOrEqual(1);
      expect(Number.isNaN(signals.efficiencySignal)).toBe(false);
    }
  });

  it('collaboration weights of zero produce signal of 0', () => {
    const zeroWeightsPolicy: EngineeringStudioPolicy = {
      ...DEFAULT_POLICY,
      scoring: {
        ...DEFAULT_POLICY.scoring,
        collaboration: {
          edgeDensity: { min: 0.0, target: 0.5, max: 1.0 },
          integrationRatio: { min: 0.0, target: 0.5, max: 1.0 },
          weights: { edgeDensity: 0, integrationRatio: 0 },
        },
      },
    };

    const evidence = [makeNode('a'), makeNode('b', ['a'])];
    const signals = extractAgencySignals(evidence, { studioPolicy: zeroWeightsPolicy });
    expect(signals.collaborationSignal).toBe(0);
    expect(Number.isNaN(signals.collaborationSignal)).toBe(false);
  });
});

// =============================================================================
// Phase 3A — Integration Node Inflation Prevention
// =============================================================================

describe('integration node counting (anti-inflation)', () => {
  it('merge node with parents from same root → NOT counted', () => {
    // a→b, a→c, d→[b,c]. All descend from root a.
    const evidence = [
      makeNode('a'),
      makeNode('b', ['a']),
      makeNode('c', ['a']),
      makeNode('d', ['b', 'c']),
    ];
    const { observed } = extractAgencySignals(evidence);
    expect(observed.integrationNodeCount).toBe(0);
  });

  it('merge node combining two root branches → counted', () => {
    // a (root), b (root), c→[a,b]
    const evidence = [
      makeNode('a'),
      makeNode('b'),
      makeNode('c', ['a', 'b']),
    ];
    const { observed } = extractAgencySignals(evidence);
    expect(observed.integrationNodeCount).toBe(1);
  });

  it('large linear chain with merge commit → NOT counted', () => {
    // a→b→c→d→e, f→[d,e]. d and e both trace to root a only.
    const evidence = [
      makeNode('a'),
      makeNode('b', ['a']),
      makeNode('c', ['b']),
      makeNode('d', ['c']),
      makeNode('e', ['d']),
      makeNode('f', ['d', 'e']),
    ];
    const { observed } = extractAgencySignals(evidence);
    expect(observed.integrationNodeCount).toBe(0);
  });

  it('merge of two independent chains counts as integration', () => {
    // root1→a→b, root2→c→d, merge→[b,d]
    const evidence = [
      makeNode('root1'),
      makeNode('a', ['root1']),
      makeNode('b', ['a']),
      makeNode('root2'),
      makeNode('c', ['root2']),
      makeNode('d', ['c']),
      makeNode('merge', ['b', 'd']),
    ];
    const { observed } = extractAgencySignals(evidence);
    expect(observed.integrationNodeCount).toBe(1);
  });
});

// =============================================================================
// Phase 3B — Anti-Gaming Penalties
// =============================================================================

describe('anti-gaming penalties', () => {
  const penaltyPolicy: EngineeringStudioPolicy = {
    version: '1.0',
    studioName: 'Penalty Test Studio',
    scoring: {
      initiative: {
        rootRatio: { min: 0.1, target: 0.35, max: 0.6 },
      },
      collaboration: {
        edgeDensity: { min: 0.2, target: 0.7, max: 1.5 },
        integrationRatio: { min: 0.0, target: 0.15, max: 0.5 },
        weights: { edgeDensity: 0.6, integrationRatio: 0.4 },
      },
      reasoning: {
        depthRatio: { min: 0.1, target: 0.4, max: 0.7 },
      },
      compliance: {
        requiredChecks: [],
        forbiddenPatterns: [],
        requiredArtifacts: [],
        weights: { testsPresent: 0.5, requiredArtifactsPresent: 0.3, noPolicyViolations: 0.2 },
      },
      efficiency: {
        weights: {},
      },
    },
    verifierInstructions: {
      initiative: '', collaboration: '', reasoning: '', compliance: '', efficiency: '',
    },
  };

  it('root spam reduces initiativeSignal vs normal', () => {
    // 10 roots + 1 child = rootRatio ≈ 0.91 — way above max 0.6
    const roots = Array.from({ length: 10 }, (_, i) => makeNode(`r${i}`));
    const evidence = [...roots, makeNode('child', ['r0'])];

    const signals = extractAgencySignals(evidence, { studioPolicy: penaltyPolicy });
    expect(signals.observed.fragmentationPenalty).toBeGreaterThan(0);
    // rangeFit(0.91, 0.1, 0.35, 0.6) = 0 (outside max), penalty further reduces
    expect(signals.initiativeSignal).toBe(0);
  });

  it('overly deep chain reduces reasoningSignal', () => {
    // 10-node linear chain: depthRatio = 10/10 = 1.0 — above max 0.7
    const evidence: EvidencePackage[] = [makeNode('n0')];
    for (let i = 1; i < 10; i++) {
      evidence.push(makeNode(`n${i}`, [`n${i - 1}`]));
    }

    const signals = extractAgencySignals(evidence, { studioPolicy: penaltyPolicy });
    expect(signals.observed.overcomplexityPenalty).toBeGreaterThan(0);
    // rangeFit(1.0, 0.1, 0.4, 0.7) = 0 (outside max), penalty further reduces
    expect(signals.reasoningSignal).toBe(0);
  });

  it('normal fan-in DAG within policy ranges has zero penalties', () => {
    // 2 roots, 3 children, 1 merge = 6 nodes
    // rootRatio = 2/6 ≈ 0.33 (within [0.1, 0.6])
    // depthRatio = 3/6 = 0.5 (within [0.1, 0.7])
    const evidence = [
      makeNode('r1'),
      makeNode('r2'),
      makeNode('a', ['r1']),
      makeNode('b', ['r2']),
      makeNode('c', ['a', 'b']),
      makeNode('d', ['c']),
    ];
    const signals = extractAgencySignals(evidence, { studioPolicy: penaltyPolicy });
    expect(signals.observed.fragmentationPenalty).toBe(0);
    expect(signals.observed.overcomplexityPenalty).toBe(0);
    expect(signals.initiativeSignal).toBeGreaterThan(0);
    expect(signals.reasoningSignal).toBeGreaterThan(0);
  });

  it('penalties do not reduce a within-range signal', () => {
    // 3-node graph: rootRatio = 1/3 ≈ 0.33, depthRatio = 3/3 = 1.0
    // initiative: rootRatio 0.33 is within [0.1, 0.6] → no penalty
    // reasoning: depthRatio 1.0 > max 0.7 → penalty applies
    const evidence = [
      makeNode('a'),
      makeNode('b', ['a']),
      makeNode('c', ['b']),
    ];
    const signals = extractAgencySignals(evidence, { studioPolicy: penaltyPolicy });
    expect(signals.observed.fragmentationPenalty).toBe(0);
    expect(signals.observed.overcomplexityPenalty).toBeGreaterThan(0);
    // Initiative was within range — no penalty applied
    expect(signals.initiativeSignal).toBeGreaterThan(0);
  });

  it('no penalties in no-policy fallback path', () => {
    const evidence = [
      makeNode('a'),
      makeNode('b', ['a']),
      makeNode('c', ['b']),
    ];
    const signals = extractAgencySignals(evidence);
    expect(signals.observed.fragmentationPenalty).toBeUndefined();
    expect(signals.observed.overcomplexityPenalty).toBeUndefined();
  });
});

// =============================================================================
// composeScoreVector
// =============================================================================

describe('composeScoreVector', () => {
  const baseSignals: AgencySignals = {
    initiativeSignal: 0.67,
    collaborationSignal: 0.85,
    reasoningSignal: 0.5,
    complianceSignal: 0.9,
    efficiencySignal: 0.72,
    observed: {
      totalNodes: 3, rootCount: 2, edgeCount: 1, maxDepth: 2,
      artifactCount: 3, terminalCount: 1, integrationNodeCount: 0,
    },
  };

  it('throws when complianceScore is missing', () => {
    expect(() =>
      composeScoreVector(baseSignals, { efficiencyScore: 80 } as any),
    ).toThrow('complianceScore is required for production scoring');
  });

  it('throws when efficiencyScore is missing', () => {
    expect(() =>
      composeScoreVector(baseSignals, { complianceScore: 80 } as any),
    ).toThrow('efficiencyScore is required for production scoring');
  });

  it('valid 0..1 input produces correct 0..100 output', () => {
    const vector = composeScoreVector(baseSignals, {
      complianceScore: 0.92,
      efficiencyScore: 0.78,
    });
    expect(vector[3]).toBe(92);
    expect(vector[4]).toBe(78);
    expect(vector[0]).toBe(67);
    expect(vector[1]).toBe(85);
    expect(vector[2]).toBe(50);
  });

  it('valid 0..100 input produces correct 0..100 output', () => {
    const vector = composeScoreVector(baseSignals, {
      complianceScore: 95,
      efficiencyScore: 88,
    });
    expect(vector[3]).toBe(95);
    expect(vector[4]).toBe(88);
    expect(vector[0]).toBe(67);
    expect(vector[1]).toBe(85);
    expect(vector[2]).toBe(50);
  });

  it('optional dimension overrides replace signal-derived values', () => {
    const vector = composeScoreVector(baseSignals, {
      initiativeScore: 80,
      collaborationScore: 60,
      reasoningScore: 70,
      complianceScore: 90,
      efficiencyScore: 75,
    });
    expect(vector).toEqual([80, 60, 70, 90, 75]);
  });

  it('all outputs clamped to 0..100', () => {
    const vector = composeScoreVector(baseSignals, {
      complianceScore: 150,
      efficiencyScore: -20,
    });
    expect(vector[3]).toBe(100);
    expect(vector[4]).toBe(0);
    for (const v of vector) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('returns exactly 5 elements', () => {
    const vector = composeScoreVector(baseSignals, {
      complianceScore: 80,
      efficiencyScore: 70,
    });
    expect(vector).toHaveLength(5);
  });

  it('assessment value of 0 is respected (not treated as missing)', () => {
    const vector = composeScoreVector(baseSignals, {
      complianceScore: 0,
      efficiencyScore: 0,
    });
    expect(vector[3]).toBe(0);
    expect(vector[4]).toBe(0);
  });

  it('rationale is accepted without affecting output', () => {
    const vector = composeScoreVector(baseSignals, {
      complianceScore: 80,
      efficiencyScore: 70,
      rationale: 'Tests pass, good quality',
    });
    expect(vector[3]).toBe(80);
    expect(vector[4]).toBe(70);
  });

  it('full pipeline: extract → compose with overrides', () => {
    const evidence = [
      makeNode('a', [], ['src/main.ts']),
      makeNode('b', ['a'], ['src/handler.ts']),
      makeNode('c', ['b'], ['tests/main.test.ts']),
    ];
    const signals = extractAgencySignals(evidence);
    const vector = composeScoreVector(signals, {
      complianceScore: 85,
      efficiencyScore: 78,
    });
    expect(vector).toHaveLength(5);
    expect(vector.every(v => Number.isInteger(v) && v >= 0 && v <= 100)).toBe(true);
    expect(vector[3]).toBe(85);
    expect(vector[4]).toBe(78);
  });
});

// =============================================================================
// composeScoreVectorWithDefaults (demo/test helper)
// =============================================================================

describe('composeScoreVectorWithDefaults', () => {
  const baseSignals: AgencySignals = {
    initiativeSignal: 0.67,
    collaborationSignal: 0.85,
    reasoningSignal: 0.5,
    complianceSignal: 0.9,
    efficiencySignal: 0.72,
    observed: {
      totalNodes: 3, rootCount: 2, edgeCount: 1, maxDepth: 2,
      artifactCount: 3, terminalCount: 1, integrationNodeCount: 0,
    },
  };

  it('works with no assessment at all', () => {
    const vector = composeScoreVectorWithDefaults(baseSignals);
    expect(vector).toEqual([67, 85, 50, 90, 72]);
    expect(vector.every(v => Number.isInteger(v))).toBe(true);
  });

  it('falls back to 0 when signal and override are both missing', () => {
    const sparse: AgencySignals = {
      initiativeSignal: 0.5,
      collaborationSignal: 0.3,
      reasoningSignal: 0.4,
      observed: {
        totalNodes: 2, rootCount: 1, edgeCount: 1, maxDepth: 2,
        artifactCount: 1, terminalCount: 1, integrationNodeCount: 0,
      },
    };
    const vector = composeScoreVectorWithDefaults(sparse);
    expect(vector[3]).toBe(0);
    expect(vector[4]).toBe(0);
  });

  it('edge: signal of exactly 1.0 maps to 100', () => {
    const perfect: AgencySignals = {
      initiativeSignal: 1.0,
      collaborationSignal: 1.0,
      reasoningSignal: 1.0,
      complianceSignal: 1.0,
      efficiencySignal: 1.0,
      observed: {
        totalNodes: 1, rootCount: 1, edgeCount: 0, maxDepth: 1,
        artifactCount: 1, terminalCount: 1, integrationNodeCount: 0,
      },
    };
    expect(composeScoreVectorWithDefaults(perfect)).toEqual([100, 100, 100, 100, 100]);
  });

  it('partial overrides merge with signal defaults', () => {
    const vector = composeScoreVectorWithDefaults(baseSignals, {
      complianceScore: 85,
      efficiencyScore: 78,
    });
    expect(vector[0]).toBe(67);
    expect(vector[3]).toBe(85);
    expect(vector[4]).toBe(78);
  });
});
