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
<strong>唯一用途</strong>是：把内容平台页面上<strong>已经渲染出来的可见数据</strong>，回传到
<strong>用户自己配置的</strong>烽火台工作区，用于竞品分析、自有内容表现记录与内容研读。</p>

<p>绝大多数情况下，这些页面就是用户本人正在浏览的那一页。少数情况下——每日定时采集、
以及用户在自己工作区里派下来的任务——由扩展在<strong>后台标签页</strong>中打开，采完立即关闭。
<strong>能打开哪些页面是一份写死在扩展代码里的清单</strong>，扩展自己校验，不依赖服务端；
其中「打开指定网址并读取正文」一项<strong>默认关闭</strong>，须由用户显式开启。详见 11.3。</p>

<h3>11.1 扩展收集并传输的数据</h3>
<table>
  <tr><th>数据</th><th>何时发生</th><th>发往哪里</th></tr>
  <tr>
    <td>受支持平台<strong>公开页面</strong>上的公开信息：账号昵称/ID、粉丝数、作品标题、公开互动指标</td>
    <td>三种触发：① 用户点击「加为竞对并采集」时；② 对<strong>用户已订阅的</strong>竞对，在用户主动打开其公开主页时（可在设置中关闭）；
        ③ <strong>每日定时批量采集</strong>——扩展每天在用户设定的时间（默认 09:00）在<strong>后台标签页</strong>中
        逐个打开<strong>用户自己已订阅的</strong>竞对公开主页，读取后<strong>立即关闭该标签页</strong>。
        <strong>此项默认开启</strong>，可在扩展设置中关闭（关闭后定时任务立即清除），时间也可自行指定；
        每轮结束发送系统通知说明结果，不存在无提示的静默采集</td>
    <td>仅用户自己配置的烽火台服务器</td>
  </tr>
  <tr>
    <td>已订阅竞对<strong>公开作品页</strong>上的公开互动指标（用于补齐主页列表拿不到的项）</td>
    <td>用户点击「补齐前 20 条作品详情」时。单轮<strong>最多 20 条、逐条串行</strong>、每条之间有间隔，
        在后台标签页中打开、读完立即关闭；<strong>不并发、不循环、不定时执行</strong></td>
    <td>同上</td>
  </tr>
  <tr>
    <td>用户<strong>本人</strong>创作者后台中<strong>用户自己作品</strong>的表现数字（播放/阅读、点赞、评论、转发、收藏、完播率等）</td>
    <td>用户点击「这是我的作品 · 回填数据看板」时；或用户显式开启「每天自动回填」后按设定时间执行</td>
    <td>同上</td>
  </tr>
  <tr>
    <td>当前页面的<strong>标题、网址、作者名</strong>与用户填写的备注</td>
    <td>用户点击「收进灵感箱」或右键菜单时，仅一次。<strong>这个按钮不上传页面正文</strong></td>
    <td>同上</td>
  </tr>
  <tr>
    <td>当前页面的标题、网址、作者名，<strong>以及页面正文（上限 20000 字符）</strong></td>
    <td>用户点击「存进资讯库」或对应右键菜单时，仅一次。它与「收进灵感箱」走同一个接口，
        区别就在于会额外上传正文并<strong>持久化保存</strong>——资讯库的用途正是留着回看原文</td>
    <td>同上</td>
  </tr>
  <tr>
    <td>当前页面的标题、<strong>可见正文摘录（上限 4000 字符）</strong>与该页公开指标</td>
    <td>用户点击「爆款拆解 / 衍生选题 / AI 问答」时，仅一次</td>
    <td>同上，用于生成 AI 分析结果</td>
  </tr>
  <tr>
    <td>作品详情页的标题/文案/作者/公开指标，外加两样非文本内容：<strong>封面图</strong>
        （把页面上<strong>已经加载出来的</strong>封面取回、缩到 1280px 转成 JPEG）与
        <strong>平台字幕轨</strong>（YouTube / B站 由平台自己提供的字幕文本，含时间戳，最多 2000 条）</td>
    <td>用户点击「一键拆解这条作品」时，仅一次。
        <strong>不下载视频文件、不解析受保护的媒体流、不做任何语音识别、不上传音频</strong></td>
    <td>同上，用于让模型看到画面与口播结构</td>
  </tr>
  <tr>
    <td>公开作品页评论区中<strong>已经显示</strong>的评论<strong>正文文本</strong>（每条 5–300 字，
        超长截断；单次最多 200 条），连同该作品的平台、ID、标题
        与<strong>作品作者的公开账号标识</strong>（作者标识仅用于账号主体申请移除时精确删除其名下的这批内容）。
        <strong>不含评论者昵称、头像、主页链接、用户 ID、IP 属地、评论时间、点赞数与回复关系</strong></td>
    <td>用户<strong>在扩展设置中显式开启</strong>「评论提问采集」后，点击「读评论提问」时，仅一次。
        不滚动、不翻页、不展开、不加载用户没看到的评论；无任何自动或定时触发</td>
    <td>回传到用户自己配置的服务器，供用户阅读自己作品下的读者反馈并做词频统计；
        正文<strong>最长保留 90 天后自动物理删除</strong>，其中被两人以上问过的问题短句另外进入选题参考。
        <strong>不进入任何模型训练或生成语料，不导出</strong></td>
  </tr>
  <tr>
    <td><strong>页面结构骨架</strong>（解析失效时，0.9.4 新增）</td>
    <td>一次采集<strong>确实没读到目标字段</strong>时（多为平台改版），同一字段每次会话只上报一次</td>
    <td>回传到用户自己配置的服务器，仅用于修复解析规则并以规则包下发。
        骨架里<strong>只有形状没有内容</strong>：标签名、类名、<code>data-*</code>/<code>aria-*</code> 的
        <strong>属性名</strong>，文本被替换成形状（数字→NUM，三字以上中文→CJK，
        只保留「粉丝」「获赞」这类两字以内的界面标签词）。
        <strong>属性值只带两种</strong>：<code>role</code>（只收 ARIA 标准词表内的值）与
        <code>data-testid</code> 一类测试标识（只收字母开头、长度 3–40 的标识符形状，
        排除 <code>user-8823</code> 这种以数字结尾的实例 ID）——类名被混淆成随机哈希时，
        它们是仅剩的稳定定位依据。两道闸在服务端再执行一次。
        <strong>不含</strong>正文、标题、昵称、头像、链接、图片、用户 ID。服务端收到后再脱敏一次并限制大小</td>
  </tr>
  <tr>
    <td><strong>失败现场截图</strong>（解析失效时，0.9.9 新增）</td>
    <td>上一行那次上报发生在<strong>用户当前正看着的页面</strong>时（本人当场点击采集、页面在前台）。
        <strong>后台标签页绝不截图</strong>：每日定时、批量采集、工作区派发任务打开的页面都在后台，永远不带截图</td>
    <td>随骨架回传到用户自己配置的服务器：该页压缩截图一张（JPEG，宽缩到 1200 像素以内，
        体积上限约 150KB，超限即放弃）。仅用于核对解析规则是否指对位置、
        以及让受委托的视觉模型生成一句「目标数字在页面哪个区域」的描述辅助诊断（未配置视觉模型则跳过）。
        <strong>最长保存 30 天后自动清空</strong>；截图失败不影响骨架上报</td>
  </tr>
  <tr>
    <td><strong>用户自己写好的发布内容</strong>（一键发布，0.9.4 新增）</td>
    <td>用户在自己的创作后台点「填入本页」时</td>
    <td>不外发：只把用户在烽火台里写好的标题与正文<strong>填进该页表单</strong>。
        <strong>默认不点击发布按钮</strong>；用户可在插件设置里显式开启「代点发布」（默认关），
        开启后仅在标题与正文都填成功、且认出明确的发布按钮时才点，点击前有 5 秒倒计时可取消</td>
  </tr>
  <tr>
    <td>用户填写的服务器地址与<strong>采集令牌</strong></td>
    <td>用户在设置中填写后保存在本机</td>
    <td>仅随请求发往用户自己配置的服务器，用于认证</td>
  </tr>
