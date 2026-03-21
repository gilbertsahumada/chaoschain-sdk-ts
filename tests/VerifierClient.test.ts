/**
 * VerifierClient Tests
 *
 * Tests for the VerifierClient that reviews worker sessions
 * and submits scores via the gateway.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { VerifierClient } from '../src/session/VerifierClient';

vi.mock('axios');
const mockedAxios = vi.mocked(axios);

const VERIFIER_ADDRESS = '0xVerifier';
const WORKER_ADDRESS = '0xWorker';
const STUDIO_ADDRESS = '0xStudio';
const DATA_HASH = '0xdatahash123';
const SESSION_ID = 'sess_test123';

function mockContextResponse() {
  return {
    data: {
      data: {
        session_metadata: {
          session_id: SESSION_ID,
          studio_address: STUDIO_ADDRESS,
          agent_address: WORKER_ADDRESS,
          data_hash: DATA_HASH,
          workflow_id: 'wf-worker-123',
          status: 'completed',
          event_count: 4,
          studio_policy_version: 'engineering-studio-default-v1',
          work_mandate_id: 'generic-task',
          task_type: 'feature',
        },
        studioPolicy: {
          version: '1.0',
          studioName: 'Engineering Agent Studio',
          scoring: {
            initiative: { rootRatio: { min: 0.2, target: 0.6, max: 1 } },
            collaboration: {
              edgeDensity: { min: 0.2, target: 0.8, max: 1 },
              integrationRatio: { min: 0, target: 0.3, max: 0.7 },
              weights: { edgeDensity: 0.6, integrationRatio: 0.4 },
            },
            reasoning: { depthRatio: { min: 0.2, target: 0.6, max: 1 } },
            compliance: {
              requiredChecks: ['tests_present'],
              forbiddenPatterns: [],
              requiredArtifacts: ['code-change'],
              weights: { testsPresent: 0.4, requiredArtifactsPresent: 0.3, noPolicyViolations: 0.3 },
            },
            efficiency: {
              artifactCountRatio: { min: 0.2, target: 1, max: 2 },
              weights: { artifactCountRatio: 1 },
            },
          },
        },
        workMandate: {
          taskId: 'generic-task',
          title: 'General task',
          objective: 'Complete assigned work',
          taskType: 'general',
        },
      },
    },
  };
}

function mockEvidenceResponse() {
  return {
    data: {
      data: {
        evidence_dag: {
          nodes: [
            {
              node_id: 'evt-1',
              event_id: 'evt-1',
              session_id: SESSION_ID,
              event_type: 'plan_created',
              agent_address: WORKER_ADDRESS,
              timestamp: '2026-03-21T10:00:00.000Z',
              parent_ids: [],
              payload_hash: '0xhash1',
              summary: 'Planning phase',
              artifacts: [],
              metadata: {},
            },
            {
              node_id: 'evt-2',
              event_id: 'evt-2',
              session_id: SESSION_ID,
              event_type: 'file_written',
              agent_address: WORKER_ADDRESS,
              timestamp: '2026-03-21T10:01:00.000Z',
              parent_ids: ['evt-1'],
              payload_hash: '0xhash2',
              summary: 'Implementation',
              artifacts: [],
              metadata: {},
            },
            {
              node_id: 'evt-3',
              event_id: 'evt-3',
              session_id: SESSION_ID,
              event_type: 'test_run',
              agent_address: WORKER_ADDRESS,
              timestamp: '2026-03-21T10:02:00.000Z',
              parent_ids: ['evt-2'],
              payload_hash: '0xhash3',
              summary: 'Tests pass',
              artifacts: [],
              metadata: {},
            },
          ],
        },
      },
    },
  };
}

function mockSessionStartResponse() {
  return { data: { data: { session_id: 'sess_verifier_123' } } };
}

function mockEventPostResponse() {
  return { data: {} };
}

function mockCompleteResponse() {
  return { data: { data: { workflow_id: 'wf-verifier', data_hash: '0xvhash' } } };
}

function mockScoreSubmissionResponse() {
  return { data: { workflow_id: 'wf-score-123', id: 'wf-score-123' } };
}

function mockWorkflowPollResponse() {
  return { data: { data: { state: 'COMPLETED' } } };
}

function createVerifier() {
  return new VerifierClient({
    gatewayUrl: 'http://localhost:3001',
    apiKey: 'test-key',
    agentAddress: VERIFIER_ADDRESS,
  });
}

function setupMocks() {
  let callIndex = 0;
  mockedAxios.mockImplementation(async (config: any) => {
    const { method, url } = config;

    // GET /context
    if (method === 'GET' && url.includes('/context')) {
      return mockContextResponse();
    }
    // GET /evidence
    if (method === 'GET' && url.includes('/evidence')) {
      return mockEvidenceResponse();
    }
    // POST /v1/sessions (create session)
    if (method === 'POST' && url.endsWith('/v1/sessions')) {
      return mockSessionStartResponse();
    }
    // POST /events (log event)
    if (method === 'POST' && url.includes('/events')) {
      return mockEventPostResponse();
    }
    // POST /complete
    if (method === 'POST' && url.includes('/complete')) {
      return mockCompleteResponse();
    }
    // POST /score-submission
    if (method === 'POST' && url.includes('/score-submission')) {
      return mockScoreSubmissionResponse();
    }
    // GET /workflows/{id} (poll)
    if (method === 'GET' && url.includes('/workflows/')) {
      return mockWorkflowPollResponse();
    }

    return { data: {} };
  });
}

describe('VerifierClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('review()', () => {
    it('should review and submit score in one call', async () => {
      const verifier = createVerifier();
      const result = await verifier.review(SESSION_ID, {
        compliance: 80,
        efficiency: 75,
        epoch: 1,
      });

      expect(result.workerSessionId).toBe(SESSION_ID);
      expect(result.workerAddress).toBe(WORKER_ADDRESS);
      expect(result.dataHash).toBe(DATA_HASH);
      expect(result.verifierSessionId).toBe('sess_verifier_123');
      expect(result.scores).toHaveLength(5);
      expect(result.scores.every((s) => s >= 0 && s <= 100)).toBe(true);
    });

    it('should submit correct score payload to gateway', async () => {
      const verifier = createVerifier();
      await verifier.review(SESSION_ID, {
        compliance: 80,
        efficiency: 75,
        epoch: 2,
      });

      // Find the score-submission call
      const scoreCall = mockedAxios.mock.calls.find(
        (c: any) => c[0].url?.includes('/score-submission'),
      );
      expect(scoreCall).toBeDefined();

      const payload = (scoreCall as any)[0].data;
      expect(payload.studio_address).toBe(STUDIO_ADDRESS);
      expect(payload.epoch).toBe(2);
      expect(payload.validator_address).toBe(VERIFIER_ADDRESS);
      expect(payload.data_hash).toBe(DATA_HASH);
      expect(payload.worker_address).toBe(WORKER_ADDRESS);
      expect(payload.mode).toBe('direct');
      expect(payload.scores).toHaveLength(5);
    });

    it('should create a verifier session with verification events', async () => {
      const verifier = createVerifier();
      await verifier.review(SESSION_ID, {
        compliance: 80,
        efficiency: 75,
        epoch: 1,
      });

      // Find session creation call
      const sessionCall = mockedAxios.mock.calls.find(
        (c: any) => c[0].method === 'POST' && c[0].url?.endsWith('/v1/sessions'),
      );
      expect(sessionCall).toBeDefined();

      const sessionPayload = (sessionCall as any)[0].data;
      expect(sessionPayload.agent_address).toBe(VERIFIER_ADDRESS);
      expect(sessionPayload.task_type).toBe('verification');

      // Find event logging calls (should be 3: review, validate, score)
      const eventCalls = mockedAxios.mock.calls.filter(
        (c: any) => c[0].method === 'POST' && c[0].url?.includes('/events'),
      );
      expect(eventCalls.length).toBe(3);
    });

    it('should pass optional score overrides', async () => {
      const verifier = createVerifier();
      const result = await verifier.review(SESSION_ID, {
        compliance: 90,
        efficiency: 85,
        epoch: 1,
        initiative: 70,
        collaboration: 60,
        reasoning: 95,
      });

      // With overrides, scores should reflect the provided values
      expect(result.scores[0]).toBe(70); // initiative
      expect(result.scores[1]).toBe(60); // collaboration
      expect(result.scores[2]).toBe(95); // reasoning
      expect(result.scores[3]).toBe(90); // compliance
      expect(result.scores[4]).toBe(85); // efficiency
    });
  });

  describe('inspect()', () => {
    it('should validate DAG and return signals, events, and metadata', async () => {
      const verifier = createVerifier();
      const review = await verifier.inspect(SESSION_ID);

      expect(review.valid).toBe(true);
      expect(review.workerAddress).toBe(WORKER_ADDRESS);
      expect(review.studioAddress).toBe(STUDIO_ADDRESS);
      expect(review.dataHash).toBe(DATA_HASH);
      expect(review.nodeCount).toBe(3);
      expect(review.events).toHaveLength(3);
      expect(review.signals).toBeDefined();
      expect(review.signals!.initiativeSignal).toBeGreaterThanOrEqual(0);
      expect(review.signals!.collaborationSignal).toBeGreaterThanOrEqual(0);
      expect(review.signals!.reasoningSignal).toBeGreaterThanOrEqual(0);
    });

    it('should provide a submit function', async () => {
      const verifier = createVerifier();
      const review = await verifier.inspect(SESSION_ID);

      expect(typeof review.submit).toBe('function');

      const result = await review.submit({
        compliance: 80,
        efficiency: 75,
        epoch: 1,
      });

      expect(result.scores).toHaveLength(5);
      expect(result.workerSessionId).toBe(SESSION_ID);
    });

    it('should reject invalid DAG on submit', async () => {
      // Create evidence with broken parent reference
      mockedAxios.mockImplementation(async (config: any) => {
        if (config.method === 'GET' && config.url.includes('/context')) {
          return mockContextResponse();
        }
        if (config.method === 'GET' && config.url.includes('/evidence')) {
          return {
            data: {
              data: {
                evidence_dag: {
                  nodes: [
                    {
                      node_id: 'evt-1',
                      event_id: 'evt-1',
                      session_id: SESSION_ID,
                      event_type: 'plan_created',
                      agent_address: WORKER_ADDRESS,
                      timestamp: '2026-03-21T10:00:00.000Z',
                      parent_ids: ['nonexistent-parent'],
                      payload_hash: '0xhash1',
                      summary: 'Broken parent reference',
                      artifacts: [],
                      metadata: {},
                    },
                  ],
                },
              },
            },
          };
        }
        return { data: {} };
      });

      const verifier = createVerifier();
      const review = await verifier.inspect(SESSION_ID);

      expect(review.valid).toBe(false);
      expect(review.signals).toBeUndefined();
      expect(() => review.submit({ compliance: 80, efficiency: 75, epoch: 1 }))
        .toThrow('evidence DAG for session');
    });

    it('should throw on review() with invalid DAG', async () => {
      mockedAxios.mockImplementation(async (config: any) => {
        if (config.method === 'GET' && config.url.includes('/context')) {
          return mockContextResponse();
        }
        if (config.method === 'GET' && config.url.includes('/evidence')) {
          return {
            data: {
              data: {
                evidence_dag: {
                  nodes: [
                    {
                      node_id: 'evt-1',
                      event_id: 'evt-1',
                      session_id: SESSION_ID,
                      event_type: 'plan_created',
                      agent_address: WORKER_ADDRESS,
                      timestamp: '2026-03-21T10:00:00.000Z',
                      parent_ids: ['nonexistent-parent'],
                      payload_hash: '0xhash1',
                      summary: 'Broken',
                      artifacts: [],
                      metadata: {},
                    },
                  ],
                },
              },
            },
          };
        }
        return { data: {} };
      });

      const verifier = createVerifier();
      await expect(verifier.review(SESSION_ID, { compliance: 80, efficiency: 75, epoch: 1 }))
        .rejects.toThrow('evidence DAG for session');
    });

    it('should throw if session has no data_hash', async () => {
      mockedAxios.mockImplementation(async (config: any) => {
        if (config.method === 'GET' && config.url.includes('/context')) {
          const resp = mockContextResponse();
          resp.data.data.session_metadata.data_hash = null;
          return resp;
        }
        return { data: {} };
      });

      const verifier = createVerifier();
      await expect(verifier.inspect(SESSION_ID)).rejects.toThrow('no data_hash');
    });
  });

  describe('verifier session evidence', () => {
    it('should log reviewed session metadata in events', async () => {
      const verifier = createVerifier();
      await verifier.review(SESSION_ID, {
        compliance: 80,
        efficiency: 75,
        epoch: 1,
      });

      const eventCalls = mockedAxios.mock.calls.filter(
        (c: any) => c[0].method === 'POST' && c[0].url?.includes('/events'),
      );

      // First event should reference the worker session
      const firstEventPayload = eventCalls[0][0].data[0];
      expect(firstEventPayload.metadata.reviewed_session_id).toBe(SESSION_ID);
      expect(firstEventPayload.metadata.reviewed_data_hash).toBe(DATA_HASH);
      expect(firstEventPayload.metadata.reviewed_worker_address).toBe(WORKER_ADDRESS);
      expect(firstEventPayload.agent.agent_address).toBe(VERIFIER_ADDRESS);
      expect(firstEventPayload.agent.role).toBe('verifier');
    });

    it('should log scores in final event metadata', async () => {
      const verifier = createVerifier();
      await verifier.review(SESSION_ID, {
        compliance: 80,
        efficiency: 75,
        epoch: 1,
      });

      const eventCalls = mockedAxios.mock.calls.filter(
        (c: any) => c[0].method === 'POST' && c[0].url?.includes('/events'),
      );

      // Third event should have the composed scores
      const scoreEvent = eventCalls[2][0].data[0];
      expect(scoreEvent.metadata.scores).toHaveLength(5);
      expect(scoreEvent.metadata.assessment.compliance).toBe(80);
      expect(scoreEvent.metadata.assessment.efficiency).toBe(75);
    });
  });
});
