import { useEffect } from 'react';

const IDLE_MS = 30 * 60 * 1000;

// Signs the user out after 30 minutes of inactivity — protects a portal left
// open on a shared machine.
export default function IdleTimeout() {
  useEffect(() => {
    let timer;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        window.location.href = '/auth/logout';
      }, IDLE_MS);
    };
    const events = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'];
    events.forEach((name) => window.addEventListener(name, reset, { passive: true }));
    reset();
    return () => {
      clearTimeout(timer);
      events.forEach((name) => window.removeEventListener(name, reset));
    };
  }, []);
  return null;
}