</table>

<h3>11.1.1 关于「翻页」——两处行为不同，分开说明</h3>
<p><strong>竞对公开主页的作品列表会被滚动加载。</strong>这些主页的作品列表是懒加载的，首屏只渲染约 20 条。
用户触发采集后，扩展会<strong>在该页面内向下滚动</strong>若干次，等平台自己把后续作品渲染出来再读取。
滚动是浏览器里的普通页面操作，<strong>不点击任何按钮、不调用平台任何接口、不发送任何请求</strong>，
读到的仍然只是「用户自己滚下去也能亲眼看到」的同一批公开数字。约束：
① 仅在用户主动点击采集、或在扩展为批量采集（含每日定时批量采集）而在后台打开的标签页中发生，
<strong>用户正在浏览的页面不会被自动滚动</strong>；② 采集结束后<strong>滚动位置还原</strong>；
③ 有硬性上限：<strong>最多 12 次、总计不超过 30 秒、单次最多 50 条作品</strong>，到顶即停。</p>
<p><strong>执行可视化（0.9.10 新增，默认关）。</strong>在扩展设置中开启后，用户<strong>当场点击</strong>
「批量采集 / 回填我的数据」时，扩展为此打开的工作标签页会显示在<strong>前台</strong>、
并叠加一张进度卡（打开页面 → 翻页 → 解析条数 → 完成）。它只改变「让用户看见」，
不改变采集的范围、字段、频率或上述任何上限；被滚动的仍只是扩展自己打开的工作页，
<strong>用户自己正在浏览的其他页面照旧不会被触碰</strong>；每日定时批量采集与后台派发任务
<strong>不受此开关影响，仍全程后台</strong>。进度卡不拦截任何点击，页面关闭即消失。</p>
<p><strong>评论区不滚动、不翻页。</strong>上表「评论正文」那一行写的「不滚动、不翻页、不展开」
只针对评论区，与上面主页列表的滚动是两回事：评论只读屏幕上已经显示的那些，代码里没有一行
scroll/click/sleep。两处行为不同，请勿混读。</p>

