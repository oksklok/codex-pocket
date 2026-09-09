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
const server=createServer(async(req,res)=>{
 const u=new URL(req.url,'http://localhost');calls.push(u.pathname);
 const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
 try{
 if(u.pathname==='/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);runtime.addSubscriber(res,false);req.on('close',()=>runtime.removeSubscriber(res));return;}
 if(u.pathname==='/api/auth')return json({required:false,authenticated:true});
 if(u.pathname==='/api/state')return json(snapshot());
 if(u.pathname==='/api/settings')return json({settings:{machines:[],phoneUrls:[]}});
 if(u.pathname==='/api/machines')return json({machines:[runtime.machineSummary()]});
 if(u.pathname==='/api/threads')return json({threads:active});
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
const open=async()=>{await page.locator('#destination-button').click();await page.waitForTimeout(210);};
const closed=()=>page.waitForFunction(()=>document.querySelector('#destination-switcher').hidden);
try {
 const defaultDialog=d=>d.accept(d.type()==='prompt'?(d.message().includes('task name')?'New test task':'/project'):undefined);
 page.on('dialog',defaultDialog);
 const input=page.locator('#message-text');
 const row=name=>page.locator('.destination-entry').filter({has:page.getByText(name,{exact:true})});
 const select=async name=>{await open();await row(name).locator('.destination-task').click();await closed();};
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
 for(const width of [1280,390]){
 runtime.state.thread=task;runtime.state.machineId='local';mode='success';active=[task,owned,...Array.from({length:9},(_,i)=>({...task,id:`draft-${i}`,name:`Draft task ${i}`}))];
 await page.setViewportSize({width,height:844});await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.waitForFunction(()=>document.querySelector('#destination-label').textContent.includes('Current task'));
 runtime.state.liveMessages=[{id:'markdown-check',role:'assistant',text:'![Remote image](https://example.com/remote.png) ![HTTP image](http://example.com/remote.png) [Web link](https://example.com/)'}];
 runtime.broadcast('snapshot',snapshot());
 await page.getByRole('link',{name:'Web link',exact:true}).waitFor();
 assert.equal(await page.locator('img[src^="https://"], img[src^="http://"]').count(),0);
 assert((await page.locator('body').innerText()).includes('Remote image'));
 runtime.state.liveMessages=[];
 await input.fill('Draft A');await page.locator('#image-picker').setInputFiles({name:'a.png',mimeType:'image/png',buffer:png});await page.locator('#composer-images img').waitFor();
 await select('Owned task');assert.equal(await input.inputValue(),'');assert.equal(await page.locator('#composer-images img').count(),0);
 await input.fill('Draft B');await select('Current task');assert.equal(await input.inputValue(),'Draft A');assert.equal(await page.locator('#composer-images img').count(),1);
 mode='reject';await open();await row('Owned task').locator('.destination-task').click();await row('Owned task').locator('.task-selection-error').waitFor();await page.locator('#destination-close').click();await closed();assert.equal(await input.inputValue(),'Draft A');assert.equal(await page.locator('#composer-images img').count(),1);
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
 failAction=false;await page.getByRole('button',{name:'New Task',exact:true}).first().click();await closed();assert.equal(await input.inputValue(),'');
 await select('Current task');assert.equal(await input.inputValue(),'Stable action draft');
 for(let i=0;i<9;i++){await select(`Draft task ${i}`);await input.fill(`Draft ${i}`);}
 await select('Current task');assert.equal(await input.inputValue(),'');assert.equal(await page.locator('#composer-images img').count(),0);
 }
 assert.deepEqual(errors,[]);console.log('PASS: desktop/mobile task-keyed text/images, failed selection preserves drafts, send clears drafts, localized Rename/Archive/Delete/Create busy and failures, new task empty, draft eviction returns empty, remote Markdown images unavailable');
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
