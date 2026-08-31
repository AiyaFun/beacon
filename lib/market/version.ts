// 产品自己的版本号。市场的包用 minAppVersion 声明「要多新的烽火台才装得上」，
// 这里是被比的那一端。
//
// 【为什么不 import package.json】那样会把整个 package.json（含全部依赖清单）
// 打进客户端 bundle，而这个常量在服务端与客户端都要用到。
// 一个字符串常量换掉几十 KB 的依赖清单，划算。
//
// ⚠️ 发版时要与 package.json 的 version 一起改；
// tests/market/pack.test.ts 有一条守卫逐字比对两处，漂了当场变红。
export const APP_VERSION = '1.3.1';
