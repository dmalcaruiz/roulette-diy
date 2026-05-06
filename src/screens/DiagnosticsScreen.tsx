import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { ON_SURFACE, BORDER, PRIMARY, BG } from '../utils/constants';
import { withAlpha } from '../utils/colorUtils';
import { PushDownButton } from '../components/PushDownButton';
import { ArrowLeft, CheckCircle2, XCircle, Loader2, Circle } from 'lucide-react';

// Service imports
import { doc, getDoc, deleteDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, fns } from '../firebase';
import { saveDraft, getDraft, deleteDraft } from '../services/blockService';
import { publishWheel, unpublishWheel } from '../services/publishService';
import { fetchWheel, fetchFeedPage } from '../services/feedService';
import {
  likeWheel, unlikeWheel, isWheelLiked,
  saveWheel, unsaveWheel, isWheelSaved,
} from '../services/socialService';
import { postComment, fetchComments, deleteComment } from '../services/commentService';
import { newRouletteBlock } from '../models/types';
import { uploadImage } from '../services/uploadService';
import { submitChallengeResponse, deleteResponse, fetchResponses } from '../services/responseService';

type Status = 'pending' | 'running' | 'pass' | 'fail';
interface TestResult { name: string; status: Status; detail?: string; durationMs?: number; }

export default function DiagnosticsScreen() {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const [results, setResults] = useState<TestResult[]>([]);
  const [running, setRunning] = useState(false);

  const run = async () => {
    if (!user || !profile || running) return;
    setRunning(true);
    setResults([]);

    const push = (r: TestResult) => setResults(prev => [...prev, r]);
    const update = (name: string, patch: Partial<TestResult>) =>
      setResults(prev => prev.map(r => r.name === name ? { ...r, ...patch } : r));

    const suite = buildSuite({ uid: user.uid, profile });
    for (const t of suite) {
      push({ name: t.name, status: 'running' });
      const start = Date.now();
      try {
        const detail = await t.fn();
        update(t.name, { status: 'pass', detail, durationMs: Date.now() - start });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        update(t.name, { status: 'fail', detail: msg, durationMs: Date.now() - start });
      }
    }
    setRunning(false);
  };

  const passCount = results.filter(r => r.status === 'pass').length;
  const failCount = results.filter(r => r.status === 'fail').length;
  const total = results.length;

  return (
    <div style={{ minHeight: '100dvh', backgroundColor: BG }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '12px 8px' }}>
        <button onClick={() => navigate('/')} style={{ padding: 8, background: 'none', border: 'none' }}>
          <ArrowLeft size={28} color={ON_SURFACE} />
        </button>
        <h1 style={{ margin: 0, marginLeft: 4, fontSize: 22, fontWeight: 800 }}>Diagnostics</h1>
      </div>

      <div style={{ padding: '0 20px 20px' }}>
        <p style={{ fontSize: 14, color: withAlpha(ON_SURFACE, 0.6), margin: '0 0 16px' }}>
          Smoke-tests every server integration: Firestore writes/reads, counters, transactions,
          Cloud Function presigning, R2 upload/read. Each test cleans up after itself.
        </p>

        {!user || !profile ? (
          <p style={{ color: '#EF4444' }}>Sign in with a profile first.</p>
        ) : (
          <PushDownButton color={PRIMARY} onTap={running ? undefined : run}>
            <span style={{ color: '#FFF', fontWeight: 700, fontSize: 15, opacity: running ? 0.6 : 1 }}>
              {running ? 'Running…' : 'Run tests'}
            </span>
          </PushDownButton>
        )}

        {total > 0 && (
          <div style={{
            marginTop: 16,
            padding: '10px 14px',
            borderRadius: 12,
            backgroundColor: failCount > 0 ? withAlpha('#EF4444', 0.08) : withAlpha('#10B981', 0.08),
            border: `1.5px solid ${failCount > 0 ? '#EF4444' : '#10B981'}`,
            fontSize: 13,
            fontWeight: 700,
            color: failCount > 0 ? '#EF4444' : '#10B981',
          }}>
            {passCount}/{total} passed {failCount > 0 && `· ${failCount} failed`}
          </div>
        )}

        <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {results.map(r => <TestRow key={r.name} r={r} />)}
        </div>
      </div>
    </div>
  );
}

