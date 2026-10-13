import catalog from '../../pdf-katalog.json' with { type: 'json' };
import pg from 'pg';
import crypto from 'node:crypto';
const { Pool } = pg;
let pool;
// Themen werden NUR nach bestätigter Zuordnung versendet. Keine zufällige PDF-Zuordnung.
function pdfForTopic(topic='') {
 const matches=Object.entries(catalog).filter(([,v])=>v.topic && v.title && v.topic.toLocaleLowerCase('de-DE')===topic.toLocaleLowerCase('de-DE'));
 if(matches.length!==1) throw new Error('PDF-Thema noch nicht eindeutig zugeordnet');
 const [key,item]=matches[0];
 return {key,link:item.url,title:item.title};
}
function response(status,data){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});}
async function sendMail(to,name,topic,pdf){
 const api=process.env.BREVO_API_KEY, sender=process.env.SENDER_EMAIL;
 if(!api||!sender) throw new Error('Maildienst nicht konfiguriert');
 const link=pdf.link; if(!link||!/^https:\/\//.test(link)) throw new Error('PDF-URL fehlt');
 
const html = `
  <div style="font-family:Arial,sans-serif;max-width:580px;margin:auto;color:#182235;line-height:1.7;padding:20px;">
    <p style="color:#007a52;font-size:12px;font-weight:bold;">
      GERMAN.FAIRSICHERT · DEINE CHECKLISTE
    </p>

    <h2 style="font-size:25px;line-height:1.3;">
      Mehr Klarheit. Weniger Fragezeichen.
    </h2>

    <p>Hallo ${escapeHtml(name.split(' ')[0])},</p>

    <p>schön, dass du dich mit deiner finanziellen Absicherung beschäftigst!</p>

    <p>Wie versprochen erhältst du hier deine Checkliste zum Thema
    <strong>${escapeHtml(topic)}</strong>.</p>

    <p>Sie hilft dir dabei, die wichtigsten Fragen zu klären,
    mögliche Stolperfallen zu erkennen und herauszufinden,
    worauf es bei deiner Entscheidung wirklich ankommt.</p>

    <div style="background:#f2f6f4;padding:24px;border-radius:12px;text-align:center;margin:28px 0;">
      <p style="font-weight:bold;margin-top:0;">
        ${escapeHtml(pdf.title)}
      </p>

      <a href="${escapeHtml(link)}"
         style="display:inline-block;background:#006b49;color:#ffffff;
         padding:13px 22px;border-radius:8px;text-decoration:none;font-weight:bold;">
        Checkliste öffnen (PDF)
      </a>
    </div>

    <p><strong>Du hast noch Fragen?</strong></p>

    <p>Dann antworte einfach auf diese E-Mail.
    Ich schaue mir deine Situation gerne mit dir an –
    verständlich, transparent und ohne Verkaufsdruck.</p>

    <p>Viele Grüße<br>
    <strong>German Vojlenko</strong><br>
    Fachberater für Vorsorge, Investments & Gewerbe<br>
    German.Fairsichert</p>
  </div>
`;
const r = await fetch('https://api.brevo.com/v3/smtp/email', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'api-key': api
  },
  body: JSON.stringify({
    sender: {
      email: sender,
      name: 'German Vojlenko | German.Fairsichert'
    },
    to: [{ email: to, name }],
    subject: 'Deine Checkliste ist da! ✓',
    htmlContent: html
  })
});

