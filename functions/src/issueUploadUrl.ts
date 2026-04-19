import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';

// Production: values come from Secret Manager (set via `firebase functions:secrets:set`).
// Local emulator: values come from functions/.env.local via process.env.
const R2_ACCESS_KEY_ID     = defineSecret('R2_ACCESS_KEY_ID');
const R2_SECRET_ACCESS_KEY = defineSecret('R2_SECRET_ACCESS_KEY');
const R2_ACCOUNT_ID        = defineSecret('R2_ACCOUNT_ID');
const R2_BUCKET_NAME       = defineSecret('R2_BUCKET_NAME');
const R2_S3_ENDPOINT       = defineSecret('R2_S3_ENDPOINT');
const R2_PUBLIC_BASE_URL   = defineSecret('R2_PUBLIC_BASE_URL');

// ── Constants ───────────────────────────────────────────────────────────
const MAX_BYTES = 5 * 1024 * 1024;              // 5 MB per upload
const USER_QUOTA_BYTES = 50 * 1024 * 1024;      // 50 MB total per user
const RATE_LIMIT_PER_HOUR = 20;                 // 20 uploads / hour / user
const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);
const PURPOSES = new Set(['profile', 'wheel-segment', 'wheel-cover', 'response']);

// Build S3 client lazily — inside the handler so defineSecret() values are
// available at runtime (they're not populated at module-load in prod).
function buildS3(): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: process.env.R2_S3_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
    // AWS SDK v3 ≥3.700 auto-adds an x-amz-checksum-crc32 query param to presigned
    // PUTs. When the client uploads the real body, R2 rejects with 403 because the
    // baked-in (zero) placeholder doesn't match. Switch back to the legacy behavior.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

interface IssueUploadUrlInput {
  purpose: 'profile' | 'wheel-segment' | 'wheel-cover' | 'response';
  contentType: string;
  sizeBytes: number;
  // Context identifiers — what the upload attaches to:
  wheelId?: string;       // required for wheel-segment, wheel-cover
  segmentId?: string;     // required for wheel-segment
  responseId?: string;    // required for response
}

interface IssueUploadUrlResult {
  uploadUrl: string;      // presigned PUT URL
  publicUrl: string;      // final CDN URL once uploaded
  key: string;            // R2 object key
  expiresInSeconds: number;
}

export const issueUploadUrl = onCall<IssueUploadUrlInput, Promise<IssueUploadUrlResult>>(
  {
    region: 'us-central1',
    // Explicit list — `cors: true` sometimes doesn't emit headers on v2 callable.
    cors: [
      /localhost:\d+$/,
      'https://roulette.diy',
      'https://www.roulette.diy',
      'https://roulette-diy.web.app',
      'https://roulette-diy.firebaseapp.com',
    ],
    secrets: [R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_S3_ENDPOINT, R2_PUBLIC_BASE_URL],
  },
  async (request) => {
    // 1. Auth check
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

    const { purpose, contentType, sizeBytes, wheelId, segmentId, responseId } = request.data ?? {};

    // 2. Purpose + MIME + size validation
    if (!PURPOSES.has(purpose)) {
      throw new HttpsError('invalid-argument', `Unknown purpose: ${purpose}`);
    }
    if (!ALLOWED_MIMES.has(contentType)) {
      throw new HttpsError('invalid-argument', `Unsupported mime type: ${contentType}`);
    }
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_BYTES) {
      throw new HttpsError('invalid-argument', `Size must be between 1 and ${MAX_BYTES} bytes.`);
    }

    // 3. Context validation per purpose
    if ((purpose === 'wheel-segment' || purpose === 'wheel-cover') && !wheelId) {
      throw new HttpsError('invalid-argument', 'wheelId required for wheel uploads.');
    }
    if (purpose === 'wheel-segment' && !segmentId) {
      throw new HttpsError('invalid-argument', 'segmentId required for segment upload.');
    }
    if (purpose === 'response' && !responseId) {
      throw new HttpsError('invalid-argument', 'responseId required for challenge response.');
    }

    // Wrap steps 4-7 so any unexpected error surfaces as an 'internal' HttpsError
    // with the actual message (instead of a generic 'INTERNAL' that leaks nothing).
    try {
      // 4. Rate limit + quota (atomic via transaction)
      const db = getFirestore();
      const quotaRef = db.doc(`uploadQuotas/${uid}`);
      const hourBucket = Math.floor(Date.now() / 3_600_000); // epoch hour

      await db.runTransaction(async (tx) => {
        const snap = await tx.get(quotaRef);
        const data = snap.exists ? snap.data()! : { totalBytes: 0, hour: hourBucket, count: 0 };

        const currentCount = data.hour === hourBucket ? data.count : 0;
        if (currentCount >= RATE_LIMIT_PER_HOUR) {
          throw new HttpsError('resource-exhausted', `Rate limit: ${RATE_LIMIT_PER_HOUR} uploads/hour.`);
        }
        if ((data.totalBytes ?? 0) + sizeBytes > USER_QUOTA_BYTES) {
          throw new HttpsError('resource-exhausted', `Storage quota ${USER_QUOTA_BYTES} bytes exceeded.`);
        }

        tx.set(quotaRef, {
          totalBytes: FieldValue.increment(sizeBytes),
          hour: hourBucket,
          count: data.hour === hourBucket ? FieldValue.increment(1) : 1,
          lastUploadAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      });

      // 5. Build the object key
      const ext = mimeToExt(contentType);
      const key = buildKey({ uid, purpose, wheelId, segmentId, responseId, ext });

      // 6. Presign the PUT URL.
      const command = new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME!,
        Key: key,
        ContentType: contentType,
        ContentLength: sizeBytes,
        CacheControl: 'public, max-age=31536000, immutable',
      });
      const uploadUrl = await getSignedUrl(buildS3(), command, { expiresIn: 300 });

      return {
        uploadUrl,
        publicUrl: `${process.env.R2_PUBLIC_BASE_URL}/${key}`,
        key,
        expiresInSeconds: 300,
      };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error('[issueUploadUrl] unexpected error:', err);
      // Surface message back to caller for debugging. In prod you'd want to hide this.
      throw new HttpsError('internal', msg);
    }
  }
);

function mimeToExt(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return 'jpg';
    case 'image/png':  return 'png';
    case 'image/webp': return 'webp';
    case 'image/gif':  return 'gif';
    default: return 'bin';
  }
}

function buildKey(args: {
  uid: string;
  purpose: IssueUploadUrlInput['purpose'];
  wheelId?: string;
  segmentId?: string;
  responseId?: string;
  ext: string;
}): string {
  const uniq = randomUUID().slice(0, 8);
  switch (args.purpose) {
    case 'profile':
      return `users/${args.uid}/profile-${uniq}.${args.ext}`;
    case 'wheel-cover':
      return `wheels/${args.wheelId}/cover-${uniq}.${args.ext}`;
    case 'wheel-segment':
      return `wheels/${args.wheelId}/segments/${args.segmentId}-${uniq}.${args.ext}`;
    case 'response':
      return `responses/${args.responseId}/image-${uniq}.${args.ext}`;
  }
}