<h3>11.2 扩展不收集的数据</h3>
<ul>
  <li><strong>不收集浏览历史。</strong>侧栏助手虽然注入在所有网站上，但<strong>不记录、也不上报用户访问过哪些页面</strong>；
      只有用户对某一页主动点击上述按钮时，那一页的信息才会被发送一次。</li>
  <li><strong>不读取、不存储、不上传任何平台的 Cookie 或登录凭证</strong>，不代替用户登录，
      不发布、不修改、不删除任何内容。
      <strong>未登录时的处理</strong>：公众号相关的两条通道要用到用户本人已登录的公众号后台；
      当扩展为采集而在后台打开的那一页停在<strong>登录页</strong>时，扩展不会替用户登录，
      也不会悄悄关掉它，而是把这个已经打开的页面<strong>切到前台</strong>交给用户本人扫码
      （不填写账号密码、不点击登录按钮、不处理二维码），最长等待 <strong>5 分钟</strong>，
      到点仍未登录即停止并如实告知；切到前台后该页由用户自行处置，扩展不再自动关闭它。
      此行为只在用户当场点击采集时发生，定时任务不会弹出任何前台页面。
      <strong>唯一一处会调用平台接口的是公众号竞对采集</strong>：公众号没有公开网页主页，
      所以这条通道是在<strong>用户本人已登录的公众号后台内</strong>，调用后台自带的两个查询接口
      （按名称搜号、读该号的已群发公开图文列表），只取标题/链接/发布时间/摘要，
      <strong>不取阅读量与在看、不下载文章正文</strong>；仅在用户主动触发时发生，
      并有写死的频率上限（每次只取最近 7 天、最多 2 页、请求间隔 3–6 秒、同号 12 小时一次、
      一轮最多 5 个号、撞频控即停 30 分钟且不重试）。除此之外不调用任何平台接口。
      <strong>该通道的风险如实告知</strong>：这两个接口<strong>不是微信官方开放的数据接口</strong>，
      以自动化方式调用它们<strong>可能违反《微信公众平台服务协议》及其运营规范</strong>；
      由此产生的接口限制或账号处罚，后果落在<strong>用户自己的公众号账号</strong>上。
      因此该功能<strong>默认关闭</strong>，首次使用时扩展弹出单独的风险确认（须勾选知悉才继续），
      之后可随时关闭。上述节流规则只能降低触发风控的概率，<strong>不能消除该风险</strong>。</li>
  <li>除用户本人创作者后台中<strong>用户自己的</strong>作品数据外，不获取任何平台的非公开数据；
      任何情况下都不采集他人的非公开数据。</li>
  <li><strong>不采集评论者的身份信息。</strong>开启评论提问采集后，扩展只取评论<strong>正文</strong>；
      昵称、头像、主页链接、用户 ID、IP 属地、评论时间、点赞数、楼层回复关系、@提及对象
      <strong>一概不取</strong>（回传结构里没有这些字段），也不做任何跨评论的身份关联或画像。
      夹带疑似手机号、邮箱、身份证号、社交账号 ID 的评论<strong>整条丢弃</strong>，不脱敏、不截断。
      <strong>关于这些正文的法律定性，据实说明</strong>：剥离上述九项身份字段后，留存的是
      <strong>去标识化</strong>信息（《个人信息保护法》第七十三条），<strong>不是匿名化信息</strong>——
      把一句评论原文拿回原平台的那条作品下检索，仍有可能找到是谁发的。因此我们不声称它
      「无法指向任何人」，而是按「仍属个人信息」对待：处理依据为《个人信息保护法》第十三条第六项
      （合理范围内处理个人自行公开的信息），处理目的限于让用户了解读者在关注什么，并以
      「不采身份字段 + 90 天即删 + 不导出 + 不进语料 + 不做画像」五条护栏把处理限制在该范围内。
      <strong>作品作者与写下评论的读者本人</strong>都可通过
      <a href="https://beacon.iyunci.cn/legal/data-request">数据移除申请</a>要求删除
      （《个人信息保护法》第二十七条、第四十七条）。</li>
  <li>不收集键盘输入内容、位置、健康、财务信息，不收集其它网站的数据。</li>
