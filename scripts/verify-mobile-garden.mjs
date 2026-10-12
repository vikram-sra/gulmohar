// Browser regression: run against a dev server on port 5174.
// playwright-cli -s=garden-phone run-code --filename scripts/verify-mobile-garden.mjs
// Models are delayed/blocked only in this browser; no gallery data is written.
async (page) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', msg => { if (msg.type() === 'error' && /shader|VALIDATE|WebGLProgram/i.test(msg.text())) errors.push(msg.text()); });
  await page.unrouteAll({behavior:'wait'});
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/main.js*', async route => {
    const r = await route.fetch();
    await route.fulfill({response:r, body:(await r.text()).replace('new GulmoharApp();', 'window.__gardenTest = new GulmoharApp();')});
  });
  let releaseBanyan;
  const waiting = new Promise(resolve => releaseBanyan = resolve);
  await page.route('**/models/banyan.glb', async route => { await waiting; await route.continue(); });
  await page.goto('http://127.0.0.1:5174/?q=low', {waitUntil:'domcontentloaded'});
  await page.waitForTimeout(9000);
  if (!(await page.locator('#loader').isVisible())) throw new Error('Loader disappeared before banyan finished loading');

  releaseBanyan();
  await page.waitForFunction(() => window.__gardenTest?._revealed, null, {timeout:60000});
  await page.locator('#loader').waitFor({state:'detached',timeout:10000});
  const state = await page.evaluate(() => {
    const app = window.__gardenTest;
    const trees = app.garden.group.getObjectByName('BackgroundTrees');
    let leafReceivers=0, twoSided=0, windDepth=0;
    app.garden.group.traverse(o => { if (o.isMesh && o.material?.side===2) { if(o.receiveShadow) leafReceivers++; if(o.material.shadowSide===2) twoSided++; if(o.customDepthMaterial?.userData.__windInjected) windDepth++; } });
    return {landmarks:app.garden.interactives.map(i=>i.data.id), trees:trees.children.map(t=>t.name), leafReceivers,twoSided,windDepth};
  });
  if (!state.landmarks.includes('banyan') || !state.landmarks.includes('mango')) throw new Error('Missing phone landmarks');
  if (!state.leafReceivers || !state.twoSided || !state.windDepth) throw new Error('Canopy shadow configuration missing');

  await page.unroute('**/models/banyan.glb');
  await page.route('**/models/banyan.glb', route => route.abort());
  await page.route('**/models/mango.glb', route => route.abort());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__gardenTest?._revealed, null, { timeout: 60000 });
  const fallback = await page.evaluate(() => window.__gardenTest.garden.group
    .getObjectByName('BackgroundTrees').children.map(tree => tree.children[0].children.length));
  if (fallback.length !== 2 || fallback.some(count => count < 4)) throw new Error('Missing fallback landmarks');
  if(errors.length) throw new Error(errors.join('\n'));
  await page.unrouteAll({behavior:'wait'});
  return { state, fallback, errors };
}
