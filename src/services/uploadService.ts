import { httpsCallable } from 'firebase/functions';
import { fns } from '../firebase';
import { resizeImage, RESIZE_PRESETS, type ResizeOptions } from '../utils/imageResize';

type Purpose = 'profile' | 'wheel-segment' | 'wheel-cover' | 'response';

interface IssueUploadUrlInput {
  purpose: Purpose;
  contentType: string;
  sizeBytes: number;
  wheelId?: string;
  segmentId?: string;
  responseId?: string;
}

interface IssueUploadUrlResult {
  uploadUrl: string;
  publicUrl: string;
  key: string;
  expiresInSeconds: number;
}

const issueUploadUrlFn = () =>
  httpsCallable<IssueUploadUrlInput, IssueUploadUrlResult>(fns, 'issueUploadUrl');

// Resize → get presigned URL → PUT → return public URL.
export async function uploadImage(args: {
  purpose: Purpose;
  source: File | Blob;
  wheelId?: string;
  segmentId?: string;
  responseId?: string;
  resize?: ResizeOptions;
}): Promise<string> {
  const preset =
    args.purpose === 'profile' ? RESIZE_PRESETS.profile :
    args.purpose === 'wheel-cover' ? RESIZE_PRESETS.wheelCover :
    args.purpose === 'wheel-segment' ? RESIZE_PRESETS.segment :
    RESIZE_PRESETS.response;

  const resized = await resizeImage(args.source, { ...preset, ...args.resize });

  const { data } = await issueUploadUrlFn()({
    purpose: args.purpose,
    contentType: resized.mimeType,
    sizeBytes: resized.blob.size,
    wheelId: args.wheelId,
    segmentId: args.segmentId,
    responseId: args.responseId,
  });

  const putRes = await fetch(data.uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': resized.mimeType,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
    body: resized.blob,
  });

  if (!putRes.ok) {
    throw new Error(`R2 upload failed (${putRes.status}): ${await putRes.text().catch(() => '')}`);
  }

  return data.publicUrl;
}
