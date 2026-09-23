import test from 'node:test';
import assert from 'node:assert/strict';
import { ArclcAdapter } from '../src/platforms/arclc.mjs';

const email = 'target@example.com';
const selected = (organization = 'ALLCPR Inc.', role = 'Instructor', address = email) => ({ cells: ['', organization, '', 'Test Teacher', address, '', role] });

test('selection guard rejects extra people, other organizations, protected roles, and select-all', async () => {
  const adapter = new ArclcAdapter({}, {});
  for (const rows of [[selected(), selected('ALLCPR Inc.', 'Instructor', 'other@example.com')], [selected('Other Org')], [selected('ALLCPR Inc.', 'Administrator')], [{ cells: ['Choose a row'] }], []]) {
    adapter.readSelections = async () => rows;
    await assert.rejects(() => adapter.assertSelection(email, 1), /Selected rows/);
  }
  adapter.readSelections = async () => [selected()];
  await adapter.assertSelection(email, 1);
});

test('aria-selected cannot substitute for checked input', async () => {
  const adapter = new ArclcAdapter({}, {});
  assert.equal(await adapter.rowIsSelected({ getAttribute: async () => 'true' }, { isChecked: async () => false }), false);
});

test('missing organization selector never allows processing', async () => {
  const page = {
    url: () => 'https://www.redcrosslearningcenter.org/s/manage-instructors',
    getByRole: () => ({}), locator: () => ({ count: async () => 0 })
  };
  const adapter = new ArclcAdapter({ sites: { arclc: { implementationStatus: 'ready', organizationLabel: 'ALLCPR Inc.' } } }, page);
  adapter.waitForGrid = async () => true;
  adapter.dismissCookieBanner = async () => {};
  await assert.rejects(() => adapter.prepare(), /selector missing/);
});

test('absence requires fresh read; reappearing teacher is READY', async () => {
  const adapter = new ArclcAdapter({}, {});
  adapter.searchExactRows = async () => [];
  adapter.freshMatches = async () => [{ role: 'Instructor', name:'Test Teacher' }];
  assert.equal((await adapter.inspect({ email,fullName:'Test Teacher' })).status, 'READY');
  adapter.freshMatches = async () => { throw new Error('login required'); };
  await assert.rejects(() => adapter.inspect({ email,fullName:'Test Teacher' }), /login required/);
  adapter.freshMatches = async () => [];
  assert.equal((await adapter.inspect({ email,fullName:'Test Teacher' })).status, 'ABSENT_VERIFIED');
});

test('ARC mismatched or missing names cannot reach selection; normalized whitespace/case may match',async()=>{
  const adapter=new ArclcAdapter({sites:{arclc:{implementationStatus:'ready'}}},{});
  adapter.freshMatches=async()=>[{name:'Different Person',role:'Instructor'}];
  adapter.readSelections=async()=>{throw new Error('Selection must not be reached');};
  for(const fullName of [undefined,'','Test Teacher']) {
    assert.equal((await adapter.inspect({email,fullName})).status,'MANUAL_REVIEW');
    assert.equal((await adapter.unalign({email,fullName})).status,'MANUAL_REVIEW');
  }
  adapter.freshMatches=async()=>[{name:' TEST   TEACHER ',role:'Instructor'}];
  assert.equal((await adapter.inspect({email,fullName:'Test Teacher'})).status,'READY');
  adapter.readSelections=async()=>[selected()];
  await assert.rejects(adapter.assertSelection(email,1,'Other Person'),/Selected rows/);
});
