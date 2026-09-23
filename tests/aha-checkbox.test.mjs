import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAhaDisciplines } from '../src/platforms/aha.mjs';

function fixture({ selected = false, disabled = false, wrongFor = false, duplicateLabel = false, extraSelection = false, noEffect = false, changedId = false } = {}) {
  const nodes = ['BLS', 'Heartsaver'].map((name, i) => ({
    id: i ? 'Heartsaver' : 'Basic Life Support', checked: selected && i === 0, disabled,
    labels: [{ textContent: name + ' ', htmlFor: i ? 'Heartsaver' : 'Basic Life Support' }]
  }));
  if (wrongFor) nodes[0].labels[0].htmlFor = 'Another Checkbox';
  const clicks = [];
  const dialog = {
    getByRole: role => {
      assert.equal(role, 'checkbox');
      return { evaluateAll: async fn => fn(nodes) };
    },
    locator: selector => {
      const id = JSON.parse(selector.slice('label[for='.length, -1));
      return {
        count: async () => duplicateLabel ? 2 : 1,
        click: async options => {
          assert.equal(options.force, undefined);
          clicks.push(id);
          if (!noEffect) nodes.find(n => n.id === id).checked = true;
          if (extraSelection) nodes.forEach(n => { n.checked = true; });
          if (changedId) nodes[0].id = 'Changed';
        }
      };
    }
  };
  return { dialog, clicks, nodes };
}

test('AHA selects associated labels, including IDs with spaces, and verifies native checked state', async () => {
  const f = fixture();
  await selectAhaDisciplines(f.dialog, ['Heartsaver','BLS']);
  assert.deepEqual(f.clicks, ['Heartsaver','Basic Life Support']);
  assert.ok(f.nodes.every(n => n.checked));
});

test('AHA refuses ambiguous, disabled or preselected checkboxes without clicking', async () => {
  for (const opts of [{ selected:true }, { disabled:true }, { wrongFor:true }, { duplicateLabel:true }]) {
    const f = fixture(opts);
    await assert.rejects(selectAhaDisciplines(f.dialog, ['BLS','Heartsaver']), /Remove was not clicked/);
    assert.deepEqual(f.clicks, []);
  }
});

test('AHA rejects unexpected selection and changed checkbox identities after label click', async () => {
  for (const opts of [{ extraSelection:true }, { changedId:true }]) {
    const f = fixture(opts);
    await assert.rejects(selectAhaDisciplines(f.dialog, ['BLS','Heartsaver']), /Remove was not clicked/);
    assert.equal(f.clicks.length, 1);
  }
});

test('AHA does not infer success when label click has no effect', async () => {
  const f = fixture({ noEffect:true });
  await assert.rejects(selectAhaDisciplines(f.dialog, ['BLS','Heartsaver']), /did not remain selected/);
  assert.equal(f.clicks.length, 1);
  assert.ok(f.nodes.every(n => !n.checked));
});
