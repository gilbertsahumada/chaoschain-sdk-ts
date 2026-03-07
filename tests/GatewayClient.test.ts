/**
 * GatewayClient Tests
 *
 * Tests for the Gateway HTTP client that handles workflow submission
 * to the ChaosChain Gateway service.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { GatewayClient } from '../src/GatewayClient';
import { WorkflowType, WorkflowState, ScoreSubmissionMode, WorkflowStatus } from '../src/types';
import {
  GatewayError,
  GatewayConnectionError,
  GatewayTimeoutError,
  WorkflowFailedError,
} from '../src/exceptions';

// Mock axios
vi.mock('axios');
const mockedAxios = vi.mocked(axios);

describe('GatewayClient', () => {
  let client: GatewayClient;
  const gatewayUrl = 'http://localhost:3000';

  beforeEach(() => {
    client = new GatewayClient({ gatewayUrl });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create client with default config', () => {
      const c = new GatewayClient({ gatewayUrl: 'http://test.com' });
      expect(c).toBeInstanceOf(GatewayClient);
    });

    it('should remove trailing slash from gatewayUrl', () => {
      const c = new GatewayClient({ gatewayUrl: 'http://test.com/' });
      // Access private property for testing
      expect((c as any).gatewayUrl).toBe('http://test.com');
    });

    it('should use custom timeout values', () => {
      const c = new GatewayClient({
        gatewayUrl: 'http://test.com',
        timeout: 5000,
        maxPollTime: 60000,
        pollInterval: 1000,
      });
      expect((c as any).timeout).toBe(5000);
      expect((c as any).maxPollTime).toBe(60000);
      expect((c as any).pollInterval).toBe(1000);
    });

    it('should use default timeout values when not specified', () => {
      const c = new GatewayClient({ gatewayUrl: 'http://test.com' });
      expect((c as any).timeout).toBe(30000);
      expect((c as any).maxPollTime).toBe(600000);
      expect((c as any).pollInterval).toBe(2000);
    });

    it('should accept baseUrl and normalize trailing slash', () => {
      const c = new GatewayClient({ baseUrl: 'https://gateway.chaoscha.in/' });
      expect((c as any).gatewayUrl).toBe('https://gateway.chaoscha.in');
    });

    it('should default to production ChaosChain gateway URL', () => {
      const c = new GatewayClient({});
      expect((c as any).gatewayUrl).toBe('https://gateway.chaoscha.in');
    });

    it('should throw helpful error for invalid baseUrl', () => {
      expect(() => new GatewayClient({ baseUrl: 'not-a-url' })).toThrow(
        /Invalid gateway baseUrl/i
      );
    });

    it('should resolve timeoutSeconds to milliseconds', () => {
      const c = new GatewayClient({
        gatewayUrl: 'http://test.com',
        timeoutSeconds: 2,
        maxPollTimeSeconds: 5,
        pollIntervalSeconds: 3,
      });
      expect((c as any).timeout).toBe(2000);
      expect((c as any).maxPollTime).toBe(5000);
      expect((c as any).pollInterval).toBe(3000);
    });

    it('should prioritize timeoutMs over timeoutSeconds and legacy timeout', () => {
      const c = new GatewayClient({
        gatewayUrl: 'http://test.com',
        timeoutMs: 1000,
        timeoutSeconds: 5,
        timeout: 8000,
      });
      expect((c as any).timeout).toBe(1000);
    });
  });

  describe('headers', () => {
    it('should always include Content-Type header', async () => {
      mockedAxios.mockResolvedValueOnce({
        data: { status: 'ok' },
      });

      await client.healthCheck();

      const callArgs = mockedAxios.mock.calls[0][0] as unknown as { headers: Record<string, string> };
      expect(callArgs.headers['Content-Type']).toBe('application/json');
    });

    it('should include X-API-Key when apiKey auth is enabled', async () => {
      const authedClient = new GatewayClient({
        gatewayUrl,
        auth: { authMode: 'apiKey', apiKey: 'test-key' },
      });
      mockedAxios.mockResolvedValueOnce({
        data: { status: 'ok' },
      });

      await authedClient.healthCheck();

      const callArgs = mockedAxios.mock.calls[0][0] as unknown as { headers: Record<string, string> };
      expect(callArgs.headers['X-API-Key']).toBe('test-key');
      expect(callArgs.headers['Content-Type']).toBe('application/json');
    });

    it('should include signature headers when signature auth is enabled', async () => {
      const authedClient = new GatewayClient({
        gatewayUrl,
        auth: {
          authMode: 'signature',
          signature: { address: '0xAddr', signature: '0xSig', timestamp: 12345 },
        },
      });
      mockedAxios.mockResolvedValueOnce({
        data: { status: 'ok' },
      });

      await authedClient.healthCheck();

      const callArgs = mockedAxios.mock.calls[0][0] as unknown as { headers: Record<string, string> };
      expect(callArgs.headers['X-Signature']).toBe('0xSig');
      expect(callArgs.headers['X-Timestamp']).toBe('12345');
      expect(callArgs.headers['X-Address']).toBe('0xAddr');
    });

    it('should allow user headers to override defaults', async () => {
      const customClient = new GatewayClient({
        gatewayUrl,
        headers: { 'Content-Type': 'text/plain', 'X-Custom': '1' },
      });
      mockedAxios.mockResolvedValueOnce({
        data: { status: 'ok' },
      });

      await customClient.healthCheck();

      const callArgs = mockedAxios.mock.calls[0][0] as unknown as { headers: Record<string, string> };
      expect(callArgs.headers['Content-Type']).toBe('text/plain');
      expect(callArgs.headers['X-Custom']).toBe('1');
    });
  });

  describe('error taxonomy', () => {
    const getError = async () => {
      try {
        await client.healthCheck();
      } catch (error) {
        return error as any;
      }
      throw new Error('Expected request to fail');
    };

    it('should classify 401/403 as auth errors', async () => {
      mockedAxios.mockRejectedValueOnce({
        response: { status: 401, data: { message: 'unauthorized' } },
      });
      const error401 = await getError();
      expect(error401.details.category).toBe('auth');
      expect(error401.details.retryable).toBe(false);

      mockedAxios.mockRejectedValueOnce({
        response: { status: 403, data: { message: 'forbidden' } },
      });
      const error403 = await getError();
      expect(error403.details.category).toBe('auth');
      expect(error403.details.retryable).toBe(false);
    });

    it('should classify 429/5xx as transient errors', async () => {
      mockedAxios.mockRejectedValueOnce({
        response: { status: 429, data: { message: 'rate limit' } },
      });
      const error429 = await getError();
      expect(error429.details.category).toBe('transient');
      expect(error429.details.retryable).toBe(true);

      mockedAxios.mockRejectedValueOnce({
        response: { status: 500, data: { message: 'server error' } },
      });
      const error500 = await getError();
      expect(error500.details.category).toBe('transient');
      expect(error500.details.retryable).toBe(true);
    });

    it('should classify 4xx as permanent errors', async () => {
      mockedAxios.mockRejectedValueOnce({
        response: { status: 404, data: { message: 'not found' } },
      });
      const error404 = await getError();
      expect(error404.details.category).toBe('permanent');
      expect(error404.details.retryable).toBe(false);
    });
  });

  describe('retry behavior', () => {
    it('should not retry by default', async () => {
      mockedAxios.mockRejectedValueOnce({
        response: { status: 500, data: { message: 'server error' } },
      });

      await expect(client.healthCheck()).rejects.toThrow(GatewayError);
      expect(mockedAxios).toHaveBeenCalledTimes(1);
    });

    it('should retry only transient errors when enabled', async () => {
      const retryClient = new GatewayClient({
        gatewayUrl,
        retry: { enabled: true, maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0, jitter: false },
      });
      mockedAxios.mockRejectedValue({
        response: { status: 500, data: { message: 'server error' } },
      });

      await expect(retryClient.healthCheck()).rejects.toThrow(GatewayError);
      expect(mockedAxios).toHaveBeenCalledTimes(3);
    });

    it('should not retry auth errors when enabled', async () => {
      const retryClient = new GatewayClient({
        gatewayUrl,
        retry: { enabled: true, maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0, jitter: false },
      });
      mockedAxios.mockRejectedValueOnce({
        response: { status: 401, data: { message: 'unauthorized' } },
      });

      await expect(retryClient.healthCheck()).rejects.toThrow(GatewayError);
      expect(mockedAxios).toHaveBeenCalledTimes(1);
    });

    it('should not retry permanent errors when enabled', async () => {
      const retryClient = new GatewayClient({
        gatewayUrl,
        retry: { enabled: true, maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0, jitter: false },
      });
      mockedAxios.mockRejectedValueOnce({
        response: { status: 404, data: { message: 'not found' } },
      });

      await expect(retryClient.healthCheck()).rejects.toThrow(GatewayError);
      expect(mockedAxios).toHaveBeenCalledTimes(1);
    });
  });

  describe('healthCheck', () => {
    it('should return health status from Gateway', async () => {
      mockedAxios.mockResolvedValueOnce({
        data: { status: 'ok', timestamp: 1234567890 },
      });

      const result = await client.healthCheck();

      expect(result).toEqual({ status: 'ok', timestamp: 1234567890 });
      expect(mockedAxios).toHaveBeenCalledWith({
        method: 'GET',
        url: `${gatewayUrl}/health`,
        data: undefined,
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    it('should throw GatewayConnectionError on connection failure', async () => {
      mockedAxios.mockRejectedValueOnce({
        code: 'ECONNREFUSED',
        message: 'Connection refused',
      });

      await expect(client.healthCheck()).rejects.toThrow(GatewayConnectionError);
    });
  });

  describe('isHealthy', () => {
    it('should return true when Gateway is healthy', async () => {
      mockedAxios.mockResolvedValueOnce({
        data: { status: 'ok' },
      });

      const result = await client.isHealthy();
      expect(result).toBe(true);
    });

    it('should return false when Gateway returns non-ok status', async () => {
      mockedAxios.mockResolvedValueOnce({
        data: { status: 'error' },
      });

      const result = await client.isHealthy();
      expect(result).toBe(false);
    });

    it('should return false when Gateway is unreachable', async () => {
      mockedAxios.mockRejectedValueOnce({
        code: 'ECONNREFUSED',
      });

      const result = await client.isHealthy();
      expect(result).toBe(false);
    });
  });

  describe('submitWork', () => {
    const workflowResponse = {
      id: 'workflow-123',
      type: 'WorkSubmission',
      state: 'CREATED',
      step: 'initialized',
      created_at: 1234567890,
      updated_at: 1234567890,
      progress: {},
    };

    it('should submit work and return workflow status', async () => {
      mockedAxios.mockResolvedValueOnce({ data: workflowResponse });

      const result = await client.submitWork(
        '0xStudioAddress',
        1,
        '0xAgentAddress',
        '0xDataHash',
        '0xThreadRoot',
        '0xEvidenceRoot',
        'evidence content',
        '0xSignerAddress'
      );

      expect(result.workflowId).toBe('workflow-123');
      expect(result.workflowType).toBe(WorkflowType.WORK_SUBMISSION);
      expect(result.state).toBe(WorkflowState.CREATED);
      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          url: `${gatewayUrl}/workflows/work-submission`,
        })
      );
    });

    it('should encode Buffer evidence as base64', async () => {
      mockedAxios.mockResolvedValueOnce({ data: workflowResponse });

      const buffer = Buffer.from('test evidence');
      await client.submitWork(
        '0xStudio',
        1,
        '0xAgent',
        '0xHash',
        '0xThread',
        '0xEvidence',
        buffer,
        '0xSigner'
      );

      const callArgs = mockedAxios.mock.calls[0][0] as unknown as { data: Record<string, any> };
      expect(callArgs.data.evidence_content).toBe(buffer.toString('base64'));
    });
  });

  describe('submitScore', () => {
    const workflowResponse = {
      id: 'workflow-456',
      type: 'ScoreSubmission',
      state: 'CREATED',
      step: 'initialized',
      created_at: 1234567890,
      updated_at: 1234567890,
      progress: {},
    };

    it('should submit score in DIRECT mode', async () => {
      mockedAxios.mockResolvedValueOnce({ data: workflowResponse });

      const result = await client.submitScore(
        '0xStudio',
        1,
        '0xValidator',
        '0xDataHash',
        [8000, 9000, 7500],
        '0xSigner',
        { workerAddress: '0xWorker', mode: ScoreSubmissionMode.DIRECT }
      );

      expect(result.workflowId).toBe('workflow-456');
      expect(result.workflowType).toBe(WorkflowType.SCORE_SUBMISSION);

      const callArgs = mockedAxios.mock.calls[0][0] as unknown as { data: Record<string, any> };
      expect(callArgs.data.mode).toBe('direct');
      expect(callArgs.data.worker_address).toBe('0xWorker');
    });

    it('should throw error if workerAddress missing in DIRECT mode', async () => {
      await expect(
        client.submitScore('0xStudio', 1, '0xValidator', '0xDataHash', [8000], '0xSigner', {
          mode: ScoreSubmissionMode.DIRECT,
        })
      ).rejects.toThrow('workerAddress is required for DIRECT');
    });

    it('should submit score in COMMIT_REVEAL mode', async () => {
      mockedAxios.mockResolvedValueOnce({ data: workflowResponse });

      await client.submitScore('0xStudio', 1, '0xValidator', '0xDataHash', [8000], '0xSigner', {
        salt: '0xSalt123',
        mode: ScoreSubmissionMode.COMMIT_REVEAL,
      });

      const callArgs = mockedAxios.mock.calls[0][0] as unknown as { data: Record<string, any> };
      expect(callArgs.data.mode).toBe('commit_reveal');
      expect(callArgs.data.salt).toBe('0xSalt123');
    });

    it('should throw error if salt missing in COMMIT_REVEAL mode', async () => {
      await expect(
        client.submitScore('0xStudio', 1, '0xValidator', '0xDataHash', [8000], '0xSigner', {
          mode: ScoreSubmissionMode.COMMIT_REVEAL,
        })
      ).rejects.toThrow('salt is required for COMMIT_REVEAL');
    });
  });

  describe('closeEpoch', () => {
    it('should close epoch and return workflow status', async () => {
      const workflowResponse = {
        id: 'workflow-789',
        type: 'CloseEpoch',
        state: 'CREATED',
        step: 'initialized',
        created_at: 1234567890,
        updated_at: 1234567890,
        progress: {},
      };

      mockedAxios.mockResolvedValueOnce({ data: workflowResponse });

      const result = await client.closeEpoch('0xStudio', 1, '0xSigner');

      expect(result.workflowId).toBe('workflow-789');
      expect(result.workflowType).toBe(WorkflowType.CLOSE_EPOCH);
      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          url: `${gatewayUrl}/workflows/close-epoch`,
        })
      );
    });
  });

  describe('getWorkflow', () => {
    it('should get workflow status by ID', async () => {
      const workflowResponse = {
        id: 'workflow-123',
        type: 'WorkSubmission',
        state: 'COMPLETED',
        step: 'done',
        created_at: 1234567890,
        updated_at: 1234567899,
        progress: {
          arweave_tx_id: 'ar-tx-123',
          arweave_confirmed: true,
          onchain_tx_hash: '0xTxHash',
          onchain_confirmed: true,
          onchain_block: 12345,
        },
      };

      mockedAxios.mockResolvedValueOnce({ data: workflowResponse });

      const result = await client.getWorkflow('workflow-123');

      expect(result.workflowId).toBe('workflow-123');
      expect(result.state).toBe(WorkflowState.COMPLETED);
      expect(result.progress.arweaveTxId).toBe('ar-tx-123');
      expect(result.progress.onchainTxHash).toBe('0xTxHash');
    });
  });

  describe('listWorkflows', () => {
    it('should list workflows with filters', async () => {
      mockedAxios.mockResolvedValueOnce({
        data: {
          workflows: [
            {
              id: 'wf-1',
              type: 'WorkSubmission',
              state: 'COMPLETED',
              step: 'done',
              created_at: 1234567890,
              updated_at: 1234567890,
              progress: {},
            },
            {
              id: 'wf-2',
              type: 'ScoreSubmission',
              state: 'RUNNING',
              step: 'submitting',
              created_at: 1234567891,
              updated_at: 1234567891,
              progress: {},
            },
          ],
        },
      });

      const result = await client.listWorkflows({
        studio: '0xStudio',
        state: 'COMPLETED',
      });

      expect(result).toHaveLength(2);
      expect(result[0].workflowId).toBe('wf-1');
      expect(result[1].workflowId).toBe('wf-2');
    });

    it('should handle empty workflow list', async () => {
      mockedAxios.mockResolvedValueOnce({
        data: { workflows: [] },
      });

      const result = await client.listWorkflows();
      expect(result).toHaveLength(0);
    });
  });

  describe('waitForCompletion', () => {
    it('should return immediately if workflow is COMPLETED', async () => {
      mockedAxios.mockResolvedValueOnce({
        data: {
          id: 'workflow-123',
          type: 'WorkSubmission',
          state: 'COMPLETED',
          step: 'done',
          created_at: 1234567890,
          updated_at: 1234567890,
          progress: {},
        },
      });

      const result = await client.waitForCompletion('workflow-123');

      expect(result.state).toBe(WorkflowState.COMPLETED);
      expect(mockedAxios).toHaveBeenCalledTimes(1);
    });

    it('should poll until workflow completes', async () => {
      // First call: RUNNING
      mockedAxios.mockResolvedValueOnce({
        data: {
          id: 'workflow-123',
          type: 'WorkSubmission',
          state: 'RUNNING',
          step: 'uploading',
          created_at: 1234567890,
          updated_at: 1234567890,
          progress: {},
        },
      });

      // Second call: COMPLETED
      mockedAxios.mockResolvedValueOnce({
        data: {
          id: 'workflow-123',
          type: 'WorkSubmission',
          state: 'COMPLETED',
          step: 'done',
          created_at: 1234567890,
          updated_at: 1234567891,
          progress: {},
        },
      });

      const result = await client.waitForCompletion('workflow-123', {
        pollInterval: 10, // Fast polling for test
      });

      expect(result.state).toBe(WorkflowState.COMPLETED);
      expect(mockedAxios).toHaveBeenCalledTimes(2);
    });

    it('should throw WorkflowFailedError if workflow fails', async () => {
      mockedAxios.mockResolvedValueOnce({
        data: {
          id: 'workflow-123',
          type: 'WorkSubmission',
          state: 'FAILED',
          step: 'uploading',
          created_at: 1234567890,
          updated_at: 1234567890,
          progress: {},
          error: {
            step: 'uploading',
            message: 'Upload failed',
            code: 'UPLOAD_ERROR',
          },
        },
      });

      await expect(client.waitForCompletion('workflow-123')).rejects.toThrow(WorkflowFailedError);
    });

    it('should throw GatewayTimeoutError if maxWait exceeded', async () => {
      // Always return RUNNING
      mockedAxios.mockResolvedValue({
        data: {
          id: 'workflow-123',
          type: 'WorkSubmission',
          state: 'RUNNING',
          step: 'uploading',
          created_at: 1234567890,
          updated_at: 1234567890,
          progress: {},
        },
      });

      await expect(
        client.waitForCompletion('workflow-123', {
          maxWait: 50,
          pollInterval: 10,
        })
      ).rejects.toThrow(GatewayTimeoutError);
    });

    it('should call onProgress callback on each poll', async () => {
      const onProgress = vi.fn();

      mockedAxios.mockResolvedValueOnce({
        data: {
          id: 'workflow-123',
          type: 'WorkSubmission',
          state: 'RUNNING',
          step: 'uploading',
          created_at: 1234567890,
          updated_at: 1234567890,
          progress: {},
        },
      });

      mockedAxios.mockResolvedValueOnce({
        data: {
          id: 'workflow-123',
          type: 'WorkSubmission',
          state: 'COMPLETED',
          step: 'done',
          created_at: 1234567890,
          updated_at: 1234567891,
          progress: {},
        },
      });

      await client.waitForCompletion('workflow-123', {
        pollInterval: 10,
        onProgress,
      });

      expect(onProgress).toHaveBeenCalledTimes(2);
    });
  });
});

describe('Gateway Exceptions', () => {
  describe('GatewayError', () => {
    it('should create error with message', () => {
      const error = new GatewayError('Test error');
      expect(error.message).toBe('Test error');
      expect(error.name).toBe('GatewayError');
    });

    it('should create error with statusCode and response', () => {
      const error = new GatewayError('Test error', {
        statusCode: 500,
        response: { error: 'Internal error' },
      });
      expect(error.statusCode).toBe(500);
      expect(error.response).toEqual({ error: 'Internal error' });
    });
  });

  describe('GatewayConnectionError', () => {
    it('should create connection error', () => {
      const error = new GatewayConnectionError('Connection failed');
      expect(error.message).toBe('Connection failed');
      expect(error.name).toBe('GatewayConnectionError');
      expect(error).toBeInstanceOf(GatewayError);
    });
  });

  describe('GatewayTimeoutError', () => {
    it('should create timeout error with workflowId', () => {
      const error = new GatewayTimeoutError('workflow-123', 'Timeout');
      expect(error.message).toBe('Timeout');
      expect(error.workflowId).toBe('workflow-123');
      expect(error.name).toBe('GatewayTimeoutError');
    });

    it('should include lastStatus if provided', () => {
      const lastStatus: WorkflowStatus = {
        workflowId: 'workflow-123',
        workflowType: WorkflowType.WORK_SUBMISSION,
        state: WorkflowState.RUNNING,
        step: 'uploading',
        createdAt: 1234567890,
        updatedAt: 1234567890,
        progress: {},
      };

      const error = new GatewayTimeoutError('workflow-123', 'Timeout', lastStatus);
      expect(error.lastStatus).toEqual(lastStatus);
    });
  });

  describe('WorkflowFailedError', () => {
    it('should create workflow failed error', () => {
      const workflowError = {
        step: 'uploading',
        message: 'Upload failed',
        code: 'UPLOAD_ERROR',
      };

      const error = new WorkflowFailedError('workflow-123', workflowError);

      expect(error.message).toContain('workflow-123');
      expect(error.message).toContain('uploading');
      expect(error.message).toContain('Upload failed');
      expect(error.workflowId).toBe('workflow-123');
      expect(error.workflowError).toEqual(workflowError);
      expect(error.name).toBe('WorkflowFailedError');
    });
  });
});

// =============================================================================
// getPendingWork
// =============================================================================

describe('GatewayClient — getPendingWork', () => {
  let client: GatewayClient;
  const gatewayUrl = 'http://localhost:3000';

  beforeEach(() => {
    client = new GatewayClient({ gatewayUrl });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const STUDIO = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

  it('returns pending work items', async () => {
    const mockResponse = {
      data: {
        version: '1.0',
        data: {
          studio: STUDIO,
          work: [{ work_id: '0xabc', agent_id: 42, epoch: 1, submitted_at: '2026-03-01T00:00:00.000Z', evidence_anchor: null, derivation_root: null }],
          total: 1,
          limit: 20,
          offset: 0,
        },
      },
    };
    mockedAxios.get.mockResolvedValueOnce(mockResponse);

    const result = await client.getPendingWork(STUDIO);
    expect(result.data.work).toHaveLength(1);
    expect(result.data.studio).toBe(STUDIO);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining(`/v1/studio/${STUDIO}/work`),
      expect.any(Object),
    );
  });

  it('handles empty response', async () => {
    const mockResponse = {
      data: {
        version: '1.0',
        data: { studio: STUDIO, work: [], total: 0, limit: 20, offset: 0 },
      },
    };
    mockedAxios.get.mockResolvedValueOnce(mockResponse);

    const result = await client.getPendingWork(STUDIO);
    expect(result.data.work).toHaveLength(0);
    expect(result.data.total).toBe(0);
  });

  it('throws GatewayConnectionError when gateway unreachable', async () => {
    const networkError = { code: 'ECONNREFUSED', response: undefined, message: 'Network error' };
    mockedAxios.get.mockRejectedValueOnce(networkError);

    await expect(client.getPendingWork(STUDIO)).rejects.toThrow(GatewayConnectionError);

    mockedAxios.get.mockRejectedValueOnce(networkError);
    await expect(client.getPendingWork(STUDIO)).rejects.toThrow(/gateway unreachable/i);
  });
});

// =============================================================================
// getWorkEvidence
// =============================================================================

describe('GatewayClient — getWorkEvidence', () => {
  let client: GatewayClient;
  const gatewayUrl = 'http://localhost:3000';

  beforeEach(() => {
    client = new GatewayClient({ gatewayUrl });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns work evidence payload', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        version: '1.0',
        data: {
          work_id: '0xwork',
          thread_root: '0xthread',
          dkg_evidence: [],
        },
      },
    });

    const result = await client.getWorkEvidence('0xwork');
    expect(result.data.work_id).toBe('0xwork');
    expect(mockedAxios.get).toHaveBeenCalledWith(
      `${gatewayUrl}/v1/work/0xwork/evidence`,
      expect.any(Object)
    );
  });
});

describe('Workflow Types', () => {
  it('should have correct WorkflowType values', () => {
    expect(WorkflowType.WORK_SUBMISSION).toBe('WorkSubmission');
    expect(WorkflowType.SCORE_SUBMISSION).toBe('ScoreSubmission');
    expect(WorkflowType.CLOSE_EPOCH).toBe('CloseEpoch');
  });

  it('should have correct WorkflowState values', () => {
    expect(WorkflowState.CREATED).toBe('CREATED');
    expect(WorkflowState.RUNNING).toBe('RUNNING');
    expect(WorkflowState.STALLED).toBe('STALLED');
    expect(WorkflowState.COMPLETED).toBe('COMPLETED');
    expect(WorkflowState.FAILED).toBe('FAILED');
  });

  it('should have correct ScoreSubmissionMode values', () => {
    expect(ScoreSubmissionMode.DIRECT).toBe('direct');
    expect(ScoreSubmissionMode.COMMIT_REVEAL).toBe('commit_reveal');
  });
});
