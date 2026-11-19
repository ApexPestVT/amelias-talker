// Tests for accounts.js against an in-memory database. Run:  npm install --no-save pg-mem && node test/accounts-unit.js
const assert=require('assert'); const { makeAccounts, cleanEmail } = require('../accounts.js');
(async()=>{
  let clock=Date.UTC(2026,10,19,15,0,0); const mails=[]; let mailFail=false;
  const A=makeAccounts({pool:(()=>{ const { newDb } = require('pg-mem'); const { Pool } = newDb().adapters.createPg(); return new Pool(); })(), mailOn:true, adminKey:'a-long-admin-key-123', now:()=>clock, sendMail:async(to,sub,text)=>{ if(mailFail) throw new Error('down'); mails.push({to,code:/\b(\d{6})\b/.exec(text)[1]}); }});
  assert.strictEqual(await A.init, true); let n=0; const ok=(c,m)=>{ n++; if(!c){ console.log('FAIL '+m); process.exitCode=1; } else console.log('pass '+m); };
  const R=(p,b,ip)=>A.route(p,'POST',b,ip||'1.1.1.1'); const bad=async(pr)=>{ try{ await pr; return null; }catch(e){ return e; } };
  ok(A.status().enabled===true,'status says enabled');
  ok(cleanEmail(' Dad@Example.COM ')==='dad@example.com' && cleanEmail('nope')==='' && cleanEmail('a@b')==='' && cleanEmail('a b@c.com')==='','email cleaning');
  ok((await bad(R('/api/acct/start',{email:'nope'}))).code===400,'bad email refused');
  await R('/api/acct/start',{email:'Dad@Example.com'}); ok(mails.length===1 && mails[0].to==='dad@example.com','code emailed');
  ok((await bad(R('/api/acct/start',{email:'dad@example.com'}))).code===429,'second code inside a minute refused');
  let e=await bad(R('/api/acct/verify',{email:'dad@example.com',code:'000000'})); ok(e && e.code===400 && /not right/.test(e.message),'wrong code refused');
  let v=await R('/api/acct/verify',{email:'dad@example.com',code:mails[0].code}); ok(v.token && v.children.length===0,'right code signs in');
  ok((await bad(R('/api/acct/verify',{email:'dad@example.com',code:mails[0].code}))).code===400,'a code works only once');
  const T=v.token;
  ok((await bad(R('/api/acct/child',{token:T,ageBand:'6to8',conditions:['genetic']}))).code===400,'child needs the consent tick');
  ok((await bad(R('/api/acct/child',{token:T,ageBand:'7',conditions:['genetic'],consent:true}))).code===400,'unknown age range refused');
  ok((await bad(R('/api/acct/child',{token:T,ageBand:'6to8',conditions:['made-up'],consent:true}))).code===400,'unknown condition refused');
  let c=await R('/api/acct/child',{token:T,ageBand:'6to8',conditions:['genetic','apraxia','x'],consent:true,label:' <b>Amelia</b> '}); ok(c.id && c.children[0].label==='bAmelia/b' && c.children[0].conditions.length===2,'child saved, label cleaned: '+c.children[0].label);
  let c2=await R('/api/acct/child',{token:T,ageBand:'3to5',conditions:['unsaid'],consent:true,label:'Sam'}); ok(c2.children.length===2,'second child');
  // devices: each keeps its own setup and photos; the child is still one child
  let d1=await R('/api/acct/device',{token:T,childId:c.id,name:'iPad',platform:'ipad'}); ok(d1.deviceId>0 && d1.children[0].devices.length===1,'first device added');
  let d2=await R('/api/acct/device',{token:T,childId:c.id,name:'Android <b>tablet',platform:'android'}); ok(d2.children[0].devices.length===2 && d2.children[0].devices[1].name==='Android btablet','second device added, name cleaned');
  ok((await bad(R('/api/acct/device',{token:T,childId:99999,name:'x'}))).code===404,'device for an unknown child refused');
  ok((await bad(R('/api/acct/save',{token:T,device:d1.deviceId,data:'x'}))).code===400,'save needs an object');
  const PIC='data:image/jpeg;base64,'+'A'.repeat(2000);
  let s=await R('/api/acct/save',{token:T,device:d1.deviceId,data:{settings:{stage:3},custom:[{id:'custom:1',label:'taco'}]},keys:['pic:mom','sceneimg:s1']}); ok(s.savedAt && Object.keys(s.have).length===0,'setup saved; server says it has no photos yet');
  await R('/api/acct/file',{token:T,device:d1.deviceId,key:'pic:mom',body:PIC}); await R('/api/acct/file',{token:T,device:d1.deviceId,key:'sceneimg:s1',body:PIC+'BBBB'});
  ok((await bad(R('/api/acct/file',{token:T,device:d1.deviceId,key:'../etc',body:PIC}))).code===400 && (await bad(R('/api/acct/file',{token:T,device:d1.deviceId,key:'pic:x',body:'<script>'}))).code===400,'odd photo names and non-pictures refused');
  ok((await bad(R('/api/acct/file',{token:T,device:d1.deviceId,key:'pic:big',body:'data:image/jpeg;base64,'+'A'.repeat(3200000)}))).code===413,'oversize photo refused');
  await R('/api/acct/save',{token:T,device:d2.deviceId,data:{settings:{stage:5},custom:[]},keys:[]});
  let l=await R('/api/acct/load',{token:T,device:d1.deviceId}); ok(l.data.settings.stage===3 && l.data.custom[0].label==='taco' && l.files.length===2,'first device loads back its own setup and 2 photos');
  let l2=await R('/api/acct/load',{token:T,device:d2.deviceId}); ok(l2.data.settings.stage===5 && l2.files.length===0,'second device has its own, different setup');
  ok((await R('/api/acct/file/get',{token:T,device:d1.deviceId,key:'pic:mom'})).body===PIC,'photo comes back unchanged');
  s=await R('/api/acct/save',{token:T,device:d1.deviceId,data:{settings:{stage:3}},keys:['pic:mom']}); ok(s.have['pic:mom']===PIC.length && !s.have['sceneimg:s1'],'a photo removed on the device is dropped on the server');
  ok((await R('/api/acct/me',{token:T})).children[0].devices[0].photos===1,'photo count shown per device');
  ok((await bad(R('/api/acct/save',{token:T,device:d1.deviceId,data:{big:'x'.repeat(500000)}}))).code===413,'oversize setup refused');
  await R('/api/acct/device/rename',{token:T,device:d1.deviceId,name:'Kitchen iPad'}); ok((await R('/api/acct/me',{token:T})).children[0].devices[0].name==='Kitchen iPad','device renamed');
  ok((await bad(R('/api/acct/me',{token:'x'.repeat(43)}))).code===401,'made-up token refused');
  // a second family cannot touch the first one's child, device or photos
  clock+=120e3; await R('/api/acct/start',{email:'other@example.com'}); let v2=await R('/api/acct/verify',{email:'other@example.com',code:mails[1].code});
  const X=v2.token, no=async(p,b)=>((await bad(R(p,Object.assign({token:X},b))))||{}).code===404;
  ok(await no('/api/acct/load',{device:d1.deviceId}) && await no('/api/acct/save',{device:d1.deviceId,data:{a:1}}) && await no('/api/acct/file',{device:d1.deviceId,key:'pic:mom',body:PIC}) && await no('/api/acct/file/get',{device:d1.deviceId,key:'pic:mom'}) && await no('/api/acct/device/rename',{device:d1.deviceId,name:'x'}) && await no('/api/acct/device/remove',{device:d1.deviceId}) && await no('/api/acct/device',{childId:c.id,name:'x'}) && await no('/api/acct/child/delete',{id:c.id}),'another family cannot read, write, rename, remove or attach to this child or its devices');
  // wrong tries lock the code
  clock+=120e3; await R('/api/acct/start',{email:'dad@example.com'}); for(let i=0;i<5;i++) await bad(R('/api/acct/verify',{email:'dad@example.com',code:'111111'}));
  e=await bad(R('/api/acct/verify',{email:'dad@example.com',code:mails[2].code})); ok(e && /Too many wrong/.test(e.message),'five wrong tries kills the code, even for the right one');
  // expiry
  clock+=120e3; await R('/api/acct/start',{email:'dad@example.com'}); clock+=16*60e3; e=await bad(R('/api/acct/verify',{email:'dad@example.com',code:mails[3].code})); ok(e && /run out/.test(e.message),'code runs out after 15 minutes');
  // hourly send limit (already 4 sends to dad in this hour window? window started at first send)
  let sent=0, lim=null; for(let i=0;i<8;i++){ clock+=60e3; const x=await bad(R('/api/acct/start',{email:'limit@example.com'})); if(x){ lim=x; break; } sent++; } ok(sent===5 && lim.code===429,'five codes an hour per address, then refused ('+sent+')');
  // mail failure leaves no code behind
  mailFail=true; clock+=3700e3; e=await bad(R('/api/acct/start',{email:'fail@example.com'})); ok(e.code===502,'mail failure reported'); mailFail=false;
  // stats
  ok((await bad(R('/api/admin/stats',{key:'wrong'}))).code===403,'stats: wrong key refused');
  let st=await R('/api/admin/stats',{key:'a-long-admin-key-123'}); ok(st.families===2 && st.children===2 && st.devices===2 && st.byPlatform.ipad===1 && st.byPlatform.android===1 && st.devicesActive30Days===2 && st.byAge['6to8']===1 && st.byAge['3to5']===1 && st.byCondition.genetic===1 && st.byCondition.apraxia===1 && st.byCondition.unsaid===1,'stats: 2 families, 2 children, 2 devices for one child counted once: '+JSON.stringify([st.families,st.children,st.devices,st.byPlatform]));
  ok(!/example\.com|Amelia|taco|Kitchen|AAAA/.test(JSON.stringify(st)),'stats carry no email, name, device name, saved words or photos');
  // edit, delete child, sign out, erase
  let ed=await R('/api/acct/child',{token:T,id:c.id,ageBand:'9to12',conditions:['genetic'],label:'Amelia'}); ok(ed.children[0].ageBand==='9to12','child details edited without a new consent');
  let dc=await R('/api/acct/child/delete',{token:T,id:c2.id}); ok(dc.children.length===1,'one child removed');
  let dr=await R('/api/acct/device/remove',{token:T,device:d2.deviceId}); ok(dr.children[0].devices.length===1,'one device removed');
  await R('/api/acct/signout',{token:v2.token}); ok((await bad(R('/api/acct/me',{token:v2.token}))).code===401,'signed-out token is dead');
  await R('/api/acct/erase',{token:T}); ok((await bad(R('/api/acct/me',{token:T}))).code===401,'erased account: token dead');
  st=await R('/api/admin/stats',{key:'a-long-admin-key-123'}); ok(st.families===1 && st.children===0 && st.devices===0,'erased account, its devices and photos gone from the totals');
  ok((await bad(A.route('/api/acct/me','GET',null,'1'))).code===405 && A.route('/api/other','GET')===null,'routing: GET refused, other paths passed on');
  const off=makeAccounts({pool:null,mailOn:true}); await off.init; ok(off.status().enabled===false && (await bad(off.route('/api/acct/start','POST',{email:'a@b.co'}))).code===503,'no database: accounts off, clear answer');
  console.log(process.exitCode?'FAILED':'ALL '+n+' PASS');
})().catch(e=>{ console.error('CRASH',e); process.exit(1); });
