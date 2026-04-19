export interface UserProfile {
  uid: string;
  displayName: string;
  handle: string;           // lowercase, 3-20 chars, a-z 0-9 _
  bio?: string;
  photoUrl?: string;
  createdAt: string;        // ISO
  followersCount: number;
  followingCount: number;
  wheelsCount: number;
}

export const HANDLE_REGEX = /^[a-z0-9_]{3,20}$/;

export function normalizeHandle(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@/, '');
}

export function isValidHandle(handle: string): boolean {
  return HANDLE_REGEX.test(handle);
}
