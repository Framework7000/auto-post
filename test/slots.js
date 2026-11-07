// Offline test of the daily-slot rule (slots_ in apps-script/Code.gs). Run: node test/slots.js
const fs=require('fs'); const src=fs.readFileSync(require('path').join(__dirname,'../apps-script/Code.gs'),'utf8');
function fmt(d,tz,f){ const o=new Intl.DateTimeFormat('en-CA',{timeZone:tz==='UTC'?'UTC':tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,timeZoneName:'longOffset'}).formatToParts(d); const g=t=>o.find(x=>x.type===t).value;
  if(f==='yyyy-MM-dd') return `${g('year')}-${g('month')}-${g('day')}`; if(f==='XXX'){ const z=g('timeZoneName').replace('GMT',''); return z||'+00:00'; } }
let NOW; const posts=[];
const ctx={Utilities:{formatDate:fmt},PropertiesService:{getScriptProperties:()=>({getProperty:k=>(k==='EDIT_PIN'||k==='META_PAGE_TOKEN')?'x':null})},
 UrlFetchApp:{fetch:(u,o)=>{posts.push(JSON.parse(o.payload));return{getResponseCode:()=>200}}},Logger:{log(){}},DriveApp:{},LockService:{},ContentService:{}};
const realNow=Date.now; Date.now=()=>NOW;
const f=new Function(...Object.keys(ctx),src+';return {slots_,dueMs_};')(...Object.values(ctx));
const setNow=t=>NOW=t;

 let fails=0; const ok=(c,m)=>{ if(!c) fails++; console.log((c?'ok   ':'FAIL ')+m); };
const d={cards:{a1:{s:'main'},a2:{s:'motiv'},a3:{s:'main',wide:true},b1:{s:'web'},b2:{s:'blog'},b3:{s:'web'},n1:{s:'main'},p1:{s:'main'},p2:{s:'web'}}};
const it=(k,date,time,o={})=>({id:'e-'+k,k,date,time,status:'scheduled',done:{},platforms:{ig:true,fb:true,yt:true},approved:true,auto:true,...o});
// now = Nov 7 2026 13:00 PT (21:00Z)
setNow(Date.parse('2026-11-07T21:00:00Z'));
let q={items:[it('a1','2026-11-20','10:00'),it('a2','2026-11-12','09:00'),it('a3','2026-11-09','12:00',{platforms:{yt:true}}),it('b1','2026-11-15','18:30'),it('b2','2026-11-08','18:30'),it('b3','2026-11-30','18:30'),
 it('n1','2026-11-07','10:00',{approved:false}),it('p1','2026-11-08','09:00',{status:'posted',done:{ig:'x'}}),it('p2','2026-11-07','18:30',{status:'partial',done:{ig:'x'}}), {id:'q-x',k:'a1',date:'2026-11-07',time:'09:00'}],log:[]};
const ap={a1:{st:'ok',at:'2026-11-07T10:00Z'},a2:{st:'ok',at:'2026-11-07T11:00Z'},a3:{st:'ok',at:'2026-11-07T09:00Z'},b1:{st:'ok',at:'2026-11-07T12:00Z'},b2:{st:'ok',at:'2026-11-07T08:00Z'},b3:{st:'ok',at:'2026-11-07T13:00Z'}};
f.slots_(q,d,ap); const g=k=>q.items.find(x=>x.k===k&&x.id==='e-'+k); const s=k=>g(k).date+' '+g(k).time;
console.log(['a1','a2','a3','b1','b2','b3','n1','p1','p2'].map(k=>k+'='+s(k)).join(' | '));
ok(s('a3')==='2026-11-09 09:00','a3 first approved A -> today 9:00 passed, Nov 8 taken by posted p1 -> Nov 9');
ok(s('a1')==='2026-11-10 09:00','a1 second A -> Nov 10'); ok(s('a2')==='2026-11-11 09:00','a2 third A -> Nov 11');
ok(s('b2')==='2026-11-08 18:30','b2 first B: today 18:30 taken by posted p2 -> Nov 8'); ok(s('b1')==='2026-11-09 18:30','b1'); ok(s('b3')==='2026-11-10 18:30','b3');
ok(s('n1')==='2026-11-08 10:00','not approved & time over -> tomorrow same time'); ok(s('p1')==='2026-11-08 09:00'&&s('p2')==='2026-11-07 18:30','posted untouched');
// max 2 per day for approved
const cnt={}; q.items.filter(x=>/^e-/.test(x.id)&&x.approved).forEach(x=>cnt[x.date]=(cnt[x.date]||0)+1); ok(Object.values(cnt).every(v=>v<=2),'max 2 per day '+JSON.stringify(cnt));
// idempotent: second run no posts
posts.length=0; f.slots_(q,d,ap); ok(posts.length===0,'second run changes nothing');
// at 09:02 on Nov 9: a3 own slot due -> must not move
setNow(Date.parse('2026-11-09T17:02:00Z')); posts.length=0; f.slots_(q,d,ap); ok(s('a3')==='2026-11-09 09:00','own slot being posted is kept');
// realistic: Nov 8/9 slots got posted
for (const k of ['p1','b2','a3','b1']) { const x=g(k); x.status='posted'; x.done={ig:'u'}; }
q.items.push(it('a4','2026-12-09','09:00')); d.cards.a4={s:'main'}; ap.a4={st:'ok',at:'2026-11-08T00:00Z'}; f.slots_(q,d,ap); ok(s('a4')==='2026-11-12 09:00','later approval -> next free A ('+s('a4')+')');
setNow(Date.parse('2026-11-10T16:00:00Z')); q.items.push(it('b4','2026-12-01','18:30')); d.cards.b4={s:'web'}; ap.b4={st:'ok',at:'2026-11-10T15:00Z'}; f.slots_(q,d,ap); ok(s('b4')==='2026-11-12 18:30','b4 '+s('b4')+' | '+['b1','b2','b3'].map(k=>k+' '+s(k)+' '+g(k).status).join(', '));
// youtube-only approved video (YouTube not connected): keeps its day and uses that day's A slot
q.items.push(it('y1','2026-11-10','07:00',{platforms:{ig:false,fb:false,yt:true}})); d.cards.y1={s:'main',wide:true}; ap.y1={st:'ok',at:'2026-11-01T00:00Z'}; f.slots_(q,d,ap); ok(s('y1')==='2026-11-10 07:00'&&s('a1')==='2026-11-11 09:00','yt-only keeps its day, A slot counted ('+s('y1')+', a1 '+s('a1')+')');
// not approved but time ahead today -> stays
q.items.push(it('n2','2026-11-10','18:30',{approved:false})); d.cards.n2={s:'web'}; f.slots_(q,d,ap); ok(s('n2')==='2026-11-10 18:30','unapproved before time stays');
// DST: Nov 1 2026 is DST end; check dueMs for Nov 7 9:00 PT = 17:00Z
ok(new Date(f.dueMs_({date:'2026-11-07',time:'09:00'})).toISOString()==='2026-11-07T17:00:00.000Z','PT time zone');

console.log(fails? fails+' FAILED':'ALL SLOT CHECKS PASSED'); process.exit(fails?1:0);
