// 密钥脱敏：本机命令输出、本机文件内容进模型上下文之前过一遍（2026-09-02，学自 Hermes agent/redact.py）。
//
// 【为什么要有】整机版的 run_shell / read_file 把结果原样塞进 AgentRun.messages，再送给模型供应商。
// 用户让 AI「看看配置对不对」，AI 一句 `cat .env`（或 read_file('.env')），
// 数据库密码、各家 API Key 就进了我们的库、也进了第三方模型的请求日志——
// 而用户根本没打算把密钥交给谁，他只是想让 AI 看一眼配置。
//
// 【形状清单从哪来】.githooks/pre-commit 那十条是项目里已经验证过会出现在这个仓库里的形状，
// 这里照搬，再补几家常见平台的 token 前缀。同一份形状两处用，改一处要记得看另一处。
//
// 【它挡不住什么】只认「长得像密钥」的东西。一个 16 位随机字符串放在一个叫 foo 的变量里，
// 它认不出来。所以这不是「密钥不会进上下文」的保证，是把最常见的那批挡掉。

const MASK = '[已脱敏]';

/** [形状, 替换]。替换里用 $1 保留上下文（键名、协议）让模型仍能看懂那一行是什么。 */
const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, `-----BEGIN PRIVATE KEY-----${MASK}-----END PRIVATE KEY-----`],
  // 各家 key 前缀
  [/\bsk-[A-Za-z0-9_-]{20,}/g, `sk-${MASK}`],
  [/\bAKIA[0-9A-Z]{16}\b/g, `AKIA${MASK}`],
  [/\bAKLT[A-Za-z0-9+/=]{20,}/g, `AKLT${MASK}`],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, `gh_${MASK}`],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, `xox-${MASK}`],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, `AIza${MASK}`],
  // 连接串里的密码
  [/\b(postgres(?:ql)?|redis|mysql|mongodb(?:\+srv)?|amqp|mqtt):\/\/([^:\s/@]+):([^@\s]+)@/gi, `$1://$2:${MASK}@`],
  [/\b(redis):\/\/:([^@\s]+)@/gi, `$1://:${MASK}@`],
  // HTTP 头
  [/\b(authorization\s*:\s*(?:bearer|basic|token)\s+)\S+/gi, `$1${MASK}`],
  // 环境变量 / 配置文件里的赋值：KEY 名里带 SECRET/TOKEN/PASSWORD/API_KEY/ACCESS_KEY 的。
  // 值里排除 `[`：前面的前缀形状已经打过码的（sk-[已脱敏]）不再打第二遍，免得一处算成两处、前缀也丢了
  [/\b([A-Za-z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET)[A-Za-z0-9_]*)(\s*[=:]\s*)(["']?)([^\s"'#\[]{6,})\3/gi, `$1$2$3${MASK}$3`],
  // JSON / YAML 里的常见键名
  [/(["']?(?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key)["']?\s*[:=]\s*["']?)([^\s"',;}\[]{6,})/gi, `$1${MASK}`],
];

export type RedactResult = { text: string; count: number };

/** 把文本里长得像密钥的部分打码。count = 打了几处。 */
export function redactSecrets(text: string): RedactResult {
  let out = text;
  let count = 0;
  for (const [re, rep] of PATTERNS) {
    out = out.replace(re, (...m) => {
      count++;
      // 手动展开 $1/$2/$3：replace 的函数形式不认 $n
      return rep.replace(/\$(\d)/g, (_s, i) => String(m[Number(i)] ?? ''));
    });
  }
  return { text: out, count };
}
