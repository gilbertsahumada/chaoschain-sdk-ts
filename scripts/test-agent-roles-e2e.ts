/**
 * E2E test — Agent override roles against the ChaosChain gateway.
 *
 * Tests 4 scenarios:
 *   1. Single agent — worker completes a task
 *   2. Single agent — verifier reviews the evidence from scenario 1
 *   3. Multi-agent — two workers collaborate on a task
 *   4. Multi-agent — worker + verifier in same session, verifier reviews evidence from scenario 3
 */

import axios from 'axios';
import { SessionClient } from '../src/session/SessionClient';

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:3001';
const API_KEY = process.env.CHAOSCHAIN_API_KEY!;
const STUDIO = process.env.STUDIO_ADDRESS!;
const AGENT_COPILOT = process.env.AGENT_ADDRESS!;
const AGENT_CODERABBIT = process.env.OVERRIDE_AGENT_ADDRESS!;

const required = ['CHAOSCHAIN_API_KEY', 'STUDIO_ADDRESS', 'AGENT_ADDRESS', 'OVERRIDE_AGENT_ADDRESS'] as const;
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const client = new SessionClient({ gatewayUrl: GATEWAY_URL, apiKey: API_KEY });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface EvidenceNode {
  agent_address: string;
  event_type: string;
  summary: string;
  node_id: string;
}

async function fetchEvidence(sessionId: string) {
  const url = `${GATEWAY_URL}/v1/sessions/${sessionId}/evidence`;
  const headers: Record<string, string> = {};
  if (API_KEY) headers['X-API-Key'] = API_KEY;
  const res = await axios.get(url, { headers, timeout: 15_000 });
  return res.data.data.evidence_dag.nodes as EvidenceNode[];
}

function printEvents(nodes: EvidenceNode[]) {
  nodes.forEach((n, i) => {
    const addr = n.agent_address.slice(0, 8) + '...';
    console.log(`    ${i} | ${addr} | ${n.event_type.padEnd(18)} | ${n.summary.slice(0, 60)}`);
  });
}

// ============================================================================
// Scenario 1: Single agent — Worker
// ============================================================================
async function testSingleAgentWorker() {
  console.log('\n=== Scenario 1: Single Agent — Worker ===');
  const session = await client.start({
    studio_address: STUDIO,
    agent_address: AGENT_COPILOT,
    task_type: 'feature',
  });
  console.log(`  Session: ${session.sessionId}`);

  await session.step('planning', 'Designing cache layer architecture');
  await session.step('implementing', 'Built CacheService class');
  await session.step('testing', 'All 12 tests pass');
  const result = await session.complete({ summary: 'Cache layer done' });

  console.log(`  workflow_id: ${result.workflow_id ?? 'null'}`);
  console.log(`  data_hash:   ${result.data_hash ?? 'null'}`);

  const nodes = await fetchEvidence(session.sessionId);
  console.log(`  Events (${nodes.length}):`);
  printEvents(nodes);

  const allCopilot = nodes.every((n) => n.agent_address === AGENT_COPILOT);
  console.log(`  All events from Copilot: ${allCopilot ? 'PASS' : 'FAIL'}`);

  return {
    passed: allCopilot,
    sessionId: session.sessionId,
    workflowId: result.workflow_id,
    dataHash: result.data_hash,
    nodeCount: nodes.length,
  };
}

