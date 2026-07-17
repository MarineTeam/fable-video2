import { useEffect, useState } from 'react';
import { BellIcon, BellOffIcon } from './icons';

const VAPID_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

// Per-device push opt-in/out. Renders nothing unless push is configured and
// the browser supports it.
export default function NotifyButton() {
  const [state, setState] = useState('hidden'); // hidden | off | on | busy

  useEffect(() => {
    if (!VAPID_KEY) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    let mounted = true;
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => {
        if (mounted) setState(sub ? 'on' : 'off');
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  if (state === 'hidden') return null;

  async function toggle() {
    setState('busy');
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        const endpoint = existing.endpoint;
        await existing.unsubscribe();
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint }),
        });
        setState('off');
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState('off');
        return;
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_KEY),
      });
      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      if (!res.ok) {
        await sub.unsubscribe().catch(() => {});
        setState('off');
        return;
      }
      setState('on');
    } catch {
      setState('off');
    }
  }

  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={toggle}
      disabled={state === 'busy'}
      title={state === 'on' ? 'Turn off notifications on this device' : 'Get notified about new videos'}
    >
      {state === 'on' ? <BellOffIcon /> : <BellIcon />}
      <span>{state === 'on' ? 'Mute' : 'Notify me'}</span>
    </button>
  );
}
