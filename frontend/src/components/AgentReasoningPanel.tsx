import React, { useEffect, useState } from 'react';
import { Brain, Wrench, ChevronDown, ChevronUp, Play, CheckCircle, XCircle, Loader } from 'lucide-react';
import { fetchAgentRuns, triggerAgentRun, AgentRun, AgentStep } from '../api/metadataApi';

const TOOL_COLORS: Record<string, string> = {
  get_pipeline_health: 'text-blue-400',
  get_latency_percentiles: 'text-purple-400',
  get_failed_images: 'text-red-400',
  get_dlq_depth: 'text-orange-400',
  get_cold_start_rate: 'text-yellow-400',
  trigger_dlq_replay: 'text-emerald-400',
  publish_alert: 'text-red-500',
  write_recommendation: 'text-aws-orange',
};

function StepCard({ step }: { step: AgentStep }) {
  const [open, setOpen] = useState(false);

  if (step.type === 'reasoning') {
    return (
      <div className="flex gap-2 text-xs">
        <Brain size={12} className="text-gray-500 mt-0.5 flex-shrink-0" />
        <p className="text-gray-400 leading-relaxed">{step.text}</p>
      </div>
    );
  }

  const toolColor = TOOL_COLORS[step.tool ?? ''] ?? 'text-gray-300';

  return (
    <div className="rounded bg-gray-800 text-xs">
      <button
        className="w-full flex items-center gap-2 px-2 py-1.5 text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <Wrench size={11} className={`${toolColor} flex-shrink-0`} />
        <span className={`font-mono ${toolColor}`}>{step.tool}</span>
        <span className="text-gray-600 ml-auto">{open ? <ChevronUp size={10} /> : <ChevronDown size={10} />}</span>
      </button>

      {open && (
        <div className="px-2 pb-2 space-y-1 border-t border-gray-700">
          {step.inputs && Object.keys(step.inputs).length > 0 && (
            <div>
              <p className="text-gray-600 mt-1">inputs</p>
              <pre className="text-gray-400 whitespace-pre-wrap break-all">
                {JSON.stringify(step.inputs, null, 2)}
              </pre>
            </div>
          )}
          <div>
            <p className="text-gray-600 mt-1">result</p>
            <pre className="text-gray-300 whitespace-pre-wrap break-all">
              {JSON.stringify(step.result, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function RunCard({ run }: { run: AgentRun }) {
  const [open, setOpen] = useState(false);
  const steps: AgentStep[] = typeof run.steps === 'string' ? JSON.parse(run.steps) : run.steps;

  const StatusIcon =
    run.status === 'COMPLETED' ? CheckCircle :
    run.status === 'FAILED' ? XCircle :
    Loader;
  const statusColor =
    run.status === 'COMPLETED' ? 'text-emerald-400' :
    run.status === 'FAILED' ? 'text-red-400' :
    'text-yellow-400';

  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      <button
        className="w-full flex items-start gap-2 p-3 text-left bg-gray-900 hover:bg-gray-850"
        onClick={() => setOpen((o) => !o)}
      >
        <StatusIcon size={14} className={`${statusColor} flex-shrink-0 mt-0.5`} />
        <div className="flex-1 min-w-0">
          <p className="text-xs text-gray-300 leading-snug line-clamp-2">
            {run.finalSummary || (run.status === 'FAILED' ? run.error : 'No summary')}
          </p>
          <div className="flex flex-wrap gap-x-3 mt-1 text-xs text-gray-600">
            <span>{new Date(run.timestamp).toLocaleString()}</span>
            <span>{run.toolsCalled?.length ?? 0} tool calls</span>
            <span>{(run.durationMs / 1000).toFixed(1)}s</span>
          </div>
        </div>
        <span className="text-gray-700 flex-shrink-0">
          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </span>
      </button>

      {open && (
        <div className="p-3 bg-gray-950 space-y-3">
          {run.actionsTaken && run.actionsTaken.length > 0 && (
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Actions taken</p>
              <ul className="space-y-0.5">
                {run.actionsTaken.map((a, i) => (
                  <li key={i} className="text-xs text-emerald-400 font-mono">{a}</li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Reasoning trace</p>
            <div className="space-y-1.5">
              {steps.map((step, i) => <StepCard key={i} step={step} />)}
            </div>
          </div>

          <div className="flex flex-wrap gap-1 pt-1">
            {[...new Set(run.toolsCalled ?? [])].map((t) => (
              <span
                key={t}
                className={`text-xs font-mono px-1 py-0.5 rounded bg-gray-800 ${TOOL_COLORS[t] ?? 'text-gray-400'}`}
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function AgentReasoningPanel() {
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);

  const load = () =>
    fetchAgentRuns(5)
      .then(setRuns)
      .catch(() => {})
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
    const id = setInterval(load, 120_000);
    return () => clearInterval(id);
  }, []);

  const handleTrigger = async () => {
    setTriggering(true);
    try {
      await triggerAgentRun();
      setTimeout(() => { load(); setTriggering(false); }, 3000);
    } catch {
      setTriggering(false);
    }
  };

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-3">
        <Brain size={16} className="text-purple-400" />
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
          Agentic Ops
        </h2>
        <span className="text-xs text-gray-600 ml-1">Claude ReAct</span>
        <button
          onClick={handleTrigger}
          disabled={triggering}
          className="ml-auto flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 bg-gray-800 hover:bg-gray-700 px-2 py-1 rounded transition-colors disabled:opacity-50"
        >
          {triggering ? <Loader size={11} className="animate-spin" /> : <Play size={11} />}
          {triggering ? 'Running...' : 'Run now'}
        </button>
      </div>

      {loading ? (
        <p className="text-gray-600 text-sm text-center py-4">Loading...</p>
      ) : runs.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-gray-500 text-sm">No agent runs yet</p>
          <p className="text-gray-700 text-xs mt-1">Runs hourly. Click "Run now" to trigger manually.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {runs.map((run) => <RunCard key={run.runId} run={run} />)}
        </div>
      )}

      <p className="text-xs text-gray-700 mt-3">
        Autonomous pipeline diagnosis via Claude {runs[0]?.model ?? 'claude-opus-4-7'} · Runs every hour
      </p>
    </div>
  );
}
