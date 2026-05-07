import React, { useCallback, useState } from 'react';
import { Upload, AlertCircle, CheckCircle, Loader2 } from 'lucide-react';
import { getPresignedUrl, uploadToS3 } from '../api/uploadApi';

interface Props {
  onUploadComplete: (imageId: string) => void;
}

type UploadState = 'idle' | 'presigning' | 'uploading' | 'done' | 'error';

export function ImageUploader({ onUploadComplete }: Props) {
  const [state, setState] = useState<UploadState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [lastImageId, setLastImageId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const processFile = useCallback(async (file: File) => {
    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      setError('Only JPEG and PNG files are accepted.');
      setState('error');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('File must be under 10 MB.');
      setState('error');
      return;
    }

    setError(null);
    setProgress(0);

    try {
      setState('presigning');
      const { imageId, uploadUrl } = await getPresignedUrl(file);

      setState('uploading');
      setProgress(30);

      await uploadToS3(uploadUrl, file);
      setProgress(100);

      setLastImageId(imageId);
      setState('done');
      onUploadComplete(imageId);
    } catch (err: any) {
      setError(err?.response?.data?.error ?? err?.message ?? 'Upload failed');
      setState('error');
    }
  }, [onUploadComplete]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) processFile(file);
    },
    [processFile]
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    e.target.value = '';
  };

  const reset = () => {
    setState('idle');
    setError(null);
    setProgress(0);
  };

  return (
    <div className="card">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
        Upload Image
      </h2>

      <div
        className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer
          ${dragging ? 'border-aws-orange bg-orange-950' : 'border-gray-700 hover:border-gray-500'}
          ${state === 'error' ? 'border-red-700' : ''}
          ${state === 'done' ? 'border-emerald-700' : ''}
        `}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => state === 'idle' && document.getElementById('file-input')?.click()}
      >
        <input
          id="file-input"
          type="file"
          accept="image/jpeg,image/png"
          className="hidden"
          onChange={handleFileChange}
        />

        {state === 'idle' && (
          <>
            <Upload className="mx-auto mb-2 text-gray-500" size={32} />
            <p className="text-gray-400 text-sm">
              Drop a JPEG or PNG here, or <span className="text-aws-orange">click to browse</span>
            </p>
            <p className="text-gray-600 text-xs mt-1">Max 10 MB</p>
          </>
        )}

        {(state === 'presigning' || state === 'uploading') && (
          <>
            <Loader2 className="mx-auto mb-2 text-aws-orange animate-spin" size={32} />
            <p className="text-gray-300 text-sm">
              {state === 'presigning' ? 'Generating secure upload URL...' : `Uploading to S3... ${progress}%`}
            </p>
            <div className="mt-3 h-1 bg-gray-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-aws-orange transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </>
        )}

        {state === 'done' && (
          <>
            <CheckCircle className="mx-auto mb-2 text-emerald-400" size={32} />
            <p className="text-emerald-300 text-sm font-semibold">Upload complete</p>
            <p className="text-gray-500 text-xs mt-1 font-mono">{lastImageId}</p>
            <p className="text-gray-500 text-xs mt-1">Rekognition is processing — results appear below</p>
            <button
              onClick={(e) => { e.stopPropagation(); reset(); }}
              className="mt-3 text-xs text-aws-orange hover:underline"
            >
              Upload another
            </button>
          </>
        )}

        {state === 'error' && (
          <>
            <AlertCircle className="mx-auto mb-2 text-red-400" size={32} />
            <p className="text-red-300 text-sm font-semibold">Upload failed</p>
            <p className="text-red-500 text-xs mt-1">{error}</p>
            <button
              onClick={(e) => { e.stopPropagation(); reset(); }}
              className="mt-3 text-xs text-aws-orange hover:underline"
            >
              Try again
            </button>
          </>
        )}
      </div>

      <div className="mt-3 flex gap-3 text-xs text-gray-600">
        <span>Direct-to-S3 via pre-signed URL</span>
        <span>·</span>
        <span>No file passes through Lambda</span>
        <span>·</span>
        <span>Duplicate detection enabled</span>
      </div>
    </div>
  );
}
