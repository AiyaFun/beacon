import { test, expect, type Page } from '@playwright/test';

// 端到端冒烟。选择器用**稳定中文文案 + role**，不依赖 class/DOM 结构（那些会随样式改动漂移）。
// dev 态短信走 Mock：验证码直接回显并自动填入登录表单，故 E2E 无需真实短信即可登录。

// 用带时间戳的手机号，确保每次是全新租户（空人设/空数据），冷启动路径也被覆盖。
function freshPhone(): string {
  const tail = String(Date.now()).slice(-8);
  return `139${tail}`;
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  // 微信登录上线后首屏是「微信一键登录」，手机验证码收进了「其他登录方式」——
  // 少了这一步，整套 e2e 会卡在第一个动作上（找不到手机号输入框）。
  const toPhone = page.getByRole('button', { name: '手机验证码登录' });
  if (await toPhone.isVisible().catch(() => false)) await toPhone.click();
  await page.getByPlaceholder('请输入手机号').fill(freshPhone());
  await page.getByRole('button', { name: '获取验证码' }).click();
  // dev 态回显并自动填入验证码
  await expect(page.getByPlaceholder('6 位验证码')).toHaveValue(/^\d{6}$/);
  // F9-8 合规同意：不勾这个框，登录按钮是 disabled 的。
  // 这一步此前漏了，整套 e2e 因此一直卡在第一个动作上。
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '登录 / 注册' }).click();
  // 登录成功落到今日概览
  await expect(page.getByRole('heading', { name: '今日概览' })).toBeVisible();
}

test('登录 → 今日概览（新租户自动开通，冷启动不崩）', async ({ page }) => {
  await login(page);
  // 空人设新账号应看到引导卡，而不是白屏/500
  await expect(page.getByText('AI 还不认识你')).toBeVisible();
});

test('技能中心：5 个内置技能可见，安装一个即生效', async ({ page }) => {
  await login(page);
  await page.goto('/skills');
  await expect(page.getByRole('heading', { name: '技能中心' })).toBeVisible();
  // 内置技能应齐（抽查两个代表）
  await expect(page.getByText('微信公众号一键排版')).toBeVisible();
  await expect(page.getByText('小红书图文排版')).toBeVisible();

  // 安装「微信公众号一键排版」——定位它所在的卡片，点卡片内的「安装」
  const card = page.locator('.card', { hasText: '微信公众号一键排版' });
  await card.getByRole('button', { name: '安装' }).click();
  await expect(card.getByText('已安装')).toBeVisible();
});

test('选题引擎：生成今日推荐产出候选（空人设也不 500）', async ({ page }) => {
  test.setTimeout(240_000); // 全流程生成比默认 30s 预算长得多
  await login(page);
  await page.goto('/topics');
  await page.getByRole('button', { name: '生成今日推荐' }).first().click();
  // 生成后「已推荐」页签计数 > 0，且出现「采纳」按钮。
  // 单条 expect 的 timeout 顶不过用例总预算（config 里默认 30s），所以上面要先 setTimeout——
  // 否则全流程「八个候选源海选 → AI 精排」（本机实测 40~60s）永远来不及，会被当成功能坏了。
  await expect(page.getByRole('button', { name: '采纳' }).first()).toBeVisible({ timeout: 180_000 });

  // 有推荐之后，三队列的分区标题必须都在——包括当天没货的那队（会显示「这一队今天没有货」）。
  // 空队列整块消失会让用户以为功能坏了（lib/topic/queue.ts）。
  // 注意：**一条推荐都没有时**页面渲染的是空状态引导而不是三个空标题，那是另一条正确路径。
  // 认队列标题上的 emoji 前缀，避开正文里也出现的同名词（如「补充常青储备」按钮）
  await expect(page.getByText('⚡ 今日突击')).toBeVisible();
  await expect(page.getByText('📆 本周窗口')).toBeVisible();
  await expect(page.getByText('🌲 常青储备')).toBeVisible();
});

