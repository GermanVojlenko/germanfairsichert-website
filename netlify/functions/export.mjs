import pg from 'pg';
export default async function handler(req){
 const token=req.headers.get('authorization')||'';
 if(!process.env.EXPORT_TOKEN || token!==`Bearer ${process.env.EXPORT_TOKEN}`)return new Response('Unauthorized',{status:401});
 if(!process.env.DATABASE_URL)return new Response('Database unavailable',{status:503});
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:true},max:1});
 try{
  const {rows}=await pool.query(`SELECT l.id,l.created_at,l.name,l.email,l.phone,l.topic,l.source,l.medium,l.campaign,l.status,l.marketing_consent,l.newsletter_consent,(SELECT max(created_at) FROM lead_events e WHERE e.lead_id=l.id AND e.event_type='pdf_email' AND e.status='accepted') AS pdf_accepted_at FROM leads l ORDER BY l.created_at DESC LIMIT 20000`);
  const keys=['id','created_at','name','email','phone','topic','source','medium','campaign','status','marketing_consent','newsletter_consent','pdf_accepted_at'];
  const safe=v=>{let s=String(v??'');if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"'};
  const csv='\uFEFF'+keys.join(';')+'\r\n'+rows.map(r=>keys.map(k=>safe(r[k])).join(';')).join('\r\n');
  return new Response(csv,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="germanfairsichert-leads.csv"','Cache-Control':'no-store'}});
 }finally{await pool.end();}
}
