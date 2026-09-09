import { chromium } from 'playwright';
const b = await chromium.launch();

async function kill(p) {
  await p.evaluate(() => {
    document.querySelectorAll('[class*=cookie i],[id*=cookie i],[class*=consent i],[id*=consent i]')
      .forEach(e => e.remove());
  });
}

// Desktop
const p = await b.newPage({ viewport: { width: 1512, height: 950 } });
await p.goto('http://localhost:3000/bootes-void.html', { waitUntil: 'networkidle' });
await p.waitForTimeout(4500);
await kill(p);
await p.screenshot({ path: 'shots/01-top.png' });

// Stage in each mode
const modes = [['delta','delta'],['gravityA','gravA'],['gravityB','gravB'],['velocity','vel'],['tidal','tidal']];
await p.evaluate(() => document.querySelector('.bv-stage-grid').scrollIntoView({ block: 'start' }));
await p.waitForTimeout(800);
for (const [val, name] of modes) {
  await p.selectOption('[data-bv-control="mode"]', val);
  await p.waitForTimeout(1300);
  await p.locator('.bv-stage-grid').screenshot({ path: `shots/02-stage-${name}.png` });
}
await p.selectOption('[data-bv-control="mode"]', 'delta');
await p.waitForTimeout(900);

// Headline + cards
await p.evaluate(() => document.querySelector('.bv-headline').scrollIntoView({ block: 'start' }));
await p.waitForTimeout(500);
await p.screenshot({ path: 'shots/03-headline-cards.png' });
await p.evaluate(() => document.querySelectorAll('.bv-card.bv-wide')[0].scrollIntoView({ block: 'center' }));
await p.waitForTimeout(400);
await p.screenshot({ path: 'shots/04-test4.png' });
await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight - 1100));
await p.waitForTimeout(400);
await p.screenshot({ path: 'shots/05-tail.png' });

// Full page (tall)
await p.screenshot({ path: 'shots/00-full.png', fullPage: true });
await p.close();

// Mobile
const m = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await m.goto('http://localhost:3000/bootes-void.html', { waitUntil: 'networkidle' });
await m.waitForTimeout(4500);
await kill(m);
await m.screenshot({ path: 'shots/06-mobile-top.png' });
await m.evaluate(() => document.querySelector('.bv-rail').scrollIntoView({ block: 'start' }));
await m.waitForTimeout(400);
await m.screenshot({ path: 'shots/07-mobile-rail.png' });
await m.close();

// Laptop 1366
const l = await b.newPage({ viewport: { width: 1366, height: 768 } });
await l.goto('http://localhost:3000/bootes-void.html', { waitUntil: 'networkidle' });
await l.waitForTimeout(4200);
await kill(l);
await l.screenshot({ path: 'shots/08-1366.png' });
await l.close();

await b.close();
console.log('done');