// ============================================================================
// Scenario 2: Single agent — Verifier reviews evidence from Scenario 1
// ============================================================================
async function testSingleAgentVerifier(workerResult: {
  sessionId: string;
  workflowId: string | null;
  dataHash: string | null;
  nodeCount: number;
}) {
  console.log('\n=== Scenario 2: Single Agent — Verifier (reviews Scenario 1) ===');
  console.log(`  Reviewing worker session: ${workerResult.sessionId}`);

  // Verifier fetches worker evidence first
  const workerEvidence = await fetchEvidence(workerResult.sessionId);
  console.log(`  Fetched ${workerEvidence.length} events from worker session`);

  // Verifier opens its own session
  const session = await client.start({
    studio_address: STUDIO,
    agent_address: AGENT_CODERABBIT,
    task_type: 'verification',
  });
  console.log(`  Verifier session: ${session.sessionId}`);

  // Log verification events referencing the worker's evidence
  await session.log({
    summary: `Reviewing evidence from worker session ${workerResult.sessionId}`,
    agent: { agent_address: AGENT_CODERABBIT, role: 'verifier' },
    metadata: {
      reviewed_session_id: workerResult.sessionId,
      reviewed_workflow_id: workerResult.workflowId,
      reviewed_data_hash: workerResult.dataHash,
    },
  });

  await session.log({
    summary: `Evidence DAG validated: ${workerEvidence.length} nodes, causal chain intact`,
    agent: { agent_address: AGENT_CODERABBIT, role: 'verifier' },
    metadata: {
      node_count: workerEvidence.length,
      event_types: workerEvidence.map((n) => n.event_type),
    },
  });

  await session.log({
    summary: `Work quality assessed: planning, implementation, and testing steps present`,
    agent: { agent_address: AGENT_CODERABBIT, role: 'verifier' },
    metadata: {
      has_planning: workerEvidence.some((n) => n.event_type === 'plan_created'),
      has_implementation: workerEvidence.some((n) => n.event_type === 'file_written'),
      has_testing: workerEvidence.some((n) => n.event_type === 'test_run'),
    },
  });

  const result = await session.complete({ summary: 'Verification passed — worker evidence is valid' });

  console.log(`  workflow_id: ${result.workflow_id ?? 'null'}`);
  console.log(`  data_hash:   ${result.data_hash ?? 'null'}`);

  const nodes = await fetchEvidence(session.sessionId);
  console.log(`  Verifier events (${nodes.length}):`);
  printEvents(nodes);

  const allCodeRabbit = nodes
    .filter((n) => n.event_type !== 'task_completed')
    .every((n) => n.agent_address === AGENT_CODERABBIT);
  console.log(`  All verifier events from CodeRabbit: ${allCodeRabbit ? 'PASS' : 'FAIL'}`);

  return { passed: allCodeRabbit, sessionId: session.sessionId };
}

// ============================================================================
// Scenario 3: Multi-agent — Two workers collaborate
// ============================================================================
async function testMultiAgentWorker() {
  console.log('\n=== Scenario 3: Multi-Agent — Workers ===');
  const session = await client.start({
    studio_address: STUDIO,
    agent_address: AGENT_COPILOT,
    task_type: 'feature',
  });
  console.log(`  Session: ${session.sessionId}`);

  await session.step('planning', 'Copilot: designing API endpoints');
  await session.log({
    summary: 'CodeRabbit: scaffolded request handlers',
    agent: { agent_address: AGENT_CODERABBIT, role: 'worker' },
  });
  await session.step('implementing', 'Copilot: wired up controller logic');
  await session.log({
    summary: 'CodeRabbit: added input validation',
    agent: { agent_address: AGENT_CODERABBIT, role: 'worker' },
  });
  await session.step('testing', 'Copilot: all tests pass');
  const result = await session.complete({ summary: 'Feature done — both agents contributed' });

  console.log(`  workflow_id: ${result.workflow_id ?? 'null'}`);
  console.log(`  data_hash:   ${result.data_hash ?? 'null'}`);

  const nodes = await fetchEvidence(session.sessionId);
  console.log(`  Events (${nodes.length}):`);
  printEvents(nodes);

  const copilotEvents = nodes.filter((n) => n.agent_address === AGENT_COPILOT);
  const coderabbitEvents = nodes.filter((n) => n.agent_address === AGENT_CODERABBIT);
  const hasBoth = copilotEvents.length >= 3 && coderabbitEvents.length >= 2;
  console.log(`  Copilot events: ${copilotEvents.length}, CodeRabbit events: ${coderabbitEvents.length}`);
  console.log(`  Both agents present: ${hasBoth ? 'PASS' : 'FAIL'}`);

  return {
    passed: hasBoth,
    sessionId: session.sessionId,
    workflowId: result.workflow_id,
    dataHash: result.data_hash,
    nodeCount: nodes.length,
  };
}

