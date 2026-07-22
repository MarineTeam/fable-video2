import Link from 'next/link';
import NotifyButton from './NotifyButton';
import { LogoIcon } from './icons';

export default function AppShell({ user, isAdmin, approved, wide, children }) {
  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/" className="brand">
          <LogoIcon />
          <span>Marine Video Portal</span>
        </Link>
        <div className="topbar-actions">
          {approved ? (
            <Link href="/activity" className="btn btn-ghost btn-sm">
              {isAdmin ? 'Activity' : 'My Activity'}
            </Link>
          ) : null}
          {approved ? <NotifyButton /> : null}
          {isAdmin ? (
            <Link href="/admin" className="btn btn-ghost btn-sm">
              Admin
            </Link>
          ) : null}
          {user ? (
            <span className="user-email" title={user.email}>
              {user.email}
            </span>
          ) : null}
          {user ? (
            <a href="/auth/logout" className="btn btn-ghost btn-sm">
              Sign out
            </a>
          ) : null}
        </div>
      </header>
      <main className={wide ? 'main wide' : 'main'}>{children}</main>
      <footer className="footer">Private portal — playback is tokenized and access-controlled.</footer>
    </div>
  );
}
