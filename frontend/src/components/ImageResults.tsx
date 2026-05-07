import React, { useEffect, useState } from 'react';
import { RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import { fetchImages, ImageRecord } from '../api/metadataApi';

interface Props {
  refreshTrigger: number;
}

function StatusBadge({ status }: { status: ImageRecord['status'] }) {
  const cls = `badge-${status.toLowerCase()}`;
  return <span className={cls}>{status}</span>;
}

function ConfidenceBar({ value }: { value: number }) {
  const color = value >= 90 ? 'bg-emerald-500' : value >= 75 ? 'bg-yellow-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-1.5 bg-gray-700 rounded-full overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${value}%` }} />
      </div>
      <span className="text-xs text-gray-400">{value.toFixed(1)}%</span>
    </div>
  );
}

function ImageRow({ image }: { image: ImageRecord }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <tr
        className="border-b border-gray-800 hover:bg-gray-800 cursor-pointer transition-colors"
        onClick={() => setExpanded((e) => !e)}
      >
        <td className="py-2 px-3 font-mono text-xs text-gray-400 w-8">
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </td>
        <td className="py-2 px-3 font-mono text-xs text-gray-300 max-w-[160px] truncate">
          {image.imageId}
        </td>
        <td className="py-2 px-3">
          <StatusBadge status={image.status} />
        </td>
        <td className="py-2 px-3 text-sm text-gray-200">
          {image.dominantLabel ?? '—'}
        </td>
        <td className="py-2 px-3">
          {image.confidenceScore != null ? (
            <ConfidenceBar value={image.confidenceScore} />
          ) : '—'}
        </td>
        <td className="py-2 px-3 text-xs text-gray-400">
          {image.processingLatencyMs != null ? `${image.processingLatencyMs} ms` : '—'}
        </td>
        <td className="py-2 px-3 text-xs text-gray-500">
          {new Date(image.updatedAt).toLocaleTimeString()}
        </td>
      </tr>

      {expanded && (
        <tr className="bg-gray-900">
          <td colSpan={7} className="px-6 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-gray-500 mb-2 uppercase tracking-wider">Labels</p>
                {image.labelDetails && image.labelDetails.length > 0 ? (
                  <div className="space-y-1">
                    {image.labelDetails.slice(0, 10).map((l) => (
                      <div key={l.name} className="flex items-center justify-between">
                        <span className="text-xs text-gray-300">{l.name}</span>
                        <div className="flex items-center gap-2">
                          {l.categories.length > 0 && (
                            <span className="text-xs text-gray-600">{l.categories[0]}</span>
                          )}
                          <ConfidenceBar value={l.confidence} />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-gray-600">No labels</p>
                )}
              </div>

              <div className="space-y-2">
                <p className="text-xs text-gray-500 uppercase tracking-wider">Metadata</p>
                <div className="space-y-1 text-xs font-mono">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Object key</span>
                    <span className="text-gray-300 truncate max-w-[200px]">{image.objectKey}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Upload time</span>
                    <span className="text-gray-300">{new Date(image.uploadTime).toLocaleString()}</span>
                  </div>
                  {image.retryCount != null && image.retryCount > 0 && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">Retry count</span>
                      <span className="text-yellow-400">{image.retryCount}</span>
                    </div>
                  )}
                  {image.coldStart && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">Cold start</span>
                      <span className="text-blue-400">yes</span>
                    </div>
                  )}
                  {image.duplicateOf && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">Duplicate of</span>
                      <span className="text-yellow-400 truncate max-w-[200px]">{image.duplicateOf}</span>
                    </div>
                  )}
                  {image.replaySource && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">Replay source</span>
                      <span className="text-purple-400">{image.replaySource}</span>
                    </div>
                  )}
                  {image.status === 'FAILED' && (
                    <>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Error type</span>
                        <span className="text-red-400">{image.errorType}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Error</span>
                        <span className="text-red-400 truncate max-w-[200px]">{image.errorMessage}</span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function ImageResults({ refreshTrigger }: Props) {
  const [images, setImages] = useState<ImageRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('');

  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchImages({ status: statusFilter || undefined, limit: 50 });
      setImages(data.images);
    } catch {
      // keep existing data on error
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [refreshTrigger, statusFilter]);

  // Auto-refresh every 5s while any image is PENDING or PROCESSING
  useEffect(() => {
    const hasPending = images.some((i) => i.status === 'PENDING' || i.status === 'PROCESSING');
    if (!hasPending) return;
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [images]);

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
          Recent Images
        </h2>
        <div className="flex items-center gap-2">
          <select
            className="bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded px-2 py-1"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">All statuses</option>
            <option value="PROCESSED">PROCESSED</option>
            <option value="FAILED">FAILED</option>
            <option value="DUPLICATE">DUPLICATE</option>
            <option value="PENDING">PENDING</option>
          </select>
          <button
            onClick={load}
            className="text-gray-500 hover:text-aws-orange transition-colors"
            title="Refresh"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {images.length === 0 && !loading ? (
        <p className="text-gray-600 text-sm text-center py-8">No images yet. Upload one to get started.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
                <th className="py-2 px-3 text-left w-8"></th>
                <th className="py-2 px-3 text-left">Image ID</th>
                <th className="py-2 px-3 text-left">Status</th>
                <th className="py-2 px-3 text-left">Dominant Label</th>
                <th className="py-2 px-3 text-left">Confidence</th>
                <th className="py-2 px-3 text-left">Latency</th>
                <th className="py-2 px-3 text-left">Time</th>
              </tr>
            </thead>
            <tbody>
              {images.map((img) => (
                <ImageRow key={img.imageId} image={img} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
