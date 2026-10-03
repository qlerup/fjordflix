const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const {pathToFileURL} = require('node:url');
(async () => {
  const browser = await chromium.launch({headless:true});
  const page = await browser.newPage({viewport:{width:1920,height:1080}});
  // Simulate a 4K HEVC-capable Xbox; Chromium on this PC does not advertise HEVC.
  await page.addInitScript(() => {
    const canPlayType = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function(type) {
      return /hvc1|hev1/.test(type) ? 'probably' : canPlayType.call(this,type);
    };
  });
  const errors = [], requests = [], plays = [], loginURLs = [];
  page.on('pageerror', e=>errors.push(e.message));
  let authenticated = false, empty = false;
  const items = Array.from({length:25},(_,i)=>({id:String(i),title:i===0?'Nordlys — en aften ved fjorden':'Film '+(i+1),duration:3600,position: i===0?120:0,favorite:false,height:i===0?2160:1080,width:i===0?3840:1920,video:i===0?'hevc':'h264',audio:'aac',format:'mp4',pix_fmt:i===0?'yuv420p10le':'yuv420p',hdr:false,catalog:{overview:'En film fra dit eget bibliotek. Find dig til rette og nyd aftenen.'}}));
  const cors = {'access-control-allow-origin':'*','access-control-allow-headers':'authorization,content-type','access-control-allow-methods':'GET,POST,DELETE,OPTIONS'};
  await page.route(/^https?:\/\/tv-test\.example\//, async route => {
    const req=route.request(), url=new URL(req.url()), p=url.pathname; requests.push(p);
    const reply=(status,body)=>route.fulfill({status,headers:cors,contentType:'application/json',body:JSON.stringify(body)});
    if(req.method()==='OPTIONS') return reply(200,{});
    if(p==='/tv-api/login') { loginURLs.push(req.url()); authenticated=req.postDataJSON().password==='test-password'; return reply(authenticated?200:401,authenticated?{token:'t'.repeat(43)}:{detail:'Forkert brugernavn eller adgangskode.'}); }
    if(!authenticated || req.headers().authorization!=='Bearer '+'t'.repeat(43)) return reply(401,{detail:'Log ind igen.'});
    if(p==='/tv-api/state') return reply(200,{user:{name:'TV Tester'}});
    if(p==='/tv-api/info') return reply(200,{features:['xbox-hevc-fmp4']});
    if(p==='/tv-api/movies') return reply(200,empty?[]:items);
    if(p.endsWith('/poster')||p.endsWith('/backdrop')) return route.fulfill({status:200,headers:cors,contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="480" height="600"><rect width="480" height="600" fill="#193e4b"/><path d="M0 430L170 140 370 430 480 280V600H0Z" fill="#46776a"/><circle cx="370" cy="130" r="55" fill="#b9e589"/></svg>'});
    if(p.endsWith('/favorite')) { items[0].favorite=!items[0].favorite; return reply(200,{ok:true}); }
    if(p.endsWith('/plan')) { const data=req.postDataJSON(),q=data.quality; if(q==='1080') await new Promise(r=>setTimeout(r,180)); return reply(200,{mode:q==='1080'||q==='720'||!data.video_copy?'Transcoding':data.direct?'Direct Play':'Direct Stream',height:q==='1080'?1080:q==='720'?720:2160,reason:'Beregnet ud fra fil og TV.'}); }
    if(p.endsWith('/play')) { plays.push(req.postDataJSON()); return reply(200,{mode:plays.length===1?'Direct Play':'Direct Stream',session:plays.length===1?null:'test-stream',url:'https://tv-test.example/broken.mp4',offset:0,height:2160,media_ticket:'m'.repeat(43)}); }
    if(p==='/tv-api/logout') authenticated=false;
    return reply(200,{ok:true});
  });
  const visible=selector=>page.locator(selector).waitFor({state:'visible'});
  const out=path.resolve(__dirname,'../test-results');fs.mkdirSync(out,{recursive:true});
  try {
    await page.goto(pathToFileURL(path.resolve(__dirname,'../dist/app/index.html')).href);
    await visible('#login');
    assert.equal(await page.locator('#server-address').evaluate(el=>el.readOnly), true);
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(()=>document.activeElement.id), 'phone-login');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(()=>document.activeElement.id), 'server-address');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(()=>document.activeElement.id), 'username');
    assert.equal(await page.locator('#username').evaluate(el=>el.readOnly), true);
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#username').evaluate(el=>el.readOnly), false);
    // A system keyboard can temporarily take focus outside the page.
    await page.locator('#username').evaluate(el=>el.blur());
    assert.equal(await page.locator('#username').evaluate(el=>el.readOnly), false);
    await page.locator('#username').focus();
    await page.locator('#username').evaluate(el=>el.dispatchEvent(new KeyboardEvent('keydown',{keyCode:13,repeat:true,bubbles:true})));
    assert.equal(await page.locator('#username').evaluate(el=>el.readOnly), false);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#username').evaluate(el=>el.readOnly), true);
    assert.equal(loginURLs.length, 0);
    await page.click('#username');
    assert.equal(await page.locator('#username').evaluate(el=>el.readOnly), false);
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#username').evaluate(el=>el.readOnly), true);
    await page.screenshot({path:path.join(out,'01-login.png')});
    assert.equal(await page.isChecked('#login-https'),true);
    await page.click('#server-address');await page.fill('#server-address','tv-test.example');await page.click('#username');await page.fill('#username','TV Tester');await page.click('#password');await page.fill('#password','wrong');await page.click('#login-submit');
    await page.waitForFunction(()=>document.getElementById('message').textContent.includes('Forkert'));
    assert.equal(loginURLs[0],'https://tv-test.example/tv-api/login');
    await page.focus('#login-https');await page.keyboard.press('Enter');assert.equal(await page.isChecked('#login-https'),false);
    await page.click('#login-submit');await page.waitForFunction(()=>!document.getElementById('login-submit').disabled);
    assert.equal(loginURLs[1],'http://tv-test.example/tv-api/login');
    await page.focus('#login-https');await page.keyboard.press('Enter');assert.equal(await page.isChecked('#login-https'),true);
    await page.click('#password');await page.fill('#password','test-password');await page.click('#login-submit');
    await page.waitForFunction(()=>document.querySelectorAll('.card').length===20);
    assert.equal(await page.inputValue('#password'),'');
    await page.screenshot({path:path.join(out,'02-library.png')});
    await page.click('#next');assert.equal(await page.locator('.card').count(),5);
    await page.click('#previous');
    await page.click('#search');await page.fill('#search','Nordlys');assert.equal(await page.locator('.card').count(),1);
    await page.locator('.card').first().focus();await page.keyboard.press('Enter');await visible('#detail');
    await page.keyboard.press('ArrowRight');assert.equal(await page.evaluate(()=>document.activeElement.id),'restart');
    assert.equal(await page.locator('select').count(),0);
    assert.match(await page.locator('#quality-original').textContent(),/4K/);
    assert.equal(await page.locator('#quality-4k').isVisible(),true);
    await page.click('#quality-4k');
    assert.equal(await page.locator('#quality').inputValue(),'2160');
    await page.locator('#quality-original').focus();await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.getElementById('quality-plan').textContent.includes('Direct Play')&&document.getElementById('quality-plan').textContent.includes('2160p'));
    await page.keyboard.press('ArrowUp');assert.notEqual(await page.evaluate(()=>document.activeElement.id),'quality-original');
    await page.click('[data-quality="1080"]');await page.click('[data-quality="720"]');
    await page.waitForFunction(()=>document.getElementById('quality-plan').textContent.includes('720p'));
    await page.waitForTimeout(250);assert.match(await page.locator('#quality-plan').textContent(),/Transcoding.*720p/);
    await page.keyboard.press('Escape');await visible('#library');
    await page.locator('.card').first().click();await visible('#detail');
    await page.click('#quality-original');
    await page.waitForFunction(()=>document.getElementById('quality-plan').textContent.includes('Direct Play'));
    await page.click('#favorite');await page.waitForFunction(()=>document.getElementById('favorite').textContent.includes('✓'));
    await page.screenshot({path:path.join(out,'03-details.png')});
    await page.click('#play');await visible('#player');
    await page.waitForFunction(()=>document.getElementById('message').textContent.includes('native HLS')||document.getElementById('message').textContent.includes('Original video kunne ikke afspilles'),{},{timeout:10000});
    assert.equal(plays.length,2);assert.equal(plays[0].direct,true);assert.equal(plays[0].quality,'original');assert.equal(plays[1].direct,false);assert.equal(plays[1].quality,'original');
    assert.ok(plays.every(request=>request.video_copy===true&&request.client_profile==='xbox'),'Original retries preserve the source video and Xbox profile');
    assert.equal(plays[1].audio_copy,false,'remux retry converts audio while preserving video');
    await page.keyboard.press('Escape');await visible('#detail');await page.keyboard.press('Escape');await visible('#library');
    await page.keyboard.press('Escape');assert.equal(await page.inputValue('#search'),'');
    empty=true;await page.click('#refresh');await page.waitForFunction(()=>document.getElementById('count').textContent.includes('tomt'));
    await page.setViewportSize({width:1280,height:720});await page.screenshot({path:path.join(out,'04-empty-720p.png')});
    await page.click('#logout');await visible('#login');
    assert.equal(await page.inputValue('#server-address'),'tv-test.example');
    assert.equal(await page.isChecked('#login-https'),true);
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('fjordflix.connection')).token),'');
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'05-mobile-login.png')});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth > innerWidth),false);
    assert.deepEqual(errors,[]);
    console.log('Browser flow passed: login errors, bearer requests, paging, search, remote navigation, favorites, Original remux fallback preserving 4K video, back, empty state, logout, responsive layout.');
  } catch (e) { console.error({plays,errors,status:await page.locator('#play-status').textContent(),message:await page.locator('#message').textContent()});throw e; } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