test('冷启动引导：新账号能看到「哪些来源在沉默、怎么解锁」', async ({ page }) => {
  await login(page);
  await page.goto('/topics');
  // 新租户什么数据都没有 → 引导必须出现，并如实报出几分之几在工作
  await expect(page.getByText('推荐从哪儿来')).toBeVisible();
  await expect(page.getByText(/\d\/8 个来源在工作/)).toBeVisible();
  // 每条沉默都要给出可点的解锁动作，而不是只说「未解锁」
  await expect(page.getByRole('link', { name: /贴一个同行主页链接/ })).toBeVisible();
  // markdown 星号不许漏到页面上（JSX 不解析 markdown，本组件踩过）。
  // 只断言引导卡自己的范围——页面上别的组件不归这条用例管。
  const card = page.locator('.card', { hasText: '推荐从哪儿来' });
  await expect(card.getByText('**')).toHaveCount(0);
});

test('灵感收集箱：手动记一条 → 出现在待用里；从评论挖问题能挖出提问句', async ({ page }) => {
  await login(page);
  await page.goto('/inspiration');
  await expect(page.getByRole('heading', { name: '灵感收集箱' })).toBeVisible();

  // 手动记一条
  await page.getByRole('button', { name: '手动记一条' }).click();
  await page.getByPlaceholder('刷到了什么？（标题或一句话概括）').fill('E2E 冒烟用的一条灵感');
  await page.getByRole('button', { name: '存进收集箱' }).click();
  await expect(page.getByText('E2E 冒烟用的一条灵感')).toBeVisible({ timeout: 15_000 });

  // 从评论里挖问题：混入陈述句，验证只挑出提问
  await page.getByRole('button', { name: '从评论里挖问题' }).click();
  await page.getByPlaceholder(/每行一条评论/).fill(
    ['讲得真好已经三连了', '这个工具收费吗', '请问这个工具收费吗有免费版没'].join('\n'),
  );
  await page.getByRole('button', { name: '挖出提问' }).click();
  await expect(page.getByText(/挖到 \d+ 个问题/)).toBeVisible({ timeout: 15_000 });
  // 陈述句不许被当成问题存进来
  await expect(page.getByText('讲得真好已经三连了')).toHaveCount(0);
  // 默认按「我自己的作品」入库
  await expect(page.getByText('我的读者在问').first()).toBeVisible();

  // 切到「同行的作品」：同一个问题也该各存一条（两边都被问到是有信息量的），且标签要分得开
  await page.getByRole('button', { name: '同行的作品' }).click();
  await expect(page.getByText(/系统不做任何自动抓取/)).toBeVisible();
  await page.getByPlaceholder(/每行一条评论/).fill('这个工具收费吗\n新手应该先学哪个好');
  await page.getByRole('button', { name: '挖出提问' }).click();
  await expect(page.getByText('同行读者在问').first()).toBeVisible({ timeout: 15_000 });
});

