import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
// Optional browser regression: requires Playwright, or POCKET_PLAYWRIGHT_MODULE pointing to its module.
const {chromium} = await import(process.env.POCKET_PLAYWRIGHT_MODULE || 'playwright');
import {fileURLToPath} from 'node:url';
import {MachineRuntime} from '../gateway.ts';
const root=fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const conflict='This task is open in another Codex runtime. Close it there, then retry.';
const runtime=new MachineRuntime({}, {id:'local',name:'Mac mini',ssh:null},()=>{});
const task={id:'current',name:'Current task',cwd:'/project',status:'idle',project:'project'};
const owned={...task,id:'owned',name:'Owned task'};
let active=[task,owned], archived=[{...task,id:'old',name:'Old task',archived:true}], fail=true, machineError=conflict;
Object.assign(runtime.state,{connected:true,thread:task,threadStatus:'idle'});
const snapshot=()=>({...runtime.snapshot(),submissionEpoch:"test",message:{allowed:true,reason:"",canSteer:true}});
const calls=[];let gate=null, release, mode='success', failAction=false;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAIAAAAC64paAAAAGklEQVR4nGMwnplGNmIY1TyqeVTzqOaB1QwAQBHeMIlPtLYAAAAASUVORK5CYII=','base64');
const server=createServer(async(req,res)=>{
 const u=new URL(req.url,'http://localhost');calls.push(u.pathname);
 const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
 try{
 if(u.pathname==='/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);runtime.addSubscriber(res,false);req.on('close',()=>runtime.removeSubscriber(res));return;}
 if(u.pathname==='/api/auth')return json({required:false,authenticated:true});
 if(u.pathname==='/api/state')return json(snapshot());
 if(u.pathname==='/api/settings')return json({settings:{machines:[{name:'MacBook Air',ssh:'macbook-air'},{name:'PC 1',ssh:'main-pc'}],phoneUrls:[]}});
 if(u.pathname==='/api/machines')return json({machines:[runtime.machineSummary()]});
 if(u.pathname==='/api/threads')return json({threads:active});
 if(u.pathname==='/api/activity/detail')return json({machineId:'local',threadId:runtime.state.thread.id,itemId:u.searchParams.get('itemId'),detail:{type:u.searchParams.get('itemId'),imageAvailable:true,name:'Activity image'}});
 if(u.pathname==='/api/activity/image'){res.writeHead(200,{'Content-Type':'image/png'});res.end(png);return;}
 if(u.pathname==='/api/history')return json({turns:[],nextCursor:null});
 if(u.pathname==='/api/navigation'){calls.push(u.search);return json({machines:[{id:'local',name:'Mac mini',local:true,connected:true,connectionError:machineError,tasks:u.searchParams.get('archived')==='true'?archived:active},{id:'ssh:test',name:'Second machine',connected:true,tasks:[{...owned,id:'remote-owned',name:'Remote owned task'}]}]});}
 if(u.pathname==='/api/navigation/select'){
 let text='';for await(const c of req)text+=c;const body=JSON.parse(text);
 if(gate)await gate;
 if(mode==='reject'){
 runtime.rpc={request:async(method)=>{if(method==='thread/list')return {data:[...active,{...owned,id:'remote-owned'}]};if(method==='thread/resume')throw new Error('already has an active writer');return {data:[]};}};
 try{await runtime.selectThread(body.threadId);}catch(error){return json({error:error.message},409);}
 throw new Error('Expected rejection');
 }

 runtime.state.thread=active.find(t=>t.id===body.threadId)||{...owned,id:body.threadId};runtime.state.machineId=body.machineId;
 if(mode==='lost'){req.socket.destroy();return;}
 return json(snapshot());
 }
 if(u.pathname==='/api/message'){for await(const c of req){};return json({accepted:true},202);}
 if(u.pathname==='/api/tasks'){
 let text='';for await(const c of req)text+=c;const b=JSON.parse(text);calls.push(b.action);if(gate)await gate;if(failAction)return json({error:'Fixture action failed'},409);
 if(b.action==='rename'){const t=[...active,...archived].find(t=>t.id===b.threadId);t.name=b.name;}
 if(b.action==='archive'){archived.push({...active.find(t=>t.id===b.threadId),archived:true});active=active.filter(t=>t.id!==b.threadId);}
 if(b.action==='unarchive'){active.push({...archived.find(t=>t.id===b.threadId),archived:false});archived=archived.filter(t=>t.id!==b.threadId);}
 if(b.action==='delete'){active=active.filter(t=>t.id!==b.threadId);archived=archived.filter(t=>t.id!==b.threadId);}
 if(b.action==='create'){const t={id:'new',name:b.name,cwd:b.cwd,status:'idle'};active.push(t);runtime.state.thread=t;}
 return json(snapshot());
 }
 const path=u.pathname==='/'?'/index.html':u.pathname;
 const file=path==='/vendor/markdown-it.min.js'?root+'/node_modules/markdown-it/dist/markdown-it.min.js':root+'/public'+path;
 res.writeHead(200,{'Content-Type':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html'});res.end(await readFile(file));
 }catch(e){json({error:e.message},500);}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true});
const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
const open=async()=>{if(await page.locator('#destination-button').getAttribute('aria-expanded')!=='true')await page.locator('#destination-button').click();await page.waitForTimeout(210);};
const closed=()=>page.waitForFunction(()=>document.querySelector('#destination-switcher').hidden);
try {
 const defaultDialog=d=>d.accept(d.type()==='prompt'?(d.message().includes('task name')?'New test task':'/project'):undefined);
 page.on('dialog',defaultDialog);
 const input=page.locator('#message-text');
 const row=name=>page.locator('.destination-entry').filter({has:page.getByText(name,{exact:true})});
 const select=async name=>{await open();await row(name).locator('.destination-task').click();
 await page.waitForFunction(name=>document.querySelector('#destination-label').textContent.includes(name),name);
 if(page.viewportSize().width>=1100){await page.waitForTimeout(210);assert.equal(await page.locator('#destination-switcher').evaluate(e=>e.hidden),false);await page.locator('#destination-close').click();}
 await closed();};

 for(const width of [1280,390]){
 runtime.state.models=[{model:'test',displayName:'Test',supportedReasoningEfforts:['low','medium','high','xhigh','max','ultra'].map(reasoningEffort=>({reasoningEffort})),defaultReasoningEffort:'low'}];runtime.state.model='test';runtime.state.reasoningEffort='low';
 runtime.state.activities=[];runtime.state.liveMessages=[];runtime.state.thread=task;runtime.state.machineId='local';mode='success';active=[task,owned,...Array.from({length:9},(_,i)=>({...task,id:`draft-${i}`,name:`Draft task ${i}`}))];
 await page.setViewportSize({width,height:844});await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.waitForFunction(()=>document.querySelector('#destination-label').textContent.includes('Current task'));
 await page.evaluate(()=>localStorage.setItem('codex-pocket-info-display',JSON.stringify({commands:false})));
 await page.reload();await page.waitForFunction(()=>document.querySelector('#destination-label').textContent.includes('Current task'));
 for(const key of ['command','tool','search','review'])assert.equal(await page.locator(`#display-${key}`).isChecked(),false);
 assert.equal(await page.locator('#display-files').isChecked(),true);
 await page.evaluate(()=>localStorage.removeItem('codex-pocket-info-display'));await page.reload();await page.waitForFunction(()=>document.querySelector('#destination-label').textContent.includes('Current task'));
 await page.locator('#settings-button').click();
 await page.locator('.machine-settings-row').first().waitFor();
 for(const name of ['Display Name','SSH Alias'])assert.equal(await page.locator('.machine-settings-row').first().getByText(name,{exact:true}).isVisible(),width<600);
 assert.equal(await page.locator('.machine-settings-header').isVisible(),width>=600);
 if(width>=600){assert((await page.locator('.machine-settings-row').first().boundingBox()).height<65);assert.deepEqual(await page.locator('.machine-settings-header span').allTextContents(),['Display Name','SSH Alias','Actions']);}
 assert.equal(await page.getByRole('button',{name:'Move MacBook Air up',exact:true}).isDisabled(),true);
 assert.equal(await page.getByRole('button',{name:'Move PC 1 down',exact:true}).isDisabled(),true);
 assert.deepEqual(await page.locator('.machine-settings-row').first().locator('button').allTextContents(),['↑','↓','×']);
 await page.locator('.machine-settings-row').first().scrollIntoViewIfNeeded();
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/settings-${width}.png`});
 await page.locator('#settings-close').click();
 if(await page.locator('#inspector-button').getAttribute('aria-expanded')!=='true')await page.locator('#inspector-button').click();
 await page.waitForTimeout(200);await page.locator('#display-files').waitFor();
 assert.deepEqual(await page.locator('#effort-select option').allTextContents(),['Light','Medium','High','Extra High','Max','Ultra']);
 assert.equal(await page.locator('#effort-select').inputValue(),'low');
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/display-${width}.png`});
 const categories=[['reasoning','reasoning','Reasoning'],['command','command','Command'],['tool','tool','Tool'],['search','search','Search'],['files','files','File Changes'],['collaboration','collaboration','Subagents'],['image','images','Image'],['review','review','Review'],['compaction','compaction','Context Compaction']];
 assert.deepEqual(await page.locator('.display-panel .display-option span').allTextContents(),categories.map(c=>c[2]).concat(['Expand Commands by Default','Expand File Changes by Default']));
 runtime.state.activities=categories.map(([kind])=>({id:`filter-${kind}`,kind,label:`Test ${kind}`,status:'completed'}));runtime.broadcast('snapshot',snapshot());
 await page.locator('.timeline-activity').nth(8).waitFor();
 for(const [kind,key,label] of categories){
 assert.equal(await page.locator(`[data-activity-id="filter-${kind}"] .activity-kind`).textContent(),label);
 await page.locator(`#display-${key}`).uncheck();assert.equal(await page.locator(`.timeline-activity.${kind}`).count(),0);assert.equal(await page.locator('.timeline-activity').count(),8);
 await page.locator(`#display-${key}`).check();assert.equal(await page.locator('.timeline-activity').count(),9);
 }
 if(width<860)await page.locator('#inspector-close').click();else await page.locator('#inspector-button').click();
 await page.waitForTimeout(200);
 for(const type of ['imageView','imageGeneration']){
 runtime.state.activities=[{id:type,kind:'image',label:'Image test',status:'completed',expandable:true}];runtime.broadcast('snapshot',snapshot());
 const card=page.locator(`[data-activity-id="${type}"]`);await card.locator('.activity-summary').click();
 await page.locator('.detail-image').scrollIntoViewIfNeeded();
 await page.waitForFunction(()=>document.querySelector('.detail-image')?.naturalWidth>0);
 const img=page.locator('.detail-image');await img.focus();await img.press('Enter');await page.locator('#image-viewer').waitFor();
 await page.locator('#close-image').click();await img.click();await page.locator('#image-viewer').waitFor();await page.locator('#close-image').click();await card.locator('.activity-summary').click();
 }
 if(width>=1100){
 const before=await page.locator('.chat-panel').boundingBox();await open();const left=await page.locator('#destination-switcher').boundingBox();
 assert(Math.abs(left.width-310)<2);assert.equal(await page.locator('#destination-backdrop').isVisible(),false);
 assert((await page.locator('.chat-panel').boundingBox()).x>=left.x+left.width-1);
 await page.locator('#inspector-button').click();await page.waitForTimeout(210);assert.equal(await page.locator('#destination-button').getAttribute('aria-expanded'),'true');
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/rails-${width}.png`});
 await page.locator('#destination-close').click();await closed();assert.equal(await page.locator('#inspector-button').getAttribute('aria-expanded'),'true');
 await page.locator('#inspector-button').click();await page.waitForTimeout(210);assert.equal((await page.locator('.chat-panel').boundingBox()).x,before.x);
 }
 runtime.handleNotification({method:'thread/tokenUsage/updated',params:{threadId:'current',tokenUsage:{last:{totalTokens:41000},modelContextWindow:100000}}});
 await page.waitForFunction(()=>document.querySelector('#context-percent').textContent==='41%');
 runtime.rpc={request:async(method,params)=>method==='thread/resume'?{thread:{id:params.threadId,status:'idle'}}:{data:[]}};
 runtime.loadedThreads=[{...task,status:'idle'}];await runtime.releaseTask();await runtime.attachLoadedThread('current',false);runtime.broadcast('snapshot',snapshot());
 await page.waitForFunction(()=>document.querySelector('#context-percent').textContent==='~41%');assert.match(await page.locator('#context-chip').getAttribute('title'),/last known/i);
 runtime.handleNotification({method:'thread/tokenUsage/updated',params:{threadId:'current',tokenUsage:{last:{totalTokens:42000},modelContextWindow:100000}}});await page.waitForFunction(()=>document.querySelector('#context-percent').textContent==='42%');
 runtime.state.activities=[];
 runtime.state.liveMessages=[{id:'markdown-check',role:'assistant',text:'![Remote image](https://example.com/remote.png) ![HTTP image](http://example.com/remote.png) [Web link](https://example.com/)'}];
 runtime.broadcast('snapshot',snapshot());
 await page.getByRole('link',{name:'Web link',exact:true}).waitFor();
 assert.equal(await page.locator('img[src^="https://"], img[src^="http://"]').count(),0);
 assert((await page.locator('body').innerText()).includes('Remote image'));
 runtime.state.liveMessages=[];
 await input.fill('Draft A');await page.locator('#image-picker').setInputFiles({name:'a.png',mimeType:'image/png',buffer:png});await page.locator('#composer-images img').waitFor();
 await select('Owned task');assert.equal(await input.inputValue(),'');assert.equal(await page.locator('#composer-images img').count(),0);
 await input.fill('Draft B');await select('Current task');assert.equal(await input.inputValue(),'Draft A');assert.equal(await page.locator('#composer-images img').count(),1);
 mode='reject';await open();await row('Owned task').locator('.destination-task').click();await row('Owned task').locator('.task-selection-error').waitFor();const attempts=calls.filter(c=>c==='/api/navigation/select').length;await row('Owned task').getByRole('button',{name:'Retry',exact:true}).click();await row('Owned task').getByRole('button',{name:'Retry',exact:true}).waitFor();assert.equal(calls.filter(c=>c==='/api/navigation/select').length,attempts+1);await page.locator('#destination-close').click();await closed();assert.equal(await input.inputValue(),'Draft A');assert.equal(await page.locator('#composer-images img').count(),1);
 mode='success';await page.locator('#send-message').click();await page.waitForFunction(()=>document.querySelector('#message-text').value==='');
 await select('Owned task');assert.equal(await input.inputValue(),'Draft B');await select('Current task');assert.equal(await input.inputValue(),'');assert.equal(await page.locator('#composer-images img').count(),0);
 await input.fill('Stable action draft');await open();
 for(const action of ['Rename','Archive','Delete']){
 failAction=true;gate=new Promise(r=>release=r);
 const before=await input.boundingBox();const signature=await page.locator('#model-select').evaluate(e=>e.outerHTML);
 await row('Owned task').locator('summary').click();await row('Owned task').getByRole('button',{name:action,exact:true}).click();
 await page.getByText(action==='Rename'?'Renaming…':action==='Archive'?'Archiving…':'Deleting…',{exact:true}).waitFor();
 assert.deepEqual(await input.boundingBox(),before);assert.equal(await page.locator('#model-select').evaluate(e=>e.outerHTML),signature);
 assert(!(await page.locator('#composer').innerText()).includes('Switching'));
 release();gate=null;await row('Owned task').locator('.task-selection-error').waitFor();
 assert.equal(await page.locator('.destination-error').count(),0);assert.equal(await input.inputValue(),'Stable action draft');
 }
 page.off('dialog',defaultDialog);
 for(const answer of [null,'   ','Current task']){
 const before=calls.filter(c=>c==='/api/tasks').length;
 page.once('dialog',async d=>{assert.equal(d.defaultValue(),'Current task');if(answer===null)await d.dismiss();else await d.accept(answer);});
 await row('Current task').locator('summary').click();await row('Current task').getByRole('button',{name:'Rename',exact:true}).click();
 await page.waitForTimeout(50);assert.equal(calls.filter(c=>c==='/api/tasks').length,before);
 await row('Current task').locator('summary').click();
 }
 page.on('dialog',defaultDialog);
 failAction=false;gate=new Promise(r=>release=r);
 await row('Current task').locator('summary').click();await row('Current task').getByRole('button',{name:'Rename',exact:true}).click();
 await row('Current task').getByText('Renaming…',{exact:true}).waitFor();assert.equal(await page.getByText('Renaming…',{exact:true}).count(),1);
 release();gate=null;await page.waitForFunction(()=>document.querySelector('#destination-label').textContent.includes('New test task'));
 assert.equal(await page.locator('#destination-switcher').evaluate(e=>e.hidden),false);assert.equal(await input.inputValue(),'Stable action draft');
 task.name='Current task';await page.locator('#destination-close').click();await closed();await open();
 failAction=true;
 gate=new Promise(r=>release=r);await page.getByRole('button',{name:'New Task',exact:true}).first().click();await page.getByRole('button',{name:'Creating…',exact:true}).waitFor();assert(!(await page.locator('#composer').innerText()).includes('Switching'));release();gate=null;
 await page.locator('.destination-group').first().getByText('Fixture action failed',{exact:true}).waitFor();assert.equal(await page.locator('.destination-error').count(),0);
 failAction=false;await page.getByRole('button',{name:'New Task',exact:true}).first().click();await page.waitForFunction(()=>document.querySelector('#destination-label').textContent.includes('New test task'));if(width>=1100){assert.equal(await page.locator('#destination-switcher').evaluate(e=>e.hidden),false);await page.locator('#destination-close').click();}await closed();assert.equal(await input.inputValue(),'');
 await select('Current task');assert.equal(await input.inputValue(),'Stable action draft');
 for(let i=0;i<9;i++){await select(`Draft task ${i}`);await input.fill(`Draft ${i}`);}
 await select('Current task');assert.equal(await input.inputValue(),'');assert.equal(await page.locator('#composer-images img').count(),0);
 if(width===390){
 runtime.state.liveMessages=Array.from({length:50},(_,i)=>({id:`viewport-${i}`,role:'assistant',text:`Message ${i}\n\nEnough content to scroll the document.`}));runtime.broadcast('snapshot',snapshot());
 await page.getByText('Message 49',{exact:false}).waitFor();
 await page.evaluate(()=>window.scrollTo(0,document.scrollingElement.scrollHeight));await page.waitForTimeout(150);
 await page.evaluate(()=>{document.activeElement?.blur();const d=document.scrollingElement;window.scrollTo(0,d.scrollHeight-d.clientHeight-120);});await page.waitForTimeout(150);
 await page.evaluate(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,value:visualViewport.height-200});visualViewport.dispatchEvent(new Event('resize'));});await page.waitForTimeout(300);
 assert((await page.evaluate(()=>{const d=document.scrollingElement;return d.scrollHeight-d.scrollTop-d.clientHeight;}))<2);
 await page.evaluate(()=>window.scrollTo(0,document.scrollingElement.scrollHeight/2));await page.waitForTimeout(150);
 const readingTop=await page.evaluate(()=>document.scrollingElement.scrollTop);
 await page.evaluate(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,value:visualViewport.height-100});visualViewport.dispatchEvent(new Event('resize'));});await page.waitForTimeout(300);
 assert(Math.abs(await page.evaluate(()=>document.scrollingElement.scrollTop)-readingTop)<2);
 // A plausible keyboard resize must leave an editing user's position alone.
 await input.focus();await page.evaluate(()=>{const d=document.scrollingElement;window.scrollTo(0,d.scrollHeight-d.clientHeight-120);});await page.waitForTimeout(150);
 const editingTop=await page.evaluate(()=>document.scrollingElement.scrollTop);
 await page.evaluate(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,value:visualViewport.height-100});visualViewport.dispatchEvent(new Event('resize'));});await page.waitForTimeout(300);
 assert.equal(await page.evaluate(()=>document.scrollingElement.scrollTop),editingTop);
 await page.evaluate(()=>delete visualViewport.height);

 }
 }
 assert.deepEqual(errors,[]);console.log('PASS: desktop/mobile task-keyed text/images, failed selection preserves drafts, send clears drafts, localized Rename/Archive/Delete/Create busy and failures, new task empty, draft eviction returns empty, remote Markdown images unavailable, settings labels and filters, image-card viewer, ownership Retry, mobile viewport follow and reading position');
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
