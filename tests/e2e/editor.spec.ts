import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { booster } from '../../src/examples';
async function open(page:Page){
 await page.goto('./');
 await page.waitForFunction(()=>!!(window as any).__scada);
}

const api=(page:Page)=>page.evaluate(()=>({source:(window as any).__scada.source,error:(window as any).__scada.error,flows:(window as any).__scada.flows,warnings:(window as any).__scada.warnings}));
async function choose(page:Page,id:string){await page.locator(`[data-node="${id}"]`).click();await expect(page.locator('.inspector-id')).toHaveText(id);}
async function field(page:Page,name:string,value:string){const el=page.locator(`#field-${name}`);await el.fill(value);await el.press('Tab');}
const rotor=(page:Page)=>page.locator('[data-node="P-101"] [data-part="rotor"]').getAttribute('transform');
const phase=(page:Page)=>page.locator('[data-flow]').first().getAttribute('stroke-dashoffset');
const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(async({page})=>{const errors:string[]=[];browserErrors.set(page,errors);page.on('pageerror',e=>errors.push(e.message));await open(page)});
test.afterEach(async({page},info)=>{
 if(!page.isClosed()) await info.attach('render', {body:await page.screenshot(),contentType:'image/png'});
 expect(browserErrors.get(page) ?? []).toEqual([]);
});
test('boot: code editor, connected geometry, visible water, real rotor movement',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 expect((await api(page)).error).toBeNull();expect((await api(page)).warnings).toEqual([]);
 await expect(page.locator('[data-node]')).toHaveCount(8);await expect(page.locator('[data-edge]')).toHaveCount(5);
 await expect(page.locator('.node.selected')).toHaveCount(0);
 const a=await rotor(page),p=await phase(page);
 await expect.poll(()=>rotor(page)).not.toBe(a);await expect.poll(()=>phase(page)).not.toBe(p);
 expect(await page.locator('[data-water]').first().getAttribute('stroke')).toBe('#08a7c5');expect(errors).toEqual([]);
});
test('drag patches TS x/y; all comments survive; one undo restores the whole gesture',async({page})=>{
 const original=(await api(page)).source;
 const node=page.locator('[data-node="P-101"] .node-hit');const box=(await node.boundingBox())!;
 await page.mouse.move(box.x+box.width*.7,box.y+box.height*.65);await page.mouse.down();await page.mouse.move(box.x+box.width*.7+45,box.y+box.height*.65+30,{steps:8});await page.mouse.up();
 const changed=await api(page);expect(changed.error).toBeNull();expect(changed.source).not.toBe(original);expect(changed.source.replace(/x: \d+, y: \d+, rpm: 1500/, 'POSITION')).toBe(original.replace(/x: \d+, y: \d+, rpm: 1500/, 'POSITION'));
 await page.locator('#undo').click();expect((await api(page)).source).toBe(original);await page.locator('#redo').click();expect((await api(page)).source).toBe(changed.source);
});
test('closing valve stops water but not independently powered rotor',async({page})=>{
 await choose(page,'V-101');await field(page,'opening','0');expect((await api(page)).source).toContain('opening: 0');expect((await api(page)).flows['P-101']).toBe(0);
 const a=await phase(page),r=await rotor(page);await page.waitForTimeout(350);expect(await phase(page)).toBe(a);expect(await rotor(page)).not.toBe(r);
 await expect(page.locator('#flow-readout')).toHaveText('0.0');
 await field(page,'opening','100');expect((await api(page)).flows['F-101']).toBe(12);const b=await phase(page);await page.waitForTimeout(250);expect(await phase(page)).not.toBe(b);
});
test('RPM slider/number, reverse, quality, trip, pause update the actual renderer',async({page})=>{
 await choose(page,'P-101');await field(page,'rpm','-1500');expect((await api(page)).flows['P-101']).toBeLessThan(0);await page.waitForTimeout(1000);
 const a=Number((await rotor(page))!.match(/rotate\(([-\d.]+)/)![1]);await page.waitForTimeout(100);const b=Number((await rotor(page))!.match(/rotate\(([-\d.]+)/)![1]);expect(b).toBeLessThan(a);
 await page.locator('#field-alarm').selectOption('trip');const stopped=await rotor(page);await page.waitForTimeout(300);expect(await rotor(page)).toBe(stopped);expect((await api(page)).flows['F-101']).toBe(0);
 await page.locator('#field-alarm').selectOption('none');await page.locator('#field-quality').selectOption('bad');expect((await api(page)).flows['F-101']).toBeNull();await expect(page.locator('#flow-readout')).toHaveText('—');
 await page.locator('#field-quality').selectOption('good');await page.locator('#pause').click();const paused=await rotor(page);await page.waitForTimeout(200);expect(await rotor(page)).toBe(paused);await page.locator('#pause').click();
});
test('all equipment fields mutate the same source, with no disconnected UI state',async({page})=>{
 for(const [id,name,v,fragment] of [['T-101','level','25','level: 25'],['HX-101','temperature','96','temperature: 96'],['PT-101','value','8.2','value: 8.2'],['TT-101','offset','140','offset: 140']]){
  await choose(page,id);await field(page,name,v);expect((await api(page)).source).toContain(fragment);expect((await api(page)).error).toBeNull();
 }
});
test('editing TS updates positions and reports bad code without losing last good frame',async({page})=>{
 await page.evaluate(s=>(window as any).__scada.setSource(s),booster.replace('rpm: 1500','rpm: 700'));
 expect((await api(page)).flows['P-101']).toBeCloseTo(12*700/1500*.76);
 await page.evaluate(()=>(window as any).__scada.setSource('while (true) {}'));
 await expect(page.locator('#error-banner')).toBeVisible();await expect(page.locator('[data-node]')).toHaveCount(8);expect((await api(page)).error).not.toBeNull();
 await page.evaluate(()=>(window as any).__scada.undo());expect((await api(page)).error).toBeNull();
});
test('source may be typed with keyboard and undone',async({page})=>{
 await page.locator('.cm-content').click();await page.keyboard.press('ControlOrMeta+End');await page.keyboard.type('\n// keyboard roundtrip');
 expect((await api(page)).source).toContain('// keyboard roundtrip');await page.keyboard.press('ControlOrMeta+z');expect((await api(page)).error).toBeNull();
});
test('computed coordinates cannot be overwritten with a drag or inspector',async({page})=>{
 await page.evaluate(s=>(window as any).__scada.setSource(s),booster.replace('x: 325','x: 300 + 25'));
 await choose(page,'P-101');await expect(page.locator('#field-x')).toBeDisabled();expect((await api(page)).source).toContain('x: 300 + 25');
});
test('palette append, delete, undo work; connect creates TS and tap attaches to it',async({page})=>{
 const s='import { tank, pump } from "@scada/core";\nconst a=tank("T",{x:50,y:250});\nconst b=pump("P",{x:400,y:338});';
 await page.evaluate(s=>{(window as any).__scada.setSource(s);(window as any).__scada.fit()},s);
 await page.locator('#connect-mode').click();await page.locator('[data-owner="T"][data-port="outlet"]').click();await page.locator('[data-owner="P"][data-port="inlet"]').click();
 expect((await api(page)).source).toContain('connect(a.outlet, b.inlet)');await expect(page.locator('[data-edge]')).toHaveCount(1);
 await page.locator('[data-edge] .edge-hit').click();await page.getByRole('button',{name:'+ Манометр',exact:true}).click();await expect(page.locator('[data-kind="pressure"]')).toHaveCount(1);
 await page.locator('#add').click();await page.locator('#palette button').filter({hasText:'Клапан'}).click();expect((await api(page)).source).toContain('valve(');
 await page.locator('#delete-object').click();await expect(page.locator('[data-kind="valve"]')).toHaveCount(0);await page.locator('#undo').click();await expect(page.locator('[data-kind="valve"]')).toHaveCount(1);
});
test('responsive layouts do not overflow or cover the inspector and canvas',async({page})=>{
 for(const [width,height] of [[1920,1080],[1440,900],[1024,768],[390,844],[844,390]]){
  await page.setViewportSize({width,height});await page.waitForTimeout(100);
  const sizes=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,w:innerWidth,body:document.body.scrollHeight,h:innerHeight}));expect(sizes.scroll).toBeLessThanOrEqual(width);expect(sizes.body).toBeLessThanOrEqual(height);
  const svg=(await page.locator('#scene').boundingBox())!;expect(svg.x).toBeGreaterThanOrEqual(0);expect(svg.x+svg.width).toBeLessThanOrEqual(width+1);expect(svg.y+svg.height).toBeLessThanOrEqual(height);
 }
 await page.setViewportSize({width:390,height:844});await page.locator('button[data-tab="code"]').click();await expect(page.locator('.cm-content')).toBeVisible();await page.locator('button[data-tab="inspect"]').click();await expect(page.locator('#inspector-body')).toBeVisible();
});
test('help dialog and standalone HTML export are usable',async({page})=>{
 await page.locator('#help').click();await expect(page.locator('#guide')).toBeVisible();await page.locator('#guide-close').click();
 const downloadEvent=page.waitForEvent('download');await page.locator('#export').click();const d=await downloadEvent;expect(d.suggestedFilename()).toBe('scada-scene.html');const file=await d.path();const html=await readFile(file!,'utf8');expect(html).toContain('id="model"');expect(html).not.toContain('src="http');
 const standalone=await page.context().newPage();await standalone.setContent(html);await expect(standalone.locator('[data-node]')).toHaveCount(8);const r=standalone.locator('[data-part="rotor"]');const a=await r.getAttribute('transform');await standalone.waitForTimeout(200);expect(await r.getAttribute('transform')).not.toBe(a);await standalone.close();
});
test('TS export equals exact source, import and reload retain source',async({page})=>{
 await choose(page,'P-101');await field(page,'rpm','800');const s=(await api(page)).source;
 const dEvent=page.waitForEvent('download');await page.locator('#save').click();const d=await dEvent;expect(await readFile((await d.path())!,'utf8')).toBe(s);
 await page.reload();await page.waitForFunction(()=>!!(window as any).__scada);expect((await api(page)).source).toBe(s);
 const context=await page.context().browser()!.newContext();const fresh=await context.newPage();await fresh.goto('http://127.0.0.1:4173/scada/');await fresh.locator('#file').setInputFiles({name:'roundtrip.ts',mimeType:'text/plain',buffer:Buffer.from(s)});expect((await api(fresh)).source).toBe(s);await context.close();
});
test('shared source loads from a unicode-safe URL hash',async({page})=>{
 const s=booster.replace('opening: 76','opening: 33'),code=Buffer.from(s).toString('base64url');await page.goto('./#code='+code);await page.waitForFunction(()=>!!(window as any).__scada);expect((await api(page)).source).toBe(s);
});

test('deselect and deletion clear stale inspector controls',async({page})=>{
 await choose(page,'V-101');await expect(page.locator('#field-opening')).toBeVisible();
 await page.locator('#deselect').click();await expect(page.locator('.inspector-empty')).toBeVisible();await expect(page.locator('#field-opening')).toHaveCount(0);
 await choose(page,'P-101');await page.locator('#delete-object').click();await expect(page.locator('.inspector-empty')).toBeVisible();await expect(page.locator('#field-rpm')).toHaveCount(0);
 await page.locator('#undo').click();await choose(page,'P-101');await expect(page.locator('#field-rpm')).toBeVisible();
});
