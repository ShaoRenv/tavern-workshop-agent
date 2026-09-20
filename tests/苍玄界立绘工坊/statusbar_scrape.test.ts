/**
 * 状态栏图库抠取测试 —— 使用真实的 酒馆助手脚本-状态栏.json 作为 fixture。
 *
 * 验证：base64 HTML 解码、内置 npcList 提取、势力映射、以及"工坊角色不在状态栏脚本内"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  extractEmbeddedHtml,
  extractBuiltinRoles,
  extractSectMap,
  scrapeStatusbarRoles,
} from '../../src/苍玄界立绘工坊/core/statusbar_scrape.ts';

const SCRIPT_PATH = path.join(import.meta.dirname, 'fixtures', '酒馆助手脚本-状态栏.json');
const scriptText = fs.readFileSync(SCRIPT_PATH, 'utf-8');

test('能从状态栏脚本 JSON 中解出内嵌 HTML', () => {
  const html = extractEmbeddedHtml(scriptText);
  assert.ok(html, '应解出 HTML');
  assert.match(html!, /fixedSectMap/);
});

test('能从 HTML 抠出内置角色图库', () => {
  const roles = scrapeStatusbarRoles(scriptText);
  assert.ok(roles.length >= 15, `内置图库应至少 15 人，实际 ${roles.length}`);

  const name = roles.map(role => role.name);
  for (const expected of ['沈慕微', '江念', '潮听澜', '凌长霜', '银摇枝']) {
    assert.ok(name.includes(expected), `内置图库应包含 ${expected}`);
  }
});

test('每个角色都有可用图片地址且带势力', () => {
  const roles = scrapeStatusbarRoles(scriptText);
  for (const role of roles) {
    assert.ok(role.name.length > 0);
    assert.match(role.defaultImg || role.portraitImg, /^https?:\/\//, `${role.name} 应有图片地址`);
    assert.ok(role.sect.length > 0, `${role.name} 应有势力`);
  }
});

test('势力映射取自 fixedSectMap', () => {
  const roles = scrapeStatusbarRoles(scriptText);
  const byName = Object.fromEntries(roles.map(role => [role.name, role]));
  assert.equal(byName['沈慕微'].sect, '天剑宗');
  assert.equal(byName['潮听澜'].sect, '沧溟海阙');
  assert.equal(byName['银摇枝'].sect, '赤铃沙海');
});

test('图库同时给出头像与立绘（部分角色两者不同）', () => {
  const roles = scrapeStatusbarRoles(scriptText);
  const byName = Object.fromEntries(roles.map(role => [role.name, role]));
  const chao = byName['潮听澜'];
  assert.ok(chao.defaultImg.includes('潮听澜头像') || chao.defaultImg.length > 0);
  assert.ok(chao.portraitImg.includes('道友录潮听澜'), '立绘应指向 道友录');
});

test('关键边界：创意工坊角色不在状态栏脚本内（所以必须另读 localStorage）', () => {
  // 这正是设计里"读 localStorage 而非只读状态栏"的依据
  assert.equal(scriptText.includes('紫不语'), false);
  assert.equal(scriptText.includes('cx_workshop_custom_roles'), false);
});

test('脚本文本不含内嵌 HTML 时返回空数组而非抛异常', () => {
  assert.equal(extractEmbeddedHtml('const x = 1;'), null);
  assert.deepEqual(scrapeStatusbarRoles('const x = 1;'), []);
  assert.deepEqual(extractBuiltinRoles('<html></html>'), []);
  assert.deepEqual(extractSectMap('<html></html>'), {});
});
