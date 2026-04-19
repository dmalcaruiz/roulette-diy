import { initializeApp } from 'firebase-admin/app';

initializeApp();

// Upload URL issuer — signs R2 presigned PUTs with auth/size/mime/rate/quota checks.
export { issueUploadUrl } from './issueUploadUrl.js';
