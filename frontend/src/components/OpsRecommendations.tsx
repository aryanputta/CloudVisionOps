import React, { useEffect, useState } from 'react';
import { AlertTriangle, Info, ChevronDown, ChevronUp, Bot } from 'lucide-react';
import { fetchOpsRecommendations, OpsRecommendation } from '../api/metadataApi';

const CATEGORY_LABELS: Record<string, string> = {
  LATENCY_SPIKE: 'Latency Spike',
  COST_RISK: 'Cost Risk',
  HIGH_FAILURE_RATE: 'High Failure Rate',
  DUPLICATE_SURGE: 'Duplicate Surge',
  LOW_CONFIDENCE_LABELS: 'Low Confidence Labels',
  HOT_PARTITION_RISK: 'Hot Partition Risk',
  DLQ_BACKLOG: 'DLQ Backlog',
  SCALING_WARNING: 'Scaling Warning',
};

function SeverityIcon({ severity }: { severity: string }) {
  if (severity === 'HIGH') return <AlertTriangle size={14} className="text-red-400 flex-shrink-0" />;
  if (severity === 'MEDIUM') return <AlertTriangle size={14} className="text-yellow-400 flex-shrink-0" />;
  return <Info size={14} className="text-blue-400 flex-shrink-0" />;
}

function RecommendationCard({ rec }: { rec: OpsRecommendation }) {
  const [expanded, setExpanded] = useState(false);
  const severityColor =
    rec.severity === 'HIGH' ? 'border-red-900' :
    rec.severity === 'MEDIUM' ? 'border-yellow-900' :
    'border-gray-800';

  let metricsObj: Record<string, unknown> = {};
  try { metricsObj = JSON.parse(rec.metrics ?? '{}'); } catch {}

  return (
    <div className={`border ${severityColor} rounded-lg p-3 bg-gray-900`}>
      <div
        className="flex items-start justify-between cursor-pointer"
        onClick={() => setExpanded((e) => !e)}
      >
        <div className="flex items-start gap-2">
          <SeverityIcon severity={rec.severity} />
          <div>
            <p className="text-sm font-semibold text-gray-200">
              {CATEGORY_LABELS[rec.category] ?? rec.category}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">{rec.sourceMetric}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs px-1.5 py-0.5 rounded ${
            rec.severity === 'HIGH' ? 'bg-red-900 text-red-300' :
            rec.severity === 'MEDIUM' ? 'bg-yellow-900 text-yellow-300' :
            'bg-blue-900 text-blue-300'
          }`}>
            {rec.severity}
          </span>
          {expanded ? <ChevronUp size={12} className="text-gray-600" /> : <ChevronDown size={12} className="text-gray-600" />}
        </div>
      </div>

      {expanded && (
        <div className="mt-3 space-y-3">
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Finding</p>
            <p className="text-xs text-gray-300">{rec.description}</p>
          </div>

          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Recommended Action</p>
            <pre className="text-xs text-emerald-400 whitespace-pre-wrap font-mono bg-gray-800 rounded p-2">
              {rec.recommendedAction}
            </pre>
          </div>

          {Object.keys(metricsObj).length > 0 && (
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Source Metrics</p>
              <div className="grid grid-cols-2 gap-1">
                {Object.entries(metricsObj).map(([k, v]) => (
                  <div key={k} className="flex justify-between text-xs">
                    <span className="text-gray-500">{k}</span>
                    <span className="text-gray-300 font-mono">{String(v)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-between text-xs text-gray-600">
            <span>Confidence: {(parseFloat(rec.confidence) * 100).toFixed(0)}%</span>
            <span>{new Date(rec.timestamp).toLocaleString()}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function OpsRecommendations() {
  const [recs, setRecs] = useState<OpsRecommendation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchOpsRecommendations()
      .then(setRecs)
      .catch(() => {})
      .finally(() => setLoading(false));

    const id = setInterval(() => {
      fetchOpsRecommendations().then(setRecs).catch(() => {});
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  const high = recs.filter((r) => r.severity === 'HIGH');
  const medium = recs.filter((r) => r.severity === 'MEDIUM');
  const low = recs.filter((r) => r.severity === 'LOW');

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-3">
        <Bot size={16} className="text-aws-orange" />
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
          Ops Agent Recommendations
        </h2>
        {recs.length > 0 && (
          <span className="ml-auto text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded">
            {recs.length} open
          </span>
        )}
      </div>

      {loading ? (
        <p className="text-gray-600 text-sm text-center py-4">Loading...</p>
      ) : recs.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-emerald-400 text-sm font-semibold">All systems nominal</p>
          <p className="text-gray-600 text-xs mt-1">Ops agent runs every 15 minutes</p>
        </div>
      ) : (
        <div className="space-y-2">
          {[...high, ...medium, ...low].map((rec) => (
            <RecommendationCard key={rec.recommendationId} rec={rec} />
          ))}
        </div>
      )}
    </div>
  );
}
