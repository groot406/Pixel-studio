// Sign-in emails. Uses Resend (https://resend.com) when RESEND_API_KEY is set; otherwise prints the link to the
// server log, which is only acceptable for local development.
import { CloudError } from './store.mjs';

const escapeHTML = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function signInMessage(link) {
  return {
    subject: 'Your Pixel Studio sign-in link',
    text: `Sign in to Pixel Studio:\n\n${link}\n\nThe link works once and expires in 15 minutes. If you did not ask for it, ignore this email.`,
    html: `<p>Sign in to Pixel Studio:</p><p><a href="${escapeHTML(link)}" style="display:inline-block;padding:10px 18px;background:#7c5cff;color:#fff;border-radius:8px;text-decoration:none">Sign in</a></p><p style="color:#666;font-size:13px">The link works once and expires in 15 minutes. If you did not ask for it, ignore this email.</p>`,
  };
}

export function createMailer({ config, fetchImpl = globalThis.fetch, log = console.log }) {
  return {
    async sendSignIn(email, link) {
      const message = signInMessage(link);
      if (!config.resendApiKey) {
        if (config.production) throw new CloudError('MAIL_DISABLED', 'Email sign-in is not set up on this server yet.', 503);
        log(`[pixel-studio-cloud] sign-in link for ${email}: ${link}`);
        return;
      }
      let response;
      try {
        response = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.resendApiKey}` },
          body: JSON.stringify({ from: config.mailFrom, to: [email], ...message }),
        });
      } catch { response = null; }
      if (!response?.ok) throw new CloudError('MAIL_FAILED', 'The sign-in email could not be sent. Try again in a moment.', 502);
    },
  };
}
