import axios from 'axios';

const BASE = import.meta.env.VITE_API_BASE_URL ?? '';

export interface PresignResponse {
  imageId: string;
  uploadUrl: string;
  objectKey: string;
  expiresIn: number;
}

export async function getPresignedUrl(
  file: File,
  userId?: string
): Promise<PresignResponse> {
  const { data } = await axios.post<PresignResponse>(`${BASE}/uploads/presign`, {
    fileName: file.name,
    contentType: file.type,
    fileSize: file.size,
    userId: userId ?? 'anonymous',
  });
  return data;
}

export async function uploadToS3(uploadUrl: string, file: File): Promise<void> {
  await axios.put(uploadUrl, file, {
    headers: { 'Content-Type': file.type },
    onUploadProgress: () => {},
  });
}
