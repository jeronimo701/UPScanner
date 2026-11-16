const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch();
  try {
    const migration = await browser.newPage();
    await migration.addInitScript(() => {
      localStorage.setItem('upscanner.mobile.v1', JSON.stringify({
        current: 'legacy',
        projects: [{id: 'legacy', name: 'Старая проверка', docs: [], scans: {}, defects: {}, missing: {}}],
      }));
      window.Android = {
        loadState: () => undefined,
        saveState: data => { window.migratedState = JSON.parse(data); return true; },
      };
    });
    await migration.goto(pathToFileURL(path.join(__dirname, '../src/main/assets/index.html')).href);
    assert.equal(await migration.evaluate(() => window.migratedState.projects[0].name), 'Старая проверка');
    await migration.close();
    for (const viewport of [{width: 320, height: 640}, {width: 393, height: 852}, {width: 844, height: 390}]) {
      const page = await browser.newPage({viewport, isMobile: true, hasTouch: true});
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        window.Android = {
          scan: () => window.receive('scan', '126207'),
          exportCsv: (_, csv) => { window.exported = csv; },
        };
      });
      await page.goto(pathToFileURL(path.join(__dirname, '../src/main/assets/index.html')).href);
      await page.locator('#projects').click();
      await page.locator('#modal').getByRole('button', {name: 'Новый проект'}).click();
      await page.getByRole('textbox', {name: 'Название проекта'}).fill('Склад');
      await page.getByRole('button', {name: 'Создать'}).click();
      const fixture = {name: 'Накладная.pdf', warnings: ['126207: количество не распознано, подставлено 1'], items: [
        {code: '126207', qty: 1, name: 'Принтер этикеток', ref: '2'},
        {code: '000099', qty: 2, name: 'Весы настольные', ref: '3'},
        {code: '543299', qty: 1, name: 'Весы фасовочные', ref: '4'},
      ]};
      await page.evaluate(doc => window.receive('import', JSON.stringify(doc)), fixture);
      assert.equal(await page.locator('#files').evaluate(details => details.open), true);
      assert.match(await page.locator('#docList').textContent(), /количество не распознано/);
      await page.evaluate(doc => window.receive('import', JSON.stringify(doc)), fixture);
      assert.equal(await page.locator('#docCount').textContent(), '1');
      await page.locator('#camera').click();
      assert.equal(await page.locator('#complete').textContent(), '1');
      assert.equal(await page.locator('.row').last().getAttribute('data-code'), '126207');
      await page.keyboard.press('F8');
      assert.equal(await page.locator('#issues').textContent(), '1');
      const code = page.locator('#code');
      await code.fill('99');
      await code.press('Enter');
      await page.locator('#modal').getByRole('button', {name: /000099/}).click();
      assert.match(await page.locator('[data-code="000099"] .amount').textContent(), /1 \/ 2/);
      await code.fill('999000');
      await code.press('Enter');
      await page.getByRole('button', {name: 'Отсутствует в накладной'}).click();
      await page.locator('[data-filter="issues"]').click();
      assert.equal(await page.locator('.row').count(), 2);
      await page.locator('#export').click();
      assert.match(await page.evaluate(() => window.exported), /126207.*Брак/);
      await page.locator('#projects').click();
      await page.getByRole('button', {name: 'Переименовать'}).click();
      await page.getByRole('textbox', {name: 'Название проекта'}).fill('Склад 2');
      await page.getByRole('button', {name: 'Сохранить'}).click();
      await page.locator('#projects').click();
      await page.getByRole('button', {name: 'В архив', exact: true}).click();
      await page.getByRole('button', {name: 'В архив', exact: true}).click();
      assert.match(await page.locator('#modalBody').textContent(), /АрхивСклад 2/);
      await page.getByRole('button', {name: 'Закрыть'}).click();
      await page.locator('#settings').click();
      await page.getByRole('radio', {name: 'Тёмная'}).check();
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
      await page.getByRole('radio', {name: 'AMOLED'}).check();
      await page.getByText('Инструкция', {exact: true}).click();
      assert.equal(await page.locator('.instructions').evaluate(details => details.open), true);
      await page.getByRole('button', {name: 'Сбросить результаты'}).click();
      await page.getByRole('button', {name: 'Отмена'}).click();
      await page.getByRole('button', {name: 'Закрыть'}).click();
      await page.reload();
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'amoled');
      assert.equal(await page.locator('#project option:checked').textContent(), 'Склад 2');
      assert.equal(await page.locator('#project optgroup[label="Архив"] option').textContent(), 'Склад 2');
      assert.equal(await page.locator('#issues').textContent(), '2');
      assert.equal(await page.locator('.row').count(), 4);
      const sizes = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth,
        viewport: document.documentElement.clientWidth,
        offset: window.scrollX,
      }));
      assert.ok(sizes.page <= viewport.width && sizes.viewport === viewport.width && sizes.offset === 0, JSON.stringify(sizes));
      assert.deepEqual(errors, []);
      if (process.env.QA_SCREENSHOTS) {
        await page.screenshot({path: path.join(process.env.QA_SCREENSHOTS, 'browser-' + viewport.width + '.png')});
      }
      console.log(viewport.width + 'x' + viewport.height + ': OK');
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
