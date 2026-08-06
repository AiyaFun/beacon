# 采集助手上架指南（Chrome / Edge / 360 / Safari）

> 分发策略：**商店正式链接为主路径**，自托管 zip 为审核期/企业内网兜底。
> 上架审核需要**你本人的开发者账号**——账号注册、实名、付费、提交都得你来做，
> 这份文档把「传什么、怎么填、填完把链接接回产品」讲清楚。

## 0. 先打包

```bash
npm run pack:ext
```

产出 `public/downloads/beacon-collector-<version>.zip`——**三个商店上传的就是这个 zip**。
（`beacon-collector-latest.zip` 是下载页兜底用的别名，别传这个版本别名去商店。）

上架材料都在本目录：
- `listing.md` — 商店详情页文案（名称/简介/详细描述/分类/关键词）
- `privacy.md` — 权限用途说明 + 数据处理声明（商店审核必填项，逐条抄）
- 截图：见下方「截图要求」，需你按真实界面截图后放到 `extension/store/screenshots/`

---

## 1. Chrome 应用商店（Chrome Web Store）

1. 注册开发者：<https://chrome.google.com/webstore/devconsole>，一次性 **$5** 注册费。
2. 「新增项目」→ 上传 `beacon-collector-<version>.zip`。
3. 商店详情：名称/简介/描述照 `listing.md` 填；分类选「生产工具（Productivity）」。
4. 隐私实践：**逐条**照 `privacy.md` 填——单一用途说明、四项权限用途、数据处理声明。
   需要一个**隐私政策 URL**：用产品内 `/legal`（如 `https://beacon.iyunci.cn/legal/privacy`）。
5. 截图：按「截图要求」传 1–5 张。
6. 提交审核（通常 1–3 个工作日，首次可能更久）。
7. **通过后**拿到详情页链接（形如 `https://chrome.google.com/webstore/detail/<id>`），
   **2026-07-30 已上架**，正式链接写在 `lib/downloads.ts: CHROME_STORE_URL`，
   不配 env 也能用。审核通过后要做的只有一件事：把在架版本号填进
   `BEACON_EXT_STORE_CHROME_VERSION`（如 `0.6.4`），下载页才敢并排写「商店版 vX / 最新版 vY」。

## 2. Microsoft Edge / 360 / Brave 等其它 Chromium —— **不提交**

2026-07-28 决定：**只提交 Chrome 一家商店**。

- Edge Addons、360 应用市场都要单独注册开发者、单独走一遍审核与后续更新，
  而这几家的用户都能用同一个 zip 走开发者模式装上，投入产出不成正比。
- 因此下载页上这几张卡是 `install: 'unpacked'`，**不会显示「商店审核中」**——
  给一个永远不会提交的商店挂「审核中」，等于让用户白等。这条有用例守着
  （`tests/bot/config.test.ts`：只有 Chrome 允许是 store 卡片）。
- Edge / Brave 能直接装 Chrome 应用商店里的同一款（Edge 需在提示里允许「来自其他应用商店的扩展」），
  所以 Chrome 上架后，这两张卡会多一个「装 Chrome 商店版」的次选入口。

哪天真要上 Edge：注册 <https://partner.microsoft.com/dashboard/microsoftedge>（免费）、
传同一个 zip（MV3 通用，无需改包），然后把该卡改回 `install: 'store'` 并加回对应 env。

## 3. Safari（本期标注「即将支持」，暂不实际上架）

Safari 扩展**无法用 crx/zip 直装**，必须：
1. macOS + Xcode：`xcrun safari-web-extension-converter extension/` 生成 Xcode 工程。
2. 用 **Apple 开发者账号（$99/年）** 签名，构建成 `.app`。
3. 走 Mac App Store 或公证（notarize）分发。

这是独立轨道、成本和周期都更高，本期下载页 Safari 卡片已如实标注「即将支持」。
真要做时，转换出的工程放到单独仓库/目录，不与本插件源码混在一起。

---

## 环境变量（上架后回填，无需改代码）

在部署机 `.env.production` 里填（见 `lib/downloads.ts`）：

```bash
BEACON_EXT_STORE_CHROME="https://chrome.google.com/webstore/detail/xxxx"
```

只有这一条（其余商店不提交，见上文第 2 节）。为空 = 用代码内置的正式链接（已上架）；填 `off`/`none` 才是「临时关掉商店入口」，
那时全部浏览器回落到 zip + 开发者模式加载；
Edge / Brave 多一个「装 Chrome 商店版」入口。

## 截图要求（放 extension/store/screenshots/）

- 尺寸：1280×800 或 640×400（Chrome 要求），PNG。
- 建议 3–5 张：① 插件弹窗竞对清单；② 竞对主页「✓ 已自动采集」提示；
  ③ 设置页填令牌+测试连接；④ app 竞对档案被回填后的数据；⑤ 数据看板一键回填。
- 不要出现真实竞对隐私数据/未脱敏账号；用示例账号或打码。