</ul>

<h3>11.3 权限用途</h3>
<table>
  <tr><th>权限</th><th>用途</th></tr>
  <tr><td><code>storage</code></td><td>保存用户填写的服务器地址、采集令牌与各项开关。</td></tr>
  <tr><td><code>activeTab</code></td><td>读取当前标签页地址，判断是否为受支持页面。仅当前标签、仅用户操作时。</td></tr>
  <tr><td><code>alarms</code></td>
      <td>① 每日定时刷新图标角标；② 每 12 小时查一次扩展是否有新版本（只收发版本号与公开下载地址，不含用户数据）；
          ③ <strong>每日定时批量采集用户已订阅的竞对（默认开启，可在设置关闭）</strong>；
          ④ 用户显式开启后的每日公众号后台自动回填（默认关闭）；
          ⑤ <strong>每 10 分钟询问一次「用户自己的工作区有没有派任务给这台浏览器」</strong>
          （可在设置页关闭；该询问不携带任何页面内容）。</td></tr>
  <tr><td><code>notifications</code></td><td>每日提醒与自动回填的结果通知，可关闭。</td></tr>
  <tr><td><code>sidePanel</code></td><td>把助手界面开在浏览器侧边栏中。</td></tr>
  <tr><td><code>contextMenus</code></td><td>右键菜单「收进灵感箱」「存进资讯库」「一键拆解这条作品」，仅在用户点击对应菜单项时发送一次；开启评论提问采集后另加「读取评论区提问」一条，关闭时不创建。</td></tr>
  <tr><td><code>scripting</code></td>
      <td>用户当场点击时，把一个随安装包分发的脚本注入当前标签页读取一次页面内容（读正文 / 读封面文案 / 读已显示的评论 / 公众号后台补注入）。不常驻、不轮询。</td></tr>
  <tr><td><code>host_permissions</code>（8 条路径）</td>
      <td>B站/抖音/小红书/YouTube/X/TikTok 的公开作品页。<strong>唯一用途</strong>是让「读评论提问」在页内侧栏上也能用——
          <code>activeTab</code> 只在用户点击扩展自己的界面时授予，点页内按钮拿不到。
          范围与早已声明的内容脚本注入范围完全相同，<strong>不含任何创作者后台域名</strong>。</td></tr>
  <tr><td>内容脚本注入范围 <code>&lt;all_urls&gt;</code></td>
      <td>让用户在任意页面都能唤出侧栏助手。<strong>注入不等于采集</strong>：默认不读取、也不上传任何内容（收起时是一条只有 logo 的悬浮竖条，
          展开后是一列图标，点哪个才发生哪件事）；整个侧栏可在扩展设置中关闭。
          <br />另有一条例外并已单独说明：用户显式开启「打开指定网址并读取正文」后（<strong>默认关闭</strong>），
          扩展在自己打开的后台标签页中会读取该页正文——<strong>仅限一份写死在扩展代码里的站点清单</strong>，
          且由扩展自己校验、落地后按最终网址复验，清单以外一律拒绝读取。见 11.5。</td></tr>
