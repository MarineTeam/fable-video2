// Share-link email delivery via Resend's REST API. No SDK dependency, nothing
// in the client bundle, and completely inert without RESEND_API_KEY.

export function mailEnabled() {
  return Boolean(process.env.RESEND_API_KEY);
}

export async function sendShareEmail({ to, url, videoTitle, expiresAt }) {
  if (!mailEnabled()) return { ok: false, skipped: true };
  try {
    const from = process.env.MAIL_FROM || 'onboarding@resend.dev';
    const title = videoTitle || 'a video';
    const expiry = expiresAt ? new Date(expiresAt).toUTCString() : null;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `A video was shared with you: ${title}`,
        html: [
          `<p>You've been given private access to <strong>${escapeHtml(title)}</strong>.</p>`,
          `<p><a href="${url}">Watch it here</a> — you'll be asked to sign in with this email address (${escapeHtml(to)}).</p>`,
          expiry ? `<p>This link expires ${expiry}.</p>` : '',
          `<p style="color:#888;font-size:12px">If you weren't expecting this, you can ignore it.</p>`,
        ].join('\n'),
      }),
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
