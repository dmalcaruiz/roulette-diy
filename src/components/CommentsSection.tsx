import { useEffect, useState, useCallback } from 'react';
import { InsetTextField } from './PushDownButton';
import { ON_SURFACE, BORDER, PRIMARY } from '../utils/constants';
import { withAlpha } from '../utils/colorUtils';
import { useAuth } from '../contexts/AuthContext';
import { fetchComments, postComment, deleteComment, type CommentCursor } from '../services/commentService';
import type { Comment } from '../types/comment';
import { Send, MoreHorizontal, Trash2 } from 'lucide-react';

type Target =
  | { kind: 'wheel'; wheelId: string }
  | { kind: 'response'; wheelId: string; responseId: string };

export default function CommentsSection({ target }: { target: Target }) {
  const { profile } = useAuth();
  const [items, setItems] = useState<Comment[]>([]);
  const [cursor, setCursor] = useState<CommentCursor>({ done: false });
  const [input, setInput] = useState('');
  const [posting, setPosting] = useState(false);
  const [loading, setLoading] = useState(false);

  const loadMore = useCallback(async () => {
    if (loading || cursor.done) return;
    setLoading(true);
    try {
      const page = await fetchComments(target, cursor);
      setItems(prev => [...prev, ...page.items]);
      setCursor(page.cursor);
    } finally {
      setLoading(false);
    }
  }, [target, cursor, loading]);

  useEffect(() => {
    setItems([]);
    setCursor({ done: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.kind === 'wheel' ? target.wheelId : target.responseId]);

  useEffect(() => {
    if (items.length === 0 && !cursor.done && !loading) loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, cursor.done]);

  const onSend = async () => {
    if (!profile || !input.trim() || posting) return;
    setPosting(true);
    try {
      await postComment({ target, author: profile, text: input });
      setInput('');
      // Prepend optimistically on next refetch
      setItems([]);
      setCursor({ done: false });
    } finally {
      setPosting(false);
    }
  };

  const onDelete = async (c: Comment) => {
    if (!profile || c.authorId !== profile.uid) return;
    await deleteComment({ target, commentId: c.id });
    setItems(prev => prev.filter(x => x.id !== c.id));
  };

  return (
    <div style={{ padding: '0 16px' }}>
      {/* Input row */}
      {profile && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <InsetTextField
              value={input}
              onChange={setInput}
              placeholder="Add a comment…"
            />
          </div>
          <button
            onClick={onSend}
            disabled={!input.trim() || posting}
            style={{
              width: 44, height: 44,
              borderRadius: 22,
              backgroundColor: PRIMARY,
              color: '#FFF',
              border: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: input.trim() && !posting ? 'pointer' : 'default',
              opacity: input.trim() && !posting ? 1 : 0.5,
            }}
          >
            <Send size={18} />
          </button>
        </div>
      )}

      {/* List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {items.map(c => (
          <CommentRow key={c.id} comment={c} canDelete={c.authorId === profile?.uid} onDelete={() => onDelete(c)} />
        ))}
        {items.length === 0 && !loading && (
          <p style={{ fontSize: 14, color: withAlpha(ON_SURFACE, 0.5), textAlign: 'center', padding: '16px 0' }}>
            Be the first to comment.
          </p>
        )}
      </div>

      {!cursor.done && items.length > 0 && (
        <button
          onClick={loadMore}
          disabled={loading}
          style={{
            marginTop: 12,
            width: '100%',
            padding: '10px',
            fontSize: 13,
            fontWeight: 700,
            color: withAlpha(ON_SURFACE, 0.6),
            background: 'none',
            border: `1.5px solid ${BORDER}`,
            borderRadius: 12,
            cursor: loading ? 'default' : 'pointer',
          }}
        >
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}

function CommentRow({ comment, canDelete, onDelete }: {
  comment: Comment; canDelete: boolean; onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div style={{ display: 'flex', gap: 10 }}>
      <Avatar url={comment.authorPhotoUrl} size={36} />
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: ON_SURFACE }}>
            {comment.authorDisplayName}
          </span>
          <span style={{ fontSize: 12, color: withAlpha(ON_SURFACE, 0.45) }}>
            @{comment.authorHandle}
          </span>
          {canDelete && (
            <div style={{ marginLeft: 'auto', position: 'relative' }}>
              <button
                onClick={() => setMenuOpen(!menuOpen)}
                style={{ background: 'none', border: 'none', padding: 4, cursor: 'pointer' }}
              >
                <MoreHorizontal size={16} color={withAlpha(ON_SURFACE, 0.5)} />
              </button>
              {menuOpen && (
                <div style={{
                  position: 'absolute', top: '100%', right: 0,
                  backgroundColor: '#FFF', border: `1.5px solid ${BORDER}`,
                  borderRadius: 10, padding: 4, zIndex: 10,
                  boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
                }}>
                  <button
                    onClick={() => { setMenuOpen(false); onDelete(); }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 10px',
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: '#EF4444', fontSize: 13, fontWeight: 600,
                    }}
                  >
                    <Trash2 size={14} /> Delete
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        <p style={{ fontSize: 14, color: ON_SURFACE, margin: '2px 0 0', lineHeight: 1.4 }}>
          {comment.text}
        </p>
      </div>
    </div>
  );
}

function Avatar({ url, size }: { url?: string | null; size: number }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      backgroundColor: '#E4E4E7',
      backgroundImage: url ? `url(${url})` : undefined,
      backgroundSize: 'cover', backgroundPosition: 'center',
      flexShrink: 0,
    }} />
  );
}
