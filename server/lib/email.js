// Sends transactional emails via Resend (https://resend.com). Uses raw fetch
// rather than their SDK to keep dependencies minimal, matching how the Groq
// provider is wired in this project.

const RESEND_API_URL = "https://api.resend.com/emails";

async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL || "Orivon <onboarding@resend.dev>";

  if (!apiKey) {
    console.warn(`[email] RESEND_API_KEY not set — would have sent "${subject}" to ${to}`);
    return { sent: false, reason: "not_configured" };
  }

  let res;
  try {
    res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ from, to, subject, html }),
    });
  } catch (e) {
    console.error("[email] Network error reaching Resend:", e.message);
    return { sent: false, reason: "network_error" };
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error(`[email] Resend request failed (${res.status}):`, errText);
    return { sent: false, reason: "send_failed" };
  }
  return { sent: true };
}

// Shared branded wrapper so every transactional email looks consistent.
function emailLayout({ title, bodyHtml }) {
  return `
<!DOCTYPE html>
<html>
  <body style="margin:0; padding:0; background:#EFEBE2; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EFEBE2; padding: 40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width: 480px; width: 100%; background:#ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #DDD8CC;">
            <tr>
              <td style="background:#ffffff; padding: 28px 36px; border-bottom: 3px solid #7DB8A0;">
                <img src="${(process.env.APP_URL || "").replace(/\/$/, "")}/img/orivon-logo.png" alt="Orivon" height="36" style="height:36px; width:auto; display:block; border:0;" />
              </td>
            </tr>
            <tr>
              <td style="padding: 36px 36px 8px;">
                <h1 style="font-family: Georgia, 'Times New Roman', serif; font-size: 22px; color: #1F2420; margin: 0 0 18px;">${title}</h1>
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding: 24px 36px 32px;">
                <div style="border-top: 1px solid #DDD8CC; padding-top: 18px;">
                  <p style="font-size: 12px; color: #8A8F86; margin: 0; line-height: 1.6;">
                    You're receiving this because it's tied to an Orivon account. If this wasn't you, you can safely ignore this email.
                  </p>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function emailButton(url, label) {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 24px 0;">
      <tr>
        <td style="border-radius: 999px; background:#294A3F;">
          <a href="${url}" style="display:inline-block; padding: 13px 28px; font-size: 15px; font-weight: 500; color:#ffffff; text-decoration:none; border-radius: 999px;">${label}</a>
        </td>
      </tr>
    </table>`;
}

function emailParagraph(text) {
  return `<p style="font-size: 15px; line-height: 1.6; color: #4A5049; margin: 0 0 14px;">${text}</p>`;
}

function emailFallbackLink(url) {
  return `<p style="font-size: 12px; color: #8A8F86; line-height: 1.6; margin: 18px 0 0; word-break: break-all;">If the button doesn't work, copy and paste this link into your browser:<br/><a href="${url}" style="color: #3D6B5C;">${url}</a></p>`;
}

function sendPasswordResetEmail({ to, resetUrl }) {
  const bodyHtml = `
    ${emailParagraph("We received a request to reset the password for your Orivon account. Click below to choose a new one.")}
    ${emailButton(resetUrl, "Reset password")}
    ${emailParagraph("This link expires in <strong>1 hour</strong>. If you didn't request this, you can safely ignore this email — your password won't be changed.")}
    ${emailFallbackLink(resetUrl)}
  `;
  return sendEmail({ to, subject: "Reset your Orivon password", html: emailLayout({ title: "Reset your password", bodyHtml }) });
}

// Not yet wired into the signup flow — this is the template only, ready for
// when email verification is built as a full feature.
function sendEmailVerificationEmail({ to, verifyUrl, firstName }) {
  const greeting = firstName ? `Hi ${firstName},` : "Hi,";
  const bodyHtml = `
    ${emailParagraph(`${greeting} welcome to Orivon. Confirm your email address to finish setting up your account.`)}
    ${emailButton(verifyUrl, "Verify email address")}
    ${emailParagraph("This link expires in <strong>24 hours</strong>. If you didn't create an Orivon account, you can safely ignore this email.")}
    ${emailFallbackLink(verifyUrl)}
  `;
  return sendEmail({ to, subject: "Verify your email for Orivon", html: emailLayout({ title: "Confirm your email", bodyHtml }) });
}

module.exports = { sendEmail, sendPasswordResetEmail, sendEmailVerificationEmail, emailLayout, emailButton, emailParagraph, emailFallbackLink };
