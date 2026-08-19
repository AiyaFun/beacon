import type { PlatformKey } from '../constants';

// ── 各平台到底能怎么发 ──────────────────────────────────────────────────────
//
// 这张表是「一键发布」全部承诺的边界。写它的时候只问一个问题：
// **这条路今天真的走得通吗？** 走不通的一律写 manual 并说明原因，不许为了矩阵好看而留白。
//
// 三种通道：
//   api       —— 服务端调平台官方接口。目前只有微信公众号（图文草稿箱 + 可选提交发布）。
//   extension —— 浏览器插件在**你自己**的创作后台把标题/正文/标签填好，**停在发布按钮前**由你点。
//                不代点发布：那是替用户做对外的意思表示，且违反各平台创作者协议。
//   manual    —— 平台没有个人可用的通道，只能复制内容自己发。如实说，不假装。

export type PublishChannel = 'api' | 'extension' | 'manual';

export type PlatformPublishCap = {
  channel: PublishChannel;
  /** 这条通道要用户先做什么（没有就是空） */
  requires: string;
  /** 为什么是这条通道——界面上要给人看，别让人以为是我们没做 */
  why: string;
  /** 插件填充脚本是否已在真机上校准过。未校准的要在界面上说破。 */
  calibrated?: boolean;
};

export const PUBLISH_CAPS: Record<string, PlatformPublishCap> = {
  wechat: {
    channel: 'api',
    requires: '在「设置 · 发布通道」填公众号的 AppID / AppSecret，并把服务器 IP 加进公众号后台的 IP 白名单',
    why: '公众号有官方接口：服务端可直接把图文写进草稿箱；是否群发由你决定（群发不可撤销且有次数限制）',
  },
  douyin: {
    channel: 'extension',
    requires: '装上采集助手并登录抖音创作者后台',
    why: '抖音开放平台的视频发布接口只对通过审核的企业应用开放，个人创作者拿不到；插件把内容填好，你来点发布',
    calibrated: false,
  },
  xiaohongshu: {
    channel: 'extension',
    requires: '装上采集助手并登录小红书创作服务平台',
    why: '小红书开放平台只对品牌/MCN 开放，个人号没有发布接口；插件把内容填好，你来点发布',
    calibrated: false,
  },
  bilibili: {
    channel: 'extension',
    requires: '装上采集助手并登录B站创作中心',
    why: 'B站没有面向个人的公开发布接口；插件把标题/简介/标签填好，你来点发布',
    calibrated: false,
  },
  shipinhao: {
    channel: 'extension',
    requires: '装上采集助手并登录视频号助手',
    why: '视频号没有任何官方内容接口；插件只在你自己的后台页面里填字段，你来点发布',
    calibrated: false,
  },
  x: {
    channel: 'manual',
    requires: '',
    why: 'X 的发推接口要付费套餐（Basic 起）。我们不替你订阅，也不做模拟点击——复制内容手动发',
  },
  youtube: {
    channel: 'manual',
    requires: '',
    why: 'YouTube 有官方上传接口，但要上传视频文件本身，而系统里只存文案与封面、不存你的视频',
  },
  tiktok: {
    channel: 'manual',
    requires: '',
    why: 'TikTok 的内容发布接口需要企业资质与审核，个人创作者拿不到',
  },
};

export function capOf(platform: string): PlatformPublishCap {
  return (
    PUBLISH_CAPS[platform] ?? {
      channel: 'manual',
      requires: '',
      why: '这个平台还没有接入发布通道',
    }
  );
}

export function channelOf(platform: string): PublishChannel {
  return capOf(platform).channel;
}

const CHANNEL_LABEL: Record<PublishChannel, string> = {
  api: '官方接口直发',
  extension: '插件半自动（你点发布）',
  manual: '手动发布',
};

export function channelLabel(channel: string): string {
  return CHANNEL_LABEL[channel as PublishChannel] ?? channel;
}

/** 插件能接管的平台清单（插件端据此决定在哪些创作后台注入填充脚本）。 */
export function extensionPlatforms(): PlatformKey[] {
  return Object.entries(PUBLISH_CAPS)
    .filter(([, c]) => c.channel === 'extension')
    .map(([k]) => k as PlatformKey);
}

// 任务状态的人话。**「已填好」与「已发布」必须是两个词**：
// 插件只能把内容填进后台，点不点发布是用户的事。把它们并成一个「已发布」，
// 用户会以为稿子已经出去了——这是这个功能最容易出、也最致命的错报。
export const TASK_STATUS_LABEL: Record<string, string> = {
  pending: '待处理',
  ready: '内容已备好',
  filled: '已填进后台，等你点发布',
  submitted: '已提交到公众号草稿箱',
  published: '已发布',
  failed: '失败',
  skipped: '已跳过',
};
