import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FiZap, FiSend, FiAlertCircle, FiExternalLink } from 'react-icons/fi';
import api from '../services/api';

const EXAMPLE_QUESTIONS = [
  'What are people discussing about React?',
  'What topics are users posting about?',
  'Summarize posts about web development.',
  'What are users saying about internships?',
];

export default function AIPage() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasAsked, setHasAsked] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const q = question.trim();
    if (!q || loading) return;

    setLoading(true);
    setError('');
    setAnswer('');
    setSources([]);
    setHasAsked(true);

    try {
      const res = await api.post('/ai/ask', { question: q });
      setAnswer(res.data.answer || '');
      setSources(res.data.sources || []);
    } catch (err) {
      const msg =
        err?.response?.data?.message ||
        'Something went wrong. Please try again.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleExample = (q) => {
    setQuestion(q);
    setAnswer('');
    setSources([]);
    setError('');
    setHasAsked(false);
  };

  const charsLeft = 500 - question.length;

  return (
    <div className="ai-page">
      {/* ── Header ── */}
      <div className="ai-page-header">
        <div className="ai-page-header-icon">
          <FiZap size={28} />
        </div>
        <div>
          <h1 className="ai-page-title">GOSocial AI</h1>
          <p className="ai-page-subtitle">
            Ask questions about public GOSocial posts — powered by RAG + Gemini
          </p>
        </div>
      </div>

      {/* ── Input Card ── */}
      <div className="ai-input-card card">
        <form onSubmit={handleSubmit} className="ai-form">
          <textarea
            id="ai-question-input"
            className="ai-textarea"
            value={question}
            onChange={(e) => setQuestion(e.target.value.slice(0, 500))}
            placeholder="Ask something about GOSocial posts…"
            rows={3}
            disabled={loading}
            aria-label="Ask a question about GOSocial posts"
          />
          <div className="ai-form-footer">
            <span className={`ai-char-count ${charsLeft < 50 ? 'ai-char-warn' : ''}`}>
              {charsLeft} chars left
            </span>
            <button
              id="ai-ask-btn"
              type="submit"
              className="primary-btn ai-ask-btn"
              disabled={loading || !question.trim()}
            >
              {loading ? (
                <>
                  <span className="loading-spinner ai-spinner" />
                  Thinking…
                </>
              ) : (
                <>
                  <FiSend size={16} />
                  Ask
                </>
              )}
            </button>
          </div>
        </form>

        {/* ── Example prompts ── */}
        <div className="ai-examples">
          <p className="ai-examples-label">Try asking:</p>
          <div className="ai-examples-list">
            {EXAMPLE_QUESTIONS.map((q) => (
              <button
                key={q}
                type="button"
                className="ai-example-chip"
                onClick={() => handleExample(q)}
                disabled={loading}
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Error state ── */}
      {error && (
        <div className="ai-error-card card" role="alert">
          <FiAlertCircle size={20} />
          <p>{error}</p>
        </div>
      )}

      {/* ── Loading skeleton ── */}
      {loading && (
        <div className="ai-answer-card card skeleton-card">
          <div className="ai-answer-skeleton">
            <div className="skeleton-line" style={{ width: '80%' }} />
            <div className="skeleton-line" style={{ width: '65%', marginTop: 10 }} />
            <div className="skeleton-line" style={{ width: '73%', marginTop: 10 }} />
            <div className="skeleton-line short" style={{ marginTop: 10 }} />
          </div>
        </div>
      )}

      {/* ── Answer ── */}
      {!loading && hasAsked && answer && (
        <div className="ai-answer-card card">
          <div className="ai-answer-header">
            <FiZap size={18} className="ai-answer-icon" />
            <h2 className="ai-answer-title">AI Answer</h2>
          </div>
          <div className="ai-divider" />
          <p className="ai-answer-text">{answer}</p>
        </div>
      )}

      {/* ── Sources ── */}
      {!loading && sources.length > 0 && (
        <div className="ai-sources-section">
          <h3 className="ai-sources-title">Sources</h3>
          <div className="ai-divider" />
          <div className="ai-sources-list">
            {sources.map((src) => (
              <Link
                key={src.postId}
                to={`/post/${src.postId}`}
                className="ai-source-card"
                aria-label={`View post by @${src.author.username}`}
              >
                <div className="ai-source-top">
                  <span className="ai-source-author">@{src.author.username}</span>
                  <FiExternalLink size={14} className="ai-source-link-icon" />
                </div>
                <p className="ai-source-content">
                  {src.content.length > 160
                    ? src.content.slice(0, 160) + '…'
                    : src.content || '(no caption)'}
                </p>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* ── Empty answer state ── */}
      {!loading && hasAsked && !answer && !error && (
        <div className="ai-answer-card card">
          <p className="ai-page-subtitle" style={{ textAlign: 'center', padding: '16px 0' }}>
            No answer was returned. Try rephrasing your question.
          </p>
        </div>
      )}
    </div>
  );
}