// 采纳 → 创作 的接力。这条路径踩过两个坑，都只有真浏览器能测出来：
// ① 采纳成功后这条选题离开「已推荐」分区，server action 触发的 RSC 重渲染会把整张卡片卸载——
//    「去工坊起这篇稿」挂在卡片里就是一闪即逝，用户点不到（表现为「点了采纳直接跳走」）。
//    所以入口挂在页面级的 AcceptedBar 上，这里必须断言它**刷新之后仍然在**。
// ② 工坊此前不接 ?topicId=，点过去只是跳到工坊首页，选题上下文当场丢掉。
test('采纳 → 去工坊：入口留得住，选题跟着走', async ({ page }) => {
  test.setTimeout(300_000); // 全流程生成 + 两次起稿
  await login(page);
  await page.goto('/topics');
  await page.getByRole('button', { name: '生成今日推荐' }).first().click();
  await expect(page.getByRole('button', { name: '采纳' }).first()).toBeVisible({ timeout: 180_000 });

  const first = await acceptFirstTopic(page);
  await expect(page.getByRole('heading', { name: '创作工坊' })).toBeVisible();
  await expect(page.getByText('来自选题引擎')).toBeVisible();
  await expect(page.getByText(/切入角/)).toBeVisible(); // 横幅里带着切入角，说明上下文真跟过来了
  await generateDraft(page, first);

  // 工坊里已经躺着别的草稿时，带过来的选题不能被它顶掉（起的是新的一版，不是改写旧稿）
  await page.goto('/topics');
  const second = await acceptFirstTopic(page);
  expect(second).not.toBe(first);
  await expect(page.getByText('来自选题引擎')).toBeVisible();
  await generateDraft(page, second);
  const list = page.locator('.card', { hasText: '草稿列表' });
  await expect(list.getByText(second)).toBeVisible();
  await expect(list.getByText(first)).toBeVisible();
});

/** 采纳第一条待处理选题 → 断言落地条留得住 → 点进工坊；返回这条选题的标题 */
async function acceptFirstTopic(page: Page): Promise<string> {
  const target = page
    .locator('.card')
    .filter({ has: page.getByRole('button', { name: '采纳', exact: true }) })
    .first();
  const title = (await target.locator('b').first().innerText()).trim();
  await target.getByRole('button', { name: '采纳', exact: true }).click();

  const bar = page.getByRole('status').filter({ hasText: '已采纳' });
  const cta = bar.getByRole('link', { name: /去工坊起这篇稿/ });
  await expect(cta).toBeVisible();
  await expect(bar.getByText(title)).toBeVisible();
  await page.waitForTimeout(3000); // 列表刷新完了入口还得在，用户才点得到
  await expect(cta).toBeVisible();
  await cta.click();
  return title;
}

/** 在工坊点「AI 生成初稿」，等这一版落进草稿列表 */
async function generateDraft(page: Page, title: string): Promise<void> {
  const list = page.locator('.card', { hasText: '草稿列表' });
  const btn = page.getByRole('button', { name: 'AI 生成初稿' });
  await expect(btn).toBeEnabled();
  await page.waitForTimeout(2000); // 等水合：点在水合之前等于没点
  await btn.click();
  // 起草中会换按钮文案；没换说明这一下没落到 React 上，补一次
  const busy = page.getByRole('button', { name: /起草中/ });
  if (!(await busy.isVisible().catch(() => false))) {
    await page.waitForTimeout(1500);
    if (!(await busy.isVisible().catch(() => false))) await btn.click();
  }
  await expect(list.getByText(title)).toBeVisible({ timeout: 90_000 });
}

test('爆款基因：无数据时给引导而不是报错', async ({ page }) => {
  await login(page);
  await page.goto('/genes');
  await expect(page.getByRole('heading', { name: '爆款基因' })).toBeVisible();
  // 新租户没有带播放的发布记录 → 空状态引导，不是 500 也不是编出来的假数字
  await expect(page.getByText('还没有带播放数据的已发布内容')).toBeVisible();
});

test('使用帮助：新功能的入口说明都在（否则用户无从发现）', async ({ page }) => {
  await login(page);
  await page.goto('/help');
  // 用各卡片的副标题定位：主标题「看懂每天的选题推荐」与页面 desc 有重叠文本，会撞 strict mode
  await expect(page.getByText('先做哪个、为什么推给你、怎么开工')).toBeVisible();
  await expect(page.getByText('灵感收集箱 · 读者提问')).toBeVisible();
  await expect(page.getByText('爆款基因 · 每个数都能自己验算')).toBeVisible();
  // 八种来源的说明表
  await expect(page.getByText('抢跑窗口')).toBeVisible();
  await expect(page.getByText('节点日历')).toBeVisible();
});