// ============================================================================
// Scenario 4: Multi-agent — Worker builds, Verifier reviews in same session
//             Verifier references evidence from Scenario 3
// ============================================================================
async function testMultiAgentVerifier(workerResult: {
  sessionId: string;
  workflowId: string | null;
  dataHash: string | null;
  nodeCount: number;
}) {
  console.log('\n=== Scenario 4: Multi-Agent — Worker + Verifier (reviews Scenario 3) ===');
  console.log(`  Reviewing multi-agent session: ${workerResult.sessionId}`);

  const workerEvidence = await fetchEvidence(workerResult.sessionId);

  const session = await client.start({
    studio_address: STUDIO,
    agent_address: AGENT_COPILOT,
    task_type: 'feature',
  });
  console.log(`  Session: ${session.sessionId}`);

  // Copilot does some work as worker
  await session.step('planning', 'Copilot: planning improvements based on prior session');
  await session.step('implementing', 'Copilot: applied improvements');

  // CodeRabbit verifies referencing the prior session's evidence
  await session.log({
    summary: `CodeRabbit: reviewing evidence from session ${workerResult.sessionId}`,
    agent: { agent_address: AGENT_CODERABBIT, role: 'verifier' },
    metadata: {
      reviewed_session_id: workerResult.sessionId,
      reviewed_workflow_id: workerResult.workflowId,
      reviewed_data_hash: workerResult.dataHash,
      reviewed_node_count: workerEvidence.length,
    },
  });

  await session.log({
    summary: `CodeRabbit: multi-agent DAG valid, ${workerEvidence.length} nodes, 2 contributors confirmed`,
    agent: { agent_address: AGENT_CODERABBIT, role: 'verifier' },
    metadata: {
      unique_agents: [...new Set(workerEvidence.map((n) => n.agent_address))],
    },
  });

  // Copilot finishes
  await session.step('testing', 'Copilot: regression tests pass');

  const result = await session.complete({ summary: 'Work + verification complete' });

  console.log(`  workflow_id: ${result.workflow_id ?? 'null'}`);
  console.log(`  data_hash:   ${result.data_hash ?? 'null'}`);

  const nodes = await fetchEvidence(session.sessionId);
  console.log(`  Events (${nodes.length}):`);
  printEvents(nodes);

  const copilotEvents = nodes.filter((n) => n.agent_address === AGENT_COPILOT);
  const verifierEvents = nodes.filter((n) => n.agent_address === AGENT_CODERABBIT);
  const hasBoth = copilotEvents.length >= 3 && verifierEvents.length >= 2;
  console.log(`  Copilot (worker) events: ${copilotEvents.length}, CodeRabbit (verifier) events: ${verifierEvents.length}`);
  console.log(`  Worker + Verifier present: ${hasBoth ? 'PASS' : 'FAIL'}`);

  return { passed: hasBoth, sessionId: session.sessionId };
}

// ============================================================================
// Run all
// ============================================================================
(async () => {
  console.log('=== Agent Override E2E — Full Verification Flow ===');
  console.log(`  Gateway:     ${GATEWAY_URL}`);
  console.log(`  Copilot:     ${AGENT_COPILOT}`);
  console.log(`  CodeRabbit:  ${AGENT_CODERABBIT}`);

  // Scenario 1: Worker does work
  const s1 = await testSingleAgentWorker();

  // Scenario 2: Verifier reviews Scenario 1's evidence in a separate session
  const s2 = await testSingleAgentVerifier(s1);

  // Scenario 3: Two workers collaborate
  const s3 = await testMultiAgentWorker();

  // Scenario 4: Worker + Verifier in same session, verifier reviews Scenario 3's evidence
  const s4 = await testMultiAgentVerifier(s3);

  console.log('\n=== RESULTS ===');
  const labels = [
    'S1 Single-Agent Worker',
    'S2 Single-Agent Verifier (reviewed S1)',
    'S3 Multi-Agent Workers',
    'S4 Multi-Agent Worker+Verifier (reviewed S3)',
  ];
  const results = [s1.passed, s2.passed, s3.passed, s4.passed];
  results.forEach((r, i) => console.log(`  ${labels[i]}: ${r ? 'PASS' : 'FAIL'}`));

  const allPassed = results.every(Boolean);
  console.log(`\n  OVERALL: ${allPassed ? 'PASS' : 'FAIL'}`);
  process.exit(allPassed ? 0 : 1);
})().catch((err) => {
  console.error('\nFATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
