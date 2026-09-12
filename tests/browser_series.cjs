// Disposable local UI harness. No user database, network services or credentials.
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '../app');
const ep = (id,s,e) => ({id:id.repeat(32),title:`The Show · S${s}E${e}`,series_key:'tmdb:42',
  width:1920,height:1080,video:'h264',audio:'aac',duration:120,position:0,size:102400,bitrate:1000000,pix_fmt:'yuv420p',format:'mp4',
  catalog:{media_type:'tv',status:'matched',series_title:'The Show',series_year:'2020',series_overview:'En serie om mennesker og deres hverdag.',
    season:s,episode:e,episode_title:`Afsnit ${e}`,overview:'Beskrivelse af dette afsnit.',genres:['Drama'],rating:8,votes:100}});
let items=[ep('a',2,10),ep('b',1,1),ep('c',1,2)];
items.push({...ep('d',1,1),series_key:null,title:'A standalone movie',catalog:{media_type:'movie'}});
let admin=true;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/')){
    let data={};
    if(url.pathname==='/api/state') data={user:{id:'owner',name:'Tester',admin},managed:false};
    else if(url.pathname==='/api/movies') data=items;
    else if(url.pathname.endsWith('/plan')) data={mode:'Direct Play',height:1080,mbps:1,reason:'Local test'};
    else if(url.pathname.endsWith('/metadata') && req.method==='PUT'){
      let raw='';for await(const chunk of req)raw+=chunk;
      const edit=JSON.parse(raw),item=items.find(m=>m.id===url.pathname.split('/')[3]);
      item.title=edit.title;item.catalog={...item.catalog,...edit,manual:true};data={ok:true};
    } else if(url.pathname.endsWith('/poster') || url.pathname.endsWith('/backdrop') || url.pathname.endsWith('/episode-still')) {
      res.writeHead(200,{'Content-Type':'image/svg+xml'});
      return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600" fill="#45334f"/><circle cx="200" cy="240" r="90" fill="#94687f"/></svg>');
    }
    res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(data));
  }
  const file=url.pathname==='/'?path.join(root,'static/index.html'):path.join(root,url.pathname);
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
  const types={'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'};
  res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream'});fs.createReadStream(file).pipe(res);
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}}), errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('#movie-grid .movie-card').first().waitFor();
    assert.equal(await page.locator('#movie-grid .movie-card').count(),2);
    await page.getByRole('button',{name:'Serier',exact:true}).click();
    assert.equal(await page.locator('#movie-grid .movie-card').count(),1);
    await page.locator('#movie-grid .movie-card').click();
    assert.equal(await page.locator('#series-season').inputValue(),'1');
    assert.equal(await page.locator('#series-episodes .episode-card').count(),2);
    await page.locator('#series-episodes .episode-card').nth(1).click();
    assert.equal(await page.locator('#series-episodes [aria-pressed="true"]').getAttribute('data-episode-id'),'c'.repeat(32));
    await page.locator('#series-season').selectOption('2');
    assert.equal(await page.locator('#series-episodes .episode-card').count(),1);
    assert.equal(await page.locator('#series-episodes [aria-pressed="true"]').getAttribute('data-episode-id'),'a'.repeat(32));
    await page.waitForFunction(()=>document.querySelector('#play-button').textContent==='▶ Afspil afsnit');
    await page.getByRole('button',{name:'Rediger oplysninger',exact:true}).click();
    await page.locator('#edit-title').fill('My corrected episode');
    await page.locator('#edit-overview').fill('<img src=x onerror=alert(1)> Manual text');
    await page.locator('#library-edit-save').click();
    await page.waitForFunction(()=>document.querySelector('#detail-title').textContent==='My corrected episode');
    assert.equal(await page.locator('#detail-description img').count(),0);
    for(const width of [390,768,1440]){
      await page.setViewportSize({width,height:900});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Page overflow');
      assert(await page.locator('#detail').evaluate(e=>e.scrollWidth<=e.clientWidth),'Dialog overflow');
    }
    await page.screenshot({path:path.join(require('node:os').tmpdir(),'fjordflix-series-detail-qa.png'),fullPage:true});
    await page.locator('[data-close="detail"]').click();
    await page.getByRole('button',{name:'Film',exact:true}).click();
    assert.equal(await page.locator('#movie-grid .movie-card').count(),1);
    admin=false;await page.reload();
    await page.locator('#movie-grid .movie-card').first().click();
    assert.equal(await page.locator('#library-edit').isVisible(),false);
    assert.deepEqual(errors,[]);
    console.log('Series browser QA passed: grouped cards, seasons, episode selection, manual edits, XSS escaping, viewer restrictions and mobile widths.');
  } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