</table>

<h3>11.4 数据流向与用户控制</h3>
<ul>
  <li>扩展采集的数据<strong>仅发往用户自己配置的服务器地址</strong>，不发往任何第三方，不出售、
      不用于与上述单一用途无关的目的、不用于判定信用资格。</li>
  <li>扩展<strong>不加载任何远程代码</strong>：所有脚本随安装包分发，运行时只请求数据接口。</li>
  <li>「访问即采」「每日提醒」「每天自动回填」「页内侧栏」均可在扩展设置中关闭。</li>
  <li>「评论提问采集」（自有作品 / 竞对作品两个独立开关）<strong>默认关闭</strong>，
      需用户在扩展设置中显式开启；关闭后按钮与右键菜单项一并消失。</li>
  <li>采集令牌可在烽火台设置页随时轮换或停用，停用后扩展立即无法回传。</li>
  <li>用户在烽火台<strong>注销账号</strong>后，采集令牌随工作区一并作废；扩展随即<strong>停止全部自动采集，
      并删除保存在本机的令牌与全部缓存</strong>（工作区名称、竞对清单、创作者账号清单、采集记录）。
      在完成注销的那台浏览器上即时生效；其它设备上的扩展在下次尝试回传发现令牌失效时自动完成同样的清除。</li>
  <li>被监控账号的主体可通过「被监控账号移除申请」页面申请移除。</li>
</ul>

<h3>11.5 工作区派下来的任务，以及「打开指定网址并读取正文」</h3>

<p>用户在烽火台网页里操作、或让 AI 助手代为发起时，可以把一件采集工作
<strong>派给用户自己的浏览器</strong>去做。任务通过用户自己的采集令牌关联到其工作区，
<strong>没有令牌的浏览器领不到任何任务</strong>。能派的动作是一份
<strong>写死在扩展代码里的白名单</strong>，目前有三件：采一个用户已订阅的竞对公开主页、
回填用户本人创作者后台的数据、以及「打开指定网址并读取正文」。
服务端<strong>不能</strong>下发白名单以外的任何指令——不能让扩展点击按钮、填写表单、
提交内容或执行任意脚本。</p>

<p><strong>「打开指定网址并读取正文」默认关闭</strong>，必须由用户在工作区设置里显式开启。
它是白名单里唯一一件「读哪一页由服务端决定」的动作，因此边界单列如下：</p>
<ul>
  <li><strong>只能打开清单内的站点</strong>：抖音、B站、快手、TikTok、小红书、知乎（含专栏）、
      微博、微信公众号文章页、今日头条、百家号、X、YouTube。按完整域名精确比对，
      <strong>不做模糊匹配</strong>。</li>
  <li><strong>校验由扩展自己完成，不依赖服务端</strong>：清单硬编码在扩展代码里；
      页面加载完成后还会按<strong>跳转后的最终网址</strong>再验一次，落到清单以外即放弃、
      不读取、不回传。</li>
  <li><strong>只读不动</strong>：只取该页已经渲染出来的文字，不点击、不滚动、不填写、不提交、
      不调用平台接口、不读取 Cookie 或登录凭证。</li>
  <li>一律使用<strong>后台标签页</strong>（不抢占用户当前正在看的页面），读完立即关闭。</li>
  <li>回传内容为：该页可见正文（上限 6 万字符，超出截断）、页面标题与最终网址。
      <strong>不含截图、不含 Cookie、不含表单内容。</strong></li>
  <li>关闭方式：在工作区设置里关闭该能力（默认即为关闭），或卸载扩展 / 解绑采集令牌。</li>
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
