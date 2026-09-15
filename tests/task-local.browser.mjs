import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// npm run test:browser uses the pinned Playwright dependency; an external module override is optional.
const {chromium} = await import(process.env.POCKET_PLAYWRIGHT_MODULE || 'playwright');
import {fileURLToPath} from 'node:url';
import {MachineRuntime,RpcClient} from '../gateway.ts';
const root=fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const conflict='This task is open in another Codex runtime. Close it there, then retry.';
const runtime=new MachineRuntime({}, {id:'local',name:'Local',ssh:null},()=>{},value=>runtime.broadcast('task-status',value));
const task={id:'current',name:'Current task',cwd:'/project',status:'idle',project:'project'};
const owned={...task,id:'owned',name:'Owned task'};
let active=[task,owned], archived=[{...task,id:'old',name:'Old task',archived:true}], fail=true, machineError=conflict;
Object.assign(runtime.state,{connected:true,thread:task,threadStatus:'idle'});
let asyncAnswers={},historyFixture=null, messageUnknown=false, messageGate=null;
let composerPost="success", recoveryMode=null;
const eventClients=new Set();
const snapshot=()=>({...runtime.snapshot(),submissionEpoch:"test",asyncAnswers,message:{allowed:true,reason:"",canSteer:true}});
const fileBodies=[];let realFilePosts=false;
const reviewResponses=new Map();
const calls=[];let gate=null, release, mode='success', failAction=false;
let freshNavigation=false;
let newTaskOptionsFixture=null;
let actionFailure='Fixture action failed', cwdFailure=false, cwdGate=null;const cwdEdits=[];
let wakeConfigured=false, wakeFailure=false;const wakeBodies=[];
let goalGate=null;const goalCalls=[];let uiGate=null;let queueEditGate=null,queueEditFailure=false;const queueEdits=[];
let failSettings=false, navigationGate=null, catalogAvailable=true, remoteConnected=true, remoteCatalogTimeout=false;
let settings={host:'127.0.0.1',port:4173,lanEnabled:false,localName:'',machines:[{name:'Laptop',ssh:'laptop'},{name:'Workstation',ssh:'workstation'}],phoneUrls:[]};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAIAAAAC64paAAAAGklEQVR4nGMwnplGNmIY1TyqeVTzqOaB1QwAQBHeMIlPtLYAAAAASUVORK5CYII=','base64');
const server=createServer(async(req,res)=>{
 const u=new URL(req.url,'http://localhost');calls.push(u.pathname);
 const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
 try{
 const scripted=reviewResponses.get(u.pathname);
 if(scripted){
 let raw='';for await(const chunk of req)raw+=chunk;
 scripted.bodies.push(raw?JSON.parse(raw):Object.fromEntries(u.searchParams));
 await scripted.gate;return json(scripted.result,scripted.status);
 }
 if(u.pathname==='/events'){eventClients.add(res);req.on('close',()=>eventClients.delete(res));res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(`retry: 50\nevent: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);runtime.addSubscriber(res,false);req.on('close',()=>runtime.removeSubscriber(res));return;}
 if(u.pathname==='/api/auth')return json({required:false,authenticated:true});
 if(u.pathname==='/api/state'){
 if(u.searchParams.has('submissionId')&&recoveryMode){
 if(recoveryMode==='unreachable'){req.socket.destroy();return;}
 return json({...snapshot(),submission:{id:u.searchParams.get('submissionId'),status:recoveryMode,turnId:'accepted-start-turn',error:recoveryMode==='rejected'?'Upstream rejected this message':undefined}});
 }
 return json(snapshot());
 }
 if(u.pathname==='/api/settings'){
 if(req.method==='POST'){
 if(failSettings)return json({error:'Settings save failed'},500);
 let text='';for await(const c of req)text+=c;const body=JSON.parse(text);
 const restartRequired=body.port!==settings.port;
 settings={...settings,...body};return json({saved:true,settings,restartRequired});
 }
 return json({settings});
 }
 if(['/api/approval','/api/input','/api/thread/settings','/api/thread/access'].includes(u.pathname)){
 let text='';for await(const c of req)text+=c;const body=JSON.parse(text);if(uiGate)await uiGate;
 if(u.pathname==='/api/thread/settings'){runtime.state.model=body.model;runtime.state.reasoningEffort=body.effort;return json({updated:true,model:body.model,reasoningEffort:body.effort});}
 if(u.pathname==='/api/thread/access'){runtime.state.access={...runtime.state.access,mode:body.mode};return json({updated:true,access:runtime.state.access});}
 runtime.state.pending=[];runtime.broadcast('request',{pending:[],message:{allowed:true,reason:null}});return json({accepted:true});
 }
 if(u.pathname==='/api/thread/cwd'){
 let text='';for await(const c of req)text+=c;const body=JSON.parse(text);cwdEdits.push(body);
 runtime.rpc={request:async(method,params)=>{
 if(method==='thread/settings/update'){
 if(cwdFailure)throw new Error('Folder unavailable on this machine');
 if(cwdGate)await cwdGate;
 runtime.handleNotification({method:'thread/settings/updated',params:{threadId:params.threadId,threadSettings:{cwd:params.cwd}}});
 }return {data:[]};}};
 try{return json(await runtime.updateWorkingPath(body.threadId,body.cwd));}catch(error){return json({error:error.message},409);}
 }
 if(u.pathname==='/api/goal'){let text='';for await(const c of req)text+=c;const body=JSON.parse(text);if(goalGate)await goalGate;return json(await runtime.goalAction(body));}
 if(u.pathname==='/api/machines/wake'){let text='';for await(const c of req)text+=c;wakeBodies.push(JSON.parse(text));return wakeFailure?json({error:'send EACCES'},400):json({sent:true});}
 if(u.pathname==='/api/machines')return json({machines:settings.headless?[{id:'ssh:test',name:'Second machine',connected:remoteConnected}]:[runtime.machineSummary()]});
 if(u.pathname==='/api/threads')return json({threads:active});
 if(u.pathname==='/api/activity/detail')return json({machineId:'local',threadId:runtime.state.thread.id,itemId:u.searchParams.get('itemId'),detail:u.searchParams.get('itemId')==='diff-test'?{type:'fileChange',changes:[{path:'file.ts',kind:'modified',diff:'+    '+ 'long_token'.repeat(100)}]}:u.searchParams.get('itemId')==='command-test'?{type:'commandExecution',command:'echo test',output:'command_output'.repeat(100),exitCode:0}:{type:u.searchParams.get('itemId'),imageAvailable:true,name:'preview.png',revisedPrompt:u.searchParams.get('itemId')==='imageGeneration'?'A small moonlit garden':undefined}});
 if(u.pathname==='/api/activity/image'||u.pathname==='/api/message/image'){res.writeHead(200,{'Content-Type':'image/png'});res.end(png);return;}
 if(u.pathname==='/api/history')return json(historyFixture||{machineId:runtime.state.machineId,threadId:runtime.state.thread?.id,turns:[],nextCursor:null});
 if(u.pathname==='/api/navigation'){calls.push(u.search);if(navigationGate)await navigationGate;
 let remoteAvailable=true;
 if(remoteCatalogTimeout){
 const rpc=new RpcClient();rpc.wire={send(){},close(){}};
 try{await rpc.request('thread/list',{},5000);}catch{remoteAvailable=false;calls.push('remote-catalog-timeout');}finally{rpc.close();}
 }
 return json({machines:[{id:'local',name:'Local',local:true,connected:true,catalogAvailable,connectionError:machineError,tasks:u.searchParams.get('archived')==='true'?archived:active},{id:'ssh:test',name:'Second machine',connected:remoteConnected,catalogAvailable:remoteAvailable,canWake:wakeConfigured&&!remoteConnected,tasks:[{...owned,id:'remote-owned',name:'Remote owned task',cwd:'/remote/project'}]}].filter(machine=>!settings.headless||!machine.local)});}
 if(u.pathname==='/api/navigation/select'){
 let text='';for await(const c of req)text+=c;const body=JSON.parse(text);
 if(gate)await gate;
 if(freshNavigation){try{runtime.assertCanLeaveNewTask();}catch(error){return json({error:error.message},409);}}
 if(mode==='unavailable')return json({error:'selected task is unavailable'},409);
 if(mode==='reject'){
 runtime.rpc={request:async(method)=>{if(method==='thread/list')return {data:[...active,{...owned,id:'remote-owned'}]};if(method==='thread/resume')throw new Error('already has an active writer');return {data:[]};}};
 try{await runtime.selectThread(body.threadId);}catch(error){return json({error:error.message},409);}
 throw new Error('Expected rejection');
 }

 runtime.state.thread=active.find(t=>t.id===body.threadId)||{...owned,id:body.threadId};runtime.state.machineId=body.machineId;
 if(mode==='lost'){req.socket.destroy();return;}
 return json(snapshot());
 }
 if(u.pathname==='/api/turn/interrupt'){if(uiGate)await uiGate;return json({accepted:true});}
 if(u.pathname==='/api/message/queue'&&req.method==='POST'){
 if(uiGate)await uiGate;
 if(messageGate)await messageGate;
 if(messageUnknown){req.socket.destroy();return;}
 if(composerPost==='lost'){res.writeHead(202,{'Content-Type':'application/json','Content-Length':'1000'});res.write('{');setTimeout(()=>req.socket.destroy(),10);return;}
 if(composerPost==='reject')return json({error:'Send rejected'},409);
 runtime.state.queuedMessage=null;return json({accepted:true,mode:'steer',turnId:runtime.state.turn.id},202);
 }
 if(u.pathname==='/api/message/queue'&&req.method==='PATCH'){
 let text='';for await(const c of req)text+=c;const body=JSON.parse(text);queueEdits.push(body);if(queueEditGate)await queueEditGate;
 if(queueEditFailure)return json({error:'Could not save this edit'},409);
 try{return json(runtime.editQueuedMessage(body.threadId,body.text));}catch(error){return json({error:error.message},409);}
 }
 if(u.pathname==='/api/message/queue'&&req.method==='DELETE')return json(runtime.cancelQueuedMessage());
 if(u.pathname==='/api/message'){
 if(uiGate)await uiGate;
 let text='';for await(const c of req)text+=c;const body=JSON.parse(text);
 if(body.files?.length)fileBodies.push(body);
 if(freshNavigation){
 if(composerPost==='reject')return json({error:'Send rejected'},409);
 return json(await runtime.sendMessage(body.text,body.action,body.images,body.files,body.submissionId),202);
 }
 if(body.question){
 const q=body.question,source=runtime.state.liveMessages.find(m=>m.id===q.messageId);
 asyncAnswers[q.messageId]={[q.index]:q.answer};
 runtime.state.liveMessages.push({id:'reply-'+q.messageId,role:'user',text:q.answer,complete:true,createdAt:source.createdAt+1,questionReplies:[{questionItemId:q.messageId,question:source.questions[q.index].title,answer:q.answer}]});
 return json({accepted:true,...snapshot()},202);
 }
 if(messageUnknown){req.socket.destroy();return;}
 if(composerPost==='lost'){res.writeHead(202,{'Content-Type':'application/json','Content-Length':'1000'});res.write('{');setTimeout(()=>req.socket.destroy(),10);return;}
 if(composerPost==='reject')return json({error:'Send rejected'},409);
 if(realFilePosts&&body.files?.length)return json(await runtime.sendMessage(body.text,body.action,body.images,body.files,body.submissionId),202);
 return json({accepted:true,turnId:'accepted-start-turn'},202);
 }
 if(u.pathname==='/api/tasks/options' && u.searchParams.get('cwd')==='/unavailable')return json({error:'Unavailable'},503);
 if(u.pathname==='/api/tasks/options')return json(newTaskOptionsFixture||{models:[{model:'demo-model',displayName:'Demo Model',supportedReasoningEfforts:[{reasoningEffort:'high'}],defaultReasoningEffort:'high'}],access:{ask:true,auto:true,full:true}});
 if(u.pathname==='/api/tasks'){
 let text='';for await(const c of req)text+=c;const b=JSON.parse(text);calls.push(b.action);if(b.action==='create')calls.push({create:b});if(gate)await gate;if(failAction)return json({error:actionFailure},409);
 if(b.action==='rename'){const t=[...active,...archived].find(t=>t.id===b.threadId);t.name=b.name;}
 if(b.action==='archive'){archived.push({...active.find(t=>t.id===b.threadId),archived:true});active=active.filter(t=>t.id!==b.threadId);}
 if(b.action==='unarchive'){active.push({...archived.find(t=>t.id===b.threadId),archived:false});archived=archived.filter(t=>t.id!==b.threadId);}
 if(b.action==='delete'){active=active.filter(t=>t.id!==b.threadId);archived=archived.filter(t=>t.id!==b.threadId);}
 if(b.action==='create'){const t={id:'new',name:b.name,cwd:b.cwd,status:'idle'};active.push(t);runtime.state.thread=t;return json(snapshot());}
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
 // A semantically last final answer displays monotonic time without changing source timestamps.
 for(const width of [1280,390]){
 await page.setViewportSize({width,height:844});
 const start=new Date(2026,0,1,0,8).getTime();
 const messages=[
 {id:'time-user',role:'user',createdAt:start},
 {id:'time-final',role:'assistant',phase:'final_answer',createdAt:start+60000},
 ];
 for(const message of messages)Object.assign(message,{turnId:'time-turn',text:message.id,complete:true});
 Object.assign(runtime.state,{thread:task,turn:null,phase:'done',liveMessages:messages,activities:[]});
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.locator('[data-message-id="time-final"] time').waitFor();
 const displayed=()=>page.locator('#conversation .message time').evaluateAll(nodes=>nodes.map(node=>({time:Date.parse(node.dateTime),text:node.textContent})));
 assert.deepEqual((await displayed()).map(value=>value.time),[start,start+60000]);
 // Arriving later must invalidate the final answer's render signature even though it is unchanged.
 messages.push({id:'time-later',role:'assistant',phase:'commentary',turnId:'time-turn',text:'Later update',complete:true,createdAt:start+120000});
 runtime.broadcast('snapshot',snapshot());
 await page.waitForFunction(expected=>Date.parse(document.querySelector('[data-message-id="time-final"] time').dateTime)===expected,start+120000);
 assert.deepEqual(await page.locator('#conversation .message').evaluateAll(nodes=>nodes.map(node=>node.dataset.messageId)),['time-user','time-later','time-final']);
 const times=await displayed();
 assert.deepEqual(times.map(value=>value.time),[start,start+120000,start+120000]);
 assert.equal(times[2].text,times[1].text);
 assert.equal(messages[1].createdAt,start+60000);
 }
 const defaultDialog=d=>{throw new Error('Unexpected browser dialog: '+d.type());};
 page.on('dialog',defaultDialog);
 const input=page.locator('#message-text');
 const row=name=>page.locator('.destination-entry').filter({has:page.getByText(name,{exact:true})});
 const select=async name=>{await open();await row(name).locator('.destination-task').click();
 await page.waitForFunction(name=>document.querySelector('#destination-label').textContent.includes(name),name);
 assert.equal(await input.evaluate(e=>document.activeElement===e),page.viewportSize().width>=1100);
 if(page.viewportSize().width>=1100){await page.waitForTimeout(210);assert.equal(await page.locator('#destination-switcher').evaluate(e=>e.hidden),false);await dismissTasks();}
 await closed();};

 // Pending deletion pins the visible slot, including searches hiding rows above it in either task view.
 for(const width of [1280,1099,390])for(const failure of [false,true])for(const view of ["normal","filtered-active","filtered-archived"]){
 await page.setViewportSize({width,height:844});
 const filtered=view!=='normal',isArchived=view==='filtered-archived';
 const visible={preview:filtered?'search-match':'',archived:isArchived};
 const deleting={...task,...visible,id:'delete-pending',name:'Delete pending',loaded:true,updatedAt:20};
 const hidden={...task,id:'hidden',name:'Hidden row',loaded:true,updatedAt:50,archived:isArchived};
 const setCatalog=tasks=>{if(isArchived)archived=tasks;else active=tasks;};
 setCatalog([...(filtered?[hidden]:[]),{...task,...visible,loaded:true,updatedAt:30},deleting,{...owned,...visible,loaded:true,updatedAt:10}]);
 Object.assign(runtime.state,{machineId:'local',thread:task,turn:null,threadStatus:'idle',liveMessages:[],activities:[]});
 await page.goto(`http://127.0.0.1:${server.address().port}`);await open();
 if(isArchived){await page.locator('#show-archived').check();await row('Delete pending').waitFor();}
 if(filtered){await page.locator('#destination-search').fill('search-match');await row('Hidden row').waitFor({state:'detached'});}
 assert.equal(await row('Current task').locator('.destination-check svg[aria-hidden="true"]').count(),1);
 assert.equal(await row('Delete pending').locator('summary svg circle').count(),3);
 const order=()=>page.locator('.destination-group').first().locator('.destination-task-label > span').allTextContents();
 assert.deepEqual(await order(),['Current task','Delete pending','Owned task']);
 failAction=failure;gate=new Promise(r=>release=r);
 await row('Delete pending').locator('summary').click();await row('Delete pending').getByRole('button',{name:'Delete',exact:true}).click();
 await page.locator('#task-dialog-submit').click();await row('Delete pending').getByText('Deleting…',{exact:true}).waitFor();
 await page.evaluate(()=>{
 window.deletingPositions=[];
 window.deleteObserver=new MutationObserver(()=>{
 const names=[...document.querySelector('.destination-group').querySelectorAll('.destination-task-label > span')].map(e=>e.textContent);
 if(document.querySelector('.destination-task-status')&&names.includes('Delete pending'))window.deletingPositions.push(names.indexOf('Delete pending'));
 });
 window.deleteObserver.observe(document.querySelector('#destination-list'),{childList:true,subtree:true});
 });
 deleting.status='notLoaded';deleting.loaded=false;
 runtime.broadcast('task-status',{machineId:'local',threadId:deleting.id,status:'notLoaded'});
 runtime.broadcast('task-status',{machineId:'local',threadId:owned.id,status:'idle',updatedAt:40});
 if(filtered){
 hidden.loaded=false;hidden.status='notLoaded';
 runtime.broadcast('task-status',{machineId:'local',threadId:hidden.id,status:'notLoaded'});
 }
 setCatalog([{...owned,...visible,loaded:true,updatedAt:40},{...task,...visible,loaded:true,updatedAt:30},deleting,...(filtered?[hidden]:[])]);
 await page.waitForFunction(()=>document.querySelector('.destination-task-label > span').textContent==='Owned task');
 assert.deepEqual(await order(),['Owned task','Delete pending','Current task']);
 await row('Delete pending').getByText('Deleting…',{exact:true}).waitFor();
 if(!failure)setCatalog((isArchived?archived:active).filter(task=>task.id!==deleting.id));
 await page.locator('#destination-refresh').click();await page.waitForFunction(()=>!document.querySelector('#destination-refresh').disabled);
 assert.deepEqual(await order(),['Owned task','Delete pending','Current task']);
 assert(await page.evaluate(()=>window.deletingPositions.length>0&&window.deletingPositions.every(index=>index===1)));
 await page.evaluate(()=>window.deleteObserver.disconnect());
 release();gate=null;
 if(failure){
 await row('Delete pending').locator('.task-selection-error').waitFor();
 assert.deepEqual(await order(),['Owned task','Current task','Delete pending']);
 }else{
 await row('Delete pending').waitFor({state:'detached'});await row('Current task').waitFor();
 assert.deepEqual(await order(),['Owned task','Current task']);
 }
 if(!isArchived){
 await row('Owned task').locator('.destination-task').click();
 await page.waitForFunction(()=>document.querySelector('#destination-label').textContent.includes('Owned task'));
 assert.equal(await input.evaluate(e=>document.activeElement===e),width>=1100);
 }
 }
 failAction=false;active=[task,owned];archived=[{...task,id:'old',name:'Old task',archived:true}];
 await page.evaluate(()=>localStorage.removeItem('codex-pocket-tasks-open'));

 // Catalog timeout is not transport failure; the later machine event alone changes the label.
 for(const width of [1280,390]){
 await page.setViewportSize({width,height:844});
 Object.assign(runtime.state,{machineId:'local',thread:task,connected:true,threadStatus:'idle',turn:null});
 await page.goto(`http://127.0.0.1:${server.address().port}`);await open();
 const remote=page.locator('.destination-group').filter({has:page.getByText('Second machine',{exact:true})});
 await remote.getByText('Remote owned task',{exact:true}).waitFor();
 await page.waitForFunction(()=>!document.querySelector('#destination-refresh').disabled);
 remoteCatalogTimeout=true;
 const timeouts=calls.filter(c=>c==='remote-catalog-timeout').length;
 await page.locator('#destination-refresh').click();
 await remote.getByText('Tasks Unavailable',{exact:true}).waitFor();
 assert(calls.filter(c=>c==='remote-catalog-timeout').length>timeouts);
 assert.equal(await remote.getByText('Offline',{exact:true}).count(),0);
 assert.equal(await remote.getByRole('button',{name:'New task',exact:true}).isEnabled(),true);
 remoteConnected=false;
 runtime.broadcast('machines',{machines:[runtime.machineSummary(),{id:'ssh:test',name:'Second machine',connected:false}]});
 await remote.getByText('Offline',{exact:true}).waitFor();
 assert.equal(await remote.getByText('Tasks Unavailable',{exact:true}).count(),0);
 assert.equal(await remote.getByRole('button',{name:'New task',exact:true}).isDisabled(),true);
 remoteCatalogTimeout=false;remoteConnected=true;
 await dismissTasks();await closed();
 }
 await page.evaluate(()=>localStorage.removeItem('codex-pocket-tasks-open'));

 // Keep unrelated sidebar overlays out of these composer-focused fixtures.
 await page.evaluate(()=>localStorage.setItem("codex-pocket-details-open","false"));
 // Review: unrelated live updates preserve the exact structured-input node and active composition.
 for(const width of [1280,390]){
 await page.setViewportSize({width,height:844});
 const question={id:'review-input',kind:'input',supported:true,blocking:true,questions:[{id:'review-q',header:'Details',question:'Describe the change',options:null}]};
 Object.assign(runtime.state,{machineId:'local',thread:task,connected:true,turn:null,threadStatus:'idle',pending:[question],queuedMessage:null,liveMessages:[],activities:[]});
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 const answer=page.locator('.input-free-text');await answer.fill('Before composition');await answer.focus();
 await answer.evaluate(e=>{window.reviewInput=e;e.setSelectionRange(2,9,'backward');e.dispatchEvent(new CompositionEvent('compositionstart',{data:'文',bubbles:true}));});
 for(const [event,value] of [['machines',{machines:[runtime.machineSummary()]}],['quota',{available:false}],['context',{context:{usedTokens:123,contextWindow:10000}}]])runtime.broadcast(event,value);
 await page.waitForTimeout(100);
 assert.deepEqual(await answer.evaluate(e=>({same:e===window.reviewInput,focus:document.activeElement===e,start:e.selectionStart,end:e.selectionEnd,direction:e.selectionDirection,value:e.value})),
 {same:true,focus:true,start:2,end:9,direction:'backward',value:'Before composition'});
 await answer.evaluate(e=>e.dispatchEvent(new CompositionEvent('compositionend',{data:'文',bubbles:true})));
 question.questions[0].question='Updated question';runtime.broadcast('request',{pending:[question]});
 await page.getByText('Updated question',{exact:true}).waitFor();assert.equal(await answer.evaluate(e=>e===window.reviewInput),false);
 assert.equal(await answer.inputValue(),'Before composition');
 uiGate=new Promise(r=>release=r);await page.getByRole('button',{name:'Send Answer',exact:true}).press('Enter');
 await page.waitForFunction(()=>document.querySelector('.structured-input-form button').disabled);
 release();uiGate=null;await page.waitForFunction(()=>document.querySelector('#attention-banner').hidden);
 }

 // Review: stale responses and failures cannot overwrite a different task's draft, settings or queue.
 for(const action of ['message','model','access','cancel','queue'])for(const failure of action==='message'?[false,true,'unknown']:[false,true]){
 await page.setViewportSize({width:1280,height:844});
 const queued=['cancel','queue'].includes(action);
 Object.assign(runtime.state,{machineId:'local',thread:task,connected:true,threadStatus:queued?'active':'idle',turn:queued?{id:'turn',status:'inProgress'}:null,pending:[],liveMessages:[],activities:[],
 queuedMessage:queued?{id:'old-queue',threadId:task.id,text:'Original queue',createdAt:1}:null,
 models:['first','second'].map(model=>({model,displayName:model,supportedReasoningEfforts:[{reasoningEffort:'high'}]})),model:'first',reasoningEffort:'high',access:{mode:'ask',choices:{ask:{available:true},auto:{available:true},full:{available:true}}}});
 await page.goto(`http://127.0.0.1:${server.address().port}`);await input.waitFor();
 const path=action==='message'?'/api/message':action==='model'?'/api/thread/settings':action==='access'?'/api/thread/access':'/api/message/queue';
 const scripted={gate:new Promise(r=>release=r),bodies:[],status:failure?409:200,result:failure?{error:'Old task rejected',...(failure==='unknown'?{submission:{status:'unknown'}}:{})}:
 {accepted:true,updated:true,cancelled:true,queuedMessage:null,model:'second',reasoningEffort:'high',access:{...runtime.state.access,mode:'full'}}};
 reviewResponses.set(path,scripted);recoveryMode=failure==='unknown'?'unknown':null;
 if(action==='message'){await input.fill('Original draft');await page.locator('#send-message').click();}
 else if(action==='model')await page.locator('#model-select').selectOption('second');
 else if(action==='access')await page.locator('#access-select').selectOption('full');
 else if(action==='cancel'){await page.locator('#cancel-queue').click();await page.locator('#queue-dialog-submit').click();}
 else await page.locator('#send-queue').click();
 while(!scripted.bodies.length)await page.waitForTimeout(10);
 assert.equal(scripted.bodies[0].threadId,task.id);
 if(queued)assert.equal(scripted.bodies[0].queueId,'old-queue');
 Object.assign(runtime.state,{thread:owned,threadStatus:'idle',turn:null,queuedMessage:{id:'new-queue',threadId:owned.id,text:'Other queue',createdAt:1}});
 runtime.broadcast('snapshot',snapshot());
 await page.waitForFunction(()=>document.querySelector('#destination-label').textContent.includes('Owned task'));
 await input.evaluate(e=>{e.value='Other draft';e.dispatchEvent(new Event('input',{bubbles:true}));});
 release();reviewResponses.delete(path);await page.waitForTimeout(100);
 assert.equal(await input.inputValue(),'Other draft');
 assert.equal(await page.locator('#model-select').inputValue(),'first');assert.equal(await page.locator('#access-select').inputValue(),'ask');
 assert.equal(await page.locator('#queue-text').textContent(),'Other queue');
 assert(!(await page.locator('#composer-status').textContent()).includes('Old task rejected'));
 if(failure==='unknown'){
 assert(!(await page.locator('#composer-status').textContent()).includes('unconfirmed'));
 Object.assign(runtime.state,{thread:task,queuedMessage:null});runtime.broadcast('snapshot',snapshot());
 await page.waitForFunction(()=>/unconfirmed/.test(document.querySelector('#composer-status').textContent));
 assert.equal(await input.inputValue(),'Original draft');assert.equal(scripted.bodies.length,1);
 }
 recoveryMode=null;
 }

 // Review: an HTTP RPC timeout enters receipt recovery; it never retries the message POST.
 for(const outcome of ['unknown','rejected']){
 Object.assign(runtime.state,{thread:task,turn:null,threadStatus:'idle',queuedMessage:null,pending:[],liveMessages:[]});
 await page.goto(`http://127.0.0.1:${server.address().port}`);await input.waitFor();
 const scripted={gate:Promise.resolve(),bodies:[],status:409,result:{error:outcome==='unknown'?'turn/start timed out':'Ordinary rejection',submission:{status:outcome}}};
 reviewResponses.set('/api/message',scripted);recoveryMode=outcome;
 await input.fill('Receipt test');await page.locator('#send-message').click();
 await page.waitForFunction(()=>!document.querySelector('#message-text').disabled);
 if(outcome==='unknown'){
 await page.waitForFunction(()=>/unconfirmed/.test(document.querySelector('#composer-status').textContent));
 assert.equal(await input.inputValue(),'');
 recoveryMode='accepted';for(const client of [...eventClients])client.end();
 await page.waitForTimeout(200);assert.equal(scripted.bodies.length,1);
 }else{
 assert.equal(await input.inputValue(),'Receipt test');
 assert((await page.locator('#composer-status').textContent()).includes('Ordinary rejection'));
 assert.equal(scripted.bodies.length,1);
 }
 reviewResponses.clear();recoveryMode=null;
 }

 for(const width of [1280,390]){
 runtime.terminalResults={};
 runtime.state.models=[{model:'test',displayName:'Test',supportedReasoningEfforts:['low','medium','high','xhigh','max','ultra'].map(reasoningEffort=>({reasoningEffort})),defaultReasoningEffort:'low'}];runtime.state.model='test';runtime.state.reasoningEffort='low';
 runtime.state.activities=[];runtime.state.liveMessages=[];runtime.state.thread=task;runtime.state.machineId='local';mode='success';active=[task,owned,...Array.from({length:9},(_,i)=>({...task,id:`draft-${i}`,name:`Draft task ${i}`}))];
 await page.setViewportSize({width,height:844});await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.waitForFunction(()=>document.querySelector('#destination-label').textContent.includes('Current task'));
 await page.evaluate(()=>{localStorage.removeItem('codex-pocket-enter-sends');localStorage.removeItem('codex-pocket-translucent-ui');localStorage.removeItem('codex-pocket-details-open');});
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
 assert.equal(await page.locator('label[for="settings-local-name"]').textContent(),'Host Machine Display Name');
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
 if(width>=600){assert((await page.locator('.machine-settings-row').first().boundingBox()).height<65);assert.deepEqual(await page.locator('.machine-settings-header span').allTextContents(),['Display Name','SSH Alias','Wake MAC (optional)','Actions']);}
 assert.equal(await page.getByRole('button',{name:'Move Laptop up',exact:true}).isDisabled(),true);
 assert.equal(await page.getByRole('button',{name:'Move Workstation down',exact:true}).isDisabled(),true);
 assert.equal(await page.locator('.machine-settings-row').first().locator('button svg[aria-hidden="true"]').count(),3);
 assert.deepEqual(await page.locator('.machine-settings-row').first().locator('input').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().height)),[40,40,40]);
 const valueSize=width>=861?'13px':'16px';
 assert((await page.locator('.settings-card input:not([type="checkbox"]), .settings-card select').evaluateAll(es=>es.map(e=>getComputedStyle(e).fontSize))).every(s=>s===valueSize));
 const gaps=await page.locator('.settings-card .form-field').evaluateAll(es=>es.map(e=>e.children[1].getBoundingClientRect().top-e.children[0].getBoundingClientRect().bottom));
 assert(gaps.every(g=>g===4));
 assert.deepEqual(await page.locator('.machine-settings-field').evaluateAll(es=>es.map(e=>getComputedStyle(e).gap)),['4px','4px','4px','4px','4px','4px']);
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
 runtime.state.activities=[{id:type,kind:'image',label:'Viewed preview.png',status:'completed',expandable:true}];runtime.broadcast('snapshot',snapshot());
 const card=page.locator(`[data-activity-id="${type}"]`);await card.locator('.activity-summary').click();
 await page.locator('.detail-image').scrollIntoViewIfNeeded();
 await page.waitForFunction(()=>document.querySelector('.detail-image')?.naturalWidth>0);
 const img=page.locator('.detail-image');
 if(type==='imageView'){assert.equal(await card.locator('.detail-field').count(),0);assert.equal((await card.innerText()).split('preview.png').length-1,1);}
 else await card.getByText('A small moonlit garden',{exact:true}).waitFor();
 await open();
 // Set up both underlying panels even on mobile, where their backdrops cover the topbar.
 await page.locator('#inspector-button').evaluate(e=>e.click());await page.waitForTimeout(210);
 const sidebarPreferences=await page.evaluate(()=>['tasks','details'].map(k=>localStorage.getItem(`codex-pocket-${k}-open`)));
 await page.locator('#settings-button').evaluate(e=>e.click());await page.locator('#settings-screen').waitFor();
 await page.keyboard.press('Escape');assert.equal(await page.locator('#settings-screen').isVisible(),false);
 for(const id of ['destination-button','inspector-button'])assert.equal(await page.locator(`#${id}`).getAttribute('aria-expanded'),'true');
 await page.keyboard.press('Escape');await page.waitForTimeout(210);
 if(width<1100){
 assert.equal(await page.locator('#inspector-button').getAttribute('aria-expanded'),'false');
 assert.equal(await page.locator('#destination-button').getAttribute('aria-expanded'),'true');
 await page.keyboard.press('Escape');await closed();
 await open();await page.locator('#inspector-button').evaluate(e=>e.click());await page.waitForTimeout(210);
 }else{
 for(const id of ['destination-button','inspector-button'])assert.equal(await page.locator(`#${id}`).getAttribute('aria-expanded'),'true');
 assert.deepEqual(await page.evaluate(()=>['tasks','details'].map(k=>localStorage.getItem(`codex-pocket-${k}-open`))),sidebarPreferences);
 }
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
 const centeredClose=async id=>{const g=await page.locator(id).evaluate(e=>{const b=e.getBoundingClientRect(),s=e.querySelector('svg').getBoundingClientRect();return {dx:(b.left+b.right-s.left-s.right)/2,dy:(b.top+b.bottom-s.top-s.bottom)/2,path:e.querySelector('path').getAttribute('d')};});assert(Math.abs(g.dx)<0.1&&Math.abs(g.dy)<0.1);return g.path;};
 const closePath=await centeredClose('#destination-close');
 await dismissTasks();await closed();await page.locator('#inspector-button').click();await page.waitForTimeout(210);await capture('details');
 assert.deepEqual(await page.locator('.inspector-heading').evaluate(e=>({height:e.getBoundingClientRect().height,padding:getComputedStyle(e).padding})),header);
 assert.deepEqual(await page.locator('#inspector-close').evaluate(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height})),closeSize);
 assert.equal(await centeredClose('#inspector-close'),closePath);
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
 runtime.canAcceptDirectInput=true;
 runtime.state.queuedMessage={threadId:runtime.state.thread.id,text:'Already sending',images:[]};runtime.startingQueuedMessage=true;runtime.broadcast('snapshot',snapshot());
 await page.locator('#queue-banner').waitFor();await page.locator('#cancel-queue').click();await page.locator('#queue-dialog-submit').click();
 assert.equal(await page.locator('#queue-banner strong').textContent(),'Queued Next');
 await page.waitForFunction(()=>!document.querySelector('#cancel-queue').disabled);
 assert.equal(await page.locator('#composer-status').textContent(),'');
 assert.equal(await page.locator('#queue-banner').isVisible(),true);assert.equal(await page.locator('#queue-text').textContent(),'Already sending');
 assert.equal(runtime.state.queuedMessage.text,'Already sending');
 runtime.startingQueuedMessage=false;await page.locator('#cancel-queue').click();await page.locator('#queue-dialog-submit').click();
 await page.waitForFunction(()=>document.querySelector('#queue-banner').hidden);
 assert.equal(await page.locator('#composer-status').textContent(),'');assert.equal(await page.locator('#composer-status').isVisible(),false);
 assert.equal(await page.locator('#composer-status').evaluate(e=>e.getBoundingClientRect().height),0);
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
 const spacing=await page.evaluate(()=>({gap:document.querySelector('.destination-group-heading').getBoundingClientRect().top-document.querySelector('#destination-search').getBoundingClientRect().bottom,nextPadding:getComputedStyle(document.querySelectorAll('.destination-group')[1]).paddingTop,nextBorder:getComputedStyle(document.querySelectorAll('.destination-group')[1]).borderTopWidth}));
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
 for(const action of ['Rename','Archive','Delete'])for(const failure of [conflict,'already has an active writer','Fixture action failed']){
 actionFailure=failure;
 failAction=true;gate=new Promise(r=>release=r);
 const before=await input.boundingBox();const signature=await page.locator('#model-select').evaluate(e=>e.outerHTML);
 await row('Owned task').locator('summary').click();await row('Owned task').getByRole('button',{name:action,exact:true}).click();
 if(action==='Rename')await page.locator('#task-dialog-name').fill('New test task');
 if(action==='Rename'||action==='Delete')await page.locator('#task-dialog-submit').click();
 await page.getByText(action==='Rename'?'Renaming…':action==='Archive'?'Archiving…':'Deleting…',{exact:true}).waitFor();
 assert.deepEqual(await input.boundingBox(),before);assert.equal(await page.locator('#model-select').evaluate(e=>e.outerHTML),signature);
 assert(!(await page.locator('#composer').innerText()).includes('Switching'));
 release();gate=null;await row('Owned task').locator('.task-selection-error').waitFor();
 assert.equal(await row('Owned task').locator('.task-selection-error').textContent(),failure==='Fixture action failed'?failure:'Open elsewhere. Close it and retry.');
 assert.equal(await page.locator('.destination-error').count(),0);assert.equal(await input.inputValue(),'Stable action draft');
 }
 for(const answer of [null,'   ','Current task']){
 const before=calls.filter(c=>c==='/api/tasks').length;
 if(!await row('Current task').getByRole('button',{name:'Rename',exact:true}).isVisible())await row('Current task').locator('summary').click();await row('Current task').getByRole('button',{name:'Rename',exact:true}).click();
 assert.equal(await page.locator('#task-dialog-name').inputValue(),'Current task');
 if(answer===null)await page.locator('#task-dialog-cancel').click();
 else {await page.locator('#task-dialog-name').fill(answer);await page.locator('#task-dialog-submit').click();
 if(!answer.trim()){await page.locator('#task-dialog-error').getByText('Enter a task name up to 180 characters').waitFor();await page.keyboard.press('Escape');}}
 assert.equal(calls.filter(c=>c==='/api/tasks').length,before);
 }
 for(const cancel of ['button','escape']){
 const before=calls.filter(c=>c==='/api/tasks').length;
 if(!await row('Owned task').getByRole('button',{name:'Delete',exact:true}).isVisible())await row('Owned task').locator('summary').click();await row('Owned task').getByRole('button',{name:'Delete',exact:true}).click();
 await page.getByRole('heading',{name:'Delete Task',exact:true}).waitFor();
 assert.equal(await page.locator('#task-dialog-task-name').textContent(),'Owned task');
 await page.getByText('This permanently deletes its Codex conversation. Project files will not be deleted.',{exact:true}).waitFor();
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/delete-${width}.png`});
 if(cancel==='button')await page.locator('#task-dialog-cancel').click();else await page.keyboard.press('Escape');
 assert.equal(calls.filter(c=>c==='/api/tasks').length,before);
 }
 failAction=false;gate=new Promise(r=>release=r);
 await row('Current task').locator('summary').click();await row('Current task').getByRole('button',{name:'Rename',exact:true}).click();
 await page.locator('#task-dialog-name').fill('New test task');
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/rename-${width}.png`});
 await page.locator('#task-dialog-submit').click();
 await row('Current task').getByText('Renaming…',{exact:true}).waitFor();assert.equal(await page.getByText('Renaming…',{exact:true}).count(),1);
 release();gate=null;await page.waitForFunction(()=>document.querySelector('#destination-label').textContent.includes('New test task'));
 assert.equal(await page.locator('#destination-switcher').evaluate(e=>e.hidden),false);assert.equal(await input.inputValue(),'Stable action draft');
 task.name='Current task';await dismissTasks();await closed();await open();
 const machineToggle=page.locator('.machine-toggle').first();
 assert.equal(await machineToggle.getAttribute('aria-expanded'),'true');
 await machineToggle.click();assert.equal(await machineToggle.getAttribute('aria-expanded'),'false');
 assert.equal(await row('Current task').isVisible(),false);
 runtime.broadcast('task-status',{machineId:'local',threadId:'current',status:'idle'});
 await page.waitForTimeout(50);assert.equal(await machineToggle.getAttribute('aria-expanded'),'false');
 await page.getByRole('button',{name:'New task',exact:true}).first().click();await page.locator('#new-task-cancel').click();
 assert.equal(await machineToggle.getAttribute('aria-expanded'),'false');
 await machineToggle.focus();await page.keyboard.press('Enter');assert.equal(await row('Current task').isVisible(),true);
 await page.keyboard.press('Space');assert.equal(await machineToggle.getAttribute('aria-expanded'),'false');
 await page.locator('#destination-search').fill('Current');assert.equal(await row('Current task').isVisible(),true);
 await page.locator('#destination-search').fill('');
 assert.equal(await machineToggle.getAttribute('aria-expanded'),'false');
 await page.reload();await open();
 await input.fill('Stable action draft');
 assert.equal(await machineToggle.getAttribute('aria-expanded'),'false');
 await machineToggle.click();
 await page.getByRole('button',{name:'New task',exact:true}).last().click();
 assert.equal(await page.locator('#new-task-title').textContent(),'New Task on Second machine');
 assert.equal(await page.locator('#new-task-cwd').inputValue(),'');
 await page.locator('#new-task-cwd').fill('/unavailable');await page.locator('#new-task-cwd').blur();await page.getByText('Starting settings unavailable. Check the Project Folder and try again.',{exact:true}).waitFor();
 await page.locator('#new-task-cwd').fill('');await page.locator('#new-task-cwd').blur();await page.waitForFunction(()=>document.querySelector('#new-task-error').textContent==='');
 await page.locator('#new-task-model option[value="demo-model"]').waitFor({state:'attached'});
 await page.locator('#new-task-model').selectOption('demo-model');await page.locator('#new-task-effort').selectOption('high');await page.locator('#new-task-access').selectOption('auto');
 await page.locator('#new-task-cancel').click();
 failAction=true;
 gate=new Promise(r=>release=r);await page.getByRole('button',{name:'New task',exact:true}).first().click();
 await page.locator('#new-task-dialog').waitFor();assert.equal(await page.locator('label[for="new-task-cwd"]').textContent(),'Project Folder');assert.equal(await page.locator('#new-task-cwd').inputValue(),'/project');
 assert.equal(await page.locator('label[for="new-task-effort"]').textContent(),'Effort');
 const settingsGeometry=await page.locator('.new-task-settings').evaluate(e=>{
 const [model,effort,access]=[...e.children].map(c=>c.getBoundingClientRect());
 return {rowGap:getComputedStyle(e).rowGap,columnGap:getComputedStyle(e).columnGap,vertical:effort.top-model.bottom,horizontal:access.left-effort.right,aligned:effort.top===access.top};
 });
 assert.equal(settingsGeometry.rowGap,'12px');assert.equal(settingsGeometry.columnGap,'8px');
 if(width<=860){assert.equal(settingsGeometry.vertical,12);assert.equal(settingsGeometry.horizontal,8);assert(settingsGeometry.aligned);}
 await page.locator('#new-task-create').click();await page.getByText('Enter a task name up to 180 characters',{exact:true}).waitFor();
 await page.locator('#new-task-name').fill('New test task');await page.locator('#new-task-cwd').fill('relative/path');await page.locator('#new-task-create').click();
 await page.getByText('Enter an absolute project folder on this machine',{exact:true}).waitFor();
 await page.locator('#new-task-cwd').fill('/project');
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/new-task-${width}.png`});
 await page.locator('#new-task-create').click();await page.waitForFunction(()=>document.querySelector('.destination-group-heading .icon-button').disabled);assert.equal(await page.getByRole('button',{name:'New task',exact:true}).first().locator('svg').count(),1);assert(!(await page.locator('#composer').innerText()).includes('Switching'));release();gate=null;
 await page.locator('#new-task-error').getByText('Fixture action failed',{exact:true}).waitFor();
 assert(await page.locator('#new-task-error').evaluate(e=>e.getBoundingClientRect().bottom <= document.querySelector('#new-task-dialog .new-task-actions').getBoundingClientRect().top));assert(await page.locator('#new-task-dialog').evaluate(e=>e.open));assert.equal(await page.locator('.destination-error').count(),0);
 failAction=false;await page.locator('#new-task-cwd').fill('');await page.locator('#new-task-cwd').blur();await page.locator('#new-task-model option[value="demo-model"]').waitFor({state:'attached'});await page.locator('#new-task-model').selectOption('demo-model');await page.locator('#new-task-effort').selectOption('high');await page.locator('#new-task-access').selectOption('ask');await page.locator('#new-task-create').click();await page.waitForFunction(()=>!document.querySelector('#new-task-dialog').open);assert.equal(await input.evaluate(e=>document.activeElement===e),width>=1100);if(width>=1100){assert.equal(await page.locator('#destination-switcher').evaluate(e=>e.hidden),false);await dismissTasks();}await closed();assert.equal(await input.inputValue(),'');
 const createdSettings=calls.findLast(c=>c?.create).create;
 assert.deepEqual({model:createdSettings.model,effort:createdSettings.effort,access:createdSettings.access},{model:'demo-model',effort:'high',access:'ask'});
 await page.getByText('No conversation history yet.',{exact:true}).waitFor();
 await page.locator('#history-status').waitFor({state:'hidden'});
 await select('Current task');assert.equal(await input.inputValue(),'Stable action draft');
 // Terminal labels are observations, independent of the selected checkmark.
 await open();assert.equal(await row('Current task').locator('.destination-task-status').textContent(),'');
 const observe=async status=>{
 runtime.state.turn={id:'observed-turn',status,...(status==='interrupted'?{error:'Stopped by user'}:{})};runtime.state.phase=status==='inProgress'?'working':status==='failed'?'failed':status==='interrupted'?'stopped':'done';runtime.state.threadStatus=status==='inProgress'?'active':'idle';
 delete runtime.terminalResults[runtime.state.thread.id];
 runtime.broadcast('turn',{turn:runtime.state.turn,phase:runtime.state.phase,threadStatus:runtime.state.threadStatus});
 };
 await observe('completed');assert.equal(await row('Current task').locator('.destination-task-status').textContent(),'');
 await select('Draft task 0');await open();assert.equal(await row('Draft task 0').locator('.destination-task-status').textContent(),'');
 await observe('completed');assert.equal(await row('Draft task 0').locator('.destination-task-status').textContent(),'');
 assert.equal(await row('Current task').locator('.destination-task-status').textContent(),'');
 await select('Current task');await open();assert.equal(await row('Draft task 0').locator('.destination-task-status').textContent(),'');
 await observe('inProgress');await row('Current task').getByText('Working',{exact:true}).waitFor();
 runtime.state.phase='done';runtime.state.threadStatus='idle';runtime.broadcast('status',{phase:'done',threadStatus:'idle'});
 await page.waitForFunction(()=>document.querySelector('.destination-task[aria-current="true"] .destination-task-status').textContent==='');
 for(const [status,label] of [['failed','Failed'],['interrupted','Stopped']]){await observe(status);assert.equal(await row('Current task').locator('.destination-task-status').textContent(),'');}
 // Status broadcasts from another client invalidate a non-selected task's old Done.
 runtime.broadcast('task-status',{machineId:'local',threadId:'draft-0',status:'active'});
 await row('Draft task 0').getByText('Working',{exact:true}).waitFor();
 await observe('inProgress');await row('Current task').getByText('Working',{exact:true}).waitFor();
 assert.equal(await page.locator('.destination-task[aria-current="true"]').count(),1);
 assert.equal(await row('Draft task 0').locator('.destination-task').getAttribute('aria-current'),null);
 let finishStatusRefresh;navigationGate=new Promise(resolve=>finishStatusRefresh=resolve);
 await page.getByRole('button',{name:'Refresh tasks',exact:true}).click();
 runtime.broadcast('task-status',{machineId:'local',threadId:'draft-0',status:'active'});
 await page.waitForTimeout(30);finishStatusRefresh();navigationGate=null;
 await page.waitForFunction(()=>!document.querySelector('#destination-refresh').disabled);
 assert.equal(await row('Draft task 0').locator('.destination-task-status').textContent(),'Working');
 runtime.broadcast('task-status',{machineId:'local',threadId:'draft-0',status:'idle'});
 await page.waitForFunction(()=>[...document.querySelectorAll('.destination-entry')].find(e=>e.textContent.includes('Draft task 0')).querySelector('.destination-task-status').textContent==='');
 runtime.broadcast('task-status',{machineId:'ssh:test',threadId:'remote-owned',status:'active:waitingOnUserInput'});
 await row('Remote owned task').getByText('Waiting',{exact:true}).waitFor();
 runtime.state.turn=null;runtime.state.phase='done';runtime.state.threadStatus='idle';runtime.broadcast('snapshot',snapshot());await dismissTasks();await closed();
 // A read-only non-selected completion survives a full browser reload.
 const savedRpc=runtime.rpc;
 runtime.rpc={request:async(method,params)=>{assert.equal(method,'thread/turns/list');assert.equal(params.itemsView,'notLoaded');assert.equal(params.limit,1);return {data:[{status:params.threadId==='draft-1'?'completed':'interrupted'}]};}};
 for(const threadId of ['draft-1','draft-2'])for(const type of ['active','idle'])runtime.handleNotification({method:'thread/status/changed',params:{threadId,status:{type}}});
 await open();await row('Draft task 1').getByText('Done',{exact:true}).waitFor();await row('Draft task 2').getByText('Stopped',{exact:true}).waitFor();
 runtime.rpc=savedRpc;
 await page.reload();await open();await row('Draft task 1').getByText('Done',{exact:true}).waitFor();await row('Draft task 2').getByText('Stopped',{exact:true}).waitFor();
 assert.equal(await page.locator('.destination-task[aria-current="true"]').count(),1);await dismissTasks();await closed();
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
 const desktopId=JSON.stringify(['request_user_input_async',free.id,0]).replaceAll('"','\\"');
 runtime.handleNotification({method:'item/completed',params:{threadId:runtime.state.thread.id,turnId:'async-turn',item:{id:'desktop-live',type:'userMessage',content:[{type:'text',text:'<send_user_message_question_reply>'+JSON.stringify([{questionItemId:desktopId,question:free.questions[0].title,answer:'Your inventory is empty.'}])+'</send_user_message_question_reply>'}]}}});
 await page.waitForFunction(()=>!document.querySelector('[data-message-id="async-free"] .async-answer'));
 assert.equal(await freeMessage.locator('.message-body').innerText(),'What should the empty state say?');
 assert.equal(await page.locator('#conversation').getByText('Your inventory is empty.',{exact:true}).count(),1);
 assert.equal(await page.locator('#conversation').getByText('Answered:',{exact:false}).count(),0);
 // Async text uses the same saved Enter preference and composition guards as the composer.
 for(const preference of [true,false]) for(const submitKey of [preference?'Enter':'Control+Enter','Meta+Enter','button']) {
 const keyboardQuestion={...free,id:'keyboard-question'};
 runtime.state.liveMessages=[keyboardQuestion];asyncAnswers={};
 await page.evaluate(value=>localStorage.setItem('codex-pocket-enter-sends',JSON.stringify(value)),preference);
 await page.reload();const answer=page.locator('[data-message-id="keyboard-question"] textarea');await answer.waitFor();
 const before=calls.filter(c=>c==='/api/message').length;
 await answer.press(preference?'Enter':'Control+Enter');assert.equal(calls.filter(c=>c==='/api/message').length,before);
 await answer.fill('Keyboard answer');await answer.press('Shift+Enter');assert((await answer.inputValue()).includes('\n'));
 if(!preference){await answer.press('Enter');assert((await answer.inputValue()).endsWith('\n\n'));}
 for(const init of [{isComposing:true},{keyCode:229}])await answer.dispatchEvent('keydown',{key:'Enter',ctrlKey:true,...init});
 await answer.dispatchEvent('compositionstart');await answer.press('Control+Enter');await answer.dispatchEvent('compositionend');
 assert.equal(calls.filter(c=>c==='/api/message').length,before);
 await answer.fill('Keyboard answer');
 if(submitKey==='button')await page.locator('[data-message-id="keyboard-question"]').getByRole('button',{name:'Answer',exact:true}).click();else await answer.press(submitKey);
 await page.waitForFunction(()=>!document.querySelector('[data-message-id="keyboard-question"] .async-answer'));
 assert.equal(calls.filter(c=>c==='/api/message').length,before+1);
 }
 // Reconstruct through the real gateway normalizer, with no live answer cache.
 const items=[choice,free].map(m=>({...m,type:'agentMessage'}));
 items.push({id:'history-reply',type:'userMessage',createdAt:3000,content:[{type:'text',text:'<send_user_message_question_reply>'+JSON.stringify([
 {questionItemId:choice.id,question:choice.questions[0].title,answer:'Compact'},
 {questionItemId:desktopId,question:free.questions[0].title,answer:'Your inventory is empty.'}
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
 runtime.state.turn={id:'steer-turn',status:'inProgress'};runtime.state.phase='working';runtime.broadcast('snapshot',snapshot());
 runtime.state.queuedMessage={threadId:runtime.state.thread.id,text:'Check the loading screen.',createdAt:Date.now()};runtime.broadcast('queue',{queuedMessage:runtime.state.queuedMessage});
 let releaseSteer;messageGate=new Promise(resolve=>releaseSteer=resolve);
 await page.locator('#send-queue').click();
 assert.equal(await page.locator('#conversation').getByText('Check the loading screen.',{exact:true}).count(),0);
 releaseSteer();messageGate=null;
 await page.locator('#conversation').getByText('Check the loading screen.',{exact:true}).waitFor();
 const steerEcho={id:'steer-echo',role:'user',text:'Check the loading screen.',turnId:'steer-turn',createdAt:Date.now(),complete:true};
 runtime.state.liveMessages.push(steerEcho);runtime.broadcast('message',steerEcho);
 await page.waitForTimeout(100);
 assert.equal(await page.locator('#conversation').getByText('Check the loading screen.',{exact:true}).count(),1);
 runtime.broadcast('snapshot',snapshot());await page.waitForTimeout(100);
 assert.equal(await page.locator('#conversation').getByText('Check the loading screen.',{exact:true}).count(),1);
 messageUnknown=true;runtime.state.queuedMessage={threadId:runtime.state.thread.id,text:'Unconfirmed steer',createdAt:Date.now()};runtime.broadcast('queue',{queuedMessage:runtime.state.queuedMessage});await page.locator('#send-queue').click();
 await page.waitForFunction(()=>document.querySelector('#composer-status').textContent.includes('unconfirmed'));
 assert.equal(await page.locator('#conversation').getByText('Unconfirmed steer',{exact:true}).count(),0);
 messageUnknown=false;runtime.state.queuedMessage=null;runtime.broadcast('queue',{queuedMessage:null});await page.locator('#message-text').fill('');

 await page.reload();await page.waitForFunction(()=>document.querySelector('#destination-label').textContent.includes('Current task'));
 assert.equal(await page.locator('#conversation').getByText('Check the loading screen.',{exact:true}).count(),1);
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
 // A keyboard resize must preserve deliberate scrolling away after focus.
 await input.focus();await page.evaluate(()=>visualViewport.dispatchEvent(new Event('resize')));await page.waitForTimeout(100);await page.evaluate(()=>{const d=document.scrollingElement;window.scrollTo(0,d.scrollHeight-d.clientHeight-600);});await page.waitForTimeout(150);
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
 const rawUsage=`You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 17th, ${new Date().getFullYear()} 1:07 PM.`;
 runtime.state.turn.error=rawUsage;runtime.broadcast('turn',{turn:runtime.state.turn,phase:'failed',threadStatus:'idle'});
 await page.getByRole('link',{name:'Buy credits',exact:true}).waitFor();
 assert.equal(await page.locator('#composer-status').textContent(),'Usage limit reached. Try again Sep 17 at 1:07 PM. Buy credits');
 assert.equal(await page.getByRole('link',{name:'Buy credits',exact:true}).getAttribute('href'),'https://chatgpt.com/codex/settings/usage');
 assert.equal(runtime.state.turn.error,rawUsage);
 runtime.handleNotification({method:'turn/started',params:{threadId:'current',turn:{id:'next-turn',status:'inProgress'}}});
 await page.waitForFunction(()=>document.querySelector('#phase-pill').textContent==='Working');
 assert(!(await page.locator('#composer-status').textContent()).includes('Upstream capacity'));
 assert.equal(await page.getByRole('link',{name:'Buy credits',exact:true}).count(),0);
 // Finish the synthetic turn before checking idle-task archive/delete controls.
 Object.assign(runtime.state,{turn:{id:'next-turn',status:'completed'},phase:'done',threadStatus:'idle'});runtime.broadcast('turn',{turn:runtime.state.turn,phase:'done',threadStatus:'idle'});
 await open();
 assert.equal(await page.locator('.machine-host-badge').count(),1);
 assert.equal(await page.locator('.machine-host-badge').textContent(),'Host');
 assert.equal(await page.locator('.destination-group').last().locator('.machine-host-badge').count(),0);
 let releaseCatalog; navigationGate=new Promise(r=>releaseCatalog=r);
 const before=calls.filter(c=>c==='/api/navigation').length;
 await page.locator('#destination-refresh').click();
 await page.waitForFunction(()=>document.querySelector('#destination-refresh').disabled);
 // Refresh only disables Refresh; navigation and task actions remain available.
 assert.equal(await page.locator('.destination-task').first().isEnabled(),true);
 assert.equal(await page.locator('.destination-group-heading .icon-button').first().isEnabled(),true);
 await page.locator('.task-actions summary').first().click();
 for(const label of ['Rename','Archive','Delete'])assert.equal(await page.locator('.task-actions[open]').getByRole('button',{name:label,exact:true}).isEnabled(),true);
 await page.locator('.task-actions summary').first().click();
 assert.equal(await page.locator('#destination-refresh').getAttribute('aria-label'),'Refresh tasks');
 assert.equal(await page.locator('#destination-refresh').getAttribute('title'),'Refresh tasks');
 assert.equal(await page.locator('#destination-refresh svg').evaluate(e=>getComputedStyle(e).animationName),'refresh-spin');
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await page.locator('#destination-refresh svg').evaluate(e=>getComputedStyle(e).animationName),'none');
 await page.emulateMedia({reducedMotion:'no-preference'});
 catalogAvailable=false;remoteConnected=false;releaseCatalog();navigationGate=null;
 await page.waitForFunction(()=>!document.querySelector('#destination-refresh').disabled);
 assert.equal(calls.filter(c=>c==='/api/navigation').length,before+1);
 assert.equal(await page.locator('.destination-group.unavailable').getByText('Tasks Unavailable',{exact:true}).count(),1);
 assert.equal(await page.locator('.destination-group.offline').getByText('Offline',{exact:true}).count(),1);
 assert.equal(await page.locator('.destination-group.offline button[title="New task"]').isDisabled(),true);
 assert.equal(await page.locator('.destination-group.unavailable button[title="New task"]').isEnabled(),true);
 runtime.broadcast('machines',{machines:[{...runtime.machineSummary(),connected:false}]});
 await page.waitForFunction(()=>document.querySelectorAll('.destination-group.offline').length===2);
 assert.equal(await page.locator('.destination-group.unavailable').count(),0);
 assert.equal(await page.locator('.destination-group.offline button[title="New task"]').first().isDisabled(),true);
 runtime.broadcast('machines',{machines:[runtime.machineSummary()]});
 await page.locator('.destination-group.unavailable').waitFor();
 catalogAvailable=true;remoteConnected=true;
 await page.locator('#show-archived').check();await page.waitForFunction(()=>!document.querySelector('#destination-refresh').disabled);
 assert(await page.locator('#show-archived').isChecked());
 assert(await page.locator('.tasks-archived').evaluate(e=>{const a=e.getBoundingClientRect(),r=document.querySelector('#destination-refresh').getBoundingClientRect();return Math.abs(r.left-a.right-8)<1;}));
 assert(await page.locator('.destination-switcher-head').evaluate(e=>{const r=e.getBoundingClientRect();return [...e.children].every(c=>{const b=c.getBoundingClientRect();return !b.width||(b.left>=r.left&&b.right<=r.right&&b.top>=r.top&&b.bottom<=r.bottom);});}));
 const archivedBefore=calls.filter(c=>c==='?archived=true').length;
 await page.locator('#destination-refresh').click();await page.waitForFunction(()=>!document.querySelector('#destination-refresh').disabled);
 assert.equal(calls.filter(c=>c==='?archived=true').length,archivedBefore+1);
 await row('Old task').locator('summary').click();await row('Old task').getByRole('button',{name:'Unarchive',exact:true}).click();
 await row('Old task').waitFor({state:'detached'});assert(calls.includes('unarchive'));
 await page.locator('#show-archived').uncheck();await page.waitForFunction(()=>!document.querySelector('#destination-refresh').disabled);
 await row('Old task').waitFor();assert.equal(await page.locator('#show-archived').isChecked(),false);
 await row('Old task').locator('summary').click();await row('Old task').getByRole('button',{name:'Archive',exact:true}).click();
 await row('Old task').waitFor({state:'detached'});
 await page.locator('#show-archived').check();await row('Old task').waitFor();
 await page.locator('#show-archived').uncheck();await row('Old task').waitFor({state:'detached'});
 await page.waitForFunction(()=>!document.querySelector('#destination-refresh').disabled);
 await page.locator('#show-archived').check();await row('Old task').waitFor();
 await row('Old task').locator('summary').click();await row('Old task').getByRole('button',{name:'Delete',exact:true}).click();
 const deletes=calls.filter(c=>c==='delete').length;
 await page.locator('#task-dialog-submit').click();await row('Old task').waitFor({state:'detached'});
 assert.equal(calls.filter(c=>c==='delete').length,deletes+1);
 archived.push({...task,id:'old',name:'Old task',archived:true});
 await page.locator('#show-archived').uncheck();await page.waitForFunction(()=>!document.querySelector('#destination-refresh').disabled);
 if(width===390){
 navigationGate=new Promise(r=>releaseCatalog=r);
 const started=Date.now();await page.locator('#destination-refresh').click();
 await page.waitForFunction(()=>!document.querySelector('#destination-refresh').disabled,{},{timeout:9_000});
 assert(Date.now()-started<9_000);
 assert.equal(await page.locator('.destination-group.unavailable').count(),0); // Keep the last successful action-refreshed catalog on HTTP failure.
 releaseCatalog();navigationGate=null;
 await page.locator('#destination-refresh').click();await page.waitForFunction(()=>!document.querySelector('#destination-refresh').disabled);
 }
 await page.mouse.move(0,0);
 assert(await page.locator('.destination-group-heading .icon-button').evaluateAll(buttons=>buttons.every(button=>{
 const rect=button.getBoundingClientRect(),icon=button.querySelector('svg').getBoundingClientRect(),style=getComputedStyle(button);
 return button.getAttribute('aria-label')==='New task'&&button.title==='New task'&&rect.width===36&&rect.height===36
   &&style.borderTopWidth==='0px'&&style.backgroundColor==='rgba(0, 0, 0, 0)'
   &&Math.abs(rect.x+18-icon.x-icon.width/2)<1&&Math.abs(rect.y+18-icon.y-icon.height/2)<1;
 })));
 // The newer successful archived read restored connectivity even though active catalog data is cached.
 assert.equal(await page.locator('.destination-group.offline').count(),0);
 assert.equal(await page.locator('.destination-group-heading .icon-button').last().isEnabled(),true);
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
 // Small upward transcript scroll stops streaming follow even inside the proximity threshold.
 for(const width of [1280,390,320]){
 await page.setViewportSize({width,height:844});historyFixture=null;
 const message={id:'manual-follow',role:'assistant',text:'Streaming paragraph.\n\n'.repeat(100),complete:false,createdAt:Date.now()};
 Object.assign(runtime.state,{machineId:'local',thread:task,turn:{id:'stream',status:'inProgress'},phase:'working',goal:null,pending:[],queuedMessage:null,liveMessages:[message],activities:[]});
 await page.evaluate(()=>localStorage.setItem('codex-pocket-details-open','false'));await page.reload();await page.locator('[data-message-id="manual-follow"]').waitFor();
 const settled=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))));
 const scroll=()=>page.evaluate(()=>{const s=innerWidth<=860?document.scrollingElement:document.querySelector('#conversation');return {top:s.scrollTop,distance:s.scrollHeight-s.clientHeight-s.scrollTop};});
 await settled();assert((await scroll()).distance<3);
 const move=async(delta)=>{
 const box=await page.locator('[data-message-id="manual-follow"]').boundingBox();
 await page.mouse.move(Math.min(width-40,box.x+box.width/2),350);
 await page.mouse.wheel(0,delta);await page.waitForTimeout(100);await settled();
 };
 const append=async()=>{
 const delta='Another streamed paragraph.\n\n'.repeat(4);message.text+=delta;
 runtime.broadcast('assistant_delta',{id:message.id,delta});
 await page.waitForFunction(count=>document.querySelector('[data-message-id="manual-follow"]').textContent.split('Another streamed paragraph.').length-1===count,message.text.split('Another streamed paragraph.').length-1);
 await page.waitForTimeout(100);await settled();
 };
 await move(-35);const reading=await scroll();assert(reading.distance>0&&reading.distance<200,JSON.stringify({width,reading}));
 for(let i=0;i<3;i++){await append();assert(Math.abs((await scroll()).top-reading.top)<2,JSON.stringify({width,reading,after:await scroll()}));}
 await move(10000);assert((await scroll()).distance<3);await append();assert((await scroll()).distance<3);
 await move(-350);await page.locator('#jump-latest').click();
 await page.waitForFunction(()=>{const s=innerWidth<=860?document.scrollingElement:document.querySelector('#conversation');return s.scrollHeight-s.clientHeight-s.scrollTop<3;});
 await append();assert((await scroll()).distance<3);
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/stream-follow-${width}.png`});
 }
 // Deferred-name failure is visible without disabling message input, and clears on success.
 for(const width of [1280,390]){
 await page.setViewportSize({width,height:844});
 Object.assign(runtime.state,{machineId:'local',thread:{...task},turn:null,phase:'done',goal:null,pending:[],queuedMessage:null,liveMessages:[],activities:[]});
 const priorRpc=runtime.rpc;
 runtime.pendingTaskNames.set(task.id,{name:'Requested task name',firstMessageAccepted:true});
 runtime.rpc={request:async()=>{throw new Error('Temporary naming failure');}};
 await runtime.savePendingTaskName(task.id,'name-first');
 await page.evaluate(()=>localStorage.setItem('codex-pocket-details-open','false'));await page.reload();await page.locator('#composer-status').waitFor();
 assert.match(await page.locator('#composer-status').textContent(),/Task name could not be saved/);
 await page.locator('#message-text').fill('Next real message');assert(await page.locator('#send-message').isEnabled());
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/name-warning-${width}.png`});
 runtime.rpc={request:async()=>({})};await runtime.savePendingTaskName(task.id,'name-next');
 await page.waitForFunction(()=>document.querySelector('#composer-status').hidden);
 assert.equal(runtime.pendingTaskNames.has(task.id),false);runtime.rpc=priorRpc;
 }
 // Expand control uses the existing action rail without consuming textarea width.
 for(const width of [1280,390,320]){
 await page.setViewportSize({width,height:844});
 Object.assign(runtime.state,{machineId:'local',thread:task,turn:null,phase:'done',goal:null,pending:[],queuedMessage:null,liveMessages:[],activities:[]});
 await page.evaluate(()=>localStorage.setItem('codex-pocket-details-open','false'));await page.reload();await page.locator('#message-text').fill('Overflowing composer line with enough text to wrap.\n'.repeat(30));
 const geometry=await page.locator('#message-text').evaluate(e=>{
 const r=e.getBoundingClientRect(),b=document.querySelector('#expand-composer').getBoundingClientRect(),rail=document.querySelector('.composer-actions').getBoundingClientRect(),style=getComputedStyle(e),gap=parseFloat(getComputedStyle(document.querySelector('#composer')).columnGap);
 return {overflow:e.scrollHeight>e.clientHeight,outside:b.left>=r.right,gap:b.left-r.right,gridGap:gap,inRail:b.left>=rail.left&&b.right<=rail.right,aboveActions:b.bottom<=rail.top,insideComposer:b.top>=document.querySelector('.composer-zone').getBoundingClientRect().top,padding:style.paddingRight,width:b.width,height:b.height,horizontal:document.documentElement.scrollWidth>innerWidth,gutterTarget:document.elementFromPoint(r.right-5,r.top+15)===e};
 });
 assert(geometry.gutterTarget);assert(geometry.overflow);assert(geometry.outside,JSON.stringify({width,geometry}));assert.equal(geometry.gap,geometry.gridGap);assert(geometry.inRail);assert(geometry.aboveActions);assert(geometry.insideComposer);assert.equal(geometry.padding,'11px');assert.equal(geometry.width,32);assert.equal(geometry.height,32);assert(!geometry.horizontal);
 await page.locator('#message-text').evaluate(e=>e.scrollTop=0);
 const r=await page.locator('#message-text').boundingBox();await page.mouse.move(r.x+r.width-5,r.y+20);await page.mouse.wheel(0,150);await page.waitForTimeout(100);
 assert(await page.locator('#message-text').evaluate(e=>e.scrollTop>0));
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/composer-scrollbar-${width}.png`});
 const toggleStable=async()=>{
 const positions=await page.evaluate(async()=>{
 const read=()=>['#attach-image','#send-message'].map(id=>document.querySelector(id).getBoundingClientRect().y);
 const frames=[read()];document.querySelector('#expand-composer').click();frames.push(read());
 for(let i=0;i<12;i++){await new Promise(requestAnimationFrame);frames.push(read());}return frames;
 });
 for(const frame of positions)frame.forEach((y,i)=>assert(Math.abs(y-positions[0][i])<1,JSON.stringify({width,positions})));
 };
 const appearance=await page.locator('#expand-composer').evaluate(e=>({background:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color,attachmentColor:getComputedStyle(document.querySelector('#attach-image')).color}));
 assert.equal(appearance.background,'rgba(0, 0, 0, 0)');assert.equal(appearance.color,appearance.attachmentColor);
 await toggleStable();
 const fullscreen=await page.locator('#expand-composer').evaluate(e=>({right:getComputedStyle(e).right,width:e.getBoundingClientRect().width,padding:getComputedStyle(document.querySelector('#message-text')).paddingRight}));
 assert.deepEqual(fullscreen,{right:'4px',width:32,padding:'44px'});
 await toggleStable();
 const textareaWidth=await page.locator('#message-text').evaluate(e=>e.getBoundingClientRect().width);
 await page.locator('#message-text').fill('First line\nSecond line');
 assert(await page.locator('#expand-composer').isHidden(),'short multiline drafts hide the expand control instead of moving it above the composer');
 assert.equal(await page.locator('#message-text').evaluate(e=>e.getBoundingClientRect().width),textareaWidth);
 assert(await page.locator('#message-text').evaluate(e=>e.getBoundingClientRect().height<80),'short drafts retain their natural height');
 await page.locator('#message-text').fill('Long draft\n'.repeat(10));await toggleStable();
 await page.locator('#message-text').fill('');assert(await page.locator('#expand-composer').isVisible(),'Fullscreen Exit stays available even for an empty draft');
 await toggleStable();
 await page.locator('#message-text').fill('First line\nSecond line');
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/composer-short-${width}.png`});
 }
 // Composer surface growth/shrink follows latest only while follow mode is enabled.
 for(const width of [1280,390]){
 await page.setViewportSize({width,height:844});historyFixture=null;
 Object.assign(runtime.state,{machineId:'local',thread:task,turn:null,phase:'done',goal:null,pending:[],queuedMessage:null,liveMessages:[{id:'composer-resize-scroll',role:'assistant',text:'Transcript content.\n\n'.repeat(100),complete:true,createdAt:Date.now()}],activities:[]});
 await page.reload();await page.locator('[data-message-id="composer-resize-scroll"]').waitFor();
 const settled=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))));
 const scroll=()=>page.evaluate(()=>{const s=innerWidth<=860?document.scrollingElement:document.querySelector('#conversation');return {top:s.scrollTop,distance:s.scrollHeight-s.clientHeight-s.scrollTop};});
 const bottom=async()=>{await settled();assert((await scroll()).distance<3,JSON.stringify({width,...await scroll()}));};
 const goal=async(show)=>{
 runtime.state.goal=show?{objective:'Keep the current task moving',status:'active',timeUsedSeconds:125}:null;
 runtime.broadcast('goal',{machineId:'local',threadId:task.id,goal:runtime.state.goal});
 await page.waitForFunction(show=>document.querySelector('#goal-strip').hidden!==show,show);await settled();
 };
 const queue=async(show)=>{
 runtime.state.queuedMessage=show?{threadId:task.id,text:'The queued next message',createdAt:Date.now()}:null;
 runtime.broadcast('queue',{queuedMessage:runtime.state.queuedMessage});
 await page.waitForFunction(show=>document.querySelector('#queue-banner').hidden!==show,show);await settled();
 };
 await bottom();await goal(true);await bottom();await queue(true);await bottom();
 const geometry=await page.locator('#goal-strip, #queue-banner').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return [r.width,r.height,getComputedStyle(e).padding];}));
 assert.deepEqual(geometry[0],geometry[1]);
 assert.deepEqual(await page.evaluate(()=>{const g=document.querySelector('#goal-strip').getBoundingClientRect(),q=document.querySelector('#queue-banner').getBoundingClientRect(),c=document.querySelector('#composer').getBoundingClientRect();return [q.top-g.bottom,c.top-q.bottom];}),[8,8]);
 await queue(false);await bottom();await goal(false);await bottom();
 // A large attention surface can exceed the near-bottom threshold in one resize.
 runtime.state.pending=[{id:'resize-attention',kind:'permission',supported:true,label:'An attention request with details. '.repeat(150)}];runtime.broadcast('request',{pending:runtime.state.pending});
 await page.locator('#attention-banner').waitFor();await bottom();
 runtime.state.pending=[];runtime.broadcast('request',{pending:[]});await page.waitForFunction(()=>document.querySelector('#attention-banner').hidden);await bottom();

 await page.evaluate(()=>{const s=innerWidth<=860?document.scrollingElement:document.querySelector('#conversation');s.scrollTop-=650;});
 await page.locator('#jump-latest').waitFor();await settled();const preserved=(await scroll()).top;
 for(const [change,show] of [[goal,true],[queue,true],[queue,false],[goal,false]]){
 await change(show);assert(Math.abs((await scroll()).top-preserved)<1,JSON.stringify({width,preserved,...await scroll()}));
 }
 await page.locator('#jump-latest').click();
 await page.waitForFunction(()=>{const s=innerWidth<=860?document.scrollingElement:document.querySelector('#conversation');return s.scrollHeight-s.clientHeight-s.scrollTop<3;});
 await goal(true);await bottom();await queue(true);await bottom();await queue(false);await goal(false);await bottom();
 }
 // Only main-composer mobile focus follows latest; keyboard resize preserves it.
 for(const width of [390,1280]){
 await page.setViewportSize({width,height:844});
 Object.assign(runtime.state,{machineId:'local',thread:task,turn:null,phase:'done',pending:[],queuedMessage:null,liveMessages:[{id:'focus-scroll',role:'assistant',text:'Progress update.\n\n'.repeat(100),complete:true,createdAt:Date.now()}]});
 await page.reload();await page.locator('[data-message-id="focus-scroll"]').waitFor();
 await page.evaluate(()=>{const s=innerWidth<=860?document.scrollingElement:document.querySelector('#conversation');s.scrollTop=s.scrollHeight-s.clientHeight-600;});await page.waitForTimeout(150);
 const before=await page.evaluate(()=>(innerWidth<=860?document.scrollingElement:document.querySelector('#conversation')).scrollTop);
 await page.locator('#message-text').evaluate(e=>e.focus({preventScroll:true}));
 if(width===390){
 await page.waitForFunction(()=>document.scrollingElement.scrollHeight-document.scrollingElement.clientHeight-scrollY<3);
 await page.setViewportSize({width,height:500});
 await page.waitForTimeout(150);
 assert(await page.evaluate(()=>document.scrollingElement.scrollHeight-document.scrollingElement.clientHeight-scrollY<3));
 await page.evaluate(()=>{document.scrollingElement.scrollTop-=600;});await page.waitForTimeout(150);
 const top=await page.evaluate(()=>scrollY);
 await page.evaluate(()=>visualViewport.dispatchEvent(new Event('resize')));await page.waitForTimeout(100);
 assert(Math.abs(await page.evaluate(()=>scrollY)-top)<3);
 await page.setViewportSize({width,height:844});await page.waitForTimeout(100);
 await page.evaluate(()=>{document.scrollingElement.scrollTop-=600;});await page.waitForTimeout(100);
 await page.setViewportSize({width,height:500});await page.waitForTimeout(150);
 assert(await page.evaluate(()=>document.scrollingElement.scrollHeight-document.scrollingElement.clientHeight-scrollY<3));
 } else assert(Math.abs(await page.locator('#conversation').evaluate(e=>e.scrollTop)-before)<3);
 }
 // Confirmed sends follow latest from a deliberately scrolled-up transcript.
 for(const width of [390,1280]) for(const outcome of ['success','reject','unknown','recovered']){
 await page.setViewportSize({width,height:844});
 Object.assign(runtime.state,{machineId:'local',thread:task,turn:null,phase:'done',pending:[],queuedMessage:null,liveMessages:[{id:'scroll-send',role:'assistant',text:'A useful progress update.\n\n'.repeat(100),complete:true,createdAt:Date.now()}]});
 composerPost=outcome==='success'?'success':outcome==='reject'?'reject':'lost';recoveryMode=outcome==='unknown'||outcome==='recovered'?'unreachable':null;
 await page.reload();await page.locator('[data-message-id="scroll-send"]').waitFor();
 await page.locator('#message-text').fill('Check the next step');
 await page.evaluate(()=>{document.activeElement?.blur();const s=innerWidth<=860?document.scrollingElement:document.querySelector('#conversation');s.scrollTop=s.scrollHeight-s.clientHeight-600;});await page.waitForTimeout(180);
 const top=await page.evaluate(()=>(innerWidth<=860?document.scrollingElement:document.querySelector('#conversation')).scrollTop);
 await page.locator('#composer').evaluate(form=>form.requestSubmit());
 if(outcome==='success')await page.waitForFunction(()=>document.querySelector('#message-text').value==='');
 else if(outcome==='reject')await page.getByText('Send rejected',{exact:true}).waitFor();
 else await page.getByText('Connection lost; delivery could not be confirmed. Check the task before sending again.',{exact:true}).waitFor();
 if(outcome!=='success'){
 await page.waitForTimeout(150);
 assert(Math.abs(await page.evaluate(()=>(innerWidth<=860?document.scrollingElement:document.querySelector('#conversation')).scrollTop)-top)<3);
 }
 if(outcome==='recovered'){recoveryMode='accepted';for(const client of [...eventClients])client.end();}
 if(outcome==='success'||outcome==='recovered')await page.waitForFunction(()=>{const s=innerWidth<=860?document.scrollingElement:document.querySelector('#conversation');return s.scrollHeight-s.clientHeight-s.scrollTop<3;});
 if(outcome==='success'||outcome==='recovered'){
 await page.getByText('Check the next step',{exact:true}).waitFor();
 runtime.broadcast('message',{id:'start-echo',role:'user',text:'Check the next step',turnId:'accepted-start-turn',createdAt:Date.now(),complete:true});
 await page.locator('[data-message-id="start-echo"]').waitFor();
 assert.equal(await page.getByText('Check the next step',{exact:true}).count(),1);
 }else assert.equal(await page.locator('[data-message-id^="confirmed-steer-"]').count(),0);

 }
 // Fullscreen collapses only on confirmed Start/Queue/Steer, including receipt recovery.
 for(const width of [390,1280]){
 await page.setViewportSize({width,height:844});
 Object.assign(runtime.state,{machineId:'local',thread:task,turn:null,phase:'done',pending:[],queuedMessage:null,liveMessages:[]});
 composerPost='success';recoveryMode=null;await page.reload();
 await page.waitForFunction(()=>document.querySelector('#destination-label').textContent.includes('Current task'));
 const expand=async()=>{
 await page.locator('#message-text').fill('Composer test\n'.repeat(8));
 await page.locator('#expand-composer').click();
 assert.equal(await page.locator('#expand-composer').getAttribute('aria-expanded'),'true');
 };
 const collapsed=()=>page.waitForFunction(()=>document.querySelector('#expand-composer').getAttribute('aria-expanded')==='false');
 for(const action of ['start','queue','steer']){
 runtime.state.turn=action==='start'?null:{id:'composer-turn',status:'inProgress'};
 runtime.state.queuedMessage=null;runtime.broadcast('snapshot',snapshot());
 await expand();
 if(action==='steer'){
 runtime.state.queuedMessage={threadId:task.id,text:'Steer from fullscreen',createdAt:Date.now()};runtime.broadcast('queue',{queuedMessage:runtime.state.queuedMessage});
 await page.locator('#send-queue').click();
 }else await page.locator('#send-message').click();
 await collapsed();runtime.state.queuedMessage=null;runtime.broadcast('queue',{queuedMessage:null});
 }
 await expand();await page.locator('#message-text').fill('');
 await page.locator('#send-message').click();
 await page.waitForFunction(()=>!document.querySelector('#composer-status').textContent.includes('Stopping'));
 assert.equal(await page.locator('#expand-composer').getAttribute('aria-expanded'),'true');
 await page.locator('#expand-composer').click();
 runtime.state.turn=null;runtime.broadcast('snapshot',snapshot());composerPost='reject';
 await expand();await page.locator('#send-message').click();
 await page.getByText('Send rejected',{exact:true}).waitFor();
 assert.equal(await page.locator('#expand-composer').getAttribute('aria-expanded'),'true');
 await page.locator('#expand-composer').click();
 // Initial lost-response recovery cannot connect; SSE reconnect later checks the same receipt.
 for(const outcome of ['accepted','unknown','rejected']){
 composerPost='lost';recoveryMode='unreachable';
 await expand();
 const postsBefore=calls.filter(c=>c==='/api/message').length;
 await page.locator('#send-message').click();
 await page.waitForFunction(()=>document.querySelector('#composer-status').textContent.startsWith('Connection lost;'));
 assert.equal(await page.locator('#expand-composer').getAttribute('aria-expanded'),'true');
 // Let the first automatic SSE reconnect also fail its read before restoring the gateway.
 await page.waitForTimeout(200);
 recoveryMode=outcome;
 for(const client of eventClients)client.end();
 if(outcome==='accepted'){
 await collapsed();assert.equal(await page.locator('#composer-status').textContent(),'');
 }else{
 const warning=outcome==='unknown'?'Delivery unconfirmed. Check the task before sending again.':'Upstream rejected this message';
 await page.getByText(warning,{exact:true}).waitFor();
 assert.equal(await page.locator('#expand-composer').getAttribute('aria-expanded'),'true');
 await page.locator('#expand-composer').click();
 }
 assert.equal(calls.filter(c=>c==='/api/message').length,postsBefore+1);
 }
 // Rejected text drafts return only if the cleared composer was never edited.
 for(const action of ['start','queue'])for(const edit of ['untouched','new text','typed then cleared']){
 runtime.state.turn=action==='start'?null:{id:'draft-turn',status:'inProgress'};
 runtime.state.queuedMessage=null;runtime.broadcast('snapshot',snapshot());
 composerPost='lost';recoveryMode='unreachable';
 const original=`Rejected ${action} draft`;
 await page.locator('#message-text').fill(original);await page.locator('#send-message').click();
 await page.waitForFunction(()=>document.querySelector('#composer-status').textContent.startsWith('Connection lost;'));
 assert.equal(await page.locator('#message-text').inputValue(),'');
 if(edit!=='untouched')await page.locator('#message-text').fill('Replacement draft');
 if(edit==='typed then cleared')await page.locator('#message-text').fill('');
 await page.waitForTimeout(200);recoveryMode='rejected';
 for(const client of eventClients)client.end();
 await page.getByText('Upstream rejected this message',{exact:true}).waitFor();
 assert.equal(await page.locator('#message-text').inputValue(),edit==='untouched'?original:edit==='new text'?'Replacement draft':'');
 }
 runtime.state.turn=null;runtime.state.queuedMessage=null;runtime.broadcast('snapshot',snapshot());
 // A successful initial lost-response recovery also collapses immediately.
 recoveryMode='accepted';await expand();await page.locator('#send-message').click();await collapsed();
 composerPost='success';recoveryMode=null;
 }
 // Headless catalogs contain only SSH runtimes, and their settings omit the host-name field.
 settings.headless=true;runtime.state.machineId='ssh:test';
 for(const width of [390,1280]){
 await page.setViewportSize({width,height:844});await page.reload();
 await open();await page.locator('.destination-group').waitFor();
 assert.equal(await page.locator('.destination-group').count(),1);
 assert.equal(await page.locator('.machine-host-badge').count(),0);
 await settingsOpen();
 assert.equal(await page.locator('#settings-local-machine').isVisible(),false);
 assert.equal(await page.getByLabel('Host Machine Display Name',{exact:true}).isVisible(),false);
 await page.locator('#settings-close').click();
 }
 // Near-top pagination is independent of the near-bottom follow threshold.
 settings.headless=false;composerPost='success';recoveryMode=null;
 for(const width of [390,1280]){
 await page.setViewportSize({width,height:844});
 Object.assign(runtime.state,{machineId:'local',thread:task,turn:null,phase:'done',liveMessages:[],activities:[],pending:[]});
 historyFixture={machineId:'local',threadId:task.id,turns:[{id:'short',messages:[{id:'short-message',role:'assistant',text:'Recent content',complete:true}],activities:[]}],nextCursor:'older'};
 await page.reload();await page.locator('[data-message-id="short-message"]').waitFor();
 await page.evaluate(()=>{
 const scroller=innerWidth<=860?document.scrollingElement:document.querySelector('#conversation');
 const m=document.querySelector('[data-message-id="short-message"]');
 m.style.minHeight=`${scroller.clientHeight+150}px`;
 scroller.scrollTop=scroller.scrollHeight;
 });
 await page.waitForTimeout(100);
 const before=calls.filter(c=>c==='/api/history').length;
 await page.evaluate(()=>{const s=innerWidth<=860?document.scrollingElement:document.querySelector('#conversation');s.scrollTop=145;});
 await page.waitForTimeout(100);
 assert.equal(calls.filter(c=>c==='/api/history').length,before);
 // Make the full scroll range exactly 180px, then scroll to the top while still near bottom.
 await page.evaluate(()=>{
 const s=innerWidth<=860?document.scrollingElement:document.querySelector('#conversation');
 const m=document.querySelector('[data-message-id="short-message"]');
 m.style.minHeight=`${m.getBoundingClientRect().height-(s.scrollHeight-s.clientHeight)+180}px`;
 });
 const overflow=await page.evaluate(()=>{const s=innerWidth<=860?document.scrollingElement:document.querySelector('#conversation');return s.scrollHeight-s.clientHeight;});
 assert(overflow>0&&overflow<200,`short scroll range: ${overflow}`);
 historyFixture={machineId:'local',threadId:task.id,turns:[{id:'older',messages:[{id:'older-message',role:'assistant',text:'Earlier history',complete:true}],activities:[]}],nextCursor:null};
 await page.evaluate(()=>{const s=innerWidth<=860?document.scrollingElement:document.querySelector('#conversation');s.scrollTop=0;});
 await page.locator('[data-message-id="older-message"]').waitFor();
 assert(calls.filter(c=>c==='/api/history').length>before);
 }
 historyFixture=null;
 // Transcript selections clamp escaped endpoints at every width; composer-owned selections still work.
 for(const width of [1280,860,390,320]){
 await page.setViewportSize({width,height:844});
 historyFixture={machineId:'local',threadId:task.id,turns:[{id:'clamp-turn',messages:[{id:'clamp-message',role:'assistant',text:'Select this transcript text.',complete:true}],activities:[]}],nextCursor:null};
 await page.reload();await page.locator('[data-message-id="clamp-message"] .message-body p').waitFor();
 for(const target of ['#message-text','.topbar']){
 const result=await page.evaluate(target=>{
  const transcript=document.querySelector('#conversation');
  const text=document.querySelector('[data-message-id="clamp-message"] .message-body p').firstChild;
  const endpoint=document.querySelector(target);
  const selection=getSelection();
  selection.setBaseAndExtent(text,2,text,8);
  selection.extend(endpoint,0);
  document.dispatchEvent(new Event('selectionchange'));
  return {anchorPreserved:selection.anchorNode===text&&selection.anchorOffset===2,
   inside:transcript.contains(selection.focusNode),offset:selection.focusOffset,
   boundary:target==='#message-text'?transcript.childNodes.length:0,collapsed:selection.isCollapsed};
 },target);
 assert.equal(result.anchorPreserved,true);
 assert.equal(result.collapsed,false);
 assert.equal(result.inside,true);
 assert.equal(result.offset,result.boundary);
 }
 await page.evaluate(()=>{getSelection().removeAllRanges();document.dispatchEvent(new Event('selectionchange'));});
 await input.fill('Intentional composer selection');await input.click();
 await input.evaluate(e=>e.setSelectionRange(0,11));
 await page.waitForTimeout(50);
 assert.deepEqual(await input.evaluate(e=>({focused:document.activeElement===e,text:e.value.slice(e.selectionStart,e.selectionEnd)})),{focused:true,text:'Intentional'});
 await page.keyboard.type('Normal');assert.equal(await input.inputValue(),'Normal composer selection');
 await input.fill('');
 }
 historyFixture=null;
 // A held desktop transcript drag excludes the composer, then restores it immediately on release.
 await page.setViewportSize({width:1280,height:844});
 historyFixture={machineId:'local',threadId:task.id,turns:[{id:'drag-turn',messages:[{id:'drag-message',role:'assistant',text:'Drag this transcript selection toward the composer.',complete:true}],activities:[]}],nextCursor:null};
 await page.reload();await page.locator('[data-message-id="drag-message"] .message-body p').waitFor();
 if(await page.locator('#destination-button').getAttribute('aria-expanded')==='true'){await dismissTasks();await closed();await page.waitForTimeout(210);}
 const dragText=await page.locator('[data-message-id="drag-message"] .message-body p').boundingBox();
 const composer=await input.boundingBox();
 const composerInert=()=>page.locator('.composer-zone').evaluate(e=>e.inert);
 await input.focus();
 await page.mouse.move(dragText.x+5,dragText.y+dragText.height/2);await page.mouse.down();
 await page.mouse.move(dragText.x+100,dragText.y+dragText.height/2,{steps:5});
 for(const offset of [4,12,6]){
 await page.mouse.move(composer.x+composer.width-offset,composer.y+composer.height/2,{steps:5});
 assert.equal(await composerInert(),true);
 assert.equal(await input.evaluate(e=>{const box=e.getBoundingClientRect();return !document.elementFromPoint(box.right-8,box.y+box.height/2)?.closest('.composer-zone');}),true);
 await page.waitForFunction(()=>{const s=getSelection(),c=document.querySelector('#conversation');return !s.isCollapsed&&c.contains(s.anchorNode)&&c.contains(s.focusNode);});
 }
 await page.mouse.up();assert.equal(await composerInert(),false);
 for(const type of ['pointercancel','mouseup','blur']){
 await page.mouse.move(dragText.x+5,dragText.y+dragText.height/2);await page.mouse.down();
 assert.equal(await composerInert(),true);
 await page.evaluate(type=>window.dispatchEvent(new Event(type)),type);
 assert.equal(await composerInert(),false);await page.mouse.up();
 }
 await page.evaluate(()=>{getSelection().removeAllRanges();document.dispatchEvent(new Event('selectionchange'));});
 await input.fill('Normal composer editing');await input.click();
 await input.evaluate(e=>e.setSelectionRange(0,6));await page.keyboard.type('Intentional');
 assert.equal(await input.inputValue(),'Intentional composer editing');assert.equal(await input.evaluate(e=>document.activeElement===e),true);
 await input.fill('');historyFixture=null;
 // Native Android handle behavior is covered by physical A/B; verify the hold-driven workaround.
 for(const width of [390,1280]){
 await page.setViewportSize({width,height:844});
 historyFixture={machineId:'local',threadId:task.id,turns:[{id:'selection-turn',messages:[{id:'selection-message',role:'assistant',text:'Select this synthetic transcript text.',complete:true}],activities:[]}],nextCursor:null};
 await page.reload();await page.locator('#conversation .message-body').first().waitFor();
 const hitTesting=()=>page.locator('.topbar').evaluate(e=>getComputedStyle(e).pointerEvents);
 assert.equal(await hitTesting(),'auto');
 const selectText=()=>page.locator('#conversation .message-body').first().evaluate(e=>{
  const range=document.createRange();range.selectNodeContents(e);
  const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
 });
 const collapse=()=>page.evaluate(()=>{getSelection().removeAllRanges();document.dispatchEvent(new Event('selectionchange'));});
 await selectText();
 assert.equal(await hitTesting(),width<=860?'none':'auto');
 await collapse();await page.waitForTimeout(150);
 assert.equal(await hitTesting(),width<=860?'none':'auto');
 // A second handle drag renews the same hold, rather than letting its old timer release it.
 await selectText();await page.waitForTimeout(550);
 assert.equal(await hitTesting(),width<=860?'none':'auto');
 await collapse();await page.waitForFunction(()=>!document.querySelector('#app-shell').classList.contains('transcript-selection-held'));
 assert.equal(await hitTesting(),'auto');
 }
 historyFixture=null;
 // Wake is a machine action, never a task selection; MAC settings survive save/reopen.
 for(const width of [1280,390,320]){
 await page.setViewportSize({width,height:844});
 Object.assign(runtime.state,{machineId:'local',thread:task,turn:null,phase:'done',liveMessages:[],activities:[]});
 settings.headless=false;settings.machines=[{name:'PC',ssh:'pc'}];
 remoteConnected=false;wakeConfigured=true;wakeFailure=false;
 await page.reload();await open();
 const wake=page.getByRole('button',{name:'Wake Second machine',exact:true});await wake.waitFor();
 assert.equal(await wake.getAttribute('title'),'Wake Second machine');
 assert.equal(await wake.getAttribute('class'),'icon-button');
 assert.equal(await wake.locator('svg[aria-hidden="true"]').count(),1);
 const group=wake.locator('xpath=ancestor::section[contains(@class,"destination-group")]');
 const heading=group.locator('.destination-group-heading');
 const checkHeader=async(header,expectedCount)=>{
 const layout=await header.evaluate(e=>{
  const controls=e.querySelector('.machine-header-controls');
  const boxes=[...controls.children].map(node=>node.getBoundingClientRect());
  const name=e.querySelector('.machine-toggle').getBoundingClientRect();
  let visibleGaps=null;
  if(controls.children.length===3){
   const text=document.createRange();text.selectNodeContents(controls.children[0]);
   const wake=controls.querySelector('.wake-action svg').getBoundingClientRect();
   const create=controls.querySelector('.wake-action + .icon-button svg').getBoundingClientRect();
   visibleGaps=[wake.left-text.getBoundingClientRect().right,create.left-wake.right];
  }
  return {count:boxes.length,gaps:boxes.slice(1).map((box,i)=>box.left-boxes[i].right),
   visibleGaps,hitTargets:[...controls.querySelectorAll('.icon-button')].map(node=>{const box=node.getBoundingClientRect();return [box.width,box.height];}),
   fits:boxes.every(box=>box.left>=0&&box.right<=innerWidth)&&name.right<=controls.getBoundingClientRect().left,
   centers:boxes.map(box=>(box.top+box.bottom)/2)};
 });
 assert.equal(layout.count,expectedCount);assert.equal(layout.fits,true);
 if(expectedCount===3){
 assert(Math.abs(layout.gaps[0]-8)<1);assert(Math.abs(layout.gaps[1])<1);
 assert(Math.abs(layout.visibleGaps[0]-layout.visibleGaps[1])<=1,JSON.stringify(layout.visibleGaps));
 }
 assert(layout.hitTargets.every(([width,height])=>width===36&&height===36));
 assert(layout.centers.every(center=>Math.abs(center-layout.centers[0])<1));
 };
 await checkHeader(heading,3);
 await heading.locator('.machine-toggle strong').evaluate(e=>e.textContent='A very long machine name that must fit without displacing controls');
 await checkHeader(heading,3);
 assert.equal(await heading.locator('.machine-toggle strong').evaluate(e=>getComputedStyle(e).textOverflow),'ellipsis');
 await checkHeader(page.locator('.destination-group-heading').first(),1);
 const newTask=heading.getByRole('button',{name:'New task',exact:true});
 assert.equal(await wake.isEnabled(),true);
 assert.equal(await wake.evaluate(e=>{let opacity=1;for(let node=e;node;node=node.parentElement)opacity*=Number(getComputedStyle(node).opacity);return opacity;}),1);
 assert.equal(await newTask.isDisabled(),true);
 assert.equal(await newTask.evaluate(e=>getComputedStyle(e).opacity),'0.52');
 const groupRows=await group.locator(':scope > *').count();
 const headingHeight=(await heading.boundingBox()).height;
 const localFeedback=async()=>{
 assert.equal(await heading.locator('.wake-action [role="status"]').count(),1);
 assert.equal(await group.locator(':scope > *').count(),groupRows);
 assert.equal((await heading.boundingBox()).height,headingHeight);
 assert.equal(await group.locator('.destination-empty.wake-feedback').count(),0);
 };
 const selectionCalls=calls.filter(c=>c==='/api/navigation/select'||c==='/api/thread'||c==='/api/tasks').length;
 const label=await page.locator('#destination-label').textContent();
 await wake.click();await page.getByText('Wake packet sent',{exact:true}).waitFor();
 await localFeedback();
 assert.deepEqual(wakeBodies.at(-1),{machineId:'ssh:test'});
 assert.equal(calls.filter(c=>c==='/api/navigation/select'||c==='/api/thread'||c==='/api/tasks').length,selectionCalls);
 assert.equal(await page.locator('#destination-label').textContent(),label);
 await heading.locator('.wake-feedback').waitFor({state:'detached',timeout:5500});
 wakeFailure=true;await wake.click();await page.getByText('send EACCES',{exact:true}).waitFor();await localFeedback();
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/wake-${width}.png`});
 for(const [connected,configured] of [[true,true],[false,false]]){
 remoteConnected=connected;wakeConfigured=configured;
 await page.reload();await open();await page.locator('.machine-toggle').filter({hasText:'Second machine'}).waitFor();
 assert.equal(await page.getByRole('button',{name:/^Wake /}).count(),0);
 }
 await dismissTasks();await settingsOpen();
 const mac=page.locator('[data-machine-wake-mac]').first();await mac.fill('AA:BB:CC:DD:EE:FF');await mac.evaluate(e=>e.scrollIntoView({block:"center",behavior:"instant"}));
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/wake-settings-${width}.png`});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await settingsSave();assert.equal(settings.machines[0].wakeMac,'AA:BB:CC:DD:EE:FF');
 await settingsOpen();assert.equal(await page.locator('[data-machine-wake-mac]').first().inputValue(),'AA:BB:CC:DD:EE:FF');
 await page.locator('#settings-close').click();
 }
 // Selected goals use authoritative state, compact actions, and the existing Clear dialog.
 for(const width of [1280,390,320]){
 await page.setViewportSize({width,height:844});
 Object.assign(runtime.state,{machineId:'local',thread:task,connected:true,turn:null,phase:'done',goal:null,liveMessages:[],activities:[],pending:[]});
 historyFixture=null;await page.reload();await page.locator('#message-text').waitFor();
 assert.equal(await page.locator('#goal-strip').isVisible(),false);
 const goal={objective:'Complete this deliberately long objective while preserving a compact composer layout. '.repeat(5),status:'active',timeUsedSeconds:125,tokensUsed:1234,tokenBudget:5000};
 const update=value=>runtime.handleNotification({method:value?'thread/goal/updated':'thread/goal/cleared',params:{threadId:task.id,...(value?{goal:value}:{})}});
 runtime.rpc={request:async(method,params)=>{goalCalls.push({method,params});return method==='fs/readFile'?{dataBase64:Buffer.from(goal.objective).toString('base64')}:method==='thread/goal/clear'?{cleared:true}:{goal:{...goal,status:params.status}};}};
 update(goal);await page.getByRole('button',{name:'Pause goal',exact:true}).waitFor();
 assert.equal(await page.locator('#goal-status').textContent(),'Pursuing Goal');
 assert.equal(await page.locator('#goal-time').textContent(),'2m 05s');
 assert.equal(await page.getByRole('button',{name:'Clear goal',exact:true}).isVisible(),true);
 const goalBounds=await page.locator('#goal-strip').boundingBox();
 assert(goalBounds.x>=0&&goalBounds.x+goalBounds.width<=width&&goalBounds.height<=(width>860?48:68),JSON.stringify({width,goalBounds}));
 assert.equal(await page.locator('#goal-objective').evaluate(e=>getComputedStyle(e).textOverflow),'ellipsis');
 assert.equal(await page.locator('#goal-objective').textContent(),goal.objective);
 const layout=await page.locator('#goal-strip').evaluate(e=>{
 const rect=id=>{const r=e.querySelector(id).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,center:r.top+r.height/2};};
 return {status:rect('#goal-status'),objective:rect('#goal-objective'),time:rect('#goal-time'),toggle:rect('#goal-toggle'),clear:rect('#goal-clear'),border:getComputedStyle(e).borderStyle,radius:getComputedStyle(e).borderRadius};
 });
 assert.equal(layout.border,'solid');assert.equal(layout.radius,'10px');
 for(const item of (width>860?[layout.status,layout.time,layout.toggle,layout.clear]:[layout.status,layout.time]))assert(Math.abs(item.center-layout.status.center)<1);
 if(width>860){
 assert(Math.abs(layout.objective.center-layout.status.center)<1);
 assert(Math.abs(layout.time.left-layout.objective.right-8)<1);
 }else{
 assert(layout.objective.top>=layout.status.bottom);assert(layout.objective.bottom-layout.objective.top<20);
 }
 const composerBounds=await page.locator('#composer').boundingBox();assert.equal(goalBounds.x,composerBounds.x);assert.equal(goalBounds.width,composerBounds.width);
 assert.equal(await page.locator('#goal-clear svg path').getAttribute('d'),'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7');
 let releaseGoal;goalGate=new Promise(resolve=>releaseGoal=resolve);
 await page.getByRole('button',{name:'Pause goal',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Pause goal',exact:true}).isDisabled(),true);
 assert.equal(await page.locator('#goal-status').textContent(),'Pursuing Goal');
 goalGate=null;releaseGoal();await page.getByRole('button',{name:'Resume goal',exact:true}).waitFor();
 assert.equal(await page.locator('#goal-status').textContent(),'Goal Paused');
 assert.deepEqual(goalCalls.at(-1),{method:'thread/goal/set',params:{threadId:task.id,status:'paused'}});
 await page.getByRole('button',{name:'Resume goal',exact:true}).click();await page.getByRole('button',{name:'Pause goal',exact:true}).waitFor();
 assert.deepEqual(goalCalls.at(-1),{method:'thread/goal/set',params:{threadId:task.id,status:'active'}});
 for(const status of ['blocked','usageLimited','budgetLimited','complete']){
 update({...goal,status});await page.waitForFunction(()=>document.querySelector('#goal-toggle').hidden);
 assert.equal(await page.getByRole('button',{name:'Clear goal',exact:true}).isVisible(),true);
 assert.equal(await page.locator('#goal-status').textContent(),{blocked:'Goal Blocked',usageLimited:'Goal Usage Limited',budgetLimited:'Goal Budget Limited',complete:'Goal Complete'}[status]);
 }
 runtime.codexHome='/runtime-codex';
 const objectivePath='/runtime-codex/attachments/b1ed4737-775d-4385-9a95-888a9fac8c68/goal-objective.md';
 update({...goal,status:'paused',objective:`Read the Codex goal objective file at ${objectivePath} before continuing.`});
 await page.getByRole('button',{name:'Resume goal',exact:true}).waitFor();
 await page.waitForFunction(expected=>document.querySelector('#goal-objective').textContent===expected,goal.objective);
 assert.deepEqual(goalCalls.at(-1),{method:'fs/readFile',params:{path:objectivePath}});
 assert.equal((await page.locator('#goal-strip').textContent()).includes('goal-objective.md'),false);
 runtime.state.queuedMessage={threadId:task.id,text:'A deliberately long queued message to verify matching card geometry. '.repeat(5),createdAt:Date.now()};
 runtime.state.turn={id:'card-turn',status:'inProgress'};runtime.broadcast('snapshot',snapshot());await page.locator('#send-queue').waitFor();
 for(const [id,label] of [['send-queue','Steer Now'],['edit-queue','Edit queued message'],['cancel-queue','Cancel queued message']]){
 const button=page.getByRole('button',{name:label,exact:true});
 assert.equal(await button.getAttribute('id'),id);assert.equal(await button.getAttribute('title'),label);
 assert.equal(await button.textContent(),'');assert.equal(await button.locator('svg[aria-hidden="true"]').count(),1);
 assert.equal(await button.evaluate(e=>e.classList.contains('icon-button')),true);
 const appearance=await page.locator(`#${id}, #goal-toggle`).evaluateAll(es=>es.map(e=>{
 const s=getComputedStyle(e),r=e.getBoundingClientRect(),svg=getComputedStyle(e.querySelector('svg'));
 return [r.width,r.height,s.padding,s.borderWidth,s.borderRadius,s.backgroundColor,s.color,svg.width,svg.height,svg.strokeWidth];
 }));assert.deepEqual(appearance[0],appearance[1]);
 }
 assert.equal(await page.locator('#send-queue svg path').getAttribute('d'),'M5 19v-7a5 5 0 0 1 5-5h9m-5-5 5 5-5 5');
 assert.equal(await page.locator('#cancel-queue svg path').getAttribute('d'),'m6 6 12 12M6 18 18 6');
 assert.equal(await page.locator('.queue-copy strong').textContent(),'Queued Next');
 const cards=await page.evaluate(()=>{
 const box=e=>{const r=e.getBoundingClientRect();return {x:r.x,right:r.right,top:r.top,bottom:r.bottom,height:r.height,width:r.width,center:r.top+r.height/2};};
 const style=e=>{const s=getComputedStyle(e);return [s.padding,s.borderWidth,s.borderRadius,s.fontSize,s.fontWeight];};
 const goal=document.querySelector('#goal-strip'),queue=document.querySelector('#queue-banner'),zone=document.querySelector('.composer-zone'),composer=document.querySelector('#composer');
 return {goal:box(goal),queue:box(queue),goalStyle:style(goal),queueStyle:style(queue),goalTitle:style(document.querySelector('#goal-status')),queueTitle:style(document.querySelector('.queue-copy strong')),goalContent:style(document.querySelector('#goal-objective')),queueContent:style(document.querySelector('#queue-text')),title:box(document.querySelector('.queue-copy strong')),text:box(document.querySelector('#queue-text')),actions:box(document.querySelector('.queue-actions')),gaps:[goal.getBoundingClientRect().top-zone.getBoundingClientRect().top-parseFloat(getComputedStyle(zone).borderTopWidth),queue.getBoundingClientRect().top-goal.getBoundingClientRect().bottom,composer.getBoundingClientRect().top-queue.getBoundingClientRect().bottom,zone.getBoundingClientRect().bottom-composer.getBoundingClientRect().bottom],statusHeight:box(document.querySelector('#composer-status')).height};
 });
 assert.deepEqual(cards.goalStyle,cards.queueStyle);assert.deepEqual(cards.goalTitle,cards.queueTitle);assert.deepEqual(cards.goalContent,cards.queueContent);
 const cardPadding=await page.locator('#goal-strip, #queue-banner').evaluateAll(es=>es.map(e=>{
 const s=getComputedStyle(e);return [s.paddingTop,s.paddingBottom,s.paddingLeft,s.paddingRight];
 }));
 assert.deepEqual(cardPadding,Array(2).fill(width>860?['3px','3px','8px','8px']:['5px','5px','8px','8px']));
 assert.equal(cards.goal.x,cards.queue.x);assert.equal(cards.goal.width,cards.queue.width);assert.equal(cards.goal.height,cards.queue.height);
 assert.deepEqual(cards.gaps,[8,8,8,8]);assert.equal(cards.statusHeight,0);
 assert(cards.queue.x>=0&&cards.queue.right<=width);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 if(width>860){assert(Math.abs(cards.title.center-cards.actions.center)<1);assert(Math.abs(cards.text.center-cards.title.center)<1);}
 else {assert(cards.text.top>=cards.title.bottom);assert(cards.text.height<20);}
 assert.equal(await page.locator('#queue-text').evaluate(e=>getComputedStyle(e).textOverflow),'ellipsis');
 const optics=await page.evaluate(()=>{
 const rect=id=>document.querySelector(id).getBoundingClientRect();
 const textRect=id=>{const range=document.createRange();range.selectNodeContents(document.querySelector(id));return range.getBoundingClientRect();};
 const sizes=['#goal-toggle','#goal-clear','#send-queue','#edit-queue','#cancel-queue'].map(id=>{const r=rect(id);return [r.width,r.height];});
 const svgGaps=[['#goal-toggle','#goal-clear'],['#send-queue','#edit-queue'],['#edit-queue','#cancel-queue']].map(([a,b])=>rect(`${b} svg`).left-rect(`${a} svg`).right);
 const transforms=['#goal-objective','#queue-text','#goal-clear','#cancel-queue'].map(id=>getComputedStyle(document.querySelector(id)).transform);
 const alignment=[['#goal-strip','#goal-status','#goal-objective','#goal-clear'],['#queue-banner','.queue-copy strong','#queue-text','#cancel-queue']].map(([card,title,content,clear])=>{
 const r=rect(card),t=textRect(title),c=textRect(content);
 return {leftInset:t.left-r.left,rightInset:r.right-rect(`${clear} svg`).right,textCenter:(t.top+c.bottom)/2,cardCenter:r.top+r.height/2};
 });
 return {sizes,svgGaps,transforms,alignment,durationGap:rect('#goal-toggle svg').left-textRect('#goal-time').right};
 });
 assert.deepEqual(optics.sizes,Array(5).fill([36,36]));
 assert.deepEqual(optics.svgGaps,[18,18,18]);assert.deepEqual(optics.transforms,Array(4).fill('none'));
 assert(Math.abs(optics.durationGap-optics.svgGaps[0])<=2);
 for(const a of optics.alignment){
 assert(Math.abs(a.leftInset-a.rightInset)<=2);
 if(width<=860)assert(Math.abs(a.textCenter-a.cardCenter)<=2,JSON.stringify(a));
 }

 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/goal-${width}.png`});
 runtime.state.turn=null;runtime.broadcast('snapshot',{...snapshot(),message:{allowed:true,mode:'start'}});
 await page.waitForFunction(()=>document.querySelector('#send-queue').textContent==='Send');
 assert.equal(await page.locator('#send-queue').textContent(),'Send');assert.equal(await page.locator('#send-queue svg').count(),0);
 assert.equal(await page.locator('#queue-banner').evaluate(e=>e.querySelector('#edit-queue').getBoundingClientRect().left-e.querySelector('#send-queue').getBoundingClientRect().right),8);
 assert.equal(await page.locator('#send-queue').evaluate(e=>e.classList.contains('text-button')&&!e.classList.contains('icon-button')),true);
 assert.equal(await page.locator('#queue-banner').evaluate(e=>e.getBoundingClientRect().height),cards.queue.height);
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 runtime.state.queuedMessage=null;runtime.broadcast('snapshot',snapshot());await page.waitForFunction(()=>document.querySelector('#queue-banner').hidden);
 // Attention and draft attachments participate in the same normal 8px stack.
 await page.locator('#image-picker').setInputFiles({name:'spacing.png',mimeType:'image/png',buffer:png});await page.locator('#composer-images img').waitFor();
 runtime.state.pending=[{id:'card-permission',kind:'permission',supported:true,label:'Run command'}];runtime.broadcast('snapshot',snapshot());await page.locator('#attention-banner').waitFor();
 const stackGaps=await page.locator('.composer-zone').evaluate(zone=>{
 const children=[...zone.children].filter(e=>e.getBoundingClientRect().height&&getComputedStyle(e).position!=='absolute');
 return children.slice(1).map((e,i)=>e.getBoundingClientRect().top-children[i].getBoundingClientRect().bottom);
 });assert.deepEqual(stackGaps,[8,8,8]);
 runtime.state.pending=[];runtime.broadcast('snapshot',snapshot());await page.getByRole('button',{name:'Remove image 1',exact:true}).click();
 for(const status of ['active','paused','blocked','usageLimited','budgetLimited']){
 update({...goal,status});await page.waitForFunction(status=>document.querySelector('#goal-status').textContent===({active:'Pursuing Goal',paused:'Goal Paused',blocked:'Goal Blocked',usageLimited:'Goal Usage Limited',budgetLimited:'Goal Budget Limited'})[status],status);
 const before=goalCalls.length;
 await page.getByRole('button',{name:'Clear goal',exact:true}).click();await page.locator('#goal-clear-dialog').waitFor();
 assert.equal(goalCalls.length,before);assert.equal(await page.locator('#goal-clear-title').textContent(),'Clear unfinished goal?');
 assert.equal(await page.locator('#goal-clear-dialog p').textContent(),"This goal hasn't been completed yet.");
 assert(!(await page.locator('#goal-clear-dialog').innerText()).includes(goal.objective));
 await page.getByRole('button',{name:'Keep',exact:true}).click();assert.equal(goalCalls.length,before);assert.equal(await page.locator('#goal-strip').isVisible(),true);
 await page.getByRole('button',{name:'Clear goal',exact:true}).click();await page.keyboard.press('Escape');
 assert.equal(await page.locator('#goal-clear-dialog').isVisible(),false);assert.equal(goalCalls.length,before);
 await page.getByRole('button',{name:'Clear goal',exact:true}).click();
 assert(await page.locator('#goal-clear-dialog').evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}));
 if(process.env.POCKET_SCREENSHOT_DIR&&status==='active')await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/goal-clear-${width}.png`});
 await page.getByRole('button',{name:'Clear',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#goal-strip').hidden);
 assert.deepEqual(goalCalls.at(-1),{method:'thread/goal/clear',params:{threadId:task.id}});
 }
 update({...goal,status:'complete'});await page.waitForFunction(()=>document.querySelector('#goal-status').textContent==='Goal Complete');
 await page.getByRole('button',{name:'Clear goal',exact:true}).click();
 assert.equal(await page.locator('#goal-clear-dialog').isVisible(),false);assert.equal(await page.locator('#task-dialog').isVisible(),false);
 await page.waitForFunction(()=>document.querySelector('#goal-strip').hidden);assert.deepEqual(goalCalls.at(-1),{method:'thread/goal/clear',params:{threadId:task.id}});
 for(const change of ['disappear','task','machine']){
 update(goal);await page.locator('#goal-strip').waitFor();await page.getByRole('button',{name:'Clear goal',exact:true}).click();
 const before=goalCalls.length;
 if(change==='disappear')update(null);
 else {if(change==='task')runtime.state.thread=owned;else runtime.state.machineId='ssh:other';runtime.broadcast('snapshot',snapshot());}
 await page.waitForFunction(()=>!document.querySelector('#goal-clear-dialog').open);
 await page.locator('#goal-clear-form').evaluate(e=>e.requestSubmit());assert.equal(goalCalls.length,before);
 runtime.state.thread=task;runtime.state.machineId='local';runtime.broadcast('snapshot',snapshot());
 }
 update(goal);await page.locator('#goal-strip').waitFor();update(null);await page.waitForFunction(()=>document.querySelector('#goal-strip').hidden);
 }
 // Goal duration ticks locally from wall time without changing authoritative state or controls.
 for(const width of [1280,390]){
 await page.setViewportSize({width,height:844});historyFixture=null;
 Object.assign(runtime.state,{machineId:'local',thread:task,connected:true,turn:null,phase:'done',goal:null,pending:[],queuedMessage:null,liveMessages:[],activities:[]});
 await page.reload();await page.locator('#message-text').waitFor();
 const goal={objective:'A live Goal duration',status:'active',timeUsedSeconds:125};
 const update=value=>{runtime.state.goal=value;runtime.broadcast('goal',{machineId:runtime.state.machineId,threadId:runtime.state.thread.id,goal:value});};
 update(goal);await page.waitForFunction(()=>document.querySelector('#goal-time').textContent==='2m 05s');
 // Retain a control node to detect accidental whole-composer rendering on a tick.
 const control=await page.locator('#goal-toggle svg').elementHandle();
 const requests=calls.length;
 await page.waitForFunction(()=>document.querySelector('#goal-time').textContent!=='2m 05s');
 assert.match(await page.locator('#goal-time').textContent(),/^2m 0[67]s$/);
 assert.equal(await control.evaluate(e=>e===document.querySelector('#goal-toggle svg')),true);
 assert.equal(runtime.state.goal.timeUsedSeconds,125);assert.equal(calls.length,requests);
 // An unchanged snapshot must not restart the clock; a changed duration must resync.
 update({...goal,tokensUsed:20});
 await page.waitForTimeout(60);assert.notEqual(await page.locator('#goal-time').textContent(),'2m 05s');
 update({...goal,timeUsedSeconds:10});await page.waitForFunction(()=>document.querySelector('#goal-time').textContent==='10s');
 // Simulate a throttled/background clock jumping ahead between timer callbacks.
 await page.evaluate(()=>{window.goalClockRealNow=Date.now;Date.now=()=>window.goalClockRealNow()+60000;});
 await page.waitForFunction(()=>document.querySelector('#goal-time').textContent.startsWith('1m '));
 await page.evaluate(()=>{Date.now=window.goalClockRealNow;delete window.goalClockRealNow;});
 assert.equal(runtime.state.goal.timeUsedSeconds,10);
 for(const status of ['paused','blocked','usageLimited','budgetLimited','complete']){
 update({...goal,status,timeUsedSeconds:20});await page.waitForFunction(()=>document.querySelector('#goal-time').textContent==='20s');
 await page.waitForTimeout(1100);assert.equal(await page.locator('#goal-time').textContent(),'20s');
 }
 update({...goal,timeUsedSeconds:30});await page.waitForFunction(()=>document.querySelector('#goal-time').textContent==='30s');
 await page.waitForFunction(()=>document.querySelector('#goal-time').textContent!=='30s');
 update({...goal,objective:'A replacement Goal',timeUsedSeconds:30});await page.waitForFunction(()=>document.querySelector('#goal-time').textContent==='30s');
 await page.waitForFunction(()=>document.querySelector('#goal-time').textContent!=='30s');
 runtime.state.thread=owned;runtime.broadcast('snapshot',snapshot());await page.waitForFunction(()=>document.querySelector('#goal-time').textContent==='30s');
 await page.waitForFunction(()=>document.querySelector('#goal-time').textContent!=='30s');
 update(null);await page.waitForFunction(()=>document.querySelector('#goal-strip').hidden);
 update({...goal,objective:'A replacement Goal',timeUsedSeconds:30});await page.waitForFunction(()=>document.querySelector('#goal-time').textContent==='30s');
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/goal-clock-${width}.png`});
 runtime.state.thread=task;runtime.state.goal=null;runtime.broadcast('snapshot',snapshot());
 }
 // Queue dialog keeps user-authored instructions until confirmed discard or successful edit.
 for(const width of [1280,390,320]){
 await page.setViewportSize({width,height:844});
 Object.assign(runtime.state,{machineId:'local',thread:task,connected:true,turn:{id:'queue-dialog-turn',status:'inProgress'},phase:'working',goal:null,pending:[],queuedMessage:null,liveMessages:[],activities:[]});
 historyFixture=null;await page.reload();await page.locator('#message-text').waitFor();
 const original={threadId:task.id,text:'A private queued instruction',images:[],files:[],createdAt:101};
 const publish=async queued=>{runtime.state.queuedMessage=queued;runtime.broadcast('queue',{queuedMessage:queued});await page.waitForFunction(show=>document.querySelector('#queue-banner').hidden!==show,Boolean(queued));};
 await publish({...original});
 const beforeCancel=calls.filter(p=>p==='/api/message/queue').length;
 await page.getByRole('button',{name:'Cancel queued message',exact:true}).click();
 assert.equal(await page.locator('#queue-dialog-title').textContent(),'Cancel queued message?');
 assert.equal(await page.locator('#queue-dialog-copy').textContent(),"This queued message will be discarded and can't be recovered.");
 assert(!(await page.locator('#queue-dialog').innerText()).includes(original.text));assert.equal(await page.locator('#task-dialog').isVisible(),false);
 await page.getByRole('button',{name:'Keep',exact:true}).click();assert.deepEqual(runtime.state.queuedMessage,original);
 assert.equal(calls.filter(p=>p==='/api/message/queue').length,beforeCancel);
 await page.getByRole('button',{name:'Edit queued message',exact:true}).click();
 assert.equal(await page.locator('#queue-dialog-text').inputValue(),original.text);
 await page.locator('#queue-dialog-text').fill('An unsaved draft');await page.locator('#queue-dialog-cancel').click();assert.deepEqual(runtime.state.queuedMessage,original);
 await page.getByRole('button',{name:'Edit queued message',exact:true}).click();await page.locator('#queue-dialog-text').fill('   ');await page.locator('#queue-dialog-submit').click();
 assert.equal(await page.locator('#queue-dialog-error').textContent(),'Enter a message or attach files');assert.deepEqual(runtime.state.queuedMessage,original);
 await page.locator('#queue-dialog-text').fill('Updated instruction');queueEditFailure=true;
 await page.locator('#queue-dialog-submit').click();await page.getByText('Could not save this edit',{exact:true}).waitFor();
 assert.deepEqual(runtime.state.queuedMessage,original);assert.equal(await page.locator('#queue-text').textContent(),original.text);
 queueEditFailure=false;let releaseEdit;queueEditGate=new Promise(resolve=>releaseEdit=resolve);
 await page.locator('#queue-dialog-submit').click();await page.waitForFunction(()=>document.querySelector('#queue-dialog-submit').disabled);
 assert.deepEqual(runtime.state.queuedMessage,original);assert.equal(await page.locator('#queue-dialog-text').isDisabled(),true);
 queueEditGate=null;releaseEdit();await page.waitForFunction(()=>!document.querySelector('#queue-dialog').open);
 assert.equal(runtime.state.queuedMessage.text,'Updated instruction');assert.equal(runtime.state.queuedMessage.createdAt,original.createdAt);
 assert.deepEqual(queueEdits.at(-1),{machineId:'local',threadId:task.id,queueId:String(original.createdAt),text:'Updated instruction'});
 const attached={...original,text:'With attachments',images:[{url:`data:image/png;base64,${png.toString('base64')}`}],files:[{path:'/tmp/staged/report.pdf',name:'report.pdf',size:7}]};
 await publish(attached);await page.getByRole('button',{name:'Edit queued message',exact:true}).click();await page.locator('#queue-dialog-text').fill('');
 assert(await page.locator('#queue-dialog').evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}));
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/queue-edit-${width}.png`});
 await page.locator('#queue-dialog-submit').click();await page.waitForFunction(()=>!document.querySelector('#queue-dialog').open);
 assert.deepEqual(runtime.state.queuedMessage,{...attached,text:''});assert.equal(await page.locator('#queue-images img').count(),1);assert.equal(await page.locator('#queue-files .file-chip').count(),1);
 await page.getByRole('button',{name:'Edit queued message',exact:true}).click();await publish(null);await page.waitForFunction(()=>!document.querySelector('#queue-dialog').open);
 const editsBefore=queueEdits.length;await page.locator('#queue-dialog-form').evaluate(e=>e.requestSubmit());assert.equal(queueEdits.length,editsBefore);
 await publish({...original});await page.getByRole('button',{name:'Edit queued message',exact:true}).click();
 runtime.state.thread=owned;runtime.broadcast('snapshot',snapshot());await page.waitForFunction(()=>!document.querySelector('#queue-dialog').open);
 await page.locator('#queue-dialog-form').evaluate(e=>e.requestSubmit());assert.equal(queueEdits.length,editsBefore);
 runtime.state.thread=task;runtime.broadcast('snapshot',snapshot());
 await page.getByRole('button',{name:'Cancel queued message',exact:true}).click();
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/queue-discard-${width}.png`});
 await page.getByRole('button',{name:'Discard',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#queue-banner').hidden);assert.equal(runtime.state.queuedMessage,null);
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 }
 // File drafts and chips follow the same task identity and queue lifecycle as images.
 for(const width of [1280,390,320]){
 await page.setViewportSize({width,height:844});
 realFilePosts=true;mode='success';composerPost='success';settings.headless=false;active=[task,owned];
 Object.assign(runtime.state,{machineId:'local',thread:task,connected:true,threadStatus:'idle',turn:null,phase:'done',goal:null,queuedMessage:null,liveMessages:[],activities:[],pending:[]});
 runtime.canAcceptDirectInput=true;
 const fileTurns=[];runtime.rpc={request:async(method,params)=>{fileTurns.push({method,params});return {turn:{id:'file-turn',status:'inProgress'},turnId:'file-turn'};}};
 await page.reload();await input.waitFor();
 assert.equal(await page.getByRole('button',{name:'Attach files',exact:true}).isVisible(),true);
 assert.equal(await page.locator('#image-picker').getAttribute('accept'),null);
 const name='测试报告 résumé '+ 'a-long-report-name-'.repeat(4)+'.pdf';
 const file={name,mimeType:'application/pdf',buffer:Buffer.from('binary\0file')};
 await page.locator('#image-picker').setInputFiles([file,{name:'photo.png',mimeType:'image/png',buffer:png}]);
 await page.locator('#composer-files .file-chip').waitFor();assert.equal(await page.locator('#composer-images img').count(),1);
 await select('Owned task');assert.equal(await page.locator('#composer-files .file-chip').count(),0);assert.equal(await page.locator('#composer-images img').count(),0);
 await select('Current task');assert.equal(await page.locator('#composer-files .file-chip').count(),1);assert.equal(await page.locator('#composer-images img').count(),1);
 const removers=page.locator('#composer-images .attachment-remove, #composer-files .attachment-remove');
 assert.equal(await removers.count(),2);
 assert(await removers.evaluateAll(buttons=>buttons.every(button=>{
 const svg=button.querySelector('svg'),b=button.getBoundingClientRect(),r=svg.getBoundingClientRect();
 return svg.getAttribute('aria-hidden')==='true'&&button.textContent===''&&r.width===14&&r.height===14
 &&Math.abs(b.x+b.width/2-r.x-r.width/2)<1&&Math.abs(b.y+b.height/2-r.y-r.height/2)<1;
 })));
 assert.deepEqual(await removers.evaluateAll(buttons=>buttons.map(e=>{const s=getComputedStyle(e);return [s.color,s.borderRadius];})),await removers.evaluateAll(buttons=>buttons.map(()=>{const s=getComputedStyle(buttons[0]);return [s.color,s.borderRadius];})));
 assert.equal(await page.locator('#composer-images .attachment-remove').evaluate(e=>getComputedStyle(e).position),'absolute');
 assert.equal(await page.locator('#composer-files .attachment-remove').evaluate(e=>getComputedStyle(e).position),'static');
 await page.getByRole('button',{name:'Remove image 1',exact:true}).click();
 await page.locator('#image-picker').setInputFiles([1,2,3].map(i=>({...file,name:`${i}-${name}`})));
 await page.waitForFunction(()=>document.querySelectorAll('#composer-files .file-chip').length===4);
 const fits=async selector=>assert(await page.locator(selector).evaluateAll(es=>es.every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})));
 await fits('#composer-files .file-chip');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert.equal(await page.locator('#send-message').isEnabled(),true);
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/files-${width}.png`});
 await page.getByRole('button',{name:`Remove file ${name}`,exact:true}).click();assert.equal(await page.locator('#composer-files .file-chip').count(),3);
 await page.locator('#send-message').click();await page.waitForFunction(()=>document.querySelector('#composer-files').hidden);
 assert.equal(fileBodies.at(-1).text,'');assert.equal(fileBodies.at(-1).files.length,3);assert.equal(fileBodies.at(-1).threadId,task.id);
 assert.equal(fileTurns.at(-1).method,'turn/start');assert.match(fileTurns.at(-1).params.input[0].text,/Attached files available on this machine:/);
 assert.deepEqual(Buffer.from(fileBodies.at(-1).files[0].data,'base64'),file.buffer);
 await input.fill('Use the files and image');await page.locator('#image-picker').setInputFiles([file,{name:'photo.png',mimeType:'image/png',buffer:png}]);
 await page.locator('#composer-files .file-chip').waitFor();await page.locator('#send-message').click();
 await page.waitForFunction(()=>document.querySelector('#composer-files').hidden&&!document.querySelector('#queue-files').hidden);
 assert.equal(runtime.state.queuedMessage.files.length,1);assert.equal('data' in runtime.state.queuedMessage.files[0],false);
 assert.equal(runtime.state.queuedMessage.images.length,1);assert.equal(await page.locator('#queue-files .file-chip').count(),1);
 await fits('#queue-files .file-chip');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/queued-files-${width}.png`});
 await page.locator('#cancel-queue').click();await page.locator('#queue-dialog-submit').click();await page.waitForFunction(()=>document.querySelector('#queue-banner').hidden);
 }
 // Only actionable errors occupy the under-composer status, including during requests.
 for(const width of [1280,390]){
 await page.setViewportSize({width,height:844});
 Object.assign(runtime.state,{machineId:'local',thread:task,connected:true,threadStatus:'idle',turn:null,phase:'done',goal:null,queuedMessage:null,pending:[],liveMessages:[],activities:[],
 models:['first','second'].map(model=>({model,displayName:model,supportedReasoningEfforts:[{reasoningEffort:'high'}]})),model:'first',reasoningEffort:'high',access:{mode:'ask',choices:{ask:{available:true},auto:{available:true},full:{available:true}}}});
 composerPost='success';realFilePosts=false;await page.reload();await input.waitFor();
 const quiet=async()=>{
 assert.equal(await page.locator('#composer-status').textContent(),'');
 assert.equal(await page.locator('#composer-status').isVisible(),false);
 assert.equal(await page.locator('#composer-status').evaluate(e=>e.getBoundingClientRect().height),0);
 };
 const gated=async(route,trigger,busy,done)=>{
 let releaseUI;uiGate=new Promise(resolve=>releaseUI=resolve);
 const response=page.waitForResponse(r=>new URL(r.url()).pathname===route);
 await trigger();await page.waitForFunction(busy);await quiet();
 releaseUI();uiGate=null;await response;await page.waitForFunction(done);await quiet();
 };
 await quiet();
 for(const decision of ['approve','deny']){
 runtime.state.pending=[{id:'permission-test',kind:'permission',supported:true,label:'Run the test command'}];runtime.broadcast('snapshot',snapshot());
 await page.getByRole('button',{name:decision==='approve'?'Approve':'Deny',exact:true}).waitFor();
 await gated('/api/approval',()=>page.getByRole('button',{name:decision==='approve'?'Approve':'Deny',exact:true}).click(),()=>document.querySelector('.approval-actions button').disabled,()=>document.querySelector('#attention-banner').hidden);
 }
 runtime.state.pending=[{id:'input-test',kind:'input',supported:true,blocking:true,questions:[{id:'answer-test',header:'Choice',question:'What should be used?',options:null}]}];runtime.broadcast('snapshot',snapshot());
 await page.locator('.input-free-text').fill('The selected option');
 await gated('/api/input',()=>page.getByRole('button',{name:'Send Answer',exact:true}).click(),()=>document.querySelector('.structured-input-form button').disabled,()=>document.querySelector('#attention-banner').hidden);
 await gated('/api/thread/settings',()=>page.locator('#model-select').evaluate(e=>{e.value='second';e.dispatchEvent(new Event('change'));}),()=>document.querySelector('#model-select').disabled,()=>!document.querySelector('#model-select').disabled);
 await gated('/api/thread/access',()=>page.locator('#access-select').evaluate(e=>{e.value='full';e.dispatchEvent(new Event('change'));}),()=>document.querySelector('#access-select').disabled,()=>!document.querySelector('#access-select').disabled);
 await input.fill('A normal message');
 await gated('/api/message',()=>page.locator('#send-message').click(),()=>document.querySelector('#send-message').disabled,()=>!document.querySelector('#message-text').disabled);
 runtime.state.turn={id:'quiet-turn',status:'inProgress'};runtime.state.queuedMessage={threadId:task.id,text:'Queued text',createdAt:Date.now()};runtime.broadcast('snapshot',snapshot());
 await page.locator('#send-queue').waitFor();
 await gated('/api/message/queue',()=>page.locator('#send-queue').click(),()=>document.querySelector('#send-queue').disabled,()=>document.querySelector('#queue-banner').hidden);
 await gated('/api/turn/interrupt',()=>page.locator('#send-message').click(),()=>document.querySelector('#send-message').disabled,()=>!document.querySelector('#send-message').disabled);
 runtime.broadcast('control',{stoppingTurnId:'quiet-turn',message:{allowed:false,reason:'Stopping the active turn…'}});
 await page.waitForFunction(()=>document.querySelector('#send-message').textContent==='Stopping…');await quiet();
 runtime.state.turn=null;runtime.broadcast('snapshot',snapshot());
 runtime.broadcast('control',{message:{allowed:false,reason:'This task does not accept direct input'}});
 await page.getByText('This task does not accept direct input',{exact:true}).waitFor();
 runtime.broadcast('control',{message:{allowed:true,reason:'Informational reason'}});
 await page.waitForFunction(()=>document.querySelector('#composer-status').hidden);await quiet();
 composerPost='reject';await input.fill('Rejected message');await page.locator('#send-message').click();
 await page.getByText('Send rejected',{exact:true}).waitFor();assert.equal(await page.locator('#composer-status').isVisible(),true);
 composerPost='success';
 }
 // Explicit New Task choices are remembered only after success, separately per machine.
 const previousOptionsRemoteConnected=remoteConnected;remoteConnected=true;
 await page.setViewportSize({width:1280,height:844});
 await page.evaluate(()=>{localStorage.setItem('codex-pocket-details-open','false');for(const id of ['local','ssh:test'])localStorage.removeItem(`codex-pocket-new-task-settings:${id}`);});
 newTaskOptionsFixture={models:[{model:'choice-a',displayName:'Choice A',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'}],defaultReasoningEffort:'medium'},{model:'choice-b',displayName:'Choice B',supportedReasoningEfforts:[{reasoningEffort:'high'},{reasoningEffort:'xhigh'}],defaultReasoningEffort:'high'}],current:{model:'choice-b',effort:'xhigh',access:'full'},access:{ask:true,auto:true,full:true}};
 await page.reload();await open();
 const openNew=async index=>{await page.getByRole('button',{name:'New task',exact:true}).nth(index).click();await page.waitForFunction(()=>!document.querySelector('#new-task-create').disabled);};
 const choices=()=>page.locator('#new-task-model, #new-task-effort, #new-task-access').evaluateAll(es=>es.map(e=>e.value));
 const savedChoice=id=>page.evaluate(id=>JSON.parse(localStorage.getItem(`codex-pocket-new-task-settings:${id}`)),id);
 await openNew(0);assert.deepEqual(await choices(),['choice-b','xhigh','full']);
 assert.equal(await page.locator('.new-task-settings option[value=""]').count(),0);
 await page.locator('#new-task-model').selectOption('choice-a');assert.equal(await page.locator('#new-task-effort').inputValue(),'medium');
 await page.locator('#new-task-effort').selectOption('low');await page.locator('#new-task-access').selectOption('auto');
 await page.locator('#new-task-cancel').click();assert.equal(await savedChoice('local'),null);
 await openNew(0);assert.deepEqual(await choices(),['choice-b','xhigh','full']);
 await page.locator('#new-task-model').selectOption('choice-a');await page.locator('#new-task-effort').selectOption('low');await page.locator('#new-task-access').selectOption('auto');
 await page.locator('#new-task-name').fill('Remembered choices');failAction=true;
 await page.locator('#new-task-create').click();await page.locator('#new-task-error').getByText('Fixture action failed',{exact:true}).waitFor();
 assert.equal(await savedChoice('local'),null);
 failAction=false;await page.locator('#new-task-create').click();await page.waitForFunction(()=>!document.querySelector('#new-task-dialog').open);
 assert.deepEqual(await savedChoice('local'),{model:'choice-a',effort:'low',access:'auto'});
 await page.reload();await open();await openNew(0);assert.deepEqual(await choices(),['choice-a','low','auto']);await page.locator('#new-task-cancel').click();
 await openNew(1);assert.deepEqual(await choices(),['choice-b','xhigh','full']);
 await page.locator('#new-task-effort').selectOption('high');await page.locator('#new-task-access').selectOption('ask');await page.locator('#new-task-name').fill('Remote choices');
 await page.locator('#new-task-create').click();await page.waitForFunction(()=>!document.querySelector('#new-task-dialog').open);
 assert.deepEqual(await savedChoice('ssh:test'),{model:'choice-b',effort:'high',access:'ask'});
 assert.deepEqual(await savedChoice('local'),{model:'choice-a',effort:'low',access:'auto'});
 newTaskOptionsFixture={...newTaskOptionsFixture,models:newTaskOptionsFixture.models.slice(1),access:{ask:true}};
 await openNew(0);assert.deepEqual(await choices(),['choice-b','high','ask']);await page.locator('#new-task-cancel').click();
 assert.deepEqual(await savedChoice('local'),{model:'choice-a',effort:'low',access:'auto'},'fallbacks are not saved merely by opening');
 newTaskOptionsFixture.models[0]={...newTaskOptionsFixture.models[0],supportedReasoningEfforts:[{reasoningEffort:'xhigh'}],defaultReasoningEffort:'xhigh'};
 await openNew(1);assert.deepEqual(await choices(),['choice-b','xhigh','ask']);await page.locator('#new-task-cancel').click();
 assert.equal((await savedChoice('ssh:test')).effort,'high','unsupported effort fallback is not saved before creation');
 newTaskOptionsFixture=null;remoteConnected=previousOptionsRemoteConnected;await dismissTasks();await closed();
 // Real activity reorders cached catalogs immediately, including updates during a catalog read.
 const savedOrderingTasks=active;
 for(const width of [1280,390,320]) {
 await page.setViewportSize({width,height:844});
 const older={...task,id:'order-old',name:'Order old',loaded:true,updatedAt:100},newer={...task,id:'order-new',name:'Order new',loaded:true,updatedAt:200};
 active=[newer,older];Object.assign(runtime.state,{machineId:'local',thread:older,turn:null,threadStatus:'idle',phase:'ready',pending:[],queuedMessage:null,liveMessages:[],activities:[]});
 await page.evaluate(()=>localStorage.setItem('codex-pocket-details-open','false'));
 await page.goto(`http://127.0.0.1:${server.address().port}`);await open();
 const order=()=>page.locator('.destination-task-label > span').allTextContents().then(names=>names.filter(name=>name.startsWith('Order ')));
 assert.deepEqual(await order(),['Order new','Order old']);
 const readsBeforeSend=calls.filter(c=>c==='/api/navigation').length;
 await page.locator('#message-text').fill('New activity in the older task');await page.locator('#composer').evaluate(form=>form.requestSubmit());
 await page.waitForFunction(()=>document.querySelector('#message-text').value==='');
 assert.deepEqual(await order(),['Order old','Order new']);
 assert.equal(calls.filter(c=>c==='/api/navigation').length,readsBeforeSend,'accepted activity reorders without fetching the catalog');
 runtime.broadcast('task-status',{machineId:'local',threadId:older.id,status:'active'});
 await page.waitForFunction(()=>document.querySelector('.destination-task-label > span').textContent==='Order old');
 runtime.broadcast('task-status',{machineId:'local',threadId:older.id,status:'idle'});
 await page.waitForTimeout(30);assert.deepEqual(await order(),['Order old','Order new']);
 // Passive repeats do not move the older timestamp ahead of genuinely newer activity.
 runtime.broadcast('task-status',{machineId:'local',threadId:newer.id,status:'active',updatedAt:Date.now()+1000});
 runtime.broadcast('task-status',{machineId:'local',threadId:newer.id,status:'idle'});
 await page.waitForFunction(()=>document.querySelector('.destination-task-label > span').textContent==='Order new');
 runtime.broadcast('task-status',{machineId:'local',threadId:older.id,status:'idle'});
 await page.waitForTimeout(30);assert.deepEqual(await order(),['Order new','Order old']);
 let finishOrdering;navigationGate=new Promise(resolve=>finishOrdering=resolve);
 await page.getByRole('button',{name:'Refresh tasks',exact:true}).click();
 runtime.broadcast('task-status',{machineId:'local',threadId:older.id,status:'active',updatedAt:Date.now()+2000});
 runtime.broadcast('task-status',{machineId:'local',threadId:older.id,status:'idle'});
 await page.waitForTimeout(30);finishOrdering();navigationGate=null;
 await page.waitForFunction(()=>!document.querySelector('#destination-refresh').disabled);
 assert.deepEqual(await order(),['Order old','Order new']);
 // A fresh catalog using the same recency agrees with the live order.
 older.updatedAt=Date.now()+2000;active=[older,newer];
 await page.getByRole('button',{name:'Refresh tasks',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#destination-refresh').disabled);
 assert.deepEqual(await order(),['Order old','Order new']);
 await dismissTasks();await closed();
 }
 active=savedOrderingTasks;
 // A fresh task's leave guard belongs to the source; attach failures belong to the target.
 const savedActiveForFresh=active;
 for(const width of [1280,390,320]){
 await page.setViewportSize({width,height:844});
 const source={...task,id:'fresh-source',name:'Fresh source'},target={...task,id:'fresh-target',name:'Other target'};
 active=[source,target];mode='success';freshNavigation=true;
 Object.assign(runtime.state,{machineId:'local',connected:true,thread:source,turn:null,threadStatus:'idle',phase:'ready',goal:null,queuedMessage:null,pending:[],liveMessages:[],activities:[]});
 runtime.canAcceptDirectInput=true;runtime.pendingTaskNames.set(source.id,{name:source.name,firstMessageAccepted:false});
 runtime.rpc={request:async method=>method==='turn/start'?{turn:{id:'first-accepted',status:'inProgress'}}:{data:[]}};
 await page.evaluate(()=>localStorage.setItem('codex-pocket-details-open','false'));
 await page.goto(`http://127.0.0.1:${server.address().port}`);await open();
 const sourceRow=page.locator('.destination-entry').filter({hasText:source.name}),targetRow=page.locator('.destination-entry').filter({hasText:target.name});
 await targetRow.locator('.destination-task').click();
 await sourceRow.locator('.task-selection-error').getByText('Send the first message before leaving this new task.',{exact:true}).waitFor();
 assert.equal(await targetRow.locator('.task-selection-error').count(),0);assert.equal(await sourceRow.locator('.destination-task').getAttribute('aria-current'),'true');assert.equal(runtime.state.thread.id,source.id);
 assert.equal(await page.locator('.task-selection-error').count(),1);
 // An unrelated task action must not erase the fresh source's leave warning.
 failAction=true;gate=new Promise(resolve=>release=resolve);
 await targetRow.locator('summary').click();await targetRow.getByRole('button',{name:'Rename',exact:true}).click();
 await page.locator('#task-dialog-name').fill('Renamed target');await page.locator('#task-dialog-submit').click();
 await page.getByText('Renaming…',{exact:true}).waitFor();
 assert.equal(await sourceRow.locator('.task-selection-error').count(),1);
 release();gate=null;await targetRow.locator('.task-selection-error').waitFor();failAction=false;
 assert.equal(await sourceRow.locator('.task-selection-error').count(),1);
 const subtitleGeometry=await sourceRow.locator('.task-selection-error').evaluate(e=>{const r=e.getBoundingClientRect(),row=e.closest('.destination-task'),b=row.getBoundingClientRect(),style=getComputedStyle(row),title=row.querySelector('.destination-task-label > span').getBoundingClientRect(),menu=row.parentElement.querySelector('.task-actions summary').getBoundingClientRect();return {rightInset:b.right-r.right,expectedInset:parseFloat(style.paddingRight)+parseFloat(style.borderRightWidth),titleRight:title.right,menuLeft:menu.left};});
 assert(Math.abs(subtitleGeometry.rightInset-subtitleGeometry.expectedInset)<1,JSON.stringify({width,subtitleGeometry}));
 assert(subtitleGeometry.titleRight<=subtitleGeometry.menuLeft);

 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/fresh-source-error-${width}.png`});
 await dismissTasks();await closed();await page.locator('#message-text').fill('First real message');
 composerPost='reject';await page.locator('#send-message').click();
 await page.getByText('Send rejected',{exact:true}).waitFor();
 assert.equal(await sourceRow.locator('.task-selection-error').count(),1,'a rejected first message keeps the source task warning');
 assert.equal(runtime.pendingTaskNames.get(source.id).firstMessageAccepted,false);
 composerPost='success';await page.locator('#send-message').click();
 await page.waitForFunction(()=>document.querySelector('#message-text').value==='');assert.equal(runtime.state.turn.id,'first-accepted');runtime.assertCanLeaveNewTask();
 assert.equal(await sourceRow.locator('.task-selection-error').count(),0,'acceptance immediately rerenders the task row, before opening Tasks or navigating');
 await open();await targetRow.locator('.destination-task').click();await page.waitForFunction(()=>document.querySelector('#destination-button').textContent.includes('Other target'));
 assert.equal(runtime.state.thread.id,target.id);await open();assert.equal(await page.locator('.task-selection-error').count(),0);
 freshNavigation=false;
 for(const failureMode of ['reject','unavailable']){
 mode=failureMode;await sourceRow.locator('.destination-task').click();
 await sourceRow.locator('.task-selection-error').getByText(failureMode==='reject'?'Open elsewhere. Close it and retry.':'selected task is unavailable',{exact:true}).waitFor();
 assert.equal(await targetRow.locator('.task-selection-error').count(),0);assert.equal(await targetRow.locator('.destination-task').getAttribute('aria-current'),'true');
 }
 await dismissTasks();await closed();runtime.pendingTaskNames.delete(source.id);
 }
 active=savedActiveForFresh;mode='success';freshNavigation=false;
 // Escape respects the exact overlay breakpoint and fullscreen priority.
 for(const width of [1099,1100]){
 await page.setViewportSize({width,height:844});
 if(await page.locator('#inspector-button').getAttribute('aria-expanded')==='true')await page.locator('#inspector-button').evaluate(e=>e.click());
 await open();
 if(await page.locator('#inspector-button').getAttribute('aria-expanded')!=='true')await page.locator('#inspector-button').evaluate(e=>e.click());
 await page.locator('#message-text').fill('Multiline draft\n'.repeat(10));
 await page.locator('#expand-composer').evaluate(e=>e.click());
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('.expanded-composer').count(),0);
 for(const id of ['destination-button','inspector-button'])assert.equal(await page.locator(`#${id}`).getAttribute('aria-expanded'),'true');
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('#inspector-button').getAttribute('aria-expanded'),width<1100?'false':'true');
 if(width<1100){await page.keyboard.press('Escape');await closed();}
 else {assert.equal(await page.locator('#destination-button').getAttribute('aria-expanded'),'true');await page.locator('#inspector-button').evaluate(e=>e.click());await dismissTasks();await closed();}
 await page.locator('#message-text').fill('');
 }
 // A different client can materialize or leave the warned fresh task.
 for(const width of [1280,390])for(const evidence of ['turn','snapshot','leave']){
 await page.setViewportSize({width,height:844});
 const source={...task,id:'cross-client-fresh',name:'Cross client fresh'},target={...task,id:'cross-client-target',name:'Cross client target'};
 active=[source,target];freshNavigation=true;mode='success';
 Object.assign(runtime.state,{machineId:'local',thread:source,turn:null,threadStatus:'idle',phase:'ready',pending:[],queuedMessage:null,liveMessages:[],activities:[]});
 runtime.pendingTaskNames.set(source.id,{name:source.name,firstMessageAccepted:false});
 await page.goto(`http://127.0.0.1:${server.address().port}`);await open();
 const sourceRow=page.locator('.destination-entry').filter({hasText:source.name});
 await page.locator('.destination-entry').filter({hasText:target.name}).locator('.destination-task').click();
 await sourceRow.locator('.task-selection-error').waitFor();
 runtime.broadcast('snapshot',snapshot());await page.waitForTimeout(30);
 assert.equal(await sourceRow.locator('.task-selection-error').count(),1,'a zero-turn snapshot is not acceptance');
 runtime.broadcast('snapshot',{...snapshot(),connected:false,thread:null,turn:null});await page.waitForTimeout(30);
 assert.equal(await sourceRow.locator('.task-selection-error').count(),1,'disconnect is not successful departure');
 runtime.broadcast('snapshot',snapshot());await page.waitForTimeout(30);
 runtime.pendingTaskNames.get(source.id).firstMessageAccepted=true;
 if(evidence==='turn')runtime.broadcast('turn',{turn:{id:'other-client-turn',status:'inProgress'}});
 else if(evidence==='snapshot'){runtime.state.turn={id:'other-client-turn',status:'completed'};runtime.broadcast('snapshot',snapshot());}
 else {await page.locator('.destination-entry').filter({hasText:target.name}).locator('.destination-task').click();await page.waitForFunction(()=>document.querySelector('#destination-label').textContent.includes('Cross client target'));await open();}
 await page.waitForFunction(()=>!document.querySelector('.task-selection-error'));
 await dismissTasks();await closed();
 runtime.pendingTaskNames.delete(source.id);freshNavigation=false;
 }
 active=savedActiveForFresh;
 // Free-text Async Answer has a compact, right-aligned primary action on its own row.
 for(const width of [1280,390,320])for(const submit of ['Enter','button']){
 await page.setViewportSize({width,height:844});
 const question={id:'answer-layout',role:'assistant',delivery:'async',text:'What should the empty state say?',questions:[{title:'What should the empty state say?',options:[]}],complete:true,createdAt:1000};
 const options={...question,id:'answer-options',text:'Choose a layout',questions:[{title:'Choose a layout',options:['Compact','Spacious']}]};
 Object.assign(runtime.state,{machineId:'local',thread:{...task},turn:null,goal:null,queuedMessage:null,pending:[],liveMessages:[question,options],activities:[]});asyncAnswers={};
 await page.evaluate(()=>{localStorage.setItem('codex-pocket-details-open','false');localStorage.setItem('codex-pocket-enter-sends','true');});
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 const free=page.locator('[data-message-id="answer-layout"] .async-free-text'),answer=free.locator('textarea'),button=free.locator('button');await answer.waitFor();
 const geometry=()=>free.evaluate(e=>{const input=e.querySelector('textarea').getBoundingClientRect(),button=e.querySelector('button'),b=button.getBoundingClientRect(),r=e.getBoundingClientRect(),style=getComputedStyle(button),send=getComputedStyle(document.querySelector('#send-message'));return {right:b.right-input.right,below:b.top-input.bottom,full:input.width===r.width,compact:b.width<input.width,height:b.height,weight:style.fontWeight,accent:style.color===send.color&&style.backgroundColor===send.backgroundColor&&style.borderColor===send.borderColor,overflow:document.documentElement.scrollWidth>innerWidth};});
 const before=await geometry();assert.equal(before.right,0);assert(before.below>=6);assert.equal(before.full,true);assert.equal(before.compact,true);assert.equal(before.height,40);assert.equal(before.weight,'750');assert.equal(before.accent,true);assert.equal(before.overflow,false);
 const choices=page.locator('[data-message-id="answer-options"]');assert.equal(await choices.locator('.async-free-text').isVisible(),false);
 assert.equal(await choices.locator('.async-options button').count(),2);assert.equal(await choices.locator('.async-options button').first().evaluate(e=>getComputedStyle(e).fontWeight),'400');
 await choices.getByRole('button',{name:'Other Answer…',exact:true}).click();await choices.locator('textarea').waitFor();await choices.getByRole('button',{name:'Other Answer…',exact:true}).click();assert.equal(await choices.locator('textarea').isVisible(),false);
 await answer.fill('There are no items yet.');
 if(process.env.POCKET_SCREENSHOT_DIR&&submit==='button')await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/async-answer-${width}.png`});
 const count=calls.filter(c=>c==='/api/message').length;
 uiGate=new Promise(r=>release=r);
 if(submit==='button')await button.click();else await answer.press('Enter');
 await free.getByRole('button',{name:'Sending…',exact:true}).waitFor();assert.equal(await button.isDisabled(),true);assert.deepEqual(await geometry(),before);
 if(process.env.POCKET_SCREENSHOT_DIR&&submit==='button')await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/async-sending-${width}.png`});
 release();uiGate=null;await page.waitForFunction(()=>!document.querySelector('[data-message-id="answer-layout"] .async-answer'));
 assert.equal(calls.filter(c=>c==='/api/message').length,count+1);assert.equal(asyncAnswers[question.id][0],'There are no items yet.');
 }
 // Working Path editing uses selected-runtime settings confirmation without filesystem checks.
 for(const width of [1280,390,320]){
 await page.setViewportSize({width,height:844});
 Object.assign(runtime.state,{machineId:width===390?'ssh:test':'local',thread:{...task,cwd:'C:\\Projects\\current'},turn:null,goal:null,queuedMessage:null,pending:[],liveMessages:[],activities:[]});
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.locator('#project').getByText('C:\\Projects\\current',{exact:true}).waitFor({state:'attached'});
 if(await page.locator('#inspector-button').getAttribute('aria-expanded')!=='true')await page.locator('#inspector-button').click();
 const edit=()=>page.locator('#edit-cwd').click();
 await edit();assert.equal(await page.locator('#cwd-input').inputValue(),'C:\\Projects\\current');
 const initial=cwdEdits.length;
 await page.locator('#cwd-save').click();await page.waitForFunction(()=>!document.querySelector('#cwd-dialog').open);assert.equal(cwdEdits.length,initial);
 await edit();await page.locator('#cwd-input').fill('relative/path');await page.locator('#cwd-save').click();
 await page.locator('#cwd-error').getByText('Enter an absolute project folder on this machine').waitFor();assert.equal(cwdEdits.length,initial);
 cwdFailure=true;await page.locator('#cwd-input').fill('/unavailable');await page.locator('#cwd-save').click();
 await page.locator('#cwd-error').getByText('Folder unavailable on this machine').waitFor();assert.equal(await page.locator('#project').textContent(),'C:\\Projects\\current');assert.equal(await page.locator('#cwd-dialog').evaluate(e=>e.open),true);cwdFailure=false;
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/working-path-error-${width}.png`});
 const next=width===1280?'C:\\Projects\\日本語 résumé':('/home/remote/'+ 'long-project-'.repeat(18));
 cwdGate=new Promise(r=>release=r);await page.locator('#cwd-input').fill('  '+next+'  ');await page.locator('#cwd-save').click();
 await page.waitForFunction(()=>document.querySelector('#cwd-save').disabled);assert.equal(await page.locator('#project').textContent(),'C:\\Projects\\current');
 release();cwdGate=null;await page.waitForFunction(()=>!document.querySelector('#cwd-dialog').open);
 assert.equal(await page.locator('#project').textContent(),next);assert.deepEqual(cwdEdits.at(-1),{machineId:runtime.state.machineId,threadId:task.id,cwd:next});
 const geometry=await page.locator('#edit-cwd').evaluate(e=>{const r=e.getBoundingClientRect();return {w:r.width,h:r.height,overflow:document.documentElement.scrollWidth>innerWidth};});
 assert.deepEqual(geometry,{w:36,h:36,overflow:false});
 if(process.env.POCKET_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.POCKET_SCREENSHOT_DIR}/working-path-${width}.png`});
 await edit();await page.locator('#cwd-input').fill('/stale');const beforeSwitch=cwdEdits.length;
 runtime.state.thread={...owned};runtime.broadcast('snapshot',snapshot());await page.waitForFunction(()=>!document.querySelector('#cwd-dialog').open);
 await page.locator('#cwd-form').evaluate(e=>e.requestSubmit());assert.equal(cwdEdits.length,beforeSwitch);
 await edit();runtime.state.machineId='ssh:changed';runtime.broadcast('snapshot',snapshot());await page.waitForFunction(()=>!document.querySelector('#cwd-dialog').open);assert.equal(cwdEdits.length,beforeSwitch);
 }
 assert.deepEqual(errors,[]);console.log('PASS: desktop/mobile task-keyed text/images, failed selection preserves drafts, send clears drafts, localized Rename/Archive/Delete/Create busy and failures, new task empty, draft eviction returns empty, remote Markdown images unavailable, settings labels and filters, image-card viewer, errored-row retry, both sidebar geometry and matching shells, form control sizes, Tasks focus, frame-by-frame viewport anchoring, diff wrapping and bulk display filters');
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));for(const body of fileBodies)await rm(join(tmpdir(),'codex-pocket',body.submissionId),{recursive:true,force:true});}
