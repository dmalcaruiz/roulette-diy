import { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';
import type { CloudBlock } from '../services/blockService';
import type { PublishedWheel } from '../types/wheel';

export interface BlockStats {
  likesCount: number;
  commentsCount: number;
  responsesCount: number;
  savesCount: number;
  isChallenge: boolean;
}

// For each block that's been published, fetch the public wheel doc once and
// expose its stats keyed by publishedWheelId. Drafts with no publishedWheelId
// are absent from the map.
export function usePublishedStats(blocks: CloudBlock[]): Map<string, BlockStats> {
  const [stats, setStats] = useState<Map<string, BlockStats>>(new Map());

  const ids = blocks
    .map(b => b.publishedWheelId)
    .filter((x): x is string => !!x)
    .sort()
    .join(',');

  useEffect(() => {
    let cancelled = false;
    const wheelIds = ids ? ids.split(',') : [];
    if (wheelIds.length === 0) { setStats(new Map()); return; }

    (async () => {
      const results = await Promise.all(
        wheelIds.map(async id => {
          try {
            const snap = await getDoc(doc(db, 'wheels', id));
            if (!snap.exists()) return [id, null] as const;
            const d = snap.data() as PublishedWheel;
            return [id, {
              likesCount: d.likesCount ?? 0,
              commentsCount: d.commentsCount ?? 0,
              responsesCount: d.responsesCount ?? 0,
              savesCount: d.savesCount ?? 0,
              isChallenge: d.isChallenge ?? false,
            }] as const;
          } catch { return [id, null] as const; }
        })
      );
      if (cancelled) return;
      const m = new Map<string, BlockStats>();
      for (const [id, s] of results) {
        if (s) m.set(id, s);
      }
      setStats(m);
    })();

    return () => { cancelled = true; };
  }, [ids]);

  return stats;
}
