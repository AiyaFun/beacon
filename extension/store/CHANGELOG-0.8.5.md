# 提审说明 · 0.8.1 → 0.8.5

商店版停在 0.8.1，本次一次性提交到 0.8.5。下面是可直接粘进「版本变更说明」的文案，
以及审核方可能追问的两点预备回答。

上传文件：`public/downloads/beacon-collector-0.8.5.zip`（1032 KB）
sha256：`4163b219acd3568d6a012899138af90e89bde730f0b85cec332095bcda745d21`

---

## 可直接粘贴的版本说明（中文）

本次为体验与数据准确性修复，**未新增任何权限，未改变数据收集范围**。

**修复**
- 悬浮工具条的按钮提示气泡此前被容器裁切、始终无法显示，现已修复；每个按钮悬停即可看到
  功能名称、用途说明与快捷键。
- 「读评论提问」入口此前在关闭状态下被完全隐藏，用户无法得知该功能存在；现改为常驻显示，
  未开启时标注「未开启」并可一键跳转设置页开启（功能默认关闭的行为不变）。
- 修复采集数字取值不准确的问题：部分平台页面正文显示的是四舍五入后的概数
  （如「217万」「18亿次观看」），现改为优先读取页面本身提供的精确数值。
- 修复 B 站评论数因页面结构调整而长期无法读取的问题。

**改进**
- 悬浮工具条支持鼠标悬停自动展开，点击可固定；新增 Alt/Option + 数字 快捷键。
- 新增采集「书签数」（X 平台公开展示的公开计数）。

---

## English (if the store listing needs it)

Bug fixes and data-accuracy improvements. **No new permissions; no change to
what data is collected.**

- Fixed tooltips on the floating toolbar, which were clipped by their container
  and never appeared. Hovering a button now shows its name, purpose and shortcut.
- The comment-question entry point was hidden entirely while disabled, so users
  could not tell the feature existed. It is now always visible, marked "off",
  and links to settings. The feature itself remains off by default.
- Fixed inaccurate counts: some pages print rounded figures in the body
  ("2.17M", "1.8B views"); the extension now prefers the exact value the page
  already exposes.
- Fixed Bilibili comment count, unreadable since a page-structure change.
- Toolbar now expands on hover (click to pin); added Alt/Option + number shortcuts.
- Added collection of the publicly displayed bookmark count on X.

---

## 审核方可能追问的两点

**1. 「为什么读取页面内嵌脚本？是否在收集额外数据？」**
不收集额外数据。读取的是**页面自己已经渲染给用户看的同一个计数**——正文里印的是四舍五入后的
概数（如「18亿次观看」），而精确值（1,802,559,974）在同一页面的内嵌脚本中。两者是同一个
公开指标的两种精度，我们只是取更准的那个。不涉及任何非公开数据、不涉及用户个人信息。

**2. 「权限是否有变化？」**
无变化。`manifest.json` 的 `permissions` / `host_permissions` 与 0.8.1 完全一致，
本次改动全部发生在既有内容脚本的取值逻辑与弹出层样式上。

---

## 提交前自查

- [ ] 截图仍为 1280×800（2 倍图会被打回，见 PUBLISH.md）
- [ ] 隐私政策链接可从境外访问（robots.txt 的 Disallow 会导致「无法访问隐私政策」，
      且宝塔 WAF 默认拦截境外 IP —— 这两个坑都踩过）
- [ ] 版本号 0.8.5 与 zip 内 manifest 一致
