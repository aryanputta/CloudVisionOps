import React, { useEffect, useState } from 'react';
import { TrendingUp, AlertTriangle, Copy, Activity } from 'lucide-react';
import { fetchMetricsSummary, MetricsSummary } from '../api/metadataApi';

interface Props {
  refreshTrigger: number;
}

function Stat({
  label,
  value,
  sub,
  color = 'text-gray-100',
}: {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="bg-gray-800 rounded-lg p-3">
      <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-xl font-bold font-mono ${color}`}>{value}</p>
      {sub && <p className="text-xs text-gray-600 mt-0.5">{sub}</p>}
    </div>
  );
}

export function MetricsPanel({ refreshTrigger }: Props) {
  const [metrics, setMetrics] = useState<MetricsSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const data = await fetchMetricsSummary();
      setMetrics(data);
    } catch { /* keep existing */ }
    setLoading(false);
  };

  useEffect(() => { load(); }, [refreshTrigger]);

  if (loading || !metrics) {
    return (
      <div className="card">
        <div className="h-24 flex items-center justify-center text-gray-600 text-sm">Loading metrics...</div>
      </div>
    );
  }

  const { summary, total, failureRate, duplicateRate } = metrics;

  return (
    <div className="card">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
        Pipeline Metrics
      </h2>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        <Stat label="Total" value={total} />
        <Stat
          label="Processed"
          value={summary['PROCESSED'] ?? 0}
          color="text-emerald-400"
          sub={`${total > 0 ? (((summary['PROCESSED'] ?? 0) / total) * 100).toFixed(1) : 0}%`}
        />
        <Stat
          label="Failed"
          value={summary['FAILED'] ?? 0}
          color={(summary['FAILED'] ?? 0) > 0 ? 'text-red-400' : 'text-gray-100'}
          sub={`${(failureRate * 100).toFixed(2)}% rate`}
        />
        <Stat
          label="Duplicates"
          value={summary['DUPLICATE'] ?? 0}
          color="text-yellow-400"
          sub={`${(duplicateRate * 100).toFixed(1)}% of uploads`}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="bg-gray-800 rounded p-3">
          <p className="text-xs text-gray-500 mb-2">Status breakdown</p>
          {Object.entries(summary).map(([status, count]) => (
            <div key={status} className="flex justify-between text-xs mb-1">
              <span className="text-gray-400">{status}</span>
              <div className="flex items-center gap-2">
                <div className="w-16 h-1 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-aws-orange"
                    style={{ width: total > 0 ? `${(count / total) * 100}%` : '0%' }}
                  />
                </div>
                <span className="text-gray-300 w-6 text-right">{count}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="bg-gray-800 rounded p-3">
          <p className="text-xs text-gray-500 mb-2">Cost savings from deduplication</p>
          <p className="text-xs text-gray-400">Rekognition calls avoided</p>
          <p className="text-lg font-bold font-mono text-yellow-400">
            {summary['DUPLICATE'] ?? 0}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            ~${((summary['DUPLICATE'] ?? 0) * 0.001).toFixed(4)} saved
          </p>
          <p className="text-xs text-gray-600 mt-2">@ $0.001/image</p>
        </div>
      </div>

      <p className="text-xs text-gray-700 mt-2 text-right">
        Updated {new Date(metrics.timestamp).toLocaleTimeString()}
      </p>
    </div>
  );
}
