/**
 * 生成可托管到**境外**的自包含隐私政策页 → extension/store/privacy-policy.html
 *
 * 用法：npx tsx scripts/privacy-page.ts
 *
 * 【为什么需要它】beacon.iyunci.cn 在国内节点，**从境外访问不通**：请求能进到 nginx
 * （日志里有 Google-CWS 的记录），响应回不去，nginx 记成 444 / 0 字节；境外抓取服务
 * （r.jina.ai / allorigins）分别报「HTTP/2 framing 层 stream error」和 522。
 * Chrome 应用商店的审核机器在境外，于是无论页面本身多正常，它都只会显示
 * 「无法访问隐私权政策链接」。这不是 robots / WAF / UA / 协议的问题——全部排查过了。
 * 所以商店那一栏得填一个**境外可达**的地址，本文件就是拿去托管的那一份。
 *
 * 【为什么要拼两段】线上那页讲的是**平台**（手机号、人设、发布记录、IP、日志），
 * 而审核要看的是**扩展**收集什么（页面标题/网址、正文摘录、采集令牌）。
 * 只放平台那份会被追问，只放扩展那份又和产品对不上——两段都要，且必须与
 * extension/store/privacy.md 的口径一致（那里是逐条对着代码写的）。
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = 'https://beacon.iyunci.cn/legal/privacy';
const OUT = resolve(process.cwd(), 'extension/store/privacy-policy.html');

// 扩展专属章节。内容与 extension/store/privacy.md 同源——那份是对着代码逐条核过的，
// 改代码时两处要一起改：披露与实际行为不符是下架级问题，不是文案问题。
const EXTENSION_SECTION = `
<h2>十一、浏览器扩展「烽火台采集助手」的数据处理</h2>

<p>本章节专门说明 Chrome 扩展「烽火台采集助手」的数据处理方式。该扩展的
<strong>唯一用途</strong>是：在用户主动打开的页面上，把用户亲眼可见的、已在页面渲染的数据，
经用户点击回传到<strong>用户自己配置的</strong>烽火台工作区，用于竞品分析与自有内容表现记录。</p>

<h3>11.1 扩展收集并传输的数据</h3>
<table>
  <tr><th>数据</th><th>何时发生</th><th>发往哪里</th></tr>
  <tr>
    <td>受支持平台<strong>公开页面</strong>上的公开信息：账号昵称/ID、粉丝数、作品标题、公开互动指标</td>
    <td>用户点击「加为竞对并采集」时；或对<strong>用户已订阅的</strong>竞对，在用户主动打开其公开主页时（可在设置中关闭）</td>
    <td>仅用户自己配置的烽火台服务器</td>
  </tr>
  <tr>
    <td>用户<strong>本人</strong>创作者后台中<strong>用户自己作品</strong>的表现数字（播放/阅读、点赞、评论、转发、收藏、完播率等）</td>
    <td>用户点击「这是我的作品 · 回填数据看板」时；或用户显式开启「每天自动回填」后按设定时间执行</td>
    <td>同上</td>
  </tr>
  <tr>
    <td>当前页面的<strong>标题、网址、作者名</strong>与用户填写的备注</td>
    <td>用户点击「收进灵感箱」或右键菜单时，仅一次</td>
    <td>同上</td>
  </tr>
  <tr>
    <td>当前页面的标题、<strong>可见正文摘录（上限 4000 字符）</strong>与该页公开指标</td>
    <td>用户点击「爆款拆解 / 衍生选题 / AI 问答」时，仅一次</td>
    <td>同上，用于生成 AI 分析结果</td>
  </tr>
  <tr>
    <td>用户填写的服务器地址与<strong>采集令牌</strong></td>
    <td>用户在设置中填写后保存在本机</td>
    <td>仅随请求发往用户自己配置的服务器，用于认证</td>
  </tr>
</table>

<h3>11.2 扩展不收集的数据</h3>
<ul>
  <li><strong>不收集浏览历史。</strong>侧栏助手虽然注入在所有网站上，但<strong>不记录、也不上报用户访问过哪些页面</strong>；
      只有用户对某一页主动点击上述按钮时，那一页的信息才会被发送一次。</li>
  <li><strong>不读取、不存储、不上传任何平台的 Cookie 或登录凭证</strong>，不代替用户登录，
      不调用任何平台的接口，不发布、不修改、不删除任何内容。</li>
  <li>除用户本人创作者后台中<strong>用户自己的</strong>作品数据外，不获取任何平台的非公开数据；
      任何情况下都不采集他人的非公开数据。</li>
  <li>不收集键盘输入内容、位置、健康、财务信息，不收集其它网站的数据。</li>
</ul>

<h3>11.3 权限用途</h3>
<table>
  <tr><th>权限</th><th>用途</th></tr>
  <tr><td><code>storage</code></td><td>保存用户填写的服务器地址、采集令牌与各项开关。</td></tr>
  <tr><td><code>activeTab</code></td><td>读取当前标签页地址，判断是否为受支持页面。仅当前标签、仅用户操作时。</td></tr>
  <tr><td><code>alarms</code></td><td>每日定时刷新图标角标；用户开启后的定时回填。</td></tr>
  <tr><td><code>notifications</code></td><td>每日提醒与自动回填的结果通知，可关闭。</td></tr>
  <tr><td><code>sidePanel</code></td><td>把助手界面开在浏览器侧边栏中。</td></tr>
  <tr><td><code>contextMenus</code></td><td>右键菜单「收进灵感箱」，仅在用户点击该菜单项时发送一次。</td></tr>
  <tr><td>内容脚本注入范围 <code>&lt;all_urls&gt;</code></td>
      <td>让用户在任意页面都能唤出侧栏助手。<strong>注入不等于采集</strong>：默认只渲染一个悬浮按钮，
          不读取也不上传任何内容；整个侧栏可在扩展设置中关闭。</td></tr>
</table>

<h3>11.4 数据流向与用户控制</h3>
<ul>
  <li>扩展采集的数据<strong>仅发往用户自己配置的服务器地址</strong>，不发往任何第三方，不出售、
      不用于与上述单一用途无关的目的、不用于判定信用资格。</li>
  <li>扩展<strong>不加载任何远程代码</strong>：所有脚本随安装包分发，运行时只请求数据接口。</li>
  <li>「访问即采」「每日提醒」「每天自动回填」「页内侧栏」均可在扩展设置中关闭。</li>
  <li>采集令牌可在烽火台设置页随时轮换或停用，停用后扩展立即无法回传。</li>
  <li>用户在烽火台<strong>注销账号</strong>后，采集令牌随工作区一并作废；扩展随即<strong>停止全部自动采集，
      并删除保存在本机的令牌与全部缓存</strong>（工作区名称、竞对清单、创作者账号清单、采集记录）。
      在完成注销的那台浏览器上即时生效；其它设备上的扩展在下次尝试回传发现令牌失效时自动完成同样的清除。</li>
  <li>被监控账号的主体可通过「被监控账号移除申请」页面申请移除。</li>
</ul>
`;

async function main() {
  const html = await (await fetch(SRC)).text();
  const m = html.match(/<article class="legal-article">([\s\S]*?)<\/article>/);
  if (!m) throw new Error('没能从线上页面抽出 legal-article 容器——页面结构可能改了');

  const body = m[1]
    // 站内相对链接在境外托管时点不开，一律换成线上绝对地址
    .replace(/href="\/legal\/([a-z-]+)"/g, 'href="https://beacon.iyunci.cn/legal/$1"')
    .replace(/ class="[^"]*"/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const out = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>隐私政策 — 烽火台采集助手</title>
<style>
  body { max-width: 840px; margin: 0 auto; padding: 44px 20px 90px;
         font: 16px/1.85 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif; color:#1f2328; }
  h1 { font-size: 30px; margin: 0 0 6px; }
  h2 { font-size: 20px; margin: 36px 0 10px; padding-top: 8px; border-top: 1px solid #eaecef; }
  h3 { font-size: 17px; margin: 24px 0 8px; }
  p, li { color: #333a42; }
  li { margin: 4px 0; }
  code { background:#f6f8fa; padding:1px 5px; border-radius:4px; font-size:14px; }
  a { color:#0969da; }
  table { border-collapse: collapse; width:100%; margin:14px 0; font-size:15px; }
  th, td { border:1px solid #d6d9dd; padding:9px 11px; text-align:left; vertical-align: top; }
  th { background:#f6f8fa; }
  footer { margin-top:50px; padding-top:16px; border-top:1px solid #eaecef; color:#656d76; font-size:14px; }
</style>
${body}
${EXTENSION_SECTION}
<footer>
  本页是烽火台采集助手（Chrome 扩展）隐私政策的公开镜像，内容与
  <a href="https://beacon.iyunci.cn/legal/privacy">beacon.iyunci.cn/legal/privacy</a> 一致。
  数据删除 / 移除监控申请：<a href="https://beacon.iyunci.cn/legal/data-request">被监控账号移除申请</a>。
</footer>
`;
  writeFileSync(OUT, out);
  console.log(`✓ ${OUT}`);
  console.log(`  ${out.length} 字符 · 把它传到任意境外静态托管，把得到的网址填进商店「隐私权政策」栏`);
}

main().catch((e) => { console.error(e); process.exit(1); });
