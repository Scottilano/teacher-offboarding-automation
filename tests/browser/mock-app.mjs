// Isolated UI acceptance server: fake website sessions and outcomes only.
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startLocalServer } from '../../src/local/server.mjs';
import { LocalCoordinator } from '../../src/local/jobs.mjs';
const baseDir=await mkdtemp(path.join(os.tmpdir(),'offboarding-ui-acceptance-'));
const config={runtime:{baseDir,reportsDir:path.join(baseDir,'reports')},safety:{maxExecuteActions:10},sites:{arclc:{enabled:true,implementationStatus:'ready',organizationLabel:'ALLCPR Inc.',loginUrl:'https://example.invalid/'},aha:{enabled:true,implementationStatus:'discovery_complete',organizationId:'32238',coverageVerified:false}}};
config.safety.protectedTeachers = [];
Object.assign(config.sites.aha, {implementationStatus:'ready',coverageVerified:true,maxBatchActions:3});
const coordinator=new LocalCoordinator(config,{sessionChecker: async () => ({status:'READY', detail:'synthetic login check'}), openSession:async()=>({page:{isClosed:()=>false,goto:async()=>{}},context:{close:async()=>{}}}),adapterFactory:()=>({unalign:async()=>({status:'REMOVED',detail:'Isolated test: simulated refreshed verification, no live website action.'}),inspect:async()=>({status:'READY',detail:'Isolated test: simulated match.'})})});
const app=await startLocalServer({config,coordinator});
console.log('ISOLATED MOCK UI - NO REAL WEBSITE ACTIONS\n'+app.url);
process.on('SIGTERM',()=>app.close()); process.on('SIGINT',()=>app.close());
