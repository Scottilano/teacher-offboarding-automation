import test from 'node:test';
import assert from 'node:assert/strict';
import {coverageDecision,readCoverageDom,scrollCoverageDom} from '../src/platforms/arclc-coverage.mjs';
import {ArclcAdapter} from '../src/platforms/arclc.mjs';
const full={knownRegion:true,atEnd:true,busy:false,declaredRows:null,enabledPaging:false,pagingRegion:false,geometry:[]};

test('ARC coverage requires list end, known region and no loading or paging; declared counts must match',()=>{
  assert.equal(coverageDecision(full,2).complete,true);
  for(const change of [{atEnd:false},{knownRegion:false},{busy:true},{declaredRows:9},{enabledPaging:true},{pagingRegion:true},{declaredRows:-1}]) {
    assert.equal(coverageDecision({...full,...change},2).complete,false);
  }
  assert.equal(coverageDecision({...full,declaredRows:3},2).complete,true);
});

function fixture(mode) {
  let tick=0,scrolled=0;
  const row=email=>({cells:['','ALLCPR Inc.','','Test Teacher',email,'','Instructor']});
  const header={cells:['','Organization','Address','Name','Email','Phone','Role']};
  const grid={evaluate:async(fn,reset)=>{
    if(fn===scrollCoverageDom){scrolled++;return;}
    assert.equal(fn,readCoverageDom);
    return {...full,atEnd:tick>=2,declaredRows:mode==='partial'?3:mode==='grow'?3:null,enabledPaging:mode==='pagination'};
  }};
  const select={count:async()=>1,inputValue:async()=> 'company',getByRole:()=>({count:async()=>1,getAttribute:async()=> 'company'})};
  const page={url:()=> 'https://www.redcrosslearningcenter.org/s/manage-instructors',getByRole:()=>grid,
    locator:selector=>selector==='select'?select:{filter:()=>({count:async()=>0})},waitForTimeout:async()=>{tick++;}};
  const adapter=new ArclcAdapter({sites:{arclc:{implementationStatus:'ready',organizationLabel:'ALLCPR Inc.'}},safety:{tableTimeoutMs:mode==='grow'?1000:30}},page);
  adapter.waitForGrid=async()=>true;adapter.dismissCookieBanner=async()=>{};
  adapter.readTable=async()=>[header,...(mode==='shrink'&&tick>2?[row('second@example.com')]:[row('first@example.com'),...(mode==='grow'&&tick>=10?[row('target@example.com')]:[])])];
  return {adapter,ticks:()=>tick,scrolls:()=>scrolled};
}
test('ARC waits for delayed appended rows even when the first partial table is stable',async()=>{
  const f=fixture('grow');const rows=await f.adapter.prepare();
  assert.equal(rows.length,2);assert.ok(f.ticks()>=18);assert.ok(f.scrolls()>10);
  assert.equal(f.adapter.coverageEvidence.rowCount,2);
});
test('ARC partial counts, pagination and virtualized rows cannot pass preparation',async()=>{
  for(const mode of ['partial','pagination','shrink']) await assert.rejects(fixture(mode).adapter.prepare());
});
