import { LogoIcon } from './icons';

// Minimal shell shared by recipient-facing private-link pages (/s/[id],
// /b/[id]): recipients aren't necessarily approved viewers, so no library
// navigation here.
export default function ShareShell({ user, children }) {
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">
          <LogoIcon />
          <span>Marine Video Portal</span>
        </span>
        <div className="topbar-actions">
          {user ? <span className="user-email">{user.email}</span> : null}
          {user ? (
            <a href="/auth/logout" className="btn btn-ghost btn-sm">
              Sign out
            </a>
          ) : null}
        </div>
      </header>
      <main className="main wide">{children}</main>
      <footer className="footer">Private share — this link is tied to your email address.</footer>
    </div>
  );
}
