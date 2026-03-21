/**
 * VerifierClient — reviews worker sessions and submits scores.
 *
 * Two usage paths:
 *
 * **Quick** — review and score in one call:
 * ```ts
 * const verifier = new VerifierClient({ gatewayUrl, apiKey, agentAddress });
 * const result = await verifier.review('sess_...', {
 *   compliance: 80,
 *   efficiency: 75,
 *   epoch: 1,
 * });
 * ```
 *
 * **Detailed** — inspect evidence first, then score:
 * ```ts
 * const review = await verifier.inspect('sess_...');
 * console.log(review.signals);  // deterministic agency signals
 * console.log(review.events);   // raw evidence events
 * const result = await review.submit({ compliance: 80, efficiency: 75, epoch: 1 });
 * ```
 */

import axios, { AxiosError } from 'axios';
import { SessionClient } from './SessionClient';
import {
  extractAgencySignals,
  composeScoreVector,
  type EvidencePackage,
  type AgencySignals,
  type VerifierAssessment,
} from '../evidence';

// =============================================================================
// Types
// =============================================================================

/** Configuration for {@link VerifierClient}. */
export interface VerifierClientConfig {
  /** Gateway base URL (default: `"https://gateway.chaoscha.in"`). */
  gatewayUrl?: string;
  /** API key sent as `X-API-Key` header. */
  apiKey?: string;
  /** Verifier agent wallet address. */
  agentAddress: string;
}

/** Evidence node returned by the gateway `/v1/sessions/{id}/evidence` endpoint. */
interface GatewayEvidenceNode {
  node_id: string;
  event_id: string;
  session_id: string;
  event_type: string;
  agent_address: string;
  timestamp: string;
  parent_ids: string[];
  payload_hash: string;
  summary: string;
  artifacts: string[];
  metadata: Record<string, unknown>;
}

/** Session metadata returned by the gateway `/v1/sessions/{id}/context` endpoint. */
interface SessionMetadata {
  session_id: string;
  studio_address: string;
  agent_address: string;
  data_hash: string | null;
  workflow_id: string | null;
  status: string;
  event_count: number;
  studio_policy_version: string;
  work_mandate_id: string;
  task_type: string;
}

/** Assessment provided by the verifier for scoring. */
export interface VerifierReviewAssessment {
  /** Compliance score (0–100). Required. */
  compliance: number;
  /** Efficiency score (0–100). Required. */
  efficiency: number;
  /** Epoch number for on-chain submission. Required. */
  epoch: number;
  /** Optional initiative override (0–100). Defaults to deterministic signal. */
  initiative?: number;
  /** Optional collaboration override (0–100). Defaults to deterministic signal. */
  collaboration?: number;
  /** Optional reasoning override (0–100). Defaults to deterministic signal. */
  reasoning?: number;
}

/** Result of a completed review. */
export interface VerifierReviewResult {
  /** Score vector submitted [initiative, collaboration, reasoning, compliance, efficiency]. */
  scores: [number, number, number, number, number];
  /** Workflow ID from gateway score submission. */
  workflowId: string | null;
  /** Session ID of the verifier's own evidence session. */
  verifierSessionId: string;
  /** Session ID of the worker session that was reviewed. */
  workerSessionId: string;
  /** Worker address from the reviewed session. */
  workerAddress: string;
  /** Data hash of the reviewed work. */
  dataHash: string;
}

/** Object returned by {@link VerifierClient.inspect} for two-step review. */
export interface VerifierInspection {
  /** Deterministic agency signals extracted from the evidence DAG. */
  signals: AgencySignals;
  /** Raw evidence events from the worker session. */
  events: GatewayEvidenceNode[];
  /** Worker address from session metadata. */
  workerAddress: string;
  /** Studio address from session metadata. */
  studioAddress: string;
  /** Data hash of the completed work. */
  dataHash: string;
  /** Workflow ID of the work submission. */
  workflowId: string | null;
  /** Number of evidence nodes. */
  nodeCount: number;
  /** Submit the score after inspection. */
  submit: (assessment: VerifierReviewAssessment) => Promise<VerifierReviewResult>;
}

// =============================================================================
// VerifierClient
// =============================================================================

export class VerifierClient {
  private readonly gatewayUrl: string;
  private readonly apiKey: string | undefined;
  private readonly agentAddress: string;

  constructor(config: VerifierClientConfig) {
    this.gatewayUrl = (config.gatewayUrl ?? 'https://gateway.chaoscha.in').replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.agentAddress = config.agentAddress;
  }

  /**
   * Review a worker session and submit a score in one call.
   *
   * Fetches the session evidence, extracts deterministic signals, composes the
   * score vector with your assessment, submits it on-chain via the gateway,
   * and logs the verification as a session.
   */
  async review(
    workerSessionId: string,
    assessment: VerifierReviewAssessment,
  ): Promise<VerifierReviewResult> {
    const inspection = await this.inspect(workerSessionId);
    return inspection.submit(assessment);
  }

