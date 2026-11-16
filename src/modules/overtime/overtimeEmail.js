// Branded e-mails of the overtime requests. Table layout and inline styles only (Outlook desktop ignores <style>, flex
// and most CSS), no images (the brand logo is WebP, which Outlook does not show): the brand is the colors and the name.
// Colors as in the app: brand purple #210d65, violet #5848b5, soft violet #f2effa, lime accent #a8d62e. Never green
// for a status (green means "paid" in the company's apps): approved is violet, rejected grey, pending amber.

const BRAND = "#210d65";
const VIOLET = "#5848b5";
const SOFT = "#f2effa";
const LIME = "#a8d62e";
const INK = "#1f2937";
const MUTED = "#6b7280";
const FONT = "Arial, Helvetica, sans-serif";

export const escapeHtml = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const row = (label, value) =>
  `<tr><td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:${MUTED};font-size:14px;width:40%;">${escapeHtml(label)}</td>` +
  `<td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:${INK};font-size:14px;font-weight:bold;">${escapeHtml(value)}</td></tr>`;

const button = (href, label) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px;"><tr>` +
  `<td style="background:${VIOLET};border-radius:8px;">` +
  `<a href="${escapeHtml(href)}" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a>` +
  `</td></tr></table>`;

const pill = (text, tone) => {
  const colors = { pending: ["#fef3c7", "#92400e"], approved: [SOFT, BRAND], rejected: ["#f1f1f4", "#52525b"] }[tone];
  return `<span style="display:inline-block;padding:5px 12px;border-radius:999px;background:${colors[0]};color:${colors[1]};font-size:13px;font-weight:bold;">${escapeHtml(text)}</span>`;
};

/** The frame every message shares: purple header with the lime stripe, white card, footer. `body` is trusted HTML. */
function layout({ preheader, title, body }) {
  return [
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>`,
    `<body style="margin:0;padding:0;background:${SOFT};">`,
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${SOFT};"><tr><td align="center" style="padding:24px 12px;">`,
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:${FONT};">`,
    `<tr><td style="background:${BRAND};padding:22px 28px;">`,
    `<div style="font-size:22px;font-weight:bold;color:#ffffff;letter-spacing:0.5px;">Merkahorro</div>`,
    `<div style="font-size:13px;color:#d9d3f2;margin-top:2px;">Programador de horarios · Gestión de turnos</div>`,
    `</td></tr>`,
    `<tr><td style="height:5px;background:${LIME};line-height:5px;font-size:0;">&nbsp;</td></tr>`,
    `<tr><td style="padding:28px 28px 8px;color:${INK};">`,
    `<h1 style="margin:0 0 16px;font-size:21px;line-height:1.35;color:${BRAND};">${escapeHtml(title)}</h1>`,
    body,
    `</td></tr>`,
    `<tr><td style="padding:18px 28px 24px;border-top:1px solid #ede9f8;color:${MUTED};font-size:12px;line-height:1.5;">`,
    `Este es un correo automático del programador de horarios de Merkahorro. No lo respondas: gestiona la solicitud desde la aplicación.`,
    `</td></tr></table></td></tr></table></body></html>`,
  ].join("");
}

const hoursText = (hours) => `${Number(hours).toLocaleString("es-CO", { maximumFractionDigits: 1 })} h`;

/** To the approvers: a leader asks for extra overtime hours. */
export function requestEmail({ requester, sedeNombre, weekText, hours, motivo, link }) {
  const title = `Solicitud de ${hoursText(hours)} extra`;
  const body = [
    `<p style="margin:0 0 6px;font-size:15px;line-height:1.5;"><strong>${escapeHtml(requester)}</strong> solicita horas extra para el equipo de cajas, además de las 10 h semanales.</p>`,
    `<p style="margin:0 0 18px;">${pill("Pendiente de aprobación", "pending")}</p>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 4px;">`,
    `<tr><td colspan="2" style="padding:0 0 12px;"><span style="font-size:36px;font-weight:bold;color:${VIOLET};">${escapeHtml(hoursText(hours))}</span> <span style="font-size:14px;color:${MUTED};">extra solicitadas</span></td></tr>`,
    row("Sede", sedeNombre),
    row("Semana", `del ${weekText}`),
    row("Solicitó", requester),
    `</table>`,
    `<div style="margin:18px 0 0;padding:14px 16px;background:${SOFT};border-left:4px solid ${VIOLET};border-radius:6px;">`,
    `<div style="font-size:12px;font-weight:bold;color:${MUTED};text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Motivo</div>`,
    `<div style="font-size:15px;line-height:1.5;color:${INK};">${escapeHtml(motivo)}</div></div>`,
    button(link, "Revisar en Autorizaciones"),
    `<p style="margin:0 0 8px;font-size:13px;color:${MUTED};line-height:1.5;">Basta con que uno de los aprobadores la apruebe o la rechace. El líder recibe un correo con la respuesta.</p>`,
  ].join("");
  return {
    subject: `Solicitud de ${hoursText(hours)} extra · ${sedeNombre} · semana del ${weekText}`,
    text: `${requester} solicita ${hoursText(hours)} extra para ${sedeNombre}, semana del ${weekText}. Motivo: ${motivo}. Revísala en ${link}`,
    html: layout({ preheader: `${requester} solicita ${hoursText(hours)} extra para ${sedeNombre}`, title, body }),
  };
}

/** To the leader: an approver decided their request. */
export function decisionEmail({ approver, approved, sedeNombre, weekText, hours, comment }) {
  const verb = approved ? "aprobó" : "rechazó";
  const title = `Horas extra ${approved ? "aprobadas" : "rechazadas"}`;
  const body = [
    `<p style="margin:0 0 6px;font-size:15px;line-height:1.5;"><strong>${escapeHtml(approver)}</strong> ${verb} tu solicitud de horas extra.</p>`,
    `<p style="margin:0 0 18px;">${pill(approved ? "Aprobada" : "Rechazada", approved ? "approved" : "rejected")}</p>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">`,
    row("Horas", hoursText(hours)),
    row("Sede", sedeNombre),
    row("Semana", `del ${weekText}`),
    `</table>`,
    comment
      ? `<div style="margin:18px 0 0;padding:14px 16px;background:${SOFT};border-left:4px solid ${VIOLET};border-radius:6px;"><div style="font-size:12px;font-weight:bold;color:${MUTED};text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Comentario</div><div style="font-size:15px;line-height:1.5;color:${INK};">${escapeHtml(comment)}</div></div>`
      : "",
    `<p style="margin:18px 0 8px;font-size:14px;line-height:1.5;color:${INK};">${approved ? "Ya puedes usar esas horas al armar el horario de esa semana: el programador las suma a las 10 h del equipo." : "La semana se queda con las 10 h extra semanales del equipo."}</p>`,
  ].join("");
  return {
    subject: `Horas extra ${approved ? "aprobadas" : "rechazadas"} · ${sedeNombre} · semana del ${weekText}`,
    text: `${approver} ${verb} tu solicitud de ${hoursText(hours)} extra para ${sedeNombre}, semana del ${weekText}.${comment ? ` Comentario: ${comment}` : ""}`,
    html: layout({ preheader: `${approver} ${verb} tu solicitud de ${hoursText(hours)} extra`, title, body }),
  };
}
