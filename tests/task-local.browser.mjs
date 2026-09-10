import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
// Optional browser regression: requires Playwright, or POCKET_PLAYWRIGHT_MODULE pointing to its module.
const {chromium} = await import(process.env.POCKET_PLAYWRIGHT_MODULE || 'playwright');
import {fileURLToPath} from 'node:url';
import {MachineRuntime} from '../gateway.ts';
const root=fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const conflict='This task is open in another Codex runtime. Close it there, then retry.';
const runtime=new MachineRuntime({}, {id:'local',name:'Local',ssh:null},()=>{});
const task={id:'current',name:'Current task',cwd:'/project',status:'idle',project:'project'};
const owned={...task,id:'owned',name:'Owned task'};
let active=[task,owned], archived=[{...task,id:'old',name:'Old task',archived:true}], fail=true, machineError=conflict;
Object.assign(runtime.state,{connected:true,thread:task,threadStatus:'idle'});
let asyncAnswers={},historyFixture=null;
const snapshot=()=>({...runtime.snapshot(),submissionEpoch:"test",asyncAnswers,message:{allowed:true,reason:"",canSteer:true}});
const calls=[];let gate=null, release, mode='success', failAction=false;
let failSettings=false, navigationGate=null, catalogAvailable=true, remoteConnected=true;
let settings={host:'127.0.0.1',port:4173,lanEnabled:false,localName:'',machines:[{name:'Laptop',ssh:'laptop'},{name:'Workstation',ssh:'workstation'}],phoneUrls:[]};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAIAAAAC64paAAAAGklEQVR4nGMwnplGNmIY1TyqeVTzqOaB1QwAQBHeMIlPtLYAAAAASUVORK5CYII=','base64');
const server=createServer(async(req,res)=>{
 const u=new URL(req.url,'http://localhost');calls.push(u.pathname);
 const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
 try{
 if(u.pathname==='/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);runtime.addSubscriber(res,false);req.on('close',()=>runtime.removeSubscriber(res));return;}
 if(u.pathname==='/api/auth')return json({required:false,authenticated:true});
 if(u.pathname==='/api/state')return json(snapshot());
 if(u.pathname==='/api/settings'){
 if(req.method==='POST'){
 if(failSettings)return json({error:'Settings save failed'},500);
 let text='';for await(const c of req)text+=c;const body=JSON.parse(text);
 const restartRequired=body.port!==settings.port;
 settings={...settings,...body};return json({saved:true,settings,restartRequired});
 }
 return json({settings});
 }
 if(u.pathname==='/api/machines')return json({machines:[runtime.machineSummary()]});
 if(u.pathname==='/api/threads')return json({threads:active});
 if(u.pathname==='/api/activity/detail')return json({machineId:'local',threadId:runtime.state.thread.id,itemId:u.searchParams.get('itemId'),detail:u.searchParams.get('itemId')==='diff-test'?{type:'fileChange',changes:[{path:'file.ts',kind:'modified',diff:'+    '+ 'long_token'.repeat(100)}]}:u.searchParams.get('itemId')==='command-test'?{type:'commandExecution',command:'echo test',output:'command_output'.repeat(100),exitCode:0}:{type:u.searchParams.get('itemId'),imageAvailable:true,name:'Activity image'}});
 if(u.pathname==='/api/activity/image'||u.pathname==='/api/message/image'){res.writeHead(200,{'Content-Type':'image/png'});res.end(png);return;}
 if(u.pathname==='/api/history')return json(historyFixture||{turns:[],nextCursor:null});
 if(u.pathname==='/api/navigation'){calls.push(u.search);if(navigationGate)await navigationGate;return json({machines:[{id:'local',name:'Local',local:true,connected:true,catalogAvailable,connectionError:machineError,tasks:u.searchParams.get('archived')==='true'?archived:active},{id:'ssh:test',name:'Second machine',connected:remoteConnected,tasks:[{...owned,id:'remote-owned',name:'Remote owned task'}]}]});}
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
 if(u.pathname==='/api/message/queue'&&req.method==='DELETE')return json(runtime.cancelQueuedMessage());
 if(u.pathname==='/api/message'){
 let text='';for await(const c of req)text+=c;const body=JSON.parse(text);
 if(body.question){
 const q=body.question,source=runtime.state.liveMessages.find(m=>m.id===q.messageId);
 asyncAnswers[q.messageId]={[q.index]:q.answer};
 runtime.state.liveMessages.push({id:'reply-'+q.messageId,role:'user',text:q.answer,complete:true,createdAt:source.createdAt+1,questionReplies:[{questionItemId:q.messageId,question:source.questions[q.index].title,answer:q.answer}]});
 return json({accepted:true,...snapshot()},202);
 }
 return json({accepted:true},202);
 }
 if(u.pathname==='/api/tasks'){
 let text='';for await(const c of req)text+=c;const b=JSON.parse(text);calls.push(b.action);if(gate)await gate;if(failAction)return json({error:'Fixture action failed'},409);
 if(b.action==='rename'){const t=[...active,...archived].find(t=>t.id===b.threadId);t.name=b.name;}
 if(b.action==='archive'){archived.push({...active.find(t=>t.id===b.threadId),archived:true});active=active.filter(t=>t.id!==b.threadId);}
 if(b.action==='unarchive'){active.push({...archived.find(t=>t.id===b.threadId),archived:false});archived=archived.filter(t=>t.id!==b.threadId);}
 if(b.action==='delete'){active=active.filter(t=>t.id!==b.threadId);archived=archived.filter(t=>t.id!==b.threadId);}
 if(b.action==='create'){const t={id:'new',name:b.name,cwd:b.cwd,status:'idle'};active.push(t);runtime.state.thread=t;return json({...snapshot(),warning:'Task created, but its name could not be saved. You can rename it later.'});}
 return json(snapshot());
 }
 const path=u.pathname==='/'?'/index.html':u.pathname;
 const file=path==='/vendor/markdown-it.min.js'?root+'/node_modules/markdown-it/dist/markdown-it.min.js':root+'/public'+path;
 res.writeHead(200,{'Content-Type':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html'});res.end(await readFile(file));
 }catch(e){json({error:e.message},500);}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true});
const page=await browser.newPage();
await page.addInitScript(()=>{
 window.taskDrawerTransitions=0;
 document.addEventListener('transitionrun',event=>{if(event.target.id==='destination-switcher'&&event.propertyName==='transform')window.taskDrawerTransitions++;});
});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const open=async()=>{if(await page.locator('#destination-button').getAttribute('aria-expanded')!=='true')await page.locator('#destination-button').click();await page.waitForTimeout(210);assert.notEqual(await page.evaluate(()=>document.activeElement?.id),'destination-search');assert.equal(await page.locator('#destination-close').isVisible(),page.viewportSize().width<1100);};
const dismissTasks=()=>page.locator(page.viewportSize().width>=1100?'#destination-button':'#destination-close').click();
const closed=()=>page.waitForFunction(()=>document.querySelector('#destination-switcher').hidden);
const settingsOpen=async()=>{await page.locator('#settings-button').evaluate(e=>e.click());await page.waitForFunction(()=>document.querySelector('#settings-status').textContent==='');};
const settingsSave=async()=>{if(await page.locator('#settings-save').isEnabled())await page.locator('#settings-save').click();else await page.locator('#settings-close').click();await page.waitForFunction(()=>document.querySelector('#settings-screen').hidden);};
try {
 const defaultDialog=d=>d.accept(d.type()==='prompt'?(d.message().includes('task name')?'New test task':'/project'):undefined);
 page.on('dialog',defaultDialog);
 const input=page.locator('#message-text');
 const row=name=>page.locator('.destination-entry').filter({has:page.getByText(name,{exact:true})});
 const select=async name=>{await open();await row(name).locator('.destination-task').click();
 await page.waitForFunction(name=>document.querySelector('#destination-label').textContent.includes(name),name);
 if(page.viewportSize().width>=1100){await page.waitForTimeout(210);assert.equal(await page.locator('#destination-switcher').evaluate(e=>e.hidden),false);await dismissTasks();}
 await closed();};

 for(const width of [1280,390]){
 runtime.state.models=[{model:'test',displayName:'Test',supportedReasoningEfforts:['low','medium','high','xhigh','max','ultra'].map(reasoningEffort=>({reasoningEffort})),defaultReasoningEffort:'low'}];runtime.state.model='test';runtime.state.reasoningEffort='low';
 runtime.state.activities=[];runtime.state.liveMessages=[];runtime.state.thread=task;runtime.state.machineId='local';mode='success';active=[task,owned,...Array.from({length:9},(_,i)=>({...task,id:`draft-${i}`,name:`Draft task ${i}`}))];
 await page.setViewportSize({width,height:844});await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.waitForFunction(()=>document.querySelector('#destination-label').textContent.includes('Current task'));
 await page.evaluate(()=>{localStorage.removeItem('codex-pocket-enter-sends');localStorage.removeItem('codex-pocket-translucent-ui');});
 await page.reload();await page.waitForFunction(()=>document.querySelector('#destination-label').textContent.includes('Current task'));
 assert.equal(await page.locator('#enter-sends').isChecked(),width>860);
 await page.setViewportSize({width:width>860?390:1280,height:844});assert.equal(await page.locator('#enter-sends').isChecked(),width>860);await page.setViewportSize({width,height:844});
 for(const saved of [true,false]){
 await settingsOpen();
 await page.locator('#enter-sends').evaluate((e,value)=>{e.checked=value;e.dispatchEvent(new Event('change',{bubbles:true}));},saved);
 await settingsSave();
 await page.reload();await page.waitForFunction(()=>document.querySelector('#destination-label').textContent.includes('Current task'));
 assert.equal(await page.locator('#enter-sends').isChecked(),saved);
 }
 await page.evaluate(()=>localStorage.removeItem('codex-pocket-enter-sends'));await page.reload();await page.waitForFunction(()=>document.querySelector('#destination-label').textContent.includes('Current task'));
 const chromeColors=()=>page.locator('.topbar, .composer-zone').evaluateAll(es=>es.map(e=>getComputedStyle(e).backgroundColor));
 await settingsOpen();
 const save=page.locator('#settings-save');
 assert.equal(await save.isDisabled(),true);
 assert.equal(await page.locator('#translucent-ui').isVisible(),width<=860);
 const originalChrome=await chromeColors();
 const originalStorage=await page.evaluate(()=>JSON.stringify({...localStorage}));
 const originalTheme=await page.locator('html').getAttribute('data-theme');
 for(const id of ['enter-sends','show-context','show-quota','show-projects','translucent-ui']){
 await page.locator('#'+id).evaluate(e=>{e.checked=!e.checked;e.dispatchEvent(new Event('change',{bubbles:true}));});
 assert.equal(await save.isEnabled(),true);
 assert.deepEqual(await chromeColors(),originalChrome);
 assert(await page.locator('#context-chip, #quota-chip').evaluateAll(es=>es.every(e=>!e.hidden)));
 assert.equal(await page.evaluate(()=>JSON.stringify({...localStorage})),originalStorage);
 await page.locator('#'+id).evaluate(e=>{e.checked=!e.checked;e.dispatchEvent(new Event('change',{bubbles:true}));});
 assert.equal(await save.isDisabled(),true);
 }
 const theme=await page.locator('#settings-theme').inputValue();
 await page.locator('#settings-theme').selectOption(theme==='dark'?'light':'dark');
 assert.equal(await page.locator('html').getAttribute('data-theme'),originalTheme);assert.equal(await save.isEnabled(),true);
 await page.locator('#settings-theme').selectOption(theme);assert.equal(await save.isDisabled(),true);
 await page.locator('#settings-local-name').fill('Changed');assert.equal(await save.isEnabled(),true);
 await page.locator('#settings-local-name').fill(settings.localName);assert.equal(await save.isDisabled(),true);
 await page.locator('#machine-add').click();assert.equal(await save.isEnabled(),true);
 await page.locator('.machine-settings-row').last().locator('.machine-remove').click();assert.equal(await save.isDisabled(),true);
 for(const exit of ['settings-cancel','settings-close','Escape']){
 await page.locator('#settings-local-name').fill('Discard me');
 await page.locator('#enter-sends').evaluate(e=>{e.checked=!e.checked;e.dispatchEvent(new Event('change',{bubbles:true}));});
 await page.locator('#display-command').evaluate(e=>{e.checked=false;e.dispatchEvent(new Event('change'));});
 assert.equal(await page.evaluate(()=>JSON.stringify({...localStorage})),originalStorage);
 if(exit==='Escape')await page.keyboard.press('Escape');else await page.locator('#'+exit).click();
 await settingsOpen();
 assert.equal(await save.isDisabled(),true);
 assert.equal(await page.locator('#settings-local-name').inputValue(),settings.localName);
 assert.equal(await page.locator('#display-command').isChecked(),true);
 assert.equal(await page.locator('#enter-sends').isChecked(),width>860);
 }
 // Commit local and server changes together.
 await page.locator('#settings-local-name').fill('Saved host '+width);
 await page.locator('#translucent-ui').evaluate(e=>{e.checked=false;e.dispatchEvent(new Event('change',{bubbles:true}));});
 await page.locator('#enter-sends').evaluate(e=>{e.checked=!e.checked;e.dispatchEvent(new Event('change',{bubbles:true}));});
 await page.locator('#display-command').evaluate(e=>{e.checked=false;e.dispatchEvent(new Event('change'));});
 failSettings=true;await save.click();await page.waitForFunction(()=>document.querySelector('#settings-status').textContent==='Settings save failed');
 assert.equal(await page.evaluate(()=>JSON.stringify({...localStorage})),originalStorage);
 assert.deepEqual(await chromeColors(),originalChrome);
 failSettings=false;
 await settingsSave();
 assert.equal(settings.localName,'Saved host '+width);
 assert((await chromeColors()).every(c=>c.startsWith('rgb(')));
 assert.equal(await page.evaluate(()=>localStorage.getItem('codex-pocket-enter-sends')),String(width<=860));
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('codex-pocket-info-display')).command),false);
 await settingsOpen();assert.equal(await save.isDisabled(),true);
 await page.locator('#translucent-ui').evaluate(e=>{e.checked=true;e.dispatchEvent(new Event('change',{bubbles:true}));});
 await settingsSave();assert((await chromeColors()).every(c=>c.startsWith('rgba(')));
 await settingsOpen();
 await page.locator('#settings-port').fill(String(settings.port+1));await save.click();
 await page.locator('#settings-restart').waitFor();
 assert.equal(await page.locator('#settings-screen').isVisible(),true);assert.equal(await save.isDisabled(),true);
 assert(await page.locator('#restart-pocket').evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&document.activeElement===e;}));
 await page.locator('#settings-close').click();
 await page.evaluate(()=>localStorage.setItem('codex-pocket-info-display',JSON.stringify({commands:false})));
 await page.reload();await page.waitForFunction(()=>document.querySelector('#destination-label').textContent.includes('Current task'));
 for(const key of ['command','tool','search','review'])assert.equal(await page.locator(`#display-${key}`).isChecked(),false);
 assert.equal(await page.locator('#display-files').isChecked(),true);
 await page.evaluate(()=>localStorage.removeItem('codex-pocket-info-display'));await page.reload();await page.waitForFunction(()=>document.querySelector('#destination-label').textContent.includes('Current task'));
 const reloadReady=async()=>{await page.reload();await page.waitForFunction(()=>document.querySelector('#destination-label').textContent.includes('Current task'));await page.waitForTimeout(210);};
 if(width>=1100){
 assert.equal(await page.locator('#destination-button').getAttribute('aria-expanded'),'false');
 assert.equal(await page.locator('#inspector-button').getAttribute('aria-expanded'),'true');
 await open();assert.equal(await page.evaluate(()=>window.taskDrawerTransitions),1);await page.locator('#inspector-button').click();await reloadReady();
 assert.equal(await page.evaluate(()=>window.taskDrawerTransitions),0);
 assert.equal(await page.locator('#destination-button').getAttribute('aria-expanded'),'true');
 assert.equal(await page.locator('#inspector-button').getAttribute('aria-expanded'),'false');
 await page.locator('#inspector-button').click();await reloadReady();
 assert.equal(await page.evaluate(()=>window.taskDrawerTransitions),0);
 assert.equal(await page.locator('#destination-button').getAttribute('aria-expanded'),'true');
 assert.equal(await page.locator('#inspector-button').getAttribute('aria-expanded'),'true');
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/restored-both.png`});
 await dismissTasks();await closed();await reloadReady();
 assert.equal(await page.locator('#destination-button').getAttribute('aria-expanded'),'false');
 assert.equal(await page.locator('#inspector-button').getAttribute('aria-expanded'),'true');
 }else{
 await page.evaluate(()=>{localStorage.setItem('codex-pocket-tasks-open','true');localStorage.setItem('codex-pocket-details-open','true');});
 await reloadReady();
 for(const id of ['destination-button','inspector-button'])assert.equal(await page.locator(`#${id}`).getAttribute('aria-expanded'),'false');
 await open();await dismissTasks();await closed();await page.locator('#inspector-button').click();await page.locator('#inspector-close').click();
 assert.deepEqual(await page.evaluate(()=>['tasks','details'].map(k=>localStorage.getItem(`codex-pocket-${k}-open`))),['true','true']);
 }
 await page.locator('#settings-button').click();
 await page.locator('.machine-settings-row').first().waitFor();
 for(const [theme, system, color] of [['light','dark','#f6f8fa'],['dark','light','#0d1117'],['system','light','#f6f8fa'],['system','dark','#0d1117']]){
 await page.emulateMedia({colorScheme:system});await page.locator('#settings-theme').selectOption(theme);await settingsSave();await settingsOpen();
 await page.waitForFunction(color=>document.querySelector('meta[name="theme-color"]').content===color,color);
 }
 await page.emulateMedia({colorScheme:'light'});
 await page.waitForFunction(()=>document.querySelector('meta[name="theme-color"]').content==='#f6f8fa');

 for(const name of ['Display Name','SSH Alias'])assert.equal(await page.locator('.machine-settings-row').first().getByText(name,{exact:true}).isVisible(),width<600);
 assert.equal(await page.locator('.machine-settings-header').isVisible(),width>=600);
 if(width>=600){assert((await page.locator('.machine-settings-row').first().boundingBox()).height<65);assert.deepEqual(await page.locator('.machine-settings-header span').allTextContents(),['Display Name','SSH Alias','Actions']);}
 assert.equal(await page.getByRole('button',{name:'Move Laptop up',exact:true}).isDisabled(),true);
 assert.equal(await page.getByRole('button',{name:'Move Workstation down',exact:true}).isDisabled(),true);
 assert.deepEqual(await page.locator('.machine-settings-row').first().locator('button').allTextContents(),['↑','↓','×']);
 assert.deepEqual(await page.locator('.machine-settings-row').first().locator('input').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().height)),[40,40]);
 const valueSize=width>=861?'13px':'16px';
 assert((await page.locator('.settings-card input:not([type="checkbox"]), .settings-card select').evaluateAll(es=>es.map(e=>getComputedStyle(e).fontSize))).every(s=>s===valueSize));
 const gaps=await page.locator('.settings-card .form-field').evaluateAll(es=>es.map(e=>e.children[1].getBoundingClientRect().top-e.children[0].getBoundingClientRect().bottom));
 assert(gaps.every(g=>g===4));
 assert.deepEqual(await page.locator('.machine-settings-field').evaluateAll(es=>es.map(e=>getComputedStyle(e).gap)),['4px','4px','4px','4px']);
 if(width<600)assert((await page.locator('.machine-settings-field').evaluateAll(es=>es.map(e=>e.children[1].getBoundingClientRect().top-e.children[0].getBoundingClientRect().bottom))).every(g=>g===4));
 assert.equal(await page.locator('.settings-card .checkbox-row').first().evaluate(e=>getComputedStyle(e).display),'flex');
 assert.equal(await page.locator('.settings-card .checkbox-row').first().evaluate(e=>getComputedStyle(e).fontSize),'12px');
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/settings-top-${width}.png`});
 await page.locator('.machine-settings-row').first().scrollIntoViewIfNeeded();
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/settings-${width}.png`});
 await page.locator('#settings-close').click();
 if(await page.locator('#inspector-button').getAttribute('aria-expanded')!=='true')await page.locator('#inspector-button').click();
 await page.waitForTimeout(200);await page.locator('#display-files').waitFor();
 assert.deepEqual(await page.locator('#effort-select option').allTextContents(),['Light','Medium','High','Extra High','Max','Ultra']);
 assert.equal(await page.locator('#effort-select').inputValue(),'low');
 assert.deepEqual(await page.locator('.runtime-panel select').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().height)),[40,40,40]);
 assert.deepEqual(await page.locator('.runtime-panel select').evaluateAll(es=>es.map(e=>getComputedStyle(e).fontSize)),[valueSize,valueSize,valueSize]);
 assert.deepEqual(await page.locator('.runtime-panel .form-field').evaluateAll(es=>es.map(e=>e.children[1].getBoundingClientRect().top-e.children[0].getBoundingClientRect().bottom)),[4,4,4]);
 await page.locator('#access-select').evaluate(e=>e.classList.add('full-access'));
 assert.equal(await page.locator('#access-select').evaluate(e=>getComputedStyle(e).fontSize),valueSize);
 await page.locator('#access-select').evaluate(e=>e.classList.remove('full-access'));
 assert.equal(await page.locator('#inspector-close').isVisible(),width<861);
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/display-${width}.png`});
 const categories=[['reasoning','reasoning','Reasoning'],['command','command','Command'],['tool','tool','Tool'],['search','search','Search'],['files','files','File Changes'],['collaboration','collaboration','Subagents'],['image','images','Image'],['review','review','Review'],['compaction','compaction','Context Compaction']];
 assert.deepEqual(await page.locator('.display-panel .display-option span').allTextContents(),categories.map(c=>c[2]).concat(['Expand Commands by Default','Expand File Changes by Default','Wrap File Changes']));
 runtime.state.activities=categories.map(([kind])=>({id:`filter-${kind}`,kind,label:`Test ${kind}`,status:'completed'}));runtime.broadcast('snapshot',snapshot());
 await page.locator('.timeline-activity').nth(8).waitFor();
 for(const [kind,key,label] of categories){
 assert.equal(await page.locator(`[data-activity-id="filter-${kind}"] .activity-kind`).textContent(),label);
 await page.locator(`#display-${key}`).uncheck();assert.equal(await page.locator(`.timeline-activity.${kind}`).count(),0);assert.equal(await page.locator('.timeline-activity').count(),8);
 await page.locator(`#display-${key}`).check();assert.equal(await page.locator('.timeline-activity').count(),9);
 }
 assert.equal(await page.locator('#wrap-files').isChecked(),false);
 await page.locator('#expand-commands').check();await page.locator('#expand-files').check();
 for(const wrap of [false,true]){
 await page.locator('#wrap-files').setChecked(wrap);
 await page.locator('#display-hide-all').click();assert.equal(await page.locator('.timeline-activity').count(),0);
 for(const [,key] of categories)assert.equal(await page.locator(`#display-${key}`).isChecked(),false);
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('codex-pocket-info-display')));
 assert.equal(saved.expandCommands,true);assert.equal(saved.expandFiles,true);assert.equal(saved.wrapFiles,wrap);
 for(const [,key] of categories)assert.equal(saved[key],false);
 await page.locator('#display-show-all').click();assert.equal(await page.locator('.timeline-activity').count(),9);
 for(const [,key] of categories)assert.equal(await page.locator(`#display-${key}`).isChecked(),true);
 assert.deepEqual(await page.locator('#expand-commands, #expand-files, #wrap-files').evaluateAll(es=>es.map(e=>e.checked)),[true,true,wrap]);
 }
 await page.locator('#wrap-files').uncheck();
 runtime.state.activities=[{id:'diff-test',kind:'files',label:'Diff wrapping',status:'completed',expandable:true},{id:'command-test',kind:'command',label:'Command wrapping',status:'completed',expandable:true}];
 runtime.state.liveMessages=[{id:'code-wrap',role:'assistant',text:'```text\n'+ 'markdown_code'.repeat(100)+'\n```'}];runtime.broadcast('message',runtime.state.liveMessages[0]);for(const activity of runtime.state.activities)runtime.broadcast('activity',activity);
 await page.locator('.detail-diff .diff-line').waitFor({state:'attached'});await page.locator('[data-activity-id="command-test"] .detail-code').first().waitFor({state:'attached'});
 const codeStyles=()=>page.locator('[data-activity-id="command-test"] .detail-code, .markdown pre').evaluateAll(es=>es.map(e=>({whiteSpace:getComputedStyle(e).whiteSpace,overflowWrap:getComputedStyle(e).overflowWrap})));
 const beforeCode=await codeStyles();
 assert.equal(await page.locator('.detail-diff .diff-line').evaluate(e=>getComputedStyle(e).whiteSpace),'pre');
 assert(await page.locator('.detail-diff').evaluate(e=>e.scrollWidth>e.clientWidth));
 await page.locator('#wrap-files').check();
 assert.equal(await page.locator('.detail-diff .diff-line').evaluate(e=>getComputedStyle(e).whiteSpace),'pre-wrap');
 assert(await page.locator('.detail-diff').evaluate(e=>e.scrollWidth<=e.clientWidth+1));assert.deepEqual(await codeStyles(),beforeCode);
 await page.locator('#wrap-files').uncheck();await page.locator('#expand-files').uncheck();await page.locator('#expand-commands').uncheck();
 if(width<860)await page.locator('#inspector-close').click();else await page.locator('#inspector-button').click();
 await page.waitForTimeout(200);
 for(const type of ['imageView','imageGeneration']){
 runtime.state.activities=[{id:type,kind:'image',label:'Image test',status:'completed',expandable:true}];runtime.broadcast('snapshot',snapshot());
 const card=page.locator(`[data-activity-id="${type}"]`);await card.locator('.activity-summary').click();
 await page.locator('.detail-image').scrollIntoViewIfNeeded();
 await page.waitForFunction(()=>document.querySelector('.detail-image')?.naturalWidth>0);
 const img=page.locator('.detail-image');
 await open();
 // Set up both underlying panels even on mobile, where their backdrops cover the topbar.
 await page.locator('#inspector-button').evaluate(e=>e.click());await page.waitForTimeout(210);
 const sidebarPreferences=await page.evaluate(()=>['tasks','details'].map(k=>localStorage.getItem(`codex-pocket-${k}-open`)));
 await page.locator('#settings-button').evaluate(e=>e.click());await page.locator('#settings-screen').waitFor();
 await page.keyboard.press('Escape');assert.equal(await page.locator('#settings-screen').isVisible(),false);
 for(const id of ['destination-button','inspector-button'])assert.equal(await page.locator(`#${id}`).getAttribute('aria-expanded'),'true');
 await page.keyboard.press('Escape');await page.waitForTimeout(210);
 for(const id of ['destination-button','inspector-button'])assert.equal(await page.locator(`#${id}`).getAttribute('aria-expanded'),'true');
 assert.deepEqual(await page.evaluate(()=>['tasks','details'].map(k=>localStorage.getItem(`codex-pocket-${k}-open`))),sidebarPreferences);
 await img.focus();await img.press('Enter');await page.locator('#image-viewer').waitFor();
 await page.keyboard.press('Escape');await page.waitForTimeout(210);
 assert.equal(await page.locator('#image-viewer').evaluate(e=>e.open),false);
 for(const id of ['destination-button','inspector-button'])assert.equal(await page.locator(`#${id}`).getAttribute('aria-expanded'),'true');
 assert.deepEqual(await page.evaluate(()=>['tasks','details'].map(k=>localStorage.getItem(`codex-pocket-${k}-open`))),sidebarPreferences);
 await page.locator(width<861?'#inspector-close':'#inspector-button').click();await dismissTasks();await closed();
 await img.focus();await img.press('Enter');await page.locator('#image-viewer').waitFor();
 if(width<861){
 await page.locator('#viewer-image').evaluate(e=>{e.style.width='300px';e.style.height='600px';});
 const cdp=await page.context().newCDPSession(page);
 const touch=(type,points)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points.map(([x,y,id=1])=>({x,y,id}))});
 const center=()=>page.locator('#viewer-image').evaluate(e=>{const r=e.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2];});
 const scale=()=>page.locator('#viewer-image').evaluate(e=>new DOMMatrix(getComputedStyle(e).transform).a);
 for(const dy of [55,-55,180,-180]){
 const [x,y]=await center();const before=await page.locator('#viewer-image').boundingBox();
 await touch('touchStart',[[x,y]]);await touch('touchMove',[[x,y+dy]]);
 assert.deepEqual(await page.locator('#viewer-image').boundingBox(),before);
 await touch('touchEnd',[]);
 assert.equal(await page.locator('#image-viewer').evaluate(e=>e.open),true);
 assert.deepEqual(await page.locator('#viewer-image').boundingBox(),before);
 }
 const doubleTap=async()=>{for(let i=0;i<2;i++){const [x,y]=await center();await touch('touchStart',[[x,y]]);await touch('touchEnd',[]);}};
 await doubleTap();assert.equal(await scale(),2.5);
 const panTop=(await page.locator('#viewer-image').boundingBox()).y;
 let [x,y]=await center();await touch('touchStart',[[x,y]]);await touch('touchMove',[[x,y-150]]);await touch('touchEnd',[]);
 assert.equal(await page.locator('#image-viewer').evaluate(e=>e.open),true);assert.equal(await scale(),2.5);
 assert((await page.locator('#viewer-image').boundingBox()).y<panTop-100);
 await doubleTap();assert.equal(await scale(),1);
 [x,y]=await center();await touch('touchStart',[[x-4,y,1],[x+4,y,2]]);await touch('touchMove',[[x-8,y,1],[x+8,y,2]]);await touch('touchEnd',[]);
 assert(await scale()>1);assert.equal(await page.locator('#image-viewer').evaluate(e=>e.open),true);
 await cdp.detach();
 }
 await page.locator('#image-viewer').evaluate(e=>e.dispatchEvent(new WheelEvent('wheel',{deltaY:-300,clientX:innerWidth/2,clientY:innerHeight/2,bubbles:true,cancelable:true})));
 assert(await page.locator('#viewer-image').evaluate(e=>new DOMMatrix(getComputedStyle(e).transform).a>1));
 await page.locator('#image-viewer').evaluate(e=>e.dispatchEvent(new WheelEvent('wheel',{deltaY:10000,bubbles:true,cancelable:true})));
 await page.locator('#image-viewer').click({position:{x:5,y:60}});
 assert.equal(await page.locator('#image-viewer').evaluate(e=>e.open),false);
 await img.click();await page.locator('#image-viewer').waitFor();
 await page.locator('#close-image').click();await img.click();await page.locator('#image-viewer').waitFor();await page.locator('#close-image').click();await card.locator('.activity-summary').click();
 }
 const geometry=()=>page.evaluate(()=>({
 panels:[...document.querySelectorAll('.chat-panel, #composer, #conversation')].map(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,x:e.getBoundingClientRect().x})),
 scrollTop:document.querySelector('#conversation').scrollTop,scrollHeight:document.querySelector('#conversation').scrollHeight,
 }));
 const capture=async name=>{if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/${name}-${width}.png`});};
 if(width>=1100){
 const baseline=await geometry();await capture('neither');await open();await capture('tasks');assert.deepEqual(await geometry(),baseline);
 assert.equal((await page.locator('#destination-switcher').boundingBox()).width,310);
 assert.equal(await page.locator('#destination-backdrop').isVisible(),false);
 assert.equal(await page.locator('#destination-search').evaluate(e=>e.getBoundingClientRect().height),40);
 assert.equal(await page.locator('#destination-close').isVisible(),false);
 const shellStyle=e=>{const s=getComputedStyle(e);return {height:e.getBoundingClientRect().height,padding:s.padding,border:s.borderBottom};};
 assert.deepEqual(await page.locator('.destination-switcher-head').evaluate(shellStyle),await page.locator('.inspector-heading').evaluate(shellStyle));
 const activeStyle=e=>{const s=getComputedStyle(e);return {background:s.backgroundColor,border:s.borderColor,color:s.color};};
 const active=await page.locator('#destination-button').evaluate(activeStyle);
 await page.locator('#inspector-button').click();await page.waitForTimeout(210);await capture('both');
 assert.deepEqual(await geometry(),baseline);assert.equal((await page.locator('.inspector').boundingBox()).width,340);
 assert.deepEqual(await page.locator('#inspector-button').evaluate(activeStyle),active);
 assert.equal(await page.locator('#inspector-close').isVisible(),false);assert.equal(await page.locator('#inspector-backdrop').isVisible(),false);
 await dismissTasks();await closed();await capture('details');assert.deepEqual(await geometry(),baseline);
 assert.equal(await page.locator('#inspector-button').getAttribute('aria-expanded'),'true');
 await page.locator('#inspector-button').click();await page.waitForTimeout(210);assert.deepEqual(await geometry(),baseline);
 }else{
 await open();await capture('tasks');assert.equal(await page.locator('#destination-close').isVisible(),true);assert.equal(await page.locator('#destination-backdrop').isVisible(),true);
 const header=await page.locator('.destination-switcher-head').evaluate(e=>({height:e.getBoundingClientRect().height,padding:getComputedStyle(e).padding}));
 const closeSize=await page.locator('#destination-close').evaluate(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}));
 await dismissTasks();await closed();await page.locator('#inspector-button').click();await page.waitForTimeout(210);await capture('details');
 assert.deepEqual(await page.locator('.inspector-heading').evaluate(e=>({height:e.getBoundingClientRect().height,padding:getComputedStyle(e).padding})),header);
 assert.deepEqual(await page.locator('#inspector-close').evaluate(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height})),closeSize);
 assert.equal(await page.locator('#inspector-backdrop').isVisible(),true);await page.locator('#inspector-close').click();await page.waitForTimeout(210);
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
 runtime.state.queuedMessage={threadId:runtime.state.thread.id,text:'Already sending',images:[]};runtime.startingQueuedMessage=true;runtime.broadcast('snapshot',snapshot());
 await page.locator('#queue-banner').waitFor();await page.locator('#cancel-queue').click();
 await page.getByText('Queued message is already being sent.',{exact:true}).waitFor();
 assert.equal(await page.locator('#queue-banner').isVisible(),true);assert.equal(await page.locator('#queue-text').textContent(),'Already sending');
 assert.equal(runtime.state.queuedMessage.text,'Already sending');
 runtime.startingQueuedMessage=false;await page.locator('#cancel-queue').click();
 await page.getByText('Queued message cancelled.',{exact:true}).waitFor();assert.equal(await page.locator('#queue-banner').isVisible(),false);
 await input.fill('Draft A');await page.locator('#image-picker').setInputFiles({name:'a.png',mimeType:'image/png',buffer:png});await page.locator('#composer-images img').waitFor();
 await select('Owned task');assert.equal(await input.inputValue(),'');assert.equal(await page.locator('#composer-images img').count(),0);
 await input.fill('Draft B');await select('Current task');assert.equal(await input.inputValue(),'Draft A');assert.equal(await page.locator('#composer-images img').count(),1);
 mode='reject';await open();await row('Owned task').locator('.destination-task').click();await row('Owned task').locator('.task-selection-error').waitFor();
 assert.equal(await row('Owned task').locator('.task-selection-error').textContent(),'Open elsewhere. Close it and retry.');
 const aligned=async target=>{const centers=await target.locator('.destination-check, .destination-task-label > span, .destination-task-status').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return r.top+r.height/2;}));assert.deepEqual(centers,Array(3).fill(centers[0]));};
 await aligned(row('Current task'));await aligned(row('Owned task'));
 const centered=async()=>assert(await row('Current task').evaluate(e=>{const a=e.querySelector('.destination-check').getBoundingClientRect(),b=e.querySelector('.task-actions > summary').getBoundingClientRect();return Math.abs((a.top+a.bottom-b.top-b.bottom)/2)<1;}));
 await centered();
 const oneLineHeight=await row('Current task').locator('.destination-task').evaluate(e=>e.getBoundingClientRect().height);
 assert.equal(oneLineHeight,40);
 if(width>=1100)assert(await row('Owned task').locator('.task-selection-error').evaluate(e=>Math.abs(e.getBoundingClientRect().height-parseFloat(getComputedStyle(e).lineHeight))<0.1));
 const spacing=await page.evaluate(()=>({gap:document.querySelector('.destination-group-heading').getBoundingClientRect().top-document.querySelector('.destination-archived input').getBoundingClientRect().bottom,nextPadding:getComputedStyle(document.querySelectorAll('.destination-group')[1]).paddingTop,nextBorder:getComputedStyle(document.querySelectorAll('.destination-group')[1]).borderTopWidth}));
 assert(spacing.gap>=0&&spacing.gap<=6,JSON.stringify(spacing));assert.equal(spacing.nextPadding,'12px');assert.equal(spacing.nextBorder,'1px');
 await settingsOpen();await page.locator('#show-projects').evaluate(e=>{e.checked=true;e.dispatchEvent(new Event('change',{bubbles:true}));});await settingsSave();
 await row('Current task').locator('.task-project').waitFor();await aligned(row('Current task'));await centered();
 assert(await row('Current task').locator('.destination-task').evaluate(e=>{const r=e.getBoundingClientRect(),name=e.querySelector('.destination-task-label > span').getBoundingClientRect(),sub=e.querySelector('small').getBoundingClientRect();return r.height>=58&&sub.top-name.bottom>=4&&r.bottom-sub.bottom>=8;}));
 assert(await row('Owned task').locator('.destination-task').evaluate(e=>{const r=e.getBoundingClientRect(),sub=e.querySelector('small').getBoundingClientRect();return r.height>=58&&r.bottom-sub.bottom>=8;}));
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/task-rows-${width}.png`});
 const attempts=calls.filter(c=>c==='/api/navigation/select').length;
 gate=new Promise(r=>release=r);await row('Owned task').locator('.destination-task').click();
 await row('Owned task').getByText('Opening…',{exact:true}).waitFor();await aligned(row('Owned task'));
 // Selection clears the old error; exercise the requested combined layout without changing that behavior.
 await row('Owned task').locator('.destination-task-label').evaluate(e=>{e.querySelector('small')?.remove();e.append(Object.assign(document.createElement('small'),{className:'task-selection-error',textContent:'Open elsewhere. Close it and retry.'}));});
 await aligned(row('Owned task'));
 if(width>=1100)assert(await row('Owned task').locator('.task-selection-error').evaluate(e=>Math.abs(e.getBoundingClientRect().height-parseFloat(getComputedStyle(e).lineHeight))<0.1));
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/task-opening-${width}.png`});
 release();gate=null;
 await settingsOpen();await page.locator('#show-projects').evaluate(e=>{e.checked=false;e.dispatchEvent(new Event('change',{bubbles:true}));});await settingsSave();
await row('Owned task').locator('.task-selection-error').waitFor();assert.equal(await page.getByRole('button',{name:'Retry',exact:true}).count(),0);assert.equal(calls.filter(c=>c==='/api/navigation/select').length,attempts+1);await dismissTasks();await closed();assert.equal(await input.inputValue(),'Draft A');assert.equal(await page.locator('#composer-images img').count(),1);
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
 task.name='Current task';await dismissTasks();await closed();await open();
 failAction=true;
 gate=new Promise(r=>release=r);await page.getByRole('button',{name:'New task',exact:true}).first().click();await page.waitForFunction(()=>document.querySelector('.destination-group-heading button').disabled);assert.equal(await page.getByRole('button',{name:'New task',exact:true}).first().locator('svg').count(),1);assert(!(await page.locator('#composer').innerText()).includes('Switching'));release();gate=null;
 await page.locator('.destination-group').first().getByText('Fixture action failed',{exact:true}).waitFor();assert.equal(await page.locator('.destination-error').count(),0);
 failAction=false;await page.getByRole('button',{name:'New task',exact:true}).first().click();await page.getByText('Task created, but its name could not be saved. You can rename it later.',{exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('#destination-label').textContent.includes('New test task'));if(width>=1100){assert.equal(await page.locator('#destination-switcher').evaluate(e=>e.hidden),false);await dismissTasks();}await closed();assert.equal(await input.inputValue(),'');
 await select('Current task');assert.equal(await input.inputValue(),'Stable action draft');
 for(let i=0;i<9;i++){await select(`Draft task ${i}`);await input.fill(`Draft ${i}`);}
 await select('Current task');assert.equal(await input.inputValue(),'');assert.equal(await page.locator('#composer-images img').count(),0);
 // Async controls disappear on resolution; the normalized user reply remains the only answer.
 const choice={id:'async-choice',role:'assistant',delivery:'async',text:'Which layout should we use?\n\n- Compact\n- Spacious',questions:[{title:'Which layout should we use?',options:['Compact','Spacious']}],complete:true,createdAt:1000};
 const free={id:'async-free',role:'assistant',delivery:'async',text:'What should the empty state say?',questions:[{title:'What should the empty state say?',options:[]}],complete:true,createdAt:2000};
 runtime.state.liveMessages=[choice,free];runtime.state.activities=[];asyncAnswers={};
 await page.reload();await page.locator('[data-message-id="async-choice"] .async-answer').waitFor();
 const choiceMessage=page.locator('[data-message-id="async-choice"]'),freeMessage=page.locator('[data-message-id="async-free"]');
 assert.equal(await choiceMessage.getByRole('button',{name:'Compact',exact:true}).isVisible(),true);
 assert.equal(await choiceMessage.getByRole('button',{name:'Other Answer…',exact:true}).isVisible(),true);
 assert.equal(await freeMessage.getByRole('textbox').getAttribute('placeholder'),'Write your answer…');
 assert.equal(await freeMessage.getByRole('button',{name:'Other Answer…',exact:true}).count(),0);
 await choiceMessage.getByRole('button',{name:'Compact',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('[data-message-id="async-choice"] .async-answer'));
 assert.equal(await choiceMessage.locator('.message-body').innerText(),'Which layout should we use?');
 assert.equal(await page.locator('.message.user .message-body').filter({hasText:'Compact'}).count(),1);
 await freeMessage.getByRole('textbox').fill('Your inventory is empty.');await freeMessage.getByRole('button',{name:'Answer',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('[data-message-id="async-free"] .async-answer'));
 assert.equal(await freeMessage.locator('.message-body').innerText(),'What should the empty state say?');
 assert.equal(await page.locator('#conversation').getByText('Your inventory is empty.',{exact:true}).count(),1);
 assert.equal(await page.locator('#conversation').getByText('Answered:',{exact:false}).count(),0);
 // Reconstruct through the real gateway normalizer, with no live answer cache.
 const items=[choice,free].map(m=>({...m,type:'agentMessage'}));
 items.push({id:'history-reply',type:'userMessage',createdAt:3000,content:[{type:'text',text:'<send_user_message_question_reply>'+JSON.stringify([
 {questionItemId:choice.id,question:choice.questions[0].title,answer:'Compact'},
 {questionItemId:free.id,question:free.questions[0].title,answer:'Your inventory is empty.'}
 ])+'</send_user_message_question_reply>'}]});
 runtime.rpc={request:async method=>method==='thread/turns/list'?{data:[{id:'async-turn',status:'completed'}]}:{data:items.map(item=>({turnId:'async-turn',item}))}};
 historyFixture=await runtime.history(null,1);runtime.state.liveMessages=[];asyncAnswers={};
 await page.reload();await page.locator('[data-message-id="history-reply"]').waitFor();
 assert.equal(await page.locator('#conversation .async-answer').count(),0);
 assert.equal(await choiceMessage.locator('.message-body').innerText(),'Which layout should we use?');
 assert.equal(await freeMessage.locator('.message-body').innerText(),'What should the empty state say?');
 const transcript=await page.locator('#conversation').innerText();
 for(const answer of ['Compact','Your inventory is empty.'])assert.equal(transcript.split(answer).length-1,1);
 for(const internal of ['Answered:','send_user_message_question_reply','questionItemId'])assert.equal(transcript.includes(internal),false);
 // Blocking request_user_input still uses the separate Input Needed form.
 runtime.state.pending=[{id:'blocking-input',kind:'input',supported:true,blocking:true,questions:[{id:'block-q',header:'Confirm',isOther:true,question:'Which test suite?',options:[{label:'Unit tests',description:'Run focused checks'},{label:'All tests',description:'Run every check'}]}]}];
 runtime.broadcast('snapshot',snapshot());await page.getByText('Input Needed',{exact:true}).waitFor();
 assert.equal(await page.locator('.structured-input-form input[type="radio"]').count(),3);
 assert.equal(await page.getByText('Turn paused',{exact:true}).isVisible(),true);
 runtime.state.pending=[];historyFixture=null;runtime.state.liveMessages=[];asyncAnswers={};
 await page.reload();await page.waitForFunction(()=>document.querySelector('#destination-label').textContent.includes('Current task'));
 if(width===390){
 runtime.state.liveMessages=Array.from({length:50},(_,i)=>({id:`viewport-${i}`,role:'assistant',text:`Message ${i}\n\nEnough content to scroll the document.`}));runtime.broadcast('snapshot',snapshot());
 await page.getByText('Message 49',{exact:false}).waitFor();
 const bottomGap=()=>page.evaluate(()=>{const d=document.scrollingElement;return d.scrollHeight-d.scrollTop-d.clientHeight;});
 const scrollGap=async gap=>{await page.evaluate(gap=>{document.activeElement?.blur();const d=document.scrollingElement;window.scrollTo(0,d.scrollHeight-d.clientHeight-gap);},gap);await page.waitForTimeout(150);};
 const stream=async text=>{runtime.broadcast('assistant_delta',{id:'viewport-49',delta:`\n\n${text} `.repeat(20)});await page.getByText(text,{exact:false}).last().waitFor();await page.waitForTimeout(150);};
 await scrollGap(150);assert.equal(await page.locator('#jump-latest').isVisible(),false);
 await stream('Near-bottom streamed text');assert(await bottomGap()<2);
 await scrollGap(250);assert.equal(await page.locator('#jump-latest').isVisible(),true);
 const heldTop=await page.evaluate(()=>document.scrollingElement.scrollTop);
 await stream('Reading older content');assert(Math.abs(await page.evaluate(()=>document.scrollingElement.scrollTop)-heldTop)<2);
 assert.equal(await page.locator('#jump-latest').isVisible(),true);
 await page.locator('#jump-latest').click();await page.waitForFunction(()=>{const d=document.scrollingElement;return d.scrollHeight-d.scrollTop-d.clientHeight<2;});
 await stream('Following again');assert(await bottomGap()<2);assert.equal(await page.locator('#jump-latest').isVisible(),false);

 await page.evaluate(()=>window.scrollTo(0,document.scrollingElement.scrollHeight));await page.waitForTimeout(150);
 for(const decrease of [30,25,20,15]){
 await page.evaluate(()=>{document.activeElement?.blur();const d=document.scrollingElement;window.scrollTo(0,d.scrollHeight-d.clientHeight-90);});await page.waitForTimeout(20);
 const gap=await page.evaluate(async decrease=>{Object.defineProperty(visualViewport,'height',{configurable:true,value:visualViewport.height-decrease});visualViewport.dispatchEvent(new Event('resize'));await new Promise(requestAnimationFrame);const d=document.scrollingElement;return d.scrollHeight-d.scrollTop-d.clientHeight;},decrease);
 assert(gap<2);
 }
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
 // Isolated browser checks use the same real frontend and synthetic server.
 for(const width of [390,1080,1100,1280]){
 await page.setViewportSize({width,height:844});
 runtime.state.thread=task;runtime.state.machineId='local';runtime.state.liveMessages=[];runtime.state.activities=[];runtime.state.pending=[];
 const savedRuntime={model:runtime.state.model,reasoningEffort:runtime.state.reasoningEffort,models:runtime.state.models,access:runtime.state.access};
 for(const value of ['Not exposed','Not Exposed',null]){
 Object.assign(runtime.state,{model:value,reasoningEffort:value,models:[],access:value?{mode:'unavailable',choices:{}}:null});
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.waitForFunction(()=>document.querySelector('#destination-label').textContent.includes('Current task'));
 assert.deepEqual(await page.locator('.runtime-panel select').evaluateAll(es=>es.map(e=>e.selectedOptions[0]?.textContent)),['Unavailable','Unavailable','Unavailable']);
 }
 Object.assign(runtime.state,savedRuntime);
 runtime.state.turn={id:'failed-turn',status:'failed',error:'Upstream capacity reached. Try again later.'};runtime.state.phase='failed';runtime.state.threadStatus='idle';
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.waitForFunction(()=>document.querySelector('#destination-label').textContent.includes('Current task'));
 await page.locator('#message-text').fill('Try again');
 assert.equal(await page.locator('#send-message').isEnabled(),true);
 assert.equal(await page.locator('#composer-status').textContent(),'Upstream capacity reached. Try again later.');
 assert.equal(await page.locator('#phase-pill').textContent(),'Failed');
 runtime.handleNotification({method:'turn/started',params:{threadId:'current',turn:{id:'next-turn',status:'inProgress'}}});
 await page.waitForFunction(()=>document.querySelector('#phase-pill').textContent==='Working');
 assert(!(await page.locator('#composer-status').textContent()).includes('Upstream capacity'));
 await open();
 let releaseCatalog; navigationGate=new Promise(r=>releaseCatalog=r);
 const before=calls.filter(c=>c==='/api/navigation').length;
 await page.locator('#destination-refresh').click();
 await page.waitForFunction(()=>document.querySelector('#destination-refresh').disabled);
 assert.equal(await page.locator('#destination-refresh').getAttribute('aria-label'),'Refresh tasks');
 assert.equal(await page.locator('#destination-refresh').getAttribute('title'),'Refresh tasks');
 assert.equal(await page.locator('#destination-refresh svg').evaluate(e=>getComputedStyle(e).animationName),'refresh-spin');
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await page.locator('#destination-refresh svg').evaluate(e=>getComputedStyle(e).animationName),'none');
 await page.emulateMedia({reducedMotion:'no-preference'});
 catalogAvailable=false;remoteConnected=false;releaseCatalog();navigationGate=null;
 await page.waitForFunction(()=>!document.querySelector('#destination-refresh').disabled);
 assert.equal(calls.filter(c=>c==='/api/navigation').length,before+1);
 assert.equal(await page.locator('.destination-group.unavailable').getByText('Tasks unavailable',{exact:true}).count(),1);
 assert.equal(await page.locator('.destination-group.offline').getByText('Offline',{exact:true}).count(),1);
 catalogAvailable=true;remoteConnected=true;
 await page.locator('#show-archived').check();await page.waitForFunction(()=>!document.querySelector('#destination-refresh').disabled);
 const archivedBefore=calls.filter(c=>c==='?archived=true').length;
 await page.locator('#destination-refresh').click();await page.waitForFunction(()=>!document.querySelector('#destination-refresh').disabled);
 assert.equal(calls.filter(c=>c==='?archived=true').length,archivedBefore+1);
 await page.locator('#show-archived').uncheck();await page.waitForFunction(()=>!document.querySelector('#destination-refresh').disabled);
 if(width===390){
 navigationGate=new Promise(r=>releaseCatalog=r);
 const started=Date.now();await page.locator('#destination-refresh').click();
 await page.waitForFunction(()=>!document.querySelector('#destination-refresh').disabled,{},{timeout:9_000});
 assert(Date.now()-started<9_000);
 assert.equal(await page.locator('.destination-group.unavailable').count(),1); // Keep the last catalog on HTTP failure.
 releaseCatalog();navigationGate=null;
 await page.locator('#destination-refresh').click();await page.waitForFunction(()=>!document.querySelector('#destination-refresh').disabled);
 }
 await page.mouse.move(0,0);
 assert(await page.locator('.destination-group-heading button').evaluateAll(buttons=>buttons.every(button=>{
 const rect=button.getBoundingClientRect(),icon=button.querySelector('svg').getBoundingClientRect(),style=getComputedStyle(button);
 return button.getAttribute('aria-label')==='New task'&&button.title==='New task'&&rect.width===36&&rect.height===36
   &&style.borderTopWidth==='0px'&&style.backgroundColor==='rgba(0, 0, 0, 0)'
   &&Math.abs(rect.x+18-icon.x-icon.width/2)<1&&Math.abs(rect.y+18-icon.y-icon.height/2)<1;
 })));
 if(width!==390)assert.equal(await page.locator('.destination-group.offline button').first().isDisabled(),true);
 await page.keyboard.press('Tab');await page.getByRole('button',{name:'New task',exact:true}).first().focus();
 assert(await page.getByRole('button',{name:'New task',exact:true}).first().evaluate(e=>{const s=getComputedStyle(e);return e.matches(':focus-visible')&&s.outlineStyle==='solid'&&parseFloat(s.outlineWidth)>=2;}));
 const plus=page.getByRole('button',{name:'New task',exact:true}).first();
 await plus.hover();assert.equal(await plus.evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');
 const plusRect=await plus.boundingBox(),actionRect=await page.locator('.task-actions summary').first().boundingBox();
 assert(Math.abs(plusRect.x+plusRect.width/2-actionRect.x-actionRect.width/2)<1);
 for(const edge of ['first','last']){
 const action=page.locator('.task-actions summary')[edge]();
 await action.evaluate((e,edge)=>e.scrollIntoView({block:edge==='first'?'start':'end'}),edge);
 await page.waitForTimeout(100);await action.click();
 const placement=await action.evaluate(e=>{
 const menu=e.parentElement.querySelector('.task-action-menu');
 return {anchor:e.getBoundingClientRect().toJSON(),menu:menu.getBoundingClientRect().toJSON(),panel:document.querySelector('#destination-switcher').getBoundingClientRect().toJSON(),list:document.querySelector('#destination-list').getBoundingClientRect().toJSON(),viewport:innerHeight};
 });
 const {anchor,menu,panel,list,viewport}=placement;
 assert(Math.abs(menu.right-anchor.right)<1,JSON.stringify(placement));
 assert(Math.abs(edge==='first'?menu.top-anchor.bottom:menu.bottom-anchor.top)<1,JSON.stringify(placement));
 assert(menu.left>=panel.left&&menu.right<=panel.right&&menu.top>=Math.max(0,list.top)&&menu.bottom<=Math.min(viewport,list.bottom),JSON.stringify(placement));
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/menu-${edge}-${width}.png`});
 await action.click();
 }
 await page.locator('#destination-list').evaluate(e=>e.scrollTop=0);
 const refreshBox=await page.locator('#destination-refresh').boundingBox();
 assert.equal(refreshBox.width,36);assert.equal(refreshBox.height,36);
 if(width<1100){const closeBox=await page.locator('#destination-close').boundingBox();assert.equal(closeBox.y,refreshBox.y);assert.equal(closeBox.height,refreshBox.height);}
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/refresh-${width}.png`});
 if(width===1080){
 await page.locator("#destination-refresh").click();await page.waitForFunction(()=>!document.querySelector("#destination-refresh").disabled);
 await settingsOpen();await page.locator('#show-projects').check();await settingsSave();
 mode='reject';
 const failedRow=page.locator('.destination-entry').filter({has:page.getByText('Owned task',{exact:true})});
 await failedRow.locator('.destination-task').click();await failedRow.locator('.task-selection-error').waitFor();
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/task-rows-${width}.png`});
 const error=failedRow.locator('.task-selection-error'),copy=await error.textContent();
 await error.evaluate(e=>e.textContent+=' The task is still in use by another runtime. Please close that task before selecting it again.');
 assert(await error.evaluate(e=>e.getBoundingClientRect().height>16&&e.scrollWidth<=e.clientWidth));
 await error.evaluate((e,text)=>e.textContent=text,copy);
 mode='success';await settingsOpen();await page.locator('#show-projects').uncheck();await settingsSave();
 }
 if(width<1100){assert.equal(await page.locator('#destination-backdrop').isVisible(),true);await page.locator('#destination-backdrop').click({position:{x:width-5,y:400}});await closed();}
 else {assert.equal(await page.locator('#destination-backdrop').isVisible(),false);await dismissTasks();await closed();}
 if(await page.locator('#inspector-button').getAttribute('aria-expanded')!=='true')await page.locator('#inspector-button').click();
 await page.waitForTimeout(200);
 assert.equal(await page.locator('#inspector-close').isVisible(),width<1100);
 assert.equal(await page.locator('#inspector-backdrop').isVisible(),width<1100);
 if(width<1100)assert.equal((await page.locator('.inspector').boundingBox()).y,0);
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/inspector-${width}.png`});
 if(width<1100)await page.locator('#inspector-backdrop').click({position:{x:5,y:400}});else await page.locator('#inspector-button').click();
 assert.equal(await page.locator('#inspector-button').getAttribute('aria-expanded'),'false');
 await settingsOpen();
 if(process.env.POCKET_SCREENSHOT_DIR){
 await page.locator('.settings-card').evaluate(e=>e.scrollTop=0);
 await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/appearance-${width}.png`});
 await page.locator('#machine-add').scrollIntoViewIfNeeded();
 await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/machines-${width}.png`});
 }
 await page.locator('#settings-close').click();
 // A backdrop click located over a different transcript image closes only the modal.
 runtime.state.liveMessages=[{id:'two-images',role:'user',text:'Compare these screenshots',imageCount:2,createdAt:Date.now(),complete:true}];
 runtime.broadcast('snapshot',snapshot());
 const images=page.locator('.message-images img');await images.nth(1).waitFor();
 await images.nth(1).scrollIntoViewIfNeeded();
 const underneath=await images.nth(1).boundingBox();
 await images.first().click();await page.locator('#image-viewer').waitFor();
 const imageBox=await page.locator('#viewer-image').boundingBox();
 const point={x:underneath.x+underneath.width/2,y:underneath.y+underneath.height/2};
 assert(point.x<imageBox.x||point.x>imageBox.x+imageBox.width||point.y<imageBox.y||point.y>imageBox.y+imageBox.height);
 if(width===390){
 const touch=await page.context().newCDPSession(page);
 await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y,id:1}]});
 await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await touch.detach();
 }else await page.mouse.click(point.x,point.y);
 await page.waitForTimeout(150);
 assert.equal(await page.locator('#image-viewer').evaluate(e=>e.open),false);
 await images.nth(1).click();await page.locator('#image-viewer').waitFor();await page.keyboard.press('Escape');
 }
 assert.deepEqual(errors,[]);console.log('PASS: desktop/mobile task-keyed text/images, failed selection preserves drafts, send clears drafts, localized Rename/Archive/Delete/Create busy and failures, new task empty, draft eviction returns empty, remote Markdown images unavailable, settings labels and filters, image-card viewer, errored-row retry, both sidebar geometry and matching shells, form control sizes, Tasks focus, frame-by-frame viewport anchoring, diff wrapping and bulk display filters');
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