if (!r.ok) {
  throw new Error(`Maildienst HTTP ${r.status}`);
}

 return (await r.json()).messageId || 'accepted';
}
function escapeHtml(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
export default async function handler(request){
 if(request.method!=='POST')return response(405,{ok:false,error:'Methode nicht erlaubt'});
 const origin=request.headers.get('origin'); const allowed=process.env.ALLOWED_ORIGIN||'https://germanfairsichert.netlify.app';
 if(origin && origin!==allowed)return response(403,{ok:false,error:'Herkunft nicht erlaubt'});
 const size=Number(request.headers.get('content-length')||0);if(size>12000)return response(413,{ok:false,error:'Anfrage zu groß'});
 let b;try{b=await request.json();}catch{return response(400,{ok:false,error:'Ungültige Daten'});}
 if(b.website)return response(200,{ok:true}); // honeypot
 const email=String(b.email||'').trim().toLowerCase(),name=String(b.name||'').trim();
 const topic=String(b.topic||'').slice(0,120);
 if((b.type==='pdf' && !Object.hasOwn(catalog,topic)) || !['pdf','consultation'].includes(b.type)||name.length<2||name.length>120||!/^\S+@\S+\.\S+$/.test(email)||email.length>254)return response(400,{ok:false,error:'Bitte Name und E-Mail prüfen'});
 if(!process.env.DATABASE_URL)return response(503,{ok:false,error:'Datenbank noch nicht eingerichtet'});
 pool ||= new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:true},max:3});
 const client=await pool.connect();let id;
 try{
  await client.query('BEGIN');
  const t=b.tracking||{};const yes=b.marketingConsent===true,news=b.newsletterConsent===true;
  const result=await client.query(`INSERT INTO leads(email,name,phone,topic,source,medium,campaign,content,marketing_consent,newsletter_consent,consent_version,consent_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $9 OR $10 THEN now() ELSE NULL END)
  ON CONFLICT(email) DO UPDATE SET name=EXCLUDED.name,phone=COALESCE(NULLIF(EXCLUDED.phone,''),leads.phone),topic=EXCLUDED.topic,source=EXCLUDED.source,medium=EXCLUDED.medium,campaign=EXCLUDED.campaign,content=EXCLUDED.content,
  marketing_consent=leads.marketing_consent OR EXCLUDED.marketing_consent,newsletter_consent=leads.newsletter_consent OR EXCLUDED.newsletter_consent,updated_at=now() RETURNING id`,
  [email,name,String(b.phone||'').slice(0,40),topic,String(t.source||'direct').slice(0,200),String(t.medium||'').slice(0,80),String(t.campaign||'').slice(0,120),String(t.content||'').slice(0,120),yes,news,String(b.consentVersion||'').slice(0,40)]);
  id=result.rows[0].id;
  await client.query('INSERT INTO lead_events(lead_id,event_type,status,details) VALUES($1,$2,$3,$4)',[id,b.type,'received',JSON.stringify({topic})]);
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');return response(503,{ok:false,error:'Anfrage konnte nicht gespeichert werden'});}finally{client.release();}
 if(b.type==='pdf'){
  try{const pdf=pdfForTopic(topic);const messageId=await sendMail(email,name,topic,pdf);await pool.query('INSERT INTO lead_events(lead_id,event_type,status,details) VALUES($1,$2,$3,$4)',[id,'pdf_email','accepted',JSON.stringify({messageId,pdf:pdf.key})]);}
  catch(e){await pool.query('INSERT INTO lead_events(lead_id,event_type,status,details) VALUES($1,$2,$3,$4)',[id,'pdf_email','failed',JSON.stringify({reason:String(e.message).slice(0,100)})]);return response(503,{ok:false,error:'Anfrage gespeichert, das passende Dokument ist noch nicht zugeordnet oder der Versand derzeit nicht verfügbar. Bitte kontaktiere uns direkt.'});}
 }
 if (b.type === 'consultation' && process.env.AGENCY_NOTIFY_EMAIL) {
  const safe = (value) =>
    escapeHtml(value === undefined || value === null || value === ''
      ? 'Nicht angegeben'
      : String(value));

  const row = (label, value) => `
    <tr>
      <td style="padding:12px;border-bottom:1px solid #e2e8f0;color:#64748b;width:42%">
        ${label}
      </td>
      <td style="padding:12px;border-bottom:1px solid #e2e8f0;color:#0f172a;font-weight:600;overflow-wrap:anywhere">
        ${safe(value)}
      </td>
    </tr>`;

  const html = `
    <!DOCTYPE html>
    <html lang="de">
    <head><meta charset="UTF-8"></head>
    <body style="margin:0;padding:24px 12px;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
        <tr><td align="center">
          <table role="presentation" width="600" cellspacing="0" cellpadding="0"
            style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden">

            <tr><td style="background:#0b1928;padding:28px">
              <div style="color:#34d399;font-size:12px;font-weight:bold;letter-spacing:1px">
                GERMAN.FAIRSICHERT
              </div>
              <h1 style="color:#ffffff;font-size:25px;margin:15px 0 8px">
                Neue Beratungsanfrage
              </h1>
              <p style="color:#cbd5e1;font-size:14px;margin:0">
                Ein Interessent möchte seine Absicherung überprüfen lassen.
              </p>
            </td></tr>

            <tr><td style="padding:26px">
              <h2 style="font-size:17px;color:#0f172a">Kontaktdaten</h2>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0"
                style="font-size:14px;border-collapse:collapse">
                ${row('Name', name)}
                ${row('E-Mail', email)}
                ${row('Telefon', b.phone)}
                ${row('Versicherungsthema', topic)}
                ${row('Kontaktwunsch', b.preference)}
              </table>

              <h2 style="font-size:17px;color:#0f172a;margin-top:28px">
                Bestehende Versicherung
              </h2>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0"
                style="font-size:14px;border-collapse:collapse">
                ${row('Bestehender Vertrag', b.existingPolicy)}
                ${row('Aktueller Versicherer', b.insurer)}
                ${row('Beitrag in EUR', b.premium)}
                ${row('Zahlungsweise', b.premiumPeriod)}
              </table>

              <h2 style="font-size:17px;color:#0f172a;margin-top:28px">
                Persönliches Anliegen
              </h2>
              <div style="background:#f1f5f9;padding:18px;border-radius:9px;color:#334155;font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere">
                ${safe(b.message)}
              </div>

              <p style="font-size:12px;color:#64748b;margin-top:25px">
                Diese Anfrage wurde über German.Fairsichert übermittelt.
                Bitte ausschließlich im freigegebenen System bearbeiten.
              </p>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </body>
    </html>`;

  try {
    const notifyResponse = await fetch(
      'https://api.brevo.com/v3/smtp/email',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': process.env.BREVO_API_KEY
        },
        body: JSON.stringify({
          sender: {
            email: process.env.SENDER_EMAIL,
            name: 'German.Fairsichert'
          },
          to: [{ email: process.env.AGENCY_NOTIFY_EMAIL }],
          subject: 'German.Fairsichert | Neue Beratungsanfrage',
          htmlContent: html
        })
      }
    );

    if (!notifyResponse.ok) {
      console.error('Benachrichtigung fehlgeschlagen:', notifyResponse.status);
    }
  } catch (error) {
    console.error('Benachrichtigung fehlgeschlagen:', error.message);
  }
}
 return response(200,{ok:true,requestId:crypto.randomUUID(),message:b.type==='pdf'?'PDF-Versand vom Dienst angenommen':'Anfrage gespeichert'});
}