  /**
   * Inspect a worker session's evidence without submitting a score.
   *
   * Returns the extracted signals, raw events, and a `submit()` method
   * to send the score when ready.
   */
  async inspect(workerSessionId: string): Promise<VerifierInspection> {
    const metadata = await this.fetchSessionMetadata(workerSessionId);

    if (!metadata.data_hash) {
      throw new Error(`Session ${workerSessionId} has no data_hash — is it completed?`);
    }

    const nodes = await this.fetchEvidenceNodes(workerSessionId);
    const evidencePackages = nodes.map(toEvidencePackage);
    const signals = extractAgencySignals(evidencePackages);

    return {
      signals,
      events: nodes,
      workerAddress: metadata.agent_address,
      studioAddress: metadata.studio_address,
      dataHash: metadata.data_hash,
      workflowId: metadata.workflow_id,
      nodeCount: nodes.length,
      submit: (assessment) =>
        this.submitReview(workerSessionId, metadata, nodes, signals, assessment),
    };
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async submitReview(
    workerSessionId: string,
    metadata: SessionMetadata,
    nodes: GatewayEvidenceNode[],
    signals: AgencySignals,
    assessment: VerifierReviewAssessment,
  ): Promise<VerifierReviewResult> {
    // Compose score vector
    const verifierAssessment: VerifierAssessment = {
      complianceScore: assessment.compliance,
      efficiencyScore: assessment.efficiency,
      initiativeScore: assessment.initiative,
      collaborationScore: assessment.collaboration,
      reasoningScore: assessment.reasoning,
    };
    const scores = composeScoreVector(signals, verifierAssessment);

    // Log verification as a session
    const sessionClient = new SessionClient({
      gatewayUrl: this.gatewayUrl,
      apiKey: this.apiKey,
    });

    const session = await sessionClient.start({
      studio_address: metadata.studio_address,
      agent_address: this.agentAddress,
      task_type: 'verification',
    });

    await session.log({
      summary: `Reviewing evidence from worker session ${workerSessionId}`,
      agent: { agent_address: this.agentAddress, role: 'verifier' },
      metadata: {
        reviewed_session_id: workerSessionId,
        reviewed_data_hash: metadata.data_hash,
        reviewed_worker_address: metadata.agent_address,
        reviewed_node_count: nodes.length,
      },
    });

    await session.log({
      summary: `Evidence DAG validated: ${nodes.length} nodes, signals extracted`,
      agent: { agent_address: this.agentAddress, role: 'verifier' },
      metadata: {
        signals: {
          initiative: signals.initiativeSignal,
          collaboration: signals.collaborationSignal,
          reasoning: signals.reasoningSignal,
        },
        observed: signals.observed,
      },
    });

    await session.log({
      summary: `Score composed: [${scores.join(', ')}]`,
      agent: { agent_address: this.agentAddress, role: 'verifier' },
      metadata: {
        scores,
        assessment: {
          compliance: assessment.compliance,
          efficiency: assessment.efficiency,
        },
      },
    });

    // Submit score to gateway
    const scoreResult = await this.postScoreSubmission({
      studio_address: metadata.studio_address,
      epoch: assessment.epoch,
      validator_address: this.agentAddress,
      data_hash: metadata.data_hash!,
      scores: [...scores],
      signer_address: this.agentAddress,
      mode: 'direct',
      worker_address: metadata.agent_address,
      salt: '0x' + '0'.repeat(64),
    });

    await session.complete({
      summary: `Verification complete — scores submitted for worker ${metadata.agent_address.slice(0, 10)}...`,
    });

    return {
      scores,
      workflowId: scoreResult.workflow_id ?? null,
      verifierSessionId: session.sessionId,
      workerSessionId,
      workerAddress: metadata.agent_address,
      dataHash: metadata.data_hash!,
    };
  }

  private async fetchSessionMetadata(sessionId: string): Promise<SessionMetadata> {
    const url = `${this.gatewayUrl}/v1/sessions/${sessionId}/context`;
    const data = await this.get<{ data: { session_metadata: SessionMetadata } }>(url);
    const meta = data.data?.session_metadata;
    if (!meta) {
      throw new Error(`Session ${sessionId} not found or missing metadata`);
    }
    return meta;
  }

  private async fetchEvidenceNodes(sessionId: string): Promise<GatewayEvidenceNode[]> {
    const url = `${this.gatewayUrl}/v1/sessions/${sessionId}/evidence`;
    const data = await this.get<{ data: { evidence_dag: { nodes: GatewayEvidenceNode[] } } }>(url);
    const nodes = data.data?.evidence_dag?.nodes;
    if (!nodes || nodes.length === 0) {
      throw new Error(`No evidence found for session ${sessionId}`);
    }
    return nodes;
  }

  private async postScoreSubmission(
    payload: Record<string, unknown>,
  ): Promise<{ workflow_id?: string }> {
    const url = `${this.gatewayUrl}/workflows/score-submission`;
    return this.post<{ workflow_id?: string }>(url, payload);
  }

  private async get<T>(url: string): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers['X-API-Key'] = this.apiKey;

    try {
      const res = await axios({ method: 'GET', url, headers, timeout: 30_000 });
      return res.data as T;
    } catch (err) {
      const axiosErr = err as AxiosError;
      const status = axiosErr.response?.status ?? 0;
      const detail = JSON.stringify(axiosErr.response?.data ?? axiosErr.message);
      throw new Error(`Verifier request failed: GET ${url} → ${status} ${detail}`);
    }
  }

  private async post<T>(url: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['X-API-Key'] = this.apiKey;

    try {
      const res = await axios({ method: 'POST', url, data: body, headers, timeout: 30_000 });
      return res.data as T;
    } catch (err) {
      const axiosErr = err as AxiosError;
      const status = axiosErr.response?.status ?? 0;
      const detail = JSON.stringify(axiosErr.response?.data ?? axiosErr.message);
      throw new Error(`Verifier request failed: POST ${url} → ${status} ${detail}`);
    }
  }
}

// =============================================================================
// Helpers
// =============================================================================

/** Transform a gateway evidence node to EvidencePackage for signal extraction. */
function toEvidencePackage(node: GatewayEvidenceNode): EvidencePackage {
  return {
    arweave_tx_id: node.node_id,
    author: node.agent_address,
    timestamp: new Date(node.timestamp).getTime() / 1000,
    parent_ids: node.parent_ids,
    payload_hash: node.payload_hash,
    artifact_ids: node.artifacts ?? [],
    signature: '',
  };
}
