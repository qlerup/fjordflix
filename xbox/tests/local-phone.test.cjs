const test=require('node:test');
const assert=require('node:assert/strict');
const local=require('../tv/local-phone-server.js');
const origin='http://192.168.1.20:43000',secret='x'.repeat(43);
const req=(changes={})=>({method:'POST',path:`/${secret}/login`,headers:{host:'192.168.1.20:43000',origin,'content-type':'application/json'},body:JSON.stringify({server:'film.example',name:'Søren',password:'test-only'}),...changes});
test('local HTTP framing handles partial UTF8 bodies and rejects ambiguous lengths',()=>{
  const body=req().body,raw=local.bytes(`POST /${secret}/login HTTP/1.1\r\nHost: 192.168.1.20:43000\r\nContent-Length: ${local.bytes(body).length}\r\n\r\n${body}`);
  assert.equal(local.parse(raw.slice(0,-1)),null);
  assert.equal(JSON.parse(local.parse(raw).body).name,'Søren');
  for(const headers of ['Content-Length: 9000','Content-Length: 1\r\nContent-Length: 2','Transfer-Encoding: chunked'])
    assert.throws(()=>local.parse(local.bytes(`POST / HTTP/1.1\r\n${headers}\r\n\r\n`)));
});
test('setup requires the QR secret, exact Host/Origin and JSON before contacting a server',async()=>{
  let logins=0;
  const session=local.session({secret,origin,page:'test',login:()=>{logins++;},accept:()=>{}});
  for(const request of [req({path:'/'}),req({headers:{host:'evil.example'}}),req({headers:{...req().headers,origin:'http://evil.example'}}),req({headers:{...req().headers,'content-type':'text/plain'}})])
    assert.ok((await session.handle(request)).status>=400);
  assert.equal(logins,0);
  const html=await session.handle(req({method:'GET',path:`/${secret}/`}));
  assert.equal(html.status,200);assert.match(Buffer.from(local.wire(html)).toString(),/Cache-Control: no-store/);
});
test('only one login can run, cancellation revokes late success and tokens never go to the phone',async()=>{
  let resolve,accepted=0,revoked=0;
  const session=local.session({secret,origin,page:'test',login:()=>new Promise(r=>resolve=r),accept:()=>accepted++,revoke:()=>revoked++});
  const pending=session.handle(req());await Promise.resolve();
  assert.equal((await session.handle(req())).status,409);
  session.close();resolve({token:'sensitive',server:'https://film.example'});
  assert.equal((await pending).status,410);assert.equal(revoked,1);assert.equal(accepted,0);
  const second=local.session({secret,origin,login:()=>({token:'sensitive'}),accept:()=>accepted++,revoke:()=>revoked++});
  const response=await second.handle(req());assert.equal(response.body,'{"ok":true}');
  second.close();response.complete();assert.equal(accepted,0);assert.equal(revoked,2);
});
test('failed logins can retry and a successful session is single use',async()=>{
  let attempts=0,accepted=0;
  const session=local.session({secret,origin,login:()=>{if(++attempts===1) throw Error('Forkert login.');return {token:'secret'};},accept:()=>accepted++});
  assert.equal((await session.handle(req())).status,400);
  const response=await session.handle(req());assert.equal(response.status,200);response.complete();
  assert.equal(accepted,1);assert.equal((await session.handle(req())).status,410);
});
test('expired sessions cannot serve the form or submit credentials',async()=>{
  const now=Date.now(),original=Date.now;
  const session=local.session({secret,origin,page:'test',login:()=>assert.fail('expired login'),accept:()=>{}});
  try{Date.now=()=>now+300001;assert.equal((await session.handle(req())).status,410);}
  finally{Date.now=original;}
});