function TestRow({ r }: { r: TestResult }) {
  const icon =
    r.status === 'pending' ? <Circle size={18} color={withAlpha(ON_SURFACE, 0.3)} /> :
    r.status === 'running' ? <Loader2 size={18} className="spin" color={PRIMARY} /> :
    r.status === 'pass'    ? <CheckCircle2 size={18} color="#10B981" /> :
                             <XCircle size={18} color="#EF4444" />;
  return (
    <div style={{
      display: 'flex',
      gap: 12,
      padding: '10px 12px',
      borderRadius: 10,
      border: `1.5px solid ${BORDER}`,
      alignItems: 'flex-start',
    }}>
      <div style={{ marginTop: 1 }}>{icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: ON_SURFACE }}>{r.name}</div>
        {r.detail && (
          <div style={{
            fontSize: 12,
            color: r.status === 'fail' ? '#EF4444' : withAlpha(ON_SURFACE, 0.55),
            marginTop: 2,
            wordBreak: 'break-word',
            fontFamily: r.status === 'fail' ? 'monospace' : 'inherit',
          }}>
            {r.detail}
          </div>
        )}
      </div>
      {r.durationMs !== undefined && (
        <div style={{ fontSize: 11, color: withAlpha(ON_SURFACE, 0.4) }}>{r.durationMs}ms</div>
      )}
    </div>
  );
}

// ── Test suite builder ──────────────────────────────────────────────────

