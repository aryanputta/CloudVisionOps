import React, { useState } from 'react';
import { ImageUploader } from './components/ImageUploader';
import { ImageResults } from './components/ImageResults';
import { MetricsPanel } from './components/MetricsPanel';
import { OpsRecommendations } from './components/OpsRecommendations';
import { AgentReasoningPanel } from './components/AgentReasoningPanel';
import { useAuth, buildLoginUrl } from './auth/useAuth';
import { Activity, Layers, LogOut, LogIn } from 'lucide-react';

export default function App() {
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const { isAuthenticated, loading, signOut } = useAuth();

  const handleUploadComplete = (_imageId: string) => {
    setTimeout(() => setRefreshTrigger((n) => n + 1), 2000);
  };

  // Auth gate — show sign-in screen if Cognito env vars are set and user is not authenticated
  const cognitoConfigured = Boolean(import.meta.env.VITE_COGNITO_DOMAIN && import.meta.env.VITE_COGNITO_CLIENT_ID);
  if (cognitoConfigured && !loading && !isAuthenticated) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="flex items-center justify-center gap-2 mb-6">
            <Layers size={24} className="text-aws-orange" />
            <span className="text-xl font-semibold text-gray-100">CloudVisionOps</span>
          </div>
          <p className="text-gray-500 text-sm">Sign in to access the pipeline dashboard</p>
          <a
            href={buildLoginUrl()}
            className="inline-flex items-center gap-2 bg-aws-orange hover:bg-orange-500 text-white text-sm font-medium px-5 py-2.5 rounded transition-colors"
          >
            <LogIn size={16} />
            Sign in with Cognito
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950">
      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Layers size={20} className="text-aws-orange" />
          <span className="font-semibold text-gray-100 tracking-tight">CloudVisionOps</span>
          <span className="text-xs text-gray-600 border border-gray-800 rounded px-1.5 py-0.5">
            Serverless AI Image Intelligence
          </span>
        </div>
        <div className="flex items-center gap-4 text-xs text-gray-500">
          <span className="flex items-center gap-1">
            <Activity size={12} className="text-emerald-400" />
            Live
          </span>
          <span>AWS Lambda · S3 · Rekognition · DynamoDB · EventBridge</span>
          {cognitoConfigured && isAuthenticated && (
            <button
              onClick={signOut}
              className="flex items-center gap-1 text-gray-600 hover:text-gray-400 transition-colors"
            >
              <LogOut size={12} />
              Sign out
            </button>
          )}
        </div>
      </header>

      {/* Main layout */}
      <main className="max-w-7xl mx-auto px-4 py-6 space-y-4">

        {/* Top row: Upload + Metrics */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ImageUploader onUploadComplete={handleUploadComplete} />
          <MetricsPanel refreshTrigger={refreshTrigger} />
        </div>

        {/* Middle: Recent images */}
        <ImageResults refreshTrigger={refreshTrigger} />

        {/* Bottom row: Deterministic ops agent + Agentic Claude ops */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <OpsRecommendations />
          <AgentReasoningPanel />
        </div>

        {/* Architecture callout */}
        <div className="card text-xs text-gray-600 space-y-1">
          <p className="text-gray-500 font-semibold mb-2">Architecture</p>
          <div className="font-mono grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-0.5">
            <span>Upload: API Gateway → Lambda → S3 pre-signed URL</span>
            <span>Processing: S3 ObjectCreated → Lambda → Rekognition</span>
            <span>Storage: DynamoDB with 4 GSIs + DynamoDB Streams</span>
            <span>Events: EventBridge Pipes (4 filtered pipes)</span>
            <span>Failures: SQS FIFO DLQ → DLQ Replay Lambda</span>
            <span>Idempotency: DynamoDB conditional writes</span>
            <span>Reliability: Exponential backoff + jitter on all retries</span>
            <span>Ops (rules): Python threshold agent, 15-min schedule</span>
            <span>Ops (agent): Claude ReAct loop, tool use, hourly schedule</span>
            <span>Observability: CloudWatch EMF custom metrics + alarms</span>
            <span>IaC: AWS CDK TypeScript (7 stacks)</span>
          </div>
        </div>
      </main>
    </div>
  );
}
