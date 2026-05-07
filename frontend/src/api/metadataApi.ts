import axios from 'axios';

const BASE = import.meta.env.VITE_API_BASE_URL ?? '';

export interface ImageLabel {
  name: string;
  confidence: number;
  categories: string[];
  hasBoundingBox: boolean;
}

export interface ImageRecord {
  imageId: string;
  userId: string;
  status: 'PENDING' | 'PROCESSING' | 'PROCESSED' | 'FAILED' | 'DUPLICATE';
  objectKey: string;
  dominantLabel?: string;
  confidenceScore?: number;
  labels?: string[];
  labelDetails?: ImageLabel[];
  processingLatencyMs?: number;
  uploadTime: string;
  updatedAt: string;
  errorType?: string;
  errorMessage?: string;
  retryCount?: number;
  duplicateOf?: string;
  coldStart?: boolean;
  replaySource?: string;
}

export interface PagedResponse {
  images: ImageRecord[];
  count: number;
  nextToken: string | null;
}

export interface MetricsSummary {
  summary: Record<string, number>;
  total: number;
  failureRate: number;
  duplicateRate: number;
  timestamp: string;
}

export async function fetchImages(params?: {
  userId?: string;
  status?: string;
  limit?: number;
  nextToken?: string;
}): Promise<PagedResponse> {
  const { data } = await axios.get<PagedResponse>(`${BASE}/images`, { params });
  return data;
}

export async function fetchImage(imageId: string): Promise<ImageRecord> {
  const { data } = await axios.get<{ image: ImageRecord }>(`${BASE}/images/${imageId}`);
  return data.image;
}

export async function fetchMetricsSummary(): Promise<MetricsSummary> {
  const { data } = await axios.get<MetricsSummary>(`${BASE}/metrics/summary`);
  return data;
}

export interface OpsRecommendation {
  recommendationId: string;
  timestamp: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  category: string;
  sourceMetric: string;
  description: string;
  recommendedAction: string;
  confidence: string;
  status: string;
  metrics?: string;
}

export async function fetchOpsRecommendations(): Promise<OpsRecommendation[]> {
  const { data } = await axios.get<{ images: OpsRecommendation[] }>(`${BASE}/images`, {
    params: { table: 'ops' },
  });
  return data.images ?? [];
}

export interface AgentStep {
  type: 'reasoning' | 'tool_call';
  iteration: number;
  text?: string;
  tool?: string;
  inputs?: Record<string, unknown>;
  result?: unknown;
}

export interface AgentRun {
  runId: string;
  timestamp: string;
  status: 'COMPLETED' | 'FAILED' | 'RUNNING';
  finalSummary: string;
  steps: AgentStep[];
  toolsCalled: string[];
  actionsTaken: string[];
  iterations: number;
  durationMs: number;
  model: string;
  error?: string;
}

export async function fetchAgentRuns(limit = 5): Promise<AgentRun[]> {
  const { data } = await axios.get<{ runs: AgentRun[] }>(`${BASE}/agent/runs`, { params: { limit } });
  return data.runs ?? [];
}

export async function triggerAgentRun(): Promise<{ runId: string }> {
  const { data } = await axios.post<{ runId: string }>(`${BASE}/agent/runs/trigger`);
  return data;
}