function buildSuite(ctx: { uid: string; profile: import('../types/profile').UserProfile }) {
  // Shared state across tests so later ones can reference earlier creations.
  const state: {
    draftId?: string;
    wheelId?: string;
    commentId?: string;
    uploadUrl?: string;
    publicUrl?: string;
    testBlob?: Blob;
    uploadedProfileUrl?: string;
    responseId?: string;
  } = {};

  // Generate a realistic-sized test image (exercises the resize pipeline).
  async function generateTestImage(widthPx = 3000, heightPx = 2000): Promise<Blob> {
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(widthPx, heightPx)
      : Object.assign(document.createElement('canvas'), { width: widthPx, height: heightPx });
    const ctx = (canvas as HTMLCanvasElement | OffscreenCanvas).getContext('2d') as
      | CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    // Gradient + random noise so the bytes differ across runs.
    const grad = ctx.createLinearGradient(0, 0, widthPx, heightPx);
    grad.addColorStop(0, `hsl(${Math.random() * 360}, 70%, 55%)`);
    grad.addColorStop(1, `hsl(${Math.random() * 360}, 70%, 25%)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, widthPx, heightPx);
    ctx.fillStyle = '#FFF';
    ctx.font = 'bold 120px sans-serif';
    ctx.fillText(`diag ${Date.now()}`, 80, 200);
    return canvas instanceof OffscreenCanvas
      ? await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
      : await new Promise<Blob>((res, rej) =>
          (canvas as HTMLCanvasElement).toBlob(b => b ? res(b) : rej(new Error('toBlob null')), 'image/jpeg', 0.9));
  }

  return [
    // ── Auth / Profile ─────────────────────────────────────────────────
    {
      name: '1. Auth: signed in',
      fn: async () => `uid=${ctx.uid.slice(0, 8)}…`,
    },
    {
      name: '2. Firestore: read own profile',
      fn: async () => {
        const snap = await getDoc(doc(db, 'users', ctx.uid));
        if (!snap.exists()) throw new Error('profile doc missing');
        return `handle=@${(snap.data() as { handle: string }).handle}`;
      },
    },

    // ── Drafts (users/{uid}/drafts) ────────────────────────────────────
    {
      name: '3. Draft: create roulette',
      fn: async () => {
        const block = newRouletteBlock();
        block.id = `diag-${Date.now()}`;
        block.name = '[diag] temp roulette';
        await saveDraft(ctx.uid, block);
        state.draftId = block.id;
        return `id=${block.id}`;
      },
    },
    {
      name: '4. Draft: read back',
      fn: async () => {
        if (!state.draftId) throw new Error('no draftId from step 3');
        const d = await getDraft(ctx.uid, state.draftId);
        if (!d) throw new Error('draft not found');
        if (d.name !== '[diag] temp roulette') throw new Error('name mismatch');
        return 'match';
      },
    },

    // ── Publish flow ───────────────────────────────────────────────────
    {
      name: '5. Publish: draft → wheels/{id}',
      fn: async () => {
        if (!state.draftId) throw new Error('no draft');
        const draft = await getDraft(ctx.uid, state.draftId);
        if (!draft) throw new Error('draft not found');
        state.wheelId = await publishWheel({
          author: ctx.profile,
          draft,
          isChallenge: true,
          challengePrompt: '[diag] test',
        });
        return `wheelId=${state.wheelId}`;
      },
    },
    {
      name: '6. Feed: published wheel appears',
      fn: async () => {
        if (!state.wheelId) throw new Error('no wheelId');
        const w = await fetchWheel(state.wheelId);
        if (!w) throw new Error('wheel not found');
        if (w.authorId !== ctx.uid) throw new Error('authorId mismatch');
        return `likes=${w.likesCount} saves=${w.savesCount}`;
      },
    },
    {
      name: '7. Feed: paginated fetch returns wheel',
      fn: async () => {
        if (!state.wheelId) throw new Error('no wheelId');
        const page = await fetchFeedPage();
        const found = page.items.some(w => w.id === state.wheelId);
        if (!found) throw new Error(`wheel not in first ${page.items.length} items — may need index`);
        return `page size=${page.items.length}`;
      },
    },

    // ── Social counters (transactional) ────────────────────────────────
    {
      name: '8. Like: increments counter',
      fn: async () => {
        if (!state.wheelId) throw new Error('no wheelId');
        await likeWheel(ctx.uid, state.wheelId);
        const after = await fetchWheel(state.wheelId);
        if (after?.likesCount !== 1) throw new Error(`expected likesCount=1, got ${after?.likesCount}`);
        if (!(await isWheelLiked(ctx.uid, state.wheelId))) throw new Error('like doc not found');
        return 'likesCount=1';
      },
    },
    {
      name: '9. Like: idempotent (double-like stays at 1)',
      fn: async () => {
        if (!state.wheelId) throw new Error('no wheelId');
        await likeWheel(ctx.uid, state.wheelId);
        const after = await fetchWheel(state.wheelId);
        if (after?.likesCount !== 1) throw new Error(`expected 1, got ${after?.likesCount}`);
        return 'stable';
      },
    },
    {
      name: '10. Unlike: decrements counter',
      fn: async () => {
        if (!state.wheelId) throw new Error('no wheelId');
        await unlikeWheel(ctx.uid, state.wheelId);
        const after = await fetchWheel(state.wheelId);
        if (after?.likesCount !== 0) throw new Error(`expected 0, got ${after?.likesCount}`);
        return 'likesCount=0';
      },
    },
    {
      name: '11. Save: adds to library & bumps savesCount',
      fn: async () => {
        if (!state.wheelId) throw new Error('no wheelId');
        await saveWheel(ctx.uid, state.wheelId);
        const after = await fetchWheel(state.wheelId);
        if (after?.savesCount !== 1) throw new Error(`expected savesCount=1, got ${after?.savesCount}`);
        if (!(await isWheelSaved(ctx.uid, state.wheelId))) throw new Error('library doc missing');
        await unsaveWheel(ctx.uid, state.wheelId);
        return 'save+unsave ok';
      },
    },

    // ── Comments ────────────────────────────────────────────────────────
    {
      name: '12. Comment: post → increments commentsCount',
      fn: async () => {
        if (!state.wheelId) throw new Error('no wheelId');
        state.commentId = await postComment({
          target: { kind: 'wheel', wheelId: state.wheelId },
          author: ctx.profile,
          text: '[diag] hello',
        });
        const after = await fetchWheel(state.wheelId);
        if (after?.commentsCount !== 1) throw new Error(`expected 1, got ${after?.commentsCount}`);
        return `id=${state.commentId}`;
      },
    },
    {
      name: '13. Comment: list returns it',
      fn: async () => {
        if (!state.wheelId || !state.commentId) throw new Error('no refs');
        const page = await fetchComments({ kind: 'wheel', wheelId: state.wheelId });
        if (!page.items.some(c => c.id === state.commentId)) throw new Error('not in list');
        return `${page.items.length} comment(s)`;
      },
    },
    {
      name: '14. Comment: delete → decrements counter',
      fn: async () => {
        if (!state.wheelId || !state.commentId) throw new Error('no refs');
        await deleteComment({ target: { kind: 'wheel', wheelId: state.wheelId }, commentId: state.commentId });
        const after = await fetchWheel(state.wheelId);
        if (after?.commentsCount !== 0) throw new Error(`expected 0, got ${after?.commentsCount}`);
        return 'commentsCount=0';
      },
    },

    // ── Cloud Function: issueUploadUrl ─────────────────────────────────
    {
      name: '15. Function: issueUploadUrl signs a URL',
      fn: async () => {
        // Build the exact blob we'll upload FIRST, then presign for its actual size.
        // The signature binds to Content-Length, so the claimed size must equal the
        // PUT body's size or R2 returns 403.
        const bytes = Uint8Array.from(atob(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
        ), c => c.charCodeAt(0));
        state.testBlob = new Blob([bytes], { type: 'image/png' });

        const call = httpsCallable<
          { purpose: 'response'; contentType: string; sizeBytes: number; responseId: string },
          { uploadUrl: string; publicUrl: string; key: string; expiresInSeconds: number }
        >(fns, 'issueUploadUrl');
        const res = await call({
          purpose: 'response',
          contentType: 'image/png',
          sizeBytes: state.testBlob.size,
          responseId: `diag-${Date.now()}`,
        });
        state.uploadUrl = res.data.uploadUrl;
        state.publicUrl = res.data.publicUrl;
        if (!state.uploadUrl.startsWith('https://')) throw new Error('bad uploadUrl');
        return `key=${res.data.key} size=${state.testBlob.size}`;
      },
    },
    {
      name: '16. Function: rejects bad mime',
      fn: async () => {
        const call = httpsCallable(fns, 'issueUploadUrl');
        try {
          await call({ purpose: 'response', contentType: 'text/plain', sizeBytes: 10, responseId: 'x' });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.toLowerCase().includes('unsupported mime')) return 'rejected ✓';
          return `rejected with: ${msg}`;
        }
        throw new Error('should have rejected');
      },
    },
    {
      name: '17. Function: rejects oversized (>5MB)',
      fn: async () => {
        const call = httpsCallable(fns, 'issueUploadUrl');
        try {
          await call({
            purpose: 'response', contentType: 'image/jpeg',
            sizeBytes: 6 * 1024 * 1024, responseId: 'x',
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.toLowerCase().includes('size must be')) return 'rejected ✓';
          return `rejected with: ${msg}`;
        }
        throw new Error('should have rejected');
      },
    },

    // ── R2: end-to-end upload + read ───────────────────────────────────
    {
      name: '18. R2: PUT a 1×1 PNG via presigned URL',
      fn: async () => {
        if (!state.uploadUrl) throw new Error('no uploadUrl from step 15');
        if (!state.testBlob) throw new Error('no testBlob from step 15');
        const res = await fetch(state.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' },
          body: state.testBlob,
        });
        if (!res.ok) throw new Error(`PUT failed ${res.status} ${await res.text().catch(() => '')}`);
        return `${res.status} ${res.statusText}`;
      },
    },
    {
      name: '19. R2: GET the uploaded object',
      fn: async () => {
        if (!state.publicUrl) throw new Error('no publicUrl');
        // R2 CDN caching can be eventually consistent — retry a couple times
        let lastStatus = 0;
        for (let i = 0; i < 5; i++) {
          const r = await fetch(state.publicUrl, { cache: 'no-cache' });
          lastStatus = r.status;
          if (r.ok) return `${r.status} (${r.headers.get('content-length')} bytes)`;
          await new Promise(res => setTimeout(res, 500));
        }
        throw new Error(`GET failed after retries: ${lastStatus}`);
      },
    },

    // ── End-to-end via service wrappers (real production path) ─────────
    {
      name: '20. uploadImage() full pipeline (resize → presign → PUT → URL)',
      fn: async () => {
        const rawImage = await generateTestImage();
        // Verify the generator actually produced the image it claimed to — decode the
        // blob and check dimensions. Catches silent canvas/encoder breakage without
        // depending on byte-size guesswork.
        const bmp = await createImageBitmap(rawImage);
        try {
          if (bmp.width !== 3000 || bmp.height !== 2000) {
            throw new Error(`generator produced ${bmp.width}×${bmp.height}, expected 3000×2000`);
          }
        } finally {
          bmp.close();
        }

        const publicUrl = await uploadImage({ purpose: 'profile', source: rawImage });
        if (!publicUrl.startsWith('https://')) throw new Error(`bad public URL: ${publicUrl}`);
        state.uploadedProfileUrl = publicUrl;

        // Verify the upload round-trips through R2 + CDN.
        for (let i = 0; i < 5; i++) {
          const r = await fetch(publicUrl, { cache: 'no-cache' });
          if (r.ok) return `raw=${rawImage.size}B (3000×2000) → uploaded & reachable`;
          await new Promise(res => setTimeout(res, 500));
        }
        throw new Error('upload succeeded but CDN GET failed');
      },
    },
    {
      name: '21. submitChallengeResponse() end-to-end',
      fn: async () => {
        if (!state.wheelId) throw new Error('no wheelId — publish test must run first');
        const img = await generateTestImage(1600, 1200);
        state.responseId = await submitChallengeResponse({
          wheelId: state.wheelId,
          author: ctx.profile,
          image: img,
          caption: '[diag] response test',
          resultSegmentIndex: 0,
          resultSegmentText: 'Option 1',
        });
        // Verify the response doc exists and counter bumped.
        const page = await fetchResponses(state.wheelId);
        const found = page.items.find(r => r.id === state.responseId);
        if (!found) throw new Error('response doc missing after submit');
        if (!found.imageUrl?.startsWith('https://')) throw new Error('imageUrl missing on response doc');
        const wheel = await fetchWheel(state.wheelId);
        if (wheel?.responsesCount !== 1) throw new Error(`responsesCount expected 1, got ${wheel?.responsesCount}`);
        return `responseId=${state.responseId} count=1`;
      },
    },

    // ── Cleanup ─────────────────────────────────────────────────────────
    {
      name: '22. Cleanup: delete response (if created)',
      fn: async () => {
        if (!state.wheelId || !state.responseId) return 'skipped';
        await deleteResponse({ wheelId: state.wheelId, responseId: state.responseId });
        return 'deleted';
      },
    },
    {
      name: '23. Cleanup: unpublish wheel',
      fn: async () => {
        if (!state.wheelId) throw new Error('no wheelId');
        await unpublishWheel({ uid: ctx.uid, wheelId: state.wheelId });
        const after = await fetchWheel(state.wheelId);
        if (after) throw new Error('wheel still exists');
        return 'deleted';
      },
    },
    {
      name: '24. Cleanup: delete draft',
      fn: async () => {
        if (!state.draftId) throw new Error('no draftId');
        await deleteDraft(ctx.uid, state.draftId);
        const after = await getDraft(ctx.uid, state.draftId);
        if (after) throw new Error('draft still exists');
        return 'deleted';
      },
    },
    {
      name: '25. Cleanup: remove like doc (if lingering)',
      fn: async () => {
        if (!state.wheelId) return 'skipped';
        // No-op best-effort in case unlike already removed it
        try { await deleteDoc(doc(db, 'users', ctx.uid, 'liked_wheels', state.wheelId)); } catch {}
        return 'ok';
      },
    },
  ];
}
