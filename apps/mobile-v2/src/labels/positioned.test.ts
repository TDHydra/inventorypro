import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPositionedDoc, fieldText, type LabelTemplateModel, type LabelField } from './positioned';

const model: LabelTemplateModel = {
  id: 't1', name: 'Test', widthIn: 4, heightIn: 2, dpi: 203,
  fields: [
    { id: 'a', type: 'qr', x: 0, y: 0, w: 0.4, h: 1 },
    { id: 'b', type: 'item_name', x: 0.45, y: 0.1, w: 0.5, h: 0.4, fontPt: 12, align: 'left' },
    { id: 'c', type: 'asset_tag', x: 0.45, y: 0.55, w: 0.5, h: 0.3 },
    { id: 'd', type: 'static_text', x: 0.45, y: 0.85, w: 0.5, h: 0.15, text: 'Property of Acme' },
  ],
};
const data = { name: 'Dewalt Drill', code: 'AM-0007', payload: 'INV:unit:AM-0007' };

test('fieldText binds each field type to the right data / literal', () => {
  assert.equal(fieldText(model.fields[1], data), 'Dewalt Drill');      // item_name → name
  assert.equal(fieldText(model.fields[2], data), 'AM-0007');           // asset_tag → code
  assert.equal(fieldText(model.fields[3], data), 'Property of Acme');  // static_text → literal
  assert.equal(fieldText(model.fields[0], data), '');                  // qr → no text
});

test('buildPositionedDoc emits @page sized to the template + one page-broken block', async () => {
  const html = await buildPositionedDoc(model, [data]);
  assert.match(html, /@page\s*\{\s*size:\s*101\.6mm 50\.8mm/); // 4in×2in → mm
  assert.equal((html.match(/class="plabel"/g) ?? []).length, 1);
});

test('buildPositionedDoc positions each field absolutely as a fraction of the label', async () => {
  const html = await buildPositionedDoc(model, [data]);
  // asset_tag field at x=0.45,y=0.55,w=0.5,h=0.3
  assert.match(html, /left:45\.000%;top:55\.000%;width:50\.000%;height:30\.000%/);
  // bound text present + escaped literal
  assert.ok(html.includes('Dewalt Drill'));
  assert.ok(html.includes('AM-0007'));
  assert.ok(html.includes('Property of Acme'));
  // QR field renders an inline svg
  assert.ok(html.includes('<svg'));
});

test('buildPositionedDoc renders N page-broken blocks for a batch', async () => {
  const html = await buildPositionedDoc(model, [data, { ...data, code: 'AM-0008' }, { ...data, code: 'AM-0009' }]);
  assert.equal((html.match(/class="plabel"/g) ?? []).length, 3);
  assert.ok(html.includes('AM-0008') && html.includes('AM-0009'));
});

test('code128 field renders a barcode svg (no DOM)', async () => {
  const m: LabelTemplateModel = { ...model, fields: [{ id: 'z', type: 'code128', x: 0, y: 0, w: 1, h: 1 } as LabelField] };
  const html = await buildPositionedDoc(m, [data]);
  assert.ok(html.includes('<rect')); // hand-painted bars
});
