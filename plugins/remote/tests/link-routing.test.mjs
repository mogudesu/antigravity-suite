import test from 'node:test';
import assert from 'node:assert/strict';
import { unpackShareCard, parseWechatCard, parseQqCard, extractUrls, isPrivateHost } from '../src/channels/shared/share-card.mjs';
import { classifyLink, buildRoutingHint, userOptedOut, matchHost } from '../src/channels/shared/link-router.mjs';

test('微信 appmsg 卡片：取出真实链接与标题', () => {
  const xml = `<msg><appmsg><title><![CDATA[一篇好文]]></title><url><![CDATA[https://mp.weixin.qq.com/s/abc123]]></url></appmsg></msg>`;
  const card = parseWechatCard(xml);
  assert.equal(card.kind, 'wechat-appmsg');
  assert.equal(card.url, 'https://mp.weixin.qq.com/s/abc123');
  assert.equal(card.title, '一篇好文');
  assert.equal(parseWechatCard('普通文本'), null);
});

test('QQ 结构化卡片：jumpUrl 优先，扫不到就扫 JSON', () => {
  const json = JSON.stringify({ app: 'com.tencent.structmsg', meta: { news: { title: 'B站视频', jumpUrl: 'https://b23.tv/xyz' } } });
  const card = parseQqCard(json);
  assert.equal(card.kind, 'qq-card');
  assert.equal(card.url, 'https://b23.tv/xyz');
  assert.equal(card.title, 'B站视频');

  const fallback = parseQqCard(JSON.stringify({ meta: { detail_1: { title: 'x', qqdocurl: '' }, raw: 'https://www.bilibili.com/video/BV1aa' } }));
  assert.equal(fallback.url, 'https://www.bilibili.com/video/BV1aa');
});

test('unpackShareCard：卡片链接排在前面且去重', () => {
  const xml = '<msg><appmsg><title>t</title><url>https://mp.weixin.qq.com/s/a</url></appmsg></msg>';
  const { urls, card } = unpackShareCard(`${xml} 另外 https://mp.weixin.qq.com/s/a 和 https://example.com/x`);
  assert.equal(card.url, 'https://mp.weixin.qq.com/s/a');
  assert.equal(urls[0], 'https://mp.weixin.qq.com/s/a');
  assert.equal(urls.filter((u) => u === 'https://mp.weixin.qq.com/s/a').length, 1, '不能重复');
  assert.ok(urls.includes('https://example.com/x'));
});

test('extractUrls 去掉尾部标点', () => {
  assert.deepEqual(extractUrls('看这个 https://a.com/x。还有 https://b.com/y）'), ['https://a.com/x', 'https://b.com/y']);
});

test('内网地址不深读', () => {
  assert.equal(isPrivateHost('127.0.0.1'), true);
  assert.equal(isPrivateHost('192.168.1.5'), true);
  assert.equal(isPrivateHost('10.0.0.2'), true);
  assert.equal(isPrivateHost('localhost'), true);
  assert.equal(isPrivateHost('www.bilibili.com'), false);
});

test('链接分类：平台页要 Envoy，代码 Diff 不要', () => {
  assert.equal(classifyLink('https://www.xiaohongshu.com/explore/abc').needEnvoy, true);
  assert.equal(classifyLink('https://mp.weixin.qq.com/s/abc').kind, 'platform');
  assert.equal(classifyLink('https://www.bilibili.com/video/BV1xx').needEnvoy, true);
  assert.equal(classifyLink('https://github.com/a/b/commit/123').kind, 'code');
  assert.equal(classifyLink('https://github.com/a/b/commit/123').needEnvoy, false);
  assert.equal(classifyLink('https://github.com/a/b').needEnvoy, true);
  assert.equal(classifyLink('https://example.com/post').needEnvoy, false);
  assert.equal(classifyLink('not-a-url').kind, 'invalid');
  assert.equal(classifyLink('http://127.0.0.1:8791/api/health').kind, 'private');
});

test('注入提示只列需要深读的，最多 3 条', () => {
  const hint = buildRoutingHint([
    'https://mp.weixin.qq.com/s/1',
    'https://github.com/a/b/commit/2',
    'https://example.com/plain',
    'https://www.bilibili.com/video/BV1',
    'https://xhslink.com/x',
    'https://www.zhihu.com/question/1',
  ]);
  assert.ok(hint.startsWith('[envoy-link-routing]'));
  assert.ok(hint.includes('mp.weixin.qq.com/s/1'));
  assert.ok(!hint.includes('github.com/a/b/commit/2'), '代码页不该被列进去');
  assert.ok(!hint.includes('example.com/plain'), '普通网页先直接抓');
  assert.equal((hint.match(/^\d\. /gm) || []).length, 3, '最多 3 条');
});

test('用户说"不用 envoy"就不注入', () => {
  assert.equal(userOptedOut('这篇不用 envoy 了'), true);
  assert.equal(userOptedOut('直接读就行'), false);
  assert.equal(buildRoutingHint(['https://mp.weixin.qq.com/s/1'], { userSaidNoEnvoy: true }), '');
});

test('matchHost 支持子域', () => {
  assert.equal(matchHost('www.bilibili.com', ['bilibili.com']), true);
  assert.equal(matchHost('bilibili.com', ['bilibili.com']), true);
  assert.equal(matchHost('evilbilibili.com', ['bilibili.com']), false);
});

test('按域名挑 cookie：小红书/抖音/X 各自独立', async () => {
  const { cookieKeyFor } = await import('../src/proactive/scouts/link-reader.mjs');
  assert.equal(cookieKeyFor('https://www.xiaohongshu.com/explore/abc'), 'xhs');
  assert.equal(cookieKeyFor('https://xhslink.com/x'), 'xhs');
  assert.equal(cookieKeyFor('https://www.douyin.com/video/1'), 'douyin');
  assert.equal(cookieKeyFor('https://x.com/someone/status/1'), 'twitter');
  assert.equal(cookieKeyFor('https://twitter.com/a'), 'twitter');
  assert.equal(cookieKeyFor('https://mp.weixin.qq.com/s/x'), '', '公众号公开可读，不需要 cookie');
  assert.equal(cookieKeyFor('not-a-url'), '');
});
