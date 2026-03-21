/**
 * Golden Path E2E — Worker submits work, Verifier reviews and scores.
 *
 * Full flow using only the SDK:
 *   1. Worker creates session, logs work, completes
 *   2. Verifier inspects the worker's evidence
 *   3. Verifier submits score (with correct on-chain addresses)
 *
 * Env vars:
 *   GATEWAY_URL          — gateway base URL (default: http://localhost:3001)
 *   CHAOSCHAIN_API_KEY   — gateway API key
 *   STUDIO_ADDRESS       — studio contract address
 *   AGENT_ADDRESS        — worker session agent address (Copilot)
 *   VERIFIER_ADDRESS     — on-chain registered verifier address
 *   ONCHAIN_WORKER_ADDR  — on-chain worker address (who did submitWork)
 *   ADMIN_SIGNER_ADDR    — admin signer for registerValidator (onlyOwner)
 *   EPOCH                — current epoch number
 */

import { SessionClient } from '../src/session/SessionClient';
import { VerifierClient } from '../src/session/VerifierClient';

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:3001';
const API_KEY = process.env.CHAOSCHAIN_API_KEY!;
const STUDIO = process.env.STUDIO_ADDRESS!;
const WORKER_SESSION_ADDR = process.env.AGENT_ADDRESS!;
const VERIFIER_ADDR = process.env.VERIFIER_ADDRESS!;
const ONCHAIN_WORKER = process.env.ONCHAIN_WORKER_ADDR!;
const ADMIN_SIGNER = process.env.ADMIN_SIGNER_ADDR!;
const EPOCH = Number(process.env.EPOCH ?? '13');

const required = [
  'CHAOSCHAIN_API_KEY',
  'STUDIO_ADDRESS',
  'AGENT_ADDRESS',
  'VERIFIER_ADDRESS',
  'ONCHAIN_WORKER_ADDR',
  'ADMIN_SIGNER_ADDR',
] as const;
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}

(async () => {
  console.log('=== Golden Path E2E ===');
  console.log(`  Gateway:          ${GATEWAY_URL}`);
  console.log(`  Studio:           ${STUDIO}`);
  console.log(`  Worker (session): ${WORKER_SESSION_ADDR}`);
  console.log(`  Worker (on-chain):${ONCHAIN_WORKER}`);
  console.log(`  Verifier:         ${VERIFIER_ADDR}`);
  console.log(`  Admin signer:     ${ADMIN_SIGNER}`);
  console.log(`  Epoch:            ${EPOCH}`);
  console.log();

  // =========================================================================
  // PHASE 1: Worker does work
  // =========================================================================
  console.log('--- Phase 1: Worker Session ---');

  const sessionClient = new SessionClient({ gatewayUrl: GATEWAY_URL, apiKey: API_KEY });

  const session = await sessionClient.start({
    studio_address: STUDIO,
    agent_address: WORKER_SESSION_ADDR,
    task_type: 'feature',
  });
  console.log(`  Session created: ${session.sessionId}`);

  await session.step('planning', 'Designing authentication middleware');
  console.log('  [worker] step: planning');

  await session.step('implementing', 'Built JWT validation + session management');
  console.log('  [worker] step: implementing');

  await session.step('testing', 'All 18 tests pass, including edge cases');
  console.log('  [worker] step: testing');

  const workResult = await session.complete({ summary: 'Auth middleware complete' });
  console.log(`  Session completed`);
  console.log(`    workflow_id: ${workResult.workflow_id ?? 'null'}`);
  console.log(`    data_hash:   ${workResult.data_hash ?? 'null'}`);
  console.log();

  // =========================================================================
  // PHASE 2: Verifier inspects evidence
  // =========================================================================
  console.log('--- Phase 2: Verifier Inspects ---');

  const verifier = new VerifierClient({
    gatewayUrl: GATEWAY_URL,
    apiKey: API_KEY,
    agentAddress: VERIFIER_ADDR,
  });

  const inspection = await verifier.inspect(session.sessionId);

  console.log(`  DAG valid:       ${inspection.valid}`);
  console.log(`  Node count:      ${inspection.nodeCount}`);
  console.log(`  Worker address:  ${inspection.workerAddress}`);
  console.log(`  Data hash:       ${inspection.dataHash}`);

  if (inspection.signals) {
    console.log(`  Signals:`);
    console.log(`    initiative:    ${inspection.signals.initiativeSignal.toFixed(3)}`);
    console.log(`    collaboration: ${inspection.signals.collaborationSignal.toFixed(3)}`);
    console.log(`    reasoning:     ${inspection.signals.reasoningSignal.toFixed(3)}`);
  }

  console.log(`  Events:`);
  inspection.events.forEach((e, i) => {
    const addr = e.agent_address.slice(0, 8) + '...';
    console.log(`    ${i} | ${addr} | ${e.event_type.padEnd(18)} | ${e.summary.slice(0, 50)}`);
  });
  console.log();

  if (!inspection.valid) {
    console.error('  FAIL — Evidence DAG is invalid, cannot score');
    process.exit(1);
  }

  // =========================================================================
  // PHASE 3: Verifier submits score
  // =========================================================================
  console.log('--- Phase 3: Verifier Submits Score ---');
  console.log('  Submitting with:');
  console.log(`    validator_address:    ${VERIFIER_ADDR}`);
  console.log(`    worker_address:       ${ONCHAIN_WORKER}`);
  console.log(`    admin_signer_address: ${ADMIN_SIGNER}`);
  console.log(`    epoch:                ${EPOCH}`);

  const result = await inspection.submit({
    compliance: 85,
    efficiency: 78,
    epoch: EPOCH,
    workerAddress: ONCHAIN_WORKER,
    adminSignerAddress: ADMIN_SIGNER,
  });

  console.log(`  Scores submitted: [${result.scores.join(', ')}]`);
  console.log(`    [initiative, collaboration, reasoning, compliance, efficiency]`);
  console.log(`  Score workflow_id:    ${result.workflowId ?? 'null'}`);
  console.log(`  Verifier session_id: ${result.verifierSessionId}`);
  console.log(`  Worker session_id:   ${result.workerSessionId}`);
  console.log(`  Worker address:      ${result.workerAddress}`);
  console.log(`  Data hash:           ${result.dataHash}`);
  console.log();

  // =========================================================================
  // Summary
  // =========================================================================
  console.log('=== Summary ===');
  console.log(`  Worker session:   ${session.sessionId}`);
  console.log(`  Verifier session: ${result.verifierSessionId}`);
  console.log(`  Scores:           [${result.scores.join(', ')}]`);
  console.log(`  Work workflow:    ${workResult.workflow_id ?? 'null'}`);
  console.log(`  Score workflow:   ${result.workflowId ?? 'null'}`);
  console.log();
  console.log('RESULT: PASS');
})().catch((err) => {
  console.error('\nFATAL:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
