import type { AuthorSnapshot } from './wheel';

export interface Comment extends AuthorSnapshot {
  id: string;
  text: string;
  createdAt: string;  // ISO
  likesCount: number;
}
