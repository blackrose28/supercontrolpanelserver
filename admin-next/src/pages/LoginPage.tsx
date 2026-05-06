import { useState } from 'react';

export function LoginPage() {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(new URLSearchParams(window.location.search).get('error'));

  async function handleSubmit(e: React.FormEvent) {
    // If we want to use traditional form submission to /admin/login:
    // e.preventDefault();
    setLoading(true);
    // The form will submit normally to the backend via proxy
  }

  return (
    <div className="login-page-container">
      <style>{`
        .login-page-container {
          margin: 0;
          font-family: 'Inter', sans-serif;
          background-color: #0f172a;
          background-image:
              radial-gradient(at 0% 0%, hsla(253,16%,7%,1) 0, transparent 50%),
              radial-gradient(at 50% 0%, hsla(225,39%,30%,1) 0, transparent 50%),
              radial-gradient(at 100% 0%, hsla(339,49%,30%,1) 0, transparent 50%);
          height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          color: #f8fafc;
          overflow: hidden;
        }

        .login-card {
            background: rgba(30, 41, 59, 0.7);
            backdrop-filter: blur(12px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            padding: 2.5rem;
            border-radius: 1.5rem;
            width: 100%;
            max-width: 400px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
            animation: fadeIn 0.6s cubic-bezier(0.16, 1, 0.3, 1);
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .login-card h1 {
            font-size: 1.875rem;
            font-weight: 700;
            margin-bottom: 0.5rem;
            text-align: center;
            background: linear-gradient(to right, #818cf8, #c084fc);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        .login-card p.subtitle {
            color: #94a3b8;
            text-align: center;
            margin-bottom: 2rem;
            font-size: 0.875rem;
        }

        .form-group { margin-bottom: 1.5rem; }

        .form-group label {
            display: block;
            font-size: 0.875rem;
            font-weight: 500;
            margin-bottom: 0.5rem;
            color: #94a3b8;
        }

        .form-group input {
            width: 100%;
            background: rgba(15, 23, 42, 0.5);
            border: 1px solid rgba(255, 255, 255, 0.1);
            padding: 0.75rem 1rem;
            border-radius: 0.75rem;
            color: white;
            font-size: 1rem;
            transition: all 0.2s;
            outline: none;
        }

        .form-group input:focus {
            border-color: #6366f1;
            box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.2);
        }

        .login-card button {
            width: 100%;
            background: #6366f1;
            color: white;
            border: none;
            padding: 0.75rem;
            border-radius: 0.75rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            margin-top: 1rem;
        }

        .login-card button:hover:not(:disabled) {
            background: #4f46e5;
            transform: translateY(-1px);
        }

        .login-card button:active:not(:disabled) { transform: translateY(0); }
        .login-card button:disabled { opacity: 0.7; cursor: not-allowed; }

        .error-message {
            background: rgba(239, 68, 68, 0.1);
            border: 1px solid rgba(239, 68, 68, 0.2);
            color: #ef4444;
            padding: 0.75rem;
            border-radius: 0.75rem;
            font-size: 0.875rem;
            margin-bottom: 1.5rem;
        }
      `}</style>
      <div className="login-card">
        <h1>SuperControlPanel</h1>
        <p className="subtitle">Enter your password to access the dashboard</p>

        {error && (
          <div className="error-message">
            {error === '1' ? 'Invalid password. Please try again.' : error}
          </div>
        )}

        <form method="POST" action="/admin/login" onSubmit={handleSubmit}>
          <input type="hidden" name="next" value={new URLSearchParams(window.location.search).get('next') || '/'} />
          <div className="form-group">
            <label htmlFor="password">Admin Password</label>
            <input
              type="password"
              id="password"
              name="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
              placeholder="••••••••"
            />
          </div>
          <button type="submit" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
