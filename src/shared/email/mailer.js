// Outgoing e-mail over the company's Office 365 SMTP, same variables as the other Merkahorro backends:
// EMAIL_HOST (default smtp.office365.com), EMAIL_PORT (587), EMAIL_SECURE ("true" for 465), EMAIL_USER, EMAIL_PASS.
// Without EMAIL_USER / EMAIL_PASS the mailer is disabled: send() throws MAIL_NOT_CONFIGURED and callers degrade.

export function createMailer(env = process.env, { createTransport } = {}) {
  const user = env.EMAIL_USER;
  const pass = env.EMAIL_PASS;
  let transporter = null;

  async function transport() {
    if (transporter) return transporter;
    const factory = createTransport ?? (await import("nodemailer")).default.createTransport;
    transporter = factory({
      host: env.EMAIL_HOST || "smtp.office365.com",
      port: Number(env.EMAIL_PORT) || 587,
      secure: env.EMAIL_SECURE === "true",
      auth: { user, pass },
      tls: { ciphers: "TLSv1.2" },
    });
    return transporter;
  }

  return {
    configured: Boolean(user && pass),
    async send({ to, subject, html, text }) {
      if (!user || !pass) {
        const err = new Error("E-mail is not configured (EMAIL_USER / EMAIL_PASS)");
        err.code = "MAIL_NOT_CONFIGURED";
        throw err;
      }
      const t = await transport();
      await t.sendMail({ from: `"Programador de horarios" <${user}>`, to: to.join(", "), subject, html, text });
      return { sent: true };
    },
  };
}
